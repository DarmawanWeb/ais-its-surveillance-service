import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import type {
  AlertPersistence,
  AlertResolution,
  AlertUpdate,
  OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import {
  type Database,
  InjectDb,
  pointGeography,
  rowDateOrNull,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { RESOLUTION_REASONS, resolutionCodeOf } from '../domain/messages.js';

const { events } = schema;

/**
 * Detector that raises each alert type of this service. Every surveillance
 * detector raises exactly one type named like itself; a future type falls
 * back to its own name.
 */
export const DETECTOR_OF_ALERT_TYPE: Readonly<Record<string, string>> = {
  transhipment: 'transhipment',
  anomaly: 'anomaly',
  dark: 'dark',
  geofence: 'geofence',
  fishing: 'fishing',
};

/** The detector owning an alert type. */
export function detectorOf(type: string): string {
  return DETECTOR_OF_ALERT_TYPE[type] ?? type;
}

/**
 * The `events` table as the Detector SDK's persistence hook (spec §18). The
 * emitter calls it BEFORE publishing, so every published alert has a row;
 * each method is idempotent because deliveries and restarts repeat calls.
 * The detector lifecycle (`resolved_at`) is kept apart from the review
 * lifecycle (`status`): a resolution marks an `open` row `resolved` but keeps
 * a reviewer's `confirmed` / `dismissed` verdict.
 */
@Injectable()
export class DetectorEventsRepository implements AlertPersistence {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts the alert; an escalation also ends the alert it supersedes. */
  async onRaised(
    alert: AlertRaisedV1,
    outcome: 'raised' | 'escalated',
  ): Promise<void> {
    const occurredAt = new Date(alert.occurredAt);
    await this.db.transaction(async (tx) => {
      let openedAt = occurredAt;
      if (outcome === 'escalated') {
        const superseded = await tx
          .update(events)
          .set({
            status: sql`CASE WHEN ${events.status} = 'open' THEN 'resolved' ELSE ${events.status} END`,
            resolvedAt: occurredAt,
            resolution: {
              code: 'escalated',
              reason: RESOLUTION_REASONS.escalated,
              supersededBy: alert.id,
            },
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(events.dedupKey, alert.dedupKey),
              isNull(events.resolvedAt),
              ne(events.id, alert.id),
            ),
          )
          .returning({ openedAt: events.openedAt });
        for (const row of superseded) {
          if (row.openedAt < openedAt) openedAt = row.openedAt;
        }
      }
      await tx
        .insert(events)
        .values({
          id: alert.id,
          time: occurredAt,
          detector: detectorOf(alert.type),
          type: alert.type,
          domain: alert.domain,
          severity: alert.severity,
          currentSeverity: alert.severity,
          mmsi: alert.mmsi,
          relatedMmsi: alert.relatedMmsi,
          zoneId: alert.zoneId,
          geom:
            alert.lat === null || alert.lon === null
              ? null
              : pointGeography(alert.lon, alert.lat),
          title: alert.title,
          message: alert.message,
          methodId: alert.methodId,
          dedupKey: alert.dedupKey,
          data: alert.data,
          status: 'open',
          openedAt,
          lastSeenAt: occurredAt,
        })
        .onConflictDoNothing();
      const lastAlert = JSON.stringify({
        alertId: alert.id,
        dedupKey: alert.dedupKey,
        severity: alert.severity,
        at: alert.occurredAt,
      });
      const vessels = [alert.mmsi, alert.relatedMmsi].filter(
        (mmsi): mmsi is number => mmsi !== null,
      );
      await tx.execute(sql`
        UPDATE vessel_state
        SET last_alerts = last_alerts || jsonb_build_object(${alert.type}::text, ${lastAlert}::jsonb),
            updated_at = now()
        WHERE mmsi = ANY(${sql.param(vessels)}::integer[])`);
    });
  }

  /**
   * A de-escalation or a suppressed re-raise (which may reopen the row).
   * `last_seen_at` stores event time (the signal's `occurredAt`), never the
   * clock of the instance that processed it, and never moves backwards.
   */
  async onUpdated(update: AlertUpdate): Promise<void> {
    const seenAt = update.occurredAt ?? update.at;
    await this.db
      .update(events)
      .set({
        currentSeverity: update.alert.severity,
        lastSeenAt: sql`greatest(${events.lastSeenAt}, ${seenAt})`,
        updatedAt: sql`now()`,
        ...(update.reopened
          ? {
              status: sql`CASE WHEN ${events.status} = 'resolved' THEN 'open' ELSE ${events.status} END`,
              resolvedAt: null,
              resolution: null,
            }
          : {}),
      })
      .where(eq(events.id, update.alert.alertId));
  }

  /**
   * An unchanged signal of the open occurrence (the runner throttles it to
   * once per `alertRepeatedIntervalMs`, 60 s of event time): moves
   * `last_seen_at` forward to the signal's event time, never backwards
   * (redeliveries arrive late).
   */
  async onRepeated(alert: OpenAlert, occurredAt: Date): Promise<void> {
    await this.db
      .update(events)
      .set({ lastSeenAt: sql`greatest(${events.lastSeenAt}, ${occurredAt})` })
      .where(and(eq(events.id, alert.alertId), isNull(events.resolvedAt)));
  }

  /**
   * Ends the occurrence's row (no-op when it already ended). The stored
   * resolution is the detector's data with the English `reason` and the
   * stable `code` (from the data, else derived from the reason). When the
   * row was open, the other open rows of its `dedupKey` end with it
   * (`resolution.duplicateOf`): duplicates a second writer opened (see
   * `AlertKeyLock`) never stay open. A resolution of a row that already
   * ended (a stale instance repeating it) touches nothing, so it never ends
   * the occurrence the active instance opened since.
   */
  async onResolved(resolution: AlertResolution): Promise<void> {
    const reason = resolution.reason ?? null;
    const stored = {
      ...resolution.data,
      reason,
      code: resolutionCodeOf({ ...resolution.data, reason }),
    };
    const { alertId, dedupKey } = resolution.alert;
    const end = (data: Record<string, unknown>) => ({
      status: sql`CASE WHEN ${events.status} = 'open' THEN 'resolved' ELSE ${events.status} END`,
      resolvedAt: resolution.resolvedAt,
      resolution: data,
      updatedAt: sql`now()`,
    });
    await this.db.transaction(async (tx) => {
      const ended = await tx
        .update(events)
        .set(end(stored))
        .where(and(eq(events.id, alertId), isNull(events.resolvedAt)))
        .returning({ id: events.id });
      if (ended.length === 0) return;
      await tx
        .update(events)
        .set(end({ ...stored, duplicateOf: alertId }))
        .where(and(eq(events.dedupKey, dedupKey), isNull(events.resolvedAt)));
    });
  }

  /**
   * Occurrences the detectors have not ended (whatever their review status):
   * restored at startup and reloaded by the runner on every activation
   * (failover), so neither a restart nor a takeover re-raises them or hands
   * them to another detector. Oldest first: of duplicate open rows of one
   * key the newest wins (the SDK keeps the last one of a key).
   */
  async loadOpen(): Promise<readonly OpenAlert[]> {
    const rows = await this.db
      .select(OPEN_ALERT_COLUMNS)
      .from(events)
      .where(isNull(events.resolvedAt))
      .orderBy(asc(events.createdAt), asc(events.id));
    return rows.map(toOpenAlert);
  }
}

/**
 * The open occurrence of `dedupKey` (its newest alert), if any: the
 * cross-replica alignment of the `PostgresAlertKeyLock` (tick operations and
 * position-driven raises that would publish).
 */
export async function findOpenOccurrence(
  db: Database<typeof schema>,
  dedupKey: string,
): Promise<OpenAlert | undefined> {
  const [row] = await db
    .select(OPEN_ALERT_COLUMNS)
    .from(events)
    .where(and(eq(events.dedupKey, dedupKey), isNull(events.resolvedAt)))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return row === undefined ? undefined : toOpenAlert(row);
}

/**
 * When the latest occurrence of `dedupKey`, an alert of vessel `mmsi`, ended
 * (its event time, `resolved_at`), `null` when none ended: the staleness
 * check of position-driven raises (`AlertKeyLock.raiseFromPosition`). The
 * vessel's `(mmsi, time)` index bounds the scan.
 */
export async function findLastEndedAt(
  db: Database<typeof schema>,
  dedupKey: string,
  mmsi: number,
): Promise<Date | null> {
  const [row] = await db
    .select({ endedAt: sql<Date | string | null>`max(${events.resolvedAt})` })
    .from(events)
    .where(and(eq(events.mmsi, mmsi), eq(events.dedupKey, dedupKey)));
  return rowDateOrNull(row?.endedAt ?? null);
}

/** The columns of an open occurrence the SDK needs (never `data`, `title`, `message`). */
const OPEN_ALERT_COLUMNS = {
  id: events.id,
  dedupKey: events.dedupKey,
  type: events.type,
  domain: events.domain,
  mmsi: events.mmsi,
  relatedMmsi: events.relatedMmsi,
  zoneId: events.zoneId,
  currentSeverity: events.currentSeverity,
  severity: events.severity,
  methodId: events.methodId,
  openedAt: events.openedAt,
  createdAt: events.createdAt,
  lastSeenAt: events.lastSeenAt,
  detector: events.detector,
};

/** A row selected with {@link OPEN_ALERT_COLUMNS}. */
type OpenAlertRow = Pick<
  typeof events.$inferSelect,
  keyof typeof OPEN_ALERT_COLUMNS
>;

/** The SDK view of an `events` row that is still open. */
function toOpenAlert(row: OpenAlertRow): OpenAlert {
  return {
    alertId: row.id,
    dedupKey: row.dedupKey,
    type: row.type,
    mmsi: row.mmsi,
    relatedMmsi: row.relatedMmsi,
    zoneId: row.zoneId,
    severity: row.currentSeverity,
    publishedSeverity: row.severity,
    openedAt: row.openedAt,
    // The row is written right before the alert is published.
    publishedAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    // Event times of the occurrence: both columns store signal times.
    firstOccurredAt: row.openedAt,
    lastOccurredAt: row.lastSeenAt,
    // Published with the occurrence's alert.resolved.v1.
    domain: row.domain,
    methodId: row.methodId,
    detector: row.detector,
  };
}
