import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { bboxOf, resolveQueryTimeRange } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import { eventVisibility } from '../../tenancy/event-visibility.js';
import {
  EVENTS_DEFAULT_RANGE_MS,
  EVENTS_MAX_RANGE_MS,
} from '../events/events.service.js';
import {
  type HeatmapQueryDto,
  type HeatmapView,
  MAX_SERIES_BUCKETS,
  type SeriesBucket,
  type StatsQueryDto,
  type StatsSeriesQueryDto,
  type SurveillanceStatsSeriesView,
  type SurveillanceStatsView,
} from './statistics.dto.js';
import {
  type EventCountRow,
  type SeriesCountRow,
  StatisticsRepository,
} from './statistics.repository.js';

/** Length of a bucket, ms (local days are 23–25 h around DST changes). */
const BUCKET_MS: Readonly<Record<SeriesBucket, number>> = {
  hour: 3_600_000,
  day: 86_400_000,
};

/** One bucket of a series while it is assembled. */
interface SeriesBucketTotals {
  from: Date;
  to: Date;
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
}

/**
 * The buckets of a series clipped to `[from, to]`: the first starts at
 * `from`, the last ends at `to` (inclusive, like the range filter); a
 * zero-length bucket starting exactly at `to` is folded into the one before.
 */
export function assembleSeries(
  rows: readonly SeriesCountRow[],
  from: Date,
  to: Date,
): SeriesBucketTotals[] {
  const buckets: SeriesBucketTotals[] = [];
  for (const row of rows) {
    const start = Math.max(row.bucketFrom.getTime(), from.getTime());
    let bucket = buckets.at(-1);
    if (bucket?.from.getTime() !== start) {
      bucket = {
        from: new Date(start),
        to: new Date(Math.min(row.bucketTo.getTime(), to.getTime())),
        total: 0,
        byType: {},
        bySeverity: {},
      };
      buckets.push(bucket);
    }
    if (row.count === 0 || row.type === null || row.severity === null) continue;
    bucket.total += row.count;
    bucket.byType[row.type] = (bucket.byType[row.type] ?? 0) + row.count;
    bucket.bySeverity[row.severity] =
      (bucket.bySeverity[row.severity] ?? 0) + row.count;
  }
  const last = buckets.at(-1);
  const previous = buckets.at(-2);
  if (last !== undefined && last.from.getTime() >= last.to.getTime()) {
    buckets.pop();
    if (previous !== undefined) {
      previous.total += last.total;
      for (const [type, count] of Object.entries(last.byType))
        previous.byType[type] = (previous.byType[type] ?? 0) + count;
      for (const [severity, count] of Object.entries(last.bySeverity))
        previous.bySeverity[severity] =
          (previous.bySeverity[severity] ?? 0) + count;
    } else if (last.total > 0) {
      buckets.push(last);
    }
  }
  return buckets;
}

/** Kilometres per degree of latitude (and of longitude at the equator). */
export const KM_PER_DEGREE = 111.32;

/**
 * Grid cell size in degrees for a cell size in kilometres. The grid is
 * square in degrees: at Indonesian latitudes (11° S – 6° N) a degree of
 * longitude is at least 98 % of a degree of latitude, so cells are within
 * 2 % of square.
 */
export function cellSizeDegrees(cellKm: number): number {
  return cellKm / KM_PER_DEGREE;
}

/** Sums event counts by one key. */
function countBy(
  rows: readonly EventCountRow[],
  key: (row: EventCountRow) => string,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows)
    totals[key(row)] = (totals[key(row)] ?? 0) + row.count;
  return totals;
}

/**
 * `GET /surveillance/heatmap`, `GET /surveillance/stats` and
 * `GET /surveillance/stats/series` (tenancy per spec §8.5).
 */
@Injectable()
export class StatisticsService {
  constructor(private readonly statistics: StatisticsRepository) {}

  async heatmap(
    principal: Principal,
    query: HeatmapQueryDto,
  ): Promise<HeatmapView> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
      maxDurationMs: EVENTS_MAX_RANGE_MS,
    });
    const cellDeg = cellSizeDegrees(query.cellKm);
    const cells = await this.statistics.heatmap(
      {
        visibility: eventVisibility(principal),
        from,
        to,
        types: query.type === undefined ? undefined : [query.type],
        bbox: bboxOf(query),
      },
      cellDeg,
    );
    return {
      cells,
      cellKm: query.cellKm,
      cellDeg,
      from: from.toISOString(),
      to: to.toISOString(),
      total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
  }

  async stats(
    principal: Principal,
    query: StatsQueryDto,
  ): Promise<SurveillanceStatsView> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
      maxDurationMs: EVENTS_MAX_RANGE_MS,
    });
    const visibility = eventVisibility(principal);
    const [rows, queue, fishingViolations] = await Promise.all([
      this.statistics.eventCounts({ visibility, from, to }),
      visibility.scope === 'all'
        ? this.statistics.transhipmentQueue()
        : Promise.resolve(null),
      this.statistics.fishingViolationCount(),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      total: rows.reduce((sum, row) => sum + row.count, 0),
      active: rows
        .filter((row) => row.active)
        .reduce((sum, row) => sum + row.count, 0),
      byType: countBy(rows, (row) => row.type),
      bySeverity: countBy(rows, (row) => row.severity),
      byStatus: countBy(rows, (row) => row.status),
      transhipmentQueue:
        queue === null
          ? null
          : {
              pending: queue.pending ?? 0,
              inProgress: queue.in_progress ?? 0,
              completed: queue.completed ?? 0,
              failed: queue.failed ?? 0,
            },
      fishingViolations,
    };
  }

  /**
   * Event counts per hour or day of a time zone in one query (the overview
   * chart), every bucket of the range included; at most
   * {@link MAX_SERIES_BUCKETS} buckets (`400 VALIDATION_FAILED` on `bucket`),
   * in a zone the database knows (`400 VALIDATION_FAILED` on `tz`; echoed in
   * the database's spelling).
   */
  async series(
    principal: Principal,
    query: StatsSeriesQueryDto,
  ): Promise<SurveillanceStatsSeriesView> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
      maxDurationMs: EVENTS_MAX_RANGE_MS,
    });
    const buckets =
      Math.floor((to.getTime() - from.getTime()) / BUCKET_MS[query.bucket]) + 2;
    if (buckets > MAX_SERIES_BUCKETS)
      throw new ValidationFailedError([
        {
          field: 'bucket',
          message: `The range spans more than ${MAX_SERIES_BUCKETS} ${query.bucket} buckets: shorten it or use bucket=day`,
          code: 'maxBuckets',
        },
      ]);
    const timeZone = await this.statistics.timeZoneName(query.tz);
    if (timeZone === undefined)
      throw new ValidationFailedError([
        {
          field: 'tz',
          message:
            'tz must be an IANA time zone the database knows (e.g. Asia/Jakarta)',
          code: 'isTimeZone',
        },
      ]);
    const rows = await this.statistics.eventSeries(
      {
        visibility: eventVisibility(principal),
        from,
        to,
        types: query.type === undefined ? undefined : [query.type],
      },
      query.bucket,
      timeZone,
    );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: query.bucket,
      timeZone,
      buckets: assembleSeries(rows, from, to).map((bucket) => ({
        ...bucket,
        from: bucket.from.toISOString(),
        to: bucket.to.toISOString(),
      })),
    };
  }
}
