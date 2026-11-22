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
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';

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
            resolution: { reason: 'escalated', supersededBy: alert.id },
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

  /** A de-escalation or a suppressed re-raise (which may reopen the row). */
  async onUpdated(update: AlertUpdate): Promise<void> {
    await this.db
      .update(events)
      .set({
        currentSeverity: update.alert.severity,
        lastSeenAt: update.at,
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

  /** Ends the occurrence's row (no-op when it already ended). */
  async onResolved(resolution: AlertResolution): Promise<void> {
    await this.db
      .update(events)
      .set({
        status: sql`CASE WHEN ${events.status} = 'open' THEN 'resolved' ELSE ${events.status} END`,
        resolvedAt: resolution.resolvedAt,
        resolution: { ...resolution.data, reason: resolution.reason ?? null },
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(events.id, resolution.alert.alertId), isNull(events.resolvedAt)),
      );
  }

  /**
   * Occurrences the detectors have not ended (whatever their review status),
   * restored at startup so a restart neither re-raises them nor hands them
   * to another detector (also reloaded by the `AlertCoordinator` when this
   * instance takes over the position feed).
   */
  async loadOpen(): Promise<readonly OpenAlert[]> {
    const rows = await this.db
      .select(OPEN_ALERT_COLUMNS)
      .from(events)
      .where(isNull(events.resolvedAt));
    return rows.map(toOpenAlert);
  }

  /** The open occurrence of `dedupKey` (its newest alert), if any. */
  async openOccurrence(dedupKey: string): Promise<OpenAlert | undefined> {
    const [row] = await this.db
      .select(OPEN_ALERT_COLUMNS)
      .from(events)
      .where(and(eq(events.dedupKey, dedupKey), isNull(events.resolvedAt)))
      .orderBy(desc(events.createdAt))
      .limit(1);
    return row === undefined ? undefined : toOpenAlert(row);
  }
}

/** The columns of an open occurrence the SDK needs (never `data`, `title`, `message`). */
const OPEN_ALERT_COLUMNS = {
  id: events.id,
  dedupKey: events.dedupKey,
  type: events.type,
  mmsi: events.mmsi,
  relatedMmsi: events.relatedMmsi,
  zoneId: events.zoneId,
  currentSeverity: events.currentSeverity,
  severity: events.severity,
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
    detector: row.detector,
  };
}
