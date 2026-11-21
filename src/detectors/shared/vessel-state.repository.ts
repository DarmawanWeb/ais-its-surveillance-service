import type {
  AisSource,
  PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { VesselPosition } from '@darmawanweb/ais-its-nest/analytics';
import {
  type Database,
  InjectDb,
  pointGeography,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { type RawTimestamp, rowDate } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import {
  type SilentVesselsQuery,
  type StoredNeighbour,
  type StoredNeighbourQuery,
  type StoredVesselState,
  VesselStateStorage,
} from './storage.js';

/** A `vessel_state` row as selected by the queries below. */
interface VesselStateRow extends Record<string, unknown> {
  mmsi: number;
  time: RawTimestamp;
  source: AisSource;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  hdg: number;
  navstatus: VesselPosition['navstatus'];
  pred_navstatus: PredictedNavStatus;
  in_zone_ids: string[];
}

const STATE_COLUMNS = sql`mmsi, time, source, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
  sog, cog, hdg, navstatus, pred_navstatus, in_zone_ids`;

function toState(row: VesselStateRow): StoredVesselState {
  return {
    mmsi: row.mmsi,
    time: rowDate(row.time),
    source: row.source,
    lat: row.lat,
    lon: row.lon,
    sog: row.sog,
    cog: row.cog,
    hdg: row.hdg,
    navstatus: row.navstatus,
    predictedNavstatus: row.pred_navstatus,
    inZoneIds: row.in_zone_ids,
  };
}

/** PostgreSQL implementation of {@link VesselStateStorage} (`vessel_state`, PostGIS). */
@Injectable()
export class VesselStateRepository extends VesselStateStorage {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {
    super();
  }

  async save(
    position: VesselPosition,
    inZoneIds: readonly string[],
    patch: { readonly anomalyStreak?: number } = {},
  ): Promise<void> {
    const streak = patch.anomalyStreak;
    await this.db.execute(sql`
      INSERT INTO vessel_state AS s
        (mmsi, time, source, geom, sog, cog, hdg, navstatus, pred_navstatus, in_zone_ids, anomaly_streak)
      VALUES (${position.mmsi}, ${position.time}, ${position.source},
        ${pointGeography(position.lon, position.lat)}, ${position.sog}, ${position.cog},
        ${position.hdg}, ${position.navstatus}, ${position.predictedNavstatus},
        ${sql.param([...inZoneIds])}::uuid[], ${streak ?? 0})
      ON CONFLICT (mmsi) DO UPDATE SET
        time = EXCLUDED.time,
        source = EXCLUDED.source,
        geom = EXCLUDED.geom,
        sog = EXCLUDED.sog,
        cog = EXCLUDED.cog,
        hdg = EXCLUDED.hdg,
        navstatus = EXCLUDED.navstatus,
        pred_navstatus = EXCLUDED.pred_navstatus,
        in_zone_ids = EXCLUDED.in_zone_ids,
        anomaly_streak = ${streak === undefined ? sql`s.anomaly_streak` : sql`EXCLUDED.anomaly_streak`},
        updated_at = now()
      WHERE s.time <= EXCLUDED.time`);
  }

  async anomalyStreaks(): Promise<ReadonlyMap<number, number>> {
    const { rows } = await this.db.execute<{
      mmsi: number;
      anomaly_streak: number;
    }>(
      sql`SELECT mmsi, anomaly_streak FROM vessel_state WHERE anomaly_streak > 0`,
    );
    return new Map(rows.map((row) => [row.mmsi, row.anomaly_streak]));
  }

  async neighbours(query: StoredNeighbourQuery): Promise<StoredNeighbour[]> {
    const origin = pointGeography(query.lon, query.lat);
    const { rows } = await this.db.execute<
      VesselStateRow & { distance_m: number }
    >(sql`
      SELECT ${STATE_COLUMNS}, ST_Distance(geom, ${origin}) AS distance_m
      FROM vessel_state
      WHERE mmsi <> ${query.mmsi}
        AND time BETWEEN ${query.from} AND ${query.to}
        AND ST_DWithin(geom, ${origin}, ${query.radiusM})
        AND (source = ANY(${sql.param([...query.sources])}::text[])
             OR in_zone_ids && ${sql.param([...query.zoneIds])}::uuid[])
      ORDER BY distance_m`);
    return rows.map((row) => ({
      state: toState(row),
      distanceM: row.distance_m,
    }));
  }

  async silent(query: SilentVesselsQuery): Promise<StoredVesselState[]> {
    const { rows } = await this.db.execute<VesselStateRow>(sql`
      SELECT ${STATE_COLUMNS}
      FROM vessel_state
      WHERE time < ${query.seenBefore}
        AND time >= ${query.seenAfter}
        AND sog > ${query.minSogKn}
      ORDER BY time DESC
      LIMIT ${query.limit}`);
    return rows.map(toState);
  }
}
