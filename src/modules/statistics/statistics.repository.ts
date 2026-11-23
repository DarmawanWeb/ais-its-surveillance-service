import { type Database, InjectDb, rowDate } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type * as schema from '../../db/schema.js';
import type { SeriesBucket } from './statistics.dto.js';
import {
  type EventFilters,
  eventConditions,
} from '../events/events.repository.js';

/** One heatmap cell (centre in degrees). */
export interface HeatmapCell {
  readonly lat: number;
  readonly lon: number;
  readonly count: number;
}

/** Event counts grouped by type, severity, review status and activity. */
export interface EventCountRow {
  readonly type: string;
  readonly severity: string;
  readonly status: string;
  readonly active: boolean;
  readonly count: number;
}

/** Counts of one type and severity in one bucket; empty buckets have `count` 0. */
export interface SeriesCountRow {
  readonly bucketFrom: Date;
  readonly bucketTo: Date;
  readonly type: string | null;
  readonly severity: string | null;
  readonly count: number;
}

/** Most cells a heatmap returns (densest first). */
export const MAX_HEATMAP_CELLS = 10_000;

/** Aggregations over `events`, `transhipment_pairs` and `fishing_violations`. */
@Injectable()
export class StatisticsRepository {
  /** `pg_timezone_names` by lower-case name, loaded once. */
  private timeZones: Promise<ReadonlyMap<string, string>> | undefined;

  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * The database's spelling of a time zone name (`pg_timezone_names`,
   * matched case-insensitively like PostgreSQL does), `undefined` for a name
   * it does not know: ICU still knows aliases the database's tzdata dropped
   * (`US/Pacific-New`), which `date_trunc` would refuse. The names are read
   * once (the view scans the tz database); a failed read is retried.
   */
  async timeZoneName(name: string): Promise<string | undefined> {
    this.timeZones ??= this.db
      .execute<{ name: string }>(sql`SELECT name FROM pg_timezone_names`)
      .then(
        ({ rows }) =>
          new Map(rows.map((row) => [row.name.toLowerCase(), row.name])),
        (error: unknown) => {
          this.timeZones = undefined;
          throw error;
        },
      );
    return (await this.timeZones).get(name.toLowerCase());
  }

  /** Events per grid cell (`ST_SnapToGrid` on the geometry, cell size in degrees). */
  async heatmap(
    filters: EventFilters,
    cellDeg: number,
  ): Promise<HeatmapCell[]> {
    const conditions = [...eventConditions(filters), sql`e.geom IS NOT NULL`];
    const { rows } = await this.db.execute<{
      lat: number;
      lon: number;
      count: number;
    }>(sql`
      SELECT ST_Y(cell) AS lat, ST_X(cell) AS lon, count
      FROM (
        SELECT ST_SnapToGrid(e.geom::geometry, ${cellDeg}::double precision) AS cell,
               count(*)::integer AS count
        FROM events e
        WHERE ${sql.join(conditions, sql` AND `)}
        GROUP BY cell
      ) AS grid
      ORDER BY count DESC, lat, lon
      LIMIT ${MAX_HEATMAP_CELLS}`);
    return rows;
  }

  async eventCounts(filters: EventFilters): Promise<EventCountRow[]> {
    const { rows } = await this.db.execute<{
      type: string;
      severity: string;
      status: string;
      active: boolean;
      count: number;
    }>(sql`
      SELECT e.type, e.severity, e.status, (e.resolved_at IS NULL) AS active,
             count(*)::integer AS count
      FROM events e
      WHERE ${sql.join(eventConditions(filters), sql` AND `)}
      GROUP BY 1, 2, 3, 4`);
    return rows;
  }

  /**
   * Event counts per bucket (local hours or days of `timeZone`), every bucket
   * from the one containing `filters.from` to the one containing
   * `filters.to`, in order. A bucket starts at each distinct local truncation
   * (`date_trunc(bucket, t, timeZone)`, as the counts use) of an
   * absolute-time grid finer than any local hour or day (offsets are
   * multiples of 15 minutes) and ends where the next one starts: a repeated
   * hour at the end of daylight saving time is two buckets, a skipped hour
   * none, and a day is 23 to 25 hours long where the zone shifts its clock.
   */
  async eventSeries(
    filters: EventFilters,
    bucket: SeriesBucket,
    timeZone: string,
  ): Promise<SeriesCountRow[]> {
    const step = bucket === 'hour' ? '15 minutes' : '1 hour';
    // Past `to`, so that the bucket containing it has a successor.
    const pad = bucket === 'hour' ? '2 hours' : '2 days';
    const { rows } = await this.db.execute<{
      bucket_from: Date | string;
      bucket_to: Date | string;
      type: string | null;
      severity: string | null;
      count: number | null;
    }>(sql`
      WITH starts AS (
        SELECT DISTINCT date_trunc(${bucket}, grid, ${timeZone}) AS bucket_from
        FROM generate_series(
          ${filters.from}::timestamptz,
          ${filters.to}::timestamptz + ${pad}::interval,
          ${step}::interval
        ) AS grid
      ),
      series AS (
        SELECT bucket_from, lead(bucket_from) OVER (ORDER BY bucket_from) AS bucket_to
        FROM starts
      ),
      counts AS (
        SELECT date_trunc(${bucket}, e.time, ${timeZone}) AS bucket_from,
               e.type, e.severity, count(*)::integer AS count
        FROM events e
        WHERE ${sql.join(eventConditions(filters), sql` AND `)}
        GROUP BY 1, 2, 3
      )
      SELECT s.bucket_from, s.bucket_to, c.type, c.severity, c.count
      FROM series s
      LEFT JOIN counts c ON c.bucket_from = s.bucket_from
      WHERE s.bucket_to IS NOT NULL AND s.bucket_from <= ${filters.to}::timestamptz
      ORDER BY s.bucket_from, c.type, c.severity`);
    return rows.map((row) => ({
      bucketFrom: rowDate(row.bucket_from),
      bucketTo: rowDate(row.bucket_to),
      type: row.type,
      severity: row.severity,
      count: row.count ?? 0,
    }));
  }

  async transhipmentQueue(): Promise<Record<string, number>> {
    const { rows } = await this.db.execute<{ status: string; count: number }>(
      sql`SELECT status, count(*)::integer AS count FROM transhipment_pairs GROUP BY status`,
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async fishingViolationCount(): Promise<number> {
    const { rows } = await this.db.execute<{ count: number }>(
      sql`SELECT count(*)::integer AS count FROM fishing_violations`,
    );
    return rows[0]?.count ?? 0;
  }
}
