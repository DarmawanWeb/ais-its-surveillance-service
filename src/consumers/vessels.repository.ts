import type {
  VesselDeletedV1,
  VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { vessels } = schema;

/** Outcome of {@link VesselsRepository.upsert}. */
export type VesselUpsertOutcome = 'applied' | 'stale';

/**
 * The `vessels` projection of the `FLEET` stream: mmsi → vessel and owning
 * organization, the input of the tenancy rules (spec §8.5).
 */
@Injectable()
export class VesselsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Applies a snapshot when it is newer than the stored one. Another live
   * vessel holding the same MMSI (renumbered or replaced in fleet) gives it
   * up when its own snapshot is older; otherwise the incoming one is stale.
   */
  async upsert(vessel: VesselSnapshotV1): Promise<VesselUpsertOutcome> {
    const updatedAt = new Date(vessel.updatedAt);
    return this.db.transaction(async (tx) => {
      const holders = await tx
        .select({ id: vessels.id, sourceUpdatedAt: vessels.sourceUpdatedAt })
        .from(vessels)
        .where(
          and(
            eq(vessels.mmsi, vessel.mmsi),
            ne(vessels.id, vessel.id),
            isNull(vessels.deletedAt),
          ),
        )
        .for('update');
      if (holders.some((holder) => holder.sourceUpdatedAt >= updatedAt))
        return 'stale';
      if (holders.length > 0) {
        await tx
          .update(vessels)
          .set({ deletedAt: updatedAt, updatedAt: sql`now()` })
          .where(
            and(
              eq(vessels.mmsi, vessel.mmsi),
              ne(vessels.id, vessel.id),
              isNull(vessels.deletedAt),
            ),
          );
      }
      const values = {
        id: vessel.id,
        mmsi: vessel.mmsi,
        orgId: vessel.orgId,
        name: vessel.name,
        imo: vessel.imo,
        flag: vessel.flag,
        typeCode: vessel.type.code,
        status: vessel.status,
        sourceUpdatedAt: updatedAt,
      };
      const applied = await tx
        .insert(vessels)
        .values(values)
        .onConflictDoUpdate({
          target: vessels.id,
          set: { ...values, deletedAt: null, updatedAt: sql`now()` },
          setWhere: sql`${vessels.sourceUpdatedAt} < ${updatedAt}
            AND (${vessels.deletedAt} IS NULL OR ${vessels.deletedAt} < ${updatedAt})`,
        })
        .returning({ id: vessels.id });
      return applied.length > 0 ? 'applied' : 'stale';
    });
  }

  /** Marks a vessel deleted (tombstone at the event time). */
  async markDeleted(deleted: VesselDeletedV1, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(vessels)
      .set({ deletedAt: at, updatedAt: sql`now()` })
      .where(
        and(
          eq(vessels.id, deleted.id),
          isNull(vessels.deletedAt),
          lte(vessels.sourceUpdatedAt, at),
        ),
      )
      .returning({ id: vessels.id });
    return rows.length > 0;
  }
}
