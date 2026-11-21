import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { bboxOf, resolveQueryTimeRange } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import { eventVisibility } from '../../tenancy/event-visibility.js';
import {
  EVENTS_DEFAULT_RANGE_MS,
  EVENTS_MAX_RANGE_MS,
} from '../events/events.service.js';
import type {
  HeatmapView,
  HeatmapQueryDto,
  StatsQueryDto,
  SurveillanceStatsView,
} from './statistics.dto.js';
import {
  type EventCountRow,
  StatisticsRepository,
} from './statistics.repository.js';

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

/** `GET /surveillance/heatmap` and `GET /surveillance/stats` (tenancy per spec §8.5). */
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
}
