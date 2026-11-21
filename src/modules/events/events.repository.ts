import type {
  AlertSeverity,
  BBox,
  SurveillanceEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  bboxEnvelope,
  type Database,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { type RawTimestamp, rowDate, rowDateOrNull } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import {
  type EventVisibility,
  visibleEvents,
} from '../../tenancy/event-visibility.js';

/** An event row with the names joined from the projections. */
export interface EventRecord {
  readonly id: string;
  readonly time: Date;
  readonly detector: string;
  readonly type: string;
  readonly domain: 'safety' | 'surveillance';
  readonly severity: AlertSeverity;
  readonly currentSeverity: AlertSeverity;
  readonly mmsi: number;
  readonly relatedMmsi: number | null;
  readonly vesselName: string | null;
  readonly relatedVesselName: string | null;
  readonly zoneId: string | null;
  readonly zoneName: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly title: string;
  readonly message: string;
  readonly methodId: string;
  readonly dedupKey: string;
  readonly data: Record<string, unknown>;
  readonly status: SurveillanceEventStatus;
  readonly openedAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolution: Record<string, unknown> | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly note: string | null;
  /** When the row was written (the detection time). */
  readonly createdAt: Date;
}

/** Filters of {@link EventsRepository.list}. */
export interface EventFilters {
  readonly visibility: EventVisibility;
  readonly from: Date;
  readonly to: Date;
  readonly types?: readonly string[] | undefined;
  readonly severity?: AlertSeverity | undefined;
  readonly status?: SurveillanceEventStatus | undefined;
  readonly mmsi?: number | undefined;
  readonly bbox?: BBox | undefined;
}

/** Position of the last row of a page (`time` DESC, `id` DESC). */
export interface EventCursor {
  readonly time: string;
  readonly id: string;
}

/** A review to store. */
export interface EventReview {
  readonly status: 'open' | 'confirmed' | 'dismissed';
  readonly note: string | null;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  time: RawTimestamp;
  detector: string;
  type: string;
  domain: 'safety' | 'surveillance';
  severity: AlertSeverity;
  current_severity: AlertSeverity;
  mmsi: number;
  related_mmsi: number | null;
  vessel_name: string | null;
  related_vessel_name: string | null;
  zone_id: string | null;
  zone_name: string | null;
  lat: number | null;
  lon: number | null;
  title: string;
  message: string;
  method_id: string;
  dedup_key: string;
  data: Record<string, unknown>;
  status: SurveillanceEventStatus;
  opened_at: RawTimestamp;
  last_seen_at: RawTimestamp;
  resolved_at: RawTimestamp | null;
  resolution: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_at: RawTimestamp | null;
  note: string | null;
  created_at: RawTimestamp;
}

const SELECT_EVENTS = sql`
  SELECT e.id, e.time, e.detector, e.type, e.domain, e.severity, e.current_severity,
         e.mmsi, e.related_mmsi, v.name AS vessel_name, rv.name AS related_vessel_name,
         e.zone_id, z.name AS zone_name,
         ST_Y(e.geom::geometry) AS lat, ST_X(e.geom::geometry) AS lon,
         e.title, e.message, e.method_id, e.dedup_key, e.data, e.status,
         e.opened_at, e.last_seen_at, e.resolved_at, e.resolution,
         e.reviewed_by, e.reviewed_at, e.note, e.created_at
  FROM events e
  LEFT JOIN vessels v ON v.mmsi = e.mmsi AND v.deleted_at IS NULL
  LEFT JOIN vessels rv ON rv.mmsi = e.related_mmsi AND rv.deleted_at IS NULL
  LEFT JOIN zones z ON z.id = e.zone_id`;

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    time: rowDate(row.time),
    detector: row.detector,
    type: row.type,
    domain: row.domain,
    severity: row.severity,
    currentSeverity: row.current_severity,
    mmsi: row.mmsi,
    relatedMmsi: row.related_mmsi,
    vesselName: row.vessel_name,
    relatedVesselName: row.related_vessel_name,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
    lat: row.lat,
    lon: row.lon,
    title: row.title,
    message: row.message,
    methodId: row.method_id,
    dedupKey: row.dedup_key,
    data: row.data,
    status: row.status,
    openedAt: rowDate(row.opened_at),
    lastSeenAt: rowDate(row.last_seen_at),
    resolvedAt: rowDateOrNull(row.resolved_at),
    resolution: row.resolution,
    reviewedBy: row.reviewed_by,
    reviewedAt: rowDateOrNull(row.reviewed_at),
    note: row.note,
    createdAt: rowDate(row.created_at),
  };
}

/** The filters as SQL conditions on `events e` (tenancy first). */
export function eventConditions(filters: EventFilters): SQL[] {
  const conditions: SQL[] = [
    visibleEvents(filters.visibility, sql`e.mmsi`, sql`e.related_mmsi`),
    sql`e.time >= ${filters.from}`,
    sql`e.time <= ${filters.to}`,
  ];
  if (filters.types !== undefined && filters.types.length > 0)
    conditions.push(
      sql`e.type = ANY(${sql.param([...filters.types])}::text[])`,
    );
  if (filters.severity !== undefined)
    conditions.push(sql`e.severity = ${filters.severity}`);
  if (filters.status !== undefined)
    conditions.push(sql`e.status = ${filters.status}`);
  if (filters.mmsi !== undefined)
    conditions.push(
      sql`(e.mmsi = ${filters.mmsi} OR e.related_mmsi = ${filters.mmsi})`,
    );
  if (filters.bbox !== undefined)
    conditions.push(
      sql`ST_Intersects(e.geom::geometry, ${bboxEnvelope(filters.bbox)})`,
    );
  return conditions;
}

/** Read and review access to the `events` hypertable. */
@Injectable()
export class EventsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** A page of events, newest first; `limit` rows at most. */
  async list(
    filters: EventFilters,
    after: EventCursor | undefined,
    limit: number,
  ): Promise<EventRecord[]> {
    const conditions = eventConditions(filters);
    if (after !== undefined)
      conditions.push(
        sql`(e.time, e.id) < (${new Date(after.time)}::timestamptz, ${after.id}::uuid)`,
      );
    const { rows } = await this.db.execute<EventRow>(sql`
      ${SELECT_EVENTS}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY e.time DESC, e.id DESC
      LIMIT ${limit}`);
    return rows.map(toRecord);
  }

  /** One event visible to `visibility`. */
  async findById(
    id: string,
    visibility: EventVisibility,
  ): Promise<EventRecord | undefined> {
    const { rows } = await this.db.execute<EventRow>(sql`
      ${SELECT_EVENTS}
      WHERE e.id = ${id}
        AND ${visibleEvents(visibility, sql`e.mmsi`, sql`e.related_mmsi`)}
      LIMIT 1`);
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Stores a review verdict; `open` withdraws a verdict (`resolved` when the
   * detector already ended the occurrence). Returns `false` for an unknown event.
   */
  async review(id: string, review: EventReview): Promise<boolean> {
    const status =
      review.status === 'open'
        ? sql`CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END`
        : sql`${review.status}`;
    const { rowCount } = await this.db.execute(sql`
      UPDATE events SET
        status = ${status},
        note = ${review.note},
        reviewed_by = ${review.reviewedBy}::uuid,
        reviewed_at = ${review.reviewedAt},
        updated_at = now()
      WHERE id = ${id}`);
    return (rowCount ?? 0) > 0;
  }
}
