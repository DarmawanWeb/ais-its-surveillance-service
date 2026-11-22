import type {
  AlertSeverity,
  SurveillanceEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { type RawTimestamp, rowDate } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import {
  type EventVisibility,
  visibleEvents,
} from '../../tenancy/event-visibility.js';

/** A stored positive analysis with the names and review status joined. */
export interface StoredTranshipmentResult {
  readonly id: string;
  readonly eventId: string;
  readonly mmsiA: number;
  readonly mmsiB: number;
  readonly nameA: string | null;
  readonly nameB: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly detectedAt: Date;
  readonly accuracy: number;
  readonly averagePriority: number;
  readonly priorityDistribution: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
  };
  readonly severity: AlertSeverity;
  /** Review status of the occurrence's event (`null` once the event is gone). */
  readonly status: SurveillanceEventStatus | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly methodId: string;
}

/** Filters of {@link TranshipmentResultsRepository.list}. */
export interface TranshipmentResultFilters {
  readonly visibility: EventVisibility;
  /** Window start (`start_at`) range. */
  readonly from: Date;
  readonly to: Date;
  /** Only pairs with this vessel. */
  readonly mmsi?: number | undefined;
}

/** Position of the last row of a page (`start_at` DESC, `id` DESC). */
export interface TranshipmentResultCursor {
  readonly time: string;
  readonly id: string;
}

interface ResultRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  mmsi_a: number;
  mmsi_b: number;
  name_a: string | null;
  name_b: string | null;
  start_at: RawTimestamp;
  end_at: RawTimestamp;
  detected_at: RawTimestamp;
  accuracy: number;
  average_priority: number;
  priority_distribution: StoredTranshipmentResult['priorityDistribution'];
  severity: AlertSeverity;
  status: SurveillanceEventStatus | null;
  lat: number | null;
  lon: number | null;
  method_id: string;
}

/** Read access to `transhipment_results` (tenancy per spec §8.5, like events). */
@Injectable()
export class TranshipmentResultsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** A page of results, newest window first; `limit` rows at most. */
  async list(
    filters: TranshipmentResultFilters,
    after: TranshipmentResultCursor | undefined,
    limit: number,
  ): Promise<StoredTranshipmentResult[]> {
    const conditions: SQL[] = [
      visibleEvents(filters.visibility, sql`r.mmsi_a`, sql`r.mmsi_b`),
      sql`r.start_at >= ${filters.from}`,
      sql`r.start_at <= ${filters.to}`,
    ];
    if (filters.mmsi !== undefined)
      conditions.push(
        sql`(r.mmsi_a = ${filters.mmsi} OR r.mmsi_b = ${filters.mmsi})`,
      );
    if (after !== undefined)
      conditions.push(
        sql`(r.start_at, r.id) < (${new Date(after.time)}::timestamptz, ${after.id}::uuid)`,
      );
    const { rows } = await this.db.execute<ResultRow>(sql`
      SELECT r.id, r.event_id, r.mmsi_a, r.mmsi_b, va.name AS name_a, vb.name AS name_b,
             r.start_at, r.end_at, r.detected_at, r.accuracy, r.average_priority,
             r.priority_distribution, r.severity, e.status,
             ST_Y(r.geom::geometry) AS lat, ST_X(r.geom::geometry) AS lon, r.method_id
      FROM transhipment_results r
      LEFT JOIN vessels va ON va.mmsi = r.mmsi_a AND va.deleted_at IS NULL
      LEFT JOIN vessels vb ON vb.mmsi = r.mmsi_b AND vb.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT status FROM events WHERE events.id = r.event_id LIMIT 1
      ) e ON TRUE
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY r.start_at DESC, r.id DESC
      LIMIT ${limit}`);
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      mmsiA: row.mmsi_a,
      mmsiB: row.mmsi_b,
      nameA: row.name_a,
      nameB: row.name_b,
      startAt: rowDate(row.start_at),
      endAt: rowDate(row.end_at),
      detectedAt: rowDate(row.detected_at),
      accuracy: row.accuracy,
      averagePriority: row.average_priority,
      priorityDistribution: row.priority_distribution,
      severity: row.severity,
      status: row.status,
      lat: row.lat,
      lon: row.lon,
      methodId: row.method_id,
    }));
  }
}
