// Drizzle definitions of the "surveillance" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import type { SurveillanceEventStatus } from '@darmawanweb/ais-its-contracts/domain';
import type {
  AisSource,
  AlertDomain,
  AlertSeverity,
  AlertType,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { geography } from '@darmawanweb/ais-its-nest/db';
import { sql } from 'drizzle-orm';
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `surveillance_svc`. */
export const serviceSchema = pg.pgSchema('surveillance');

const timestamps = {
  createdAt: pg
    .timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: pg
    .timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** Projection of the `GEO` stream (`surveillance-zones`). */
export const zones = serviceSchema.table(
  'zones',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id'),
    code: pg.text('code').notNull(),
    name: pg.text('name').notNull(),
    kind: pg.text('kind').$type<ZoneKind>().notNull(),
    geom: geography('geom').notNull(),
    bufferM: pg.doublePrecision('buffer_m').notNull().default(0),
    active: pg.boolean('active').notNull(),
    alertOnEnter: pg.boolean('alert_on_enter').notNull(),
    properties: pg
      .jsonb('properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sourceUpdatedAt: pg
      .timestamp('source_updated_at', { withTimezone: true })
      .notNull(),
    deletedAt: pg.timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    pg.index('zones_geom_idx').using('gist', table.geom),
    pg
      .index('zones_kind_idx')
      .on(table.kind)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** Projection of the `FLEET` stream (`surveillance-fleet`): mmsi → vessel, organization. */
export const vessels = serviceSchema.table(
  'vessels',
  {
    id: pg.uuid('id').primaryKey(),
    mmsi: pg.integer('mmsi').notNull(),
    orgId: pg.uuid('org_id'),
    name: pg.text('name').notNull(),
    imo: pg.text('imo'),
    flag: pg.text('flag'),
    typeCode: pg.text('type_code'),
    status: pg
      .text('status')
      .$type<'active' | 'inactive' | 'laid_up'>()
      .notNull(),
    sourceUpdatedAt: pg
      .timestamp('source_updated_at', { withTimezone: true })
      .notNull(),
    deletedAt: pg.timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    pg
      .uniqueIndex('vessels_mmsi_key')
      .on(table.mmsi)
      .where(sql`deleted_at IS NULL`),
    pg
      .index('vessels_org_idx')
      .on(table.orgId, table.mmsi)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** Last alert of one type for a vessel (`vessel_state.last_alerts`). */
export interface LastAlert {
  readonly alertId: string;
  readonly dedupKey: string;
  readonly severity: AlertSeverity;
  readonly at: string;
}

/** Latest kinematic state per vessel. */
export const vesselState = serviceSchema.table(
  'vessel_state',
  {
    mmsi: pg.integer('mmsi').primaryKey(),
    time: pg.timestamp('time', { withTimezone: true }).notNull(),
    source: pg.text('source').$type<AisSource>().notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    predNavstatus: pg.smallint('pred_navstatus').notNull(),
    inZoneIds: pg
      .uuid('in_zone_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    anomalyStreak: pg.integer('anomaly_streak').notNull().default(0),
    lastAlerts: pg
      .jsonb('last_alerts')
      .$type<Record<string, LastAlert>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (table) => [
    pg.index('vessel_state_geom_idx').using('gist', table.geom),
    pg.index('vessel_state_time_idx').on(table.time),
    pg
      .index('vessel_state_anomaly_idx')
      .on(table.mmsi)
      .where(sql`anomaly_streak > 0`),
  ],
);

/** Track history of the vessels relevant to pair/pattern detectors (hypertable, 7 days). */
export const trackPoints = serviceSchema.table(
  'track_points',
  {
    time: pg.timestamp('time', { withTimezone: true }).notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    source: pg.text('source').$type<AisSource>().notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
  },
  (table) => [pg.primaryKey({ columns: [table.mmsi, table.time] })],
);

/** Queue status of a candidate pair (legacy `IllegalTranshipmentQueue.status`). */
export type TranshipmentPairStatus =
  'pending' | 'in_progress' | 'completed' | 'failed';

/** Transhipment candidate pairs with accumulated priority (replaces the legacy Mongo queue). */
export const transhipmentPairs = serviceSchema.table(
  'transhipment_pairs',
  {
    mmsiA: pg.integer('mmsi_a').notNull(),
    mmsiB: pg.integer('mmsi_b').notNull(),
    priority: pg.doublePrecision('priority').notNull().default(0),
    status: pg.text('status').$type<TranshipmentPairStatus>().notNull(),
    queuedAt: pg.timestamp('queued_at', { withTimezone: true }).notNull(),
    firstSeenAt: pg
      .timestamp('first_seen_at', { withTimezone: true })
      .notNull(),
    lastSeenAt: pg.timestamp('last_seen_at', { withTimezone: true }).notNull(),
    lastDistanceM: pg.doublePrecision('last_distance_m'),
    observations: pg.integer('observations').notNull().default(0),
    claimedAt: pg.timestamp('claimed_at', { withTimezone: true }),
    claimedPriority: pg.doublePrecision('claimed_priority'),
    lastAnalysedAt: pg.timestamp('last_analysed_at', { withTimezone: true }),
    analyses: pg.integer('analyses').notNull().default(0),
    lastResult: pg.jsonb('last_result').$type<Record<string, unknown>>(),
    lastError: pg.text('last_error'),
    ...timestamps,
  },
  (table) => [
    pg.primaryKey({ columns: [table.mmsiA, table.mmsiB] }),
    pg
      .index('transhipment_pairs_queue_idx')
      .on(table.priority.desc(), table.queuedAt)
      .where(sql`status = 'pending'`),
    pg
      .index('transhipment_pairs_claimed_idx')
      .on(table.claimedAt)
      .where(sql`status = 'in_progress'`),
    pg.index('transhipment_pairs_seen_idx').on(table.lastSeenAt),
  ],
);

/**
 * Detector events (hypertable on `time`, hence the composite primary key):
 * one row per published alert, written by the AlertPersistence hook before
 * the alert is published.
 */
export const events = serviceSchema.table(
  'events',
  {
    id: pg.uuid('id').notNull(),
    time: pg.timestamp('time', { withTimezone: true }).notNull(),
    detector: pg.text('detector').notNull(),
    type: pg.text('type').$type<AlertType>().notNull(),
    domain: pg.text('domain').$type<AlertDomain>().notNull(),
    /** Severity of this published alert. */
    severity: pg.text('severity').$type<AlertSeverity>().notNull(),
    /** Current severity of the occurrence (lower after a de-escalation). */
    currentSeverity: pg
      .text('current_severity')
      .$type<AlertSeverity>()
      .notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    relatedMmsi: pg.integer('related_mmsi'),
    zoneId: pg.uuid('zone_id'),
    geom: geography('geom', { subtype: 'Point' }),
    title: pg.text('title').notNull(),
    message: pg.text('message').notNull(),
    methodId: pg.text('method_id').notNull(),
    dedupKey: pg.text('dedup_key').notNull(),
    data: pg.jsonb('data').$type<Record<string, unknown>>().notNull(),
    status: pg.text('status').$type<SurveillanceEventStatus>().notNull(),
    openedAt: pg.timestamp('opened_at', { withTimezone: true }).notNull(),
    lastSeenAt: pg.timestamp('last_seen_at', { withTimezone: true }).notNull(),
    resolvedAt: pg.timestamp('resolved_at', { withTimezone: true }),
    resolution: pg.jsonb('resolution').$type<Record<string, unknown>>(),
    reviewedBy: pg.uuid('reviewed_by'),
    reviewedAt: pg.timestamp('reviewed_at', { withTimezone: true }),
    note: pg.text('note'),
    ...timestamps,
  },
  (table) => [
    pg.primaryKey({ columns: [table.id, table.time] }),
    pg
      .index('events_active_idx')
      .on(table.dedupKey)
      .where(sql`resolved_at IS NULL`),
    pg.index('events_time_id_idx').on(table.time.desc(), table.id.desc()),
    pg.index('events_mmsi_time_idx').on(table.mmsi, table.time.desc()),
    pg
      .index('events_related_mmsi_time_idx')
      .on(table.relatedMmsi, table.time.desc())
      .where(sql`related_mmsi IS NOT NULL`),
    pg.index('events_type_time_idx').on(table.type, table.time.desc()),
  ],
);

/** Historical illegal-fishing records (`pnpm seed`). */
export const fishingViolations = serviceSchema.table(
  'fishing_violations',
  {
    id: pg.uuid('id').primaryKey(),
    dataset: pg.text('dataset').notNull(),
    recordNo: pg.integer('record_no').notNull(),
    vesselName: pg.text('vessel_name').notNull(),
    flagCountry: pg.text('flag_country').notNull(),
    year: pg.integer('year').notNull(),
    violation: pg.text('violation').notNull(),
    action: pg.text('action').notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    source: pg.text('source').notNull(),
    sourceNote: pg.text('source_note').notNull(),
    methodId: pg.text('method_id').notNull(),
    ...timestamps,
  },
  (table) => [
    pg.unique().on(table.dataset, table.recordNo),
    pg.index('fishing_violations_year_idx').on(table.year),
  ],
);
