import type { BBox } from '@darmawanweb/ais-its-contracts/domain';
import {
  bboxEnvelope,
  type Database,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import type * as schema from '../../db/schema.js';
import {
  type HeatmapCell,
  MAX_HEATMAP_CELLS,
} from '../statistics/statistics.repository.js';
import type { FishingViolationView } from './fishing-violations.dto.js';

/** Filters of {@link FishingViolationsRepository.page}. */
export interface FishingViolationFilters {
  readonly bbox?: BBox | undefined;
  readonly year?: number | undefined;
}

/** Read access to `fishing_violations` (historical, shared across tenants). */
@Injectable()
export class FishingViolationsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Records per year, oldest first. */
  async years(): Promise<{ year: number; count: number }[]> {
    const { rows } = await this.db.execute<{ year: number; count: number }>(
      sql`SELECT year, count(*)::integer AS count FROM fishing_violations GROUP BY year ORDER BY year`,
    );
    return rows;
  }

  /** Records per grid cell (`ST_SnapToGrid`, cell size in degrees), densest first. */
  async heatmap(
    filters: FishingViolationFilters,
    cellDeg: number,
  ): Promise<HeatmapCell[]> {
    const { rows } = await this.db.execute<{
      lat: number;
      lon: number;
      count: number;
    }>(sql`
      SELECT ST_Y(cell) AS lat, ST_X(cell) AS lon, count
      FROM (
        SELECT ST_SnapToGrid(geom::geometry, ${cellDeg}::double precision) AS cell,
               count(*)::integer AS count
        FROM fishing_violations
        WHERE ${conditionsOf(filters)}
        GROUP BY cell
      ) AS grid
      ORDER BY count DESC, lat, lon
      LIMIT ${MAX_HEATMAP_CELLS}`);
    return rows;
  }

  async page(
    filters: FishingViolationFilters,
    offset: number,
    limit: number,
  ): Promise<{ rows: FishingViolationView[]; total: number }> {
    const where = conditionsOf(filters);
    const [{ rows }, count] = await Promise.all([
      this.db.execute<{
        id: string;
        vessel_name: string;
        flag_country: string;
        year: number;
        violation: string;
        action: string;
        lat: number;
        lon: number;
        source: string;
        source_note: string;
        method_id: string;
      }>(sql`
        SELECT id, vessel_name, flag_country, year, violation, action,
               ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
               source, source_note, method_id
        FROM fishing_violations
        WHERE ${where}
        ORDER BY year, record_no
        LIMIT ${limit} OFFSET ${offset}`),
      this.db.execute<{ total: number }>(
        sql`SELECT count(*)::integer AS total FROM fishing_violations WHERE ${where}`,
      ),
    ]);
    return {
      rows: rows.map((row) => ({
        id: row.id,
        vesselName: row.vessel_name,
        flagCountry: row.flag_country,
        year: row.year,
        violation: row.violation,
        action: row.action,
        lat: row.lat,
        lon: row.lon,
        source: row.source,
        sourceNote: row.source_note,
        methodId: row.method_id,
      })),
      total: count.rows[0]?.total ?? 0,
    };
  }
}

/** The filters as one SQL condition on `fishing_violations`. */
function conditionsOf(filters: FishingViolationFilters): SQL {
  const conditions: SQL[] = [sql`TRUE`];
  if (filters.year !== undefined) conditions.push(sql`year = ${filters.year}`);
  if (filters.bbox !== undefined)
    conditions.push(
      sql`ST_Intersects(geom::geometry, ${bboxEnvelope(filters.bbox)})`,
    );
  return sql.join(conditions, sql` AND `);
}
