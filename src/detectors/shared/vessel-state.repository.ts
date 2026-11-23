import type {
  AisSource,
  PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { VesselPosition } from '@darmawanweb/ais-its-nest/analytics';
import {
  type Database,
  InjectDb,
  pointGeography,
  rowDate,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type * as schema from '../../db/schema.js';
import {
  type AnomalyStreak,
  type SilentVesselsQuery,
  type StoredNeighbour,
  type StoredNeighbourQuery,
  type StoredVesselState,
  VesselStateStorage,
} from './storage.js';

/** A `vessel_state` row as selected by the queries below. */
interface VesselStateRow extends Record<string, unknown> {
  mmsi: number;
  time: Date | string;
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

/**
 * Zero streaks counted within this window before the newest counted position
 * are restored too: a position redelivered after a crash is at most minutes
 * older than the newest one, minutes of event time.
 */
const ZERO_STREAK_RESTORE_WINDOW_MIN = 60;

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
    const streakAt = streak === undefined ? null : position.time;
    await this.db.execute(sql`
      INSERT INTO vessel_state AS s
        (mmsi, time, source, geom, sog, cog, hdg, navstatus, pred_navstatus, in_zone_ids,
         anomaly_streak, anomaly_streak_at)
      VALUES (${position.mmsi}, ${position.time}, ${position.source},
        ${pointGeography(position.lon, position.lat)}, ${position.sog}, ${position.cog},
        ${position.hdg}, ${position.navstatus}, ${position.predictedNavstatus},
        ${sql.param([...inZoneIds])}::uuid[], ${streak ?? 0}, ${streakAt}::timestamptz)
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
        -- Only a position newer than the last counted one changes the streak
        -- (NULL when the write carries no streak: the counter is kept).
        anomaly_streak = CASE
          WHEN EXCLUDED.anomaly_streak_at > COALESCE(s.anomaly_streak_at, '-infinity'::timestamptz)
          THEN EXCLUDED.anomaly_streak ELSE s.anomaly_streak END,
        anomaly_streak_at = GREATEST(s.anomaly_streak_at, EXCLUDED.anomaly_streak_at),
        updated_at = now()
      WHERE s.time <= EXCLUDED.time`);
  }

  async anomalyStreaks(): Promise<ReadonlyMap<number, AnomalyStreak>> {
    const { rows } = await this.db.execute<{
      mmsi: number;
      anomaly_streak: number;
      anomaly_streak_at: Date | string;
    }>(sql`
      SELECT mmsi, anomaly_streak, anomaly_streak_at
      FROM vessel_state
      WHERE anomaly_streak_at IS NOT NULL
        AND (anomaly_streak > 0
             OR anomaly_streak_at >= (SELECT max(anomaly_streak_at) FROM vessel_state)
                                     - ${`${ZERO_STREAK_RESTORE_WINDOW_MIN} minutes`}::interval)`);
    return new Map(
      rows.map((row) => [
        row.mmsi,
        { streak: row.anomaly_streak, at: rowDate(row.anomaly_streak_at) },
      ]),
    );
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
