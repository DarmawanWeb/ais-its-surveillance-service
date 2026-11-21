import type {
  ZoneDeletedV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type Database,
  geoJsonToGeography,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { zones } = schema;

/** The `zones` projection of the `GEO` stream (zones are owned by the geo service). */
@Injectable()
export class ZonesRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Applies a snapshot when it is newer than the stored one (idempotent for
   * redeliveries; an older snapshot never overwrites a newer one or
   * resurrects a later deletion). Returns `true` when it was applied.
   */
  async upsert(zone: ZoneSnapshotV1): Promise<boolean> {
    const updatedAt = new Date(zone.updatedAt);
    const values = {
      id: zone.id,
      orgId: zone.orgId,
      code: zone.code,
      name: zone.name,
      kind: zone.kind,
      geom: geoJsonToGeography(zone.geometry),
      bufferM: zone.bufferM,
      active: zone.active,
      alertOnEnter: zone.alertOnEnter,
      properties: zone.properties,
      sourceUpdatedAt: updatedAt,
    };
    const applied = await this.db
      .insert(zones)
      .values(values)
      .onConflictDoUpdate({
        target: zones.id,
        set: { ...values, deletedAt: null, updatedAt: sql`now()` },
        setWhere: sql`${zones.sourceUpdatedAt} < ${updatedAt}
          AND (${zones.deletedAt} IS NULL OR ${zones.deletedAt} < ${updatedAt})`,
      })
      .returning({ id: zones.id });
    return applied.length > 0;
  }

  /** Marks a zone deleted (tombstone at the event time). */
  async markDeleted(deleted: ZoneDeletedV1, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(zones)
      .set({ deletedAt: at, updatedAt: sql`now()` })
      .where(
        and(
          eq(zones.id, deleted.id),
          isNull(zones.deletedAt),
          lte(zones.sourceUpdatedAt, at),
        ),
      )
      .returning({ id: zones.id });
    return rows.length > 0;
  }
}
