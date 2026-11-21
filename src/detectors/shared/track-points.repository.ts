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
import type { TrackFix } from '../../domain/transhipment/track.js';
import { TrackStorage } from './storage.js';

/** PostgreSQL implementation of {@link TrackStorage} (`track_points` hypertable). */
@Injectable()
export class TrackPointsRepository extends TrackStorage {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {
    super();
  }

  async append(position: VesselPosition): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO track_points (time, mmsi, source, geom, sog, cog, hdg, navstatus)
      VALUES (${position.time}, ${position.mmsi}, ${position.source},
        ${pointGeography(position.lon, position.lat)}, ${position.sog}, ${position.cog},
        ${position.hdg}, ${position.navstatus})
      ON CONFLICT (mmsi, time) DO NOTHING`);
  }

  async route(
    mmsi: number,
    from: Date,
    to: Date,
    maxPoints: number,
  ): Promise<TrackFix[]> {
    const { rows } = await this.db.execute<{
      time: RawTimestamp;
      lat: number;
      lon: number;
      sog: number;
      cog: number;
      hdg: number;
    }>(sql`
      SELECT time, lat, lon, sog, cog, hdg FROM (
        SELECT time, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon, sog, cog, hdg
        FROM track_points
        WHERE mmsi = ${mmsi} AND time BETWEEN ${from} AND ${to}
        ORDER BY time DESC
        LIMIT ${maxPoints}
      ) AS latest
      ORDER BY time`);
    return rows.map((row) => ({
      time: rowDate(row.time),
      lat: row.lat,
      lon: row.lon,
      sog: row.sog,
      cog: row.cog,
      hdg: row.hdg,
    }));
  }
}
