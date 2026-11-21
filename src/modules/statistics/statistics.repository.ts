import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type * as schema from '../../db/schema.js';
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

/** Most cells a heatmap returns (densest first). */
export const MAX_HEATMAP_CELLS = 10_000;

/** Aggregations over `events`, `transhipment_pairs` and `fishing_violations`. */
@Injectable()
export class StatisticsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

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
