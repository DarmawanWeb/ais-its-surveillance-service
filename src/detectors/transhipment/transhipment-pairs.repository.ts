import {
  type Database,
  InjectDb,
  pointGeography,
  rowDate,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { TranshipmentPairStatus } from '../../db/schema.js';
import type { PairObservation } from '../../domain/transhipment/pairs.js';
import {
  type AccumulateOptions,
  type ClaimedPair,
  type ClaimOptions,
  type PairAnalysisOutcome,
  pairMapKey,
  TranshipmentPairStorage,
} from './transhipment-pairs.storage.js';

interface ClaimedRow extends Record<string, unknown> {
  mmsi_a: number;
  mmsi_b: number;
  claimed_at: Date | string;
  priority: number;
  queued_at: Date | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  observations: number;
  last_distance_m: number | null;
}

/** The row of a pair while `claim` holds it (a stale claim released and claimed again is another). */
function thisClaim(pair: ClaimedPair) {
  return sql`mmsi_a = ${pair.mmsiA} AND mmsi_b = ${pair.mmsiB} AND status = 'in_progress'
    AND claimed_at = ${pair.claimedAt}::timestamptz`;
}

/** Sums the observations of the same pair and observer (one upsert row each). */
function groupByPair(
  observations: readonly PairObservation[],
): PairObservation[] {
  const byPair = new Map<string, PairObservation>();
  for (const observation of observations) {
    const key = `${pairMapKey(observation.mmsiA, observation.mmsiB)}:${observation.observer}`;
    const known = byPair.get(key);
    byPair.set(
      key,
      known === undefined
        ? observation
        : {
            ...observation,
            priority: known.priority + observation.priority,
            seenAt:
              observation.seenAt > known.seenAt
                ? observation.seenAt
                : known.seenAt,
          },
    );
  }
  return [...byPair.values()];
}

/**
 * PostgreSQL implementation of the candidate queue: one upsert per position
 * for the accumulation and `FOR UPDATE SKIP LOCKED` claims, so two analysers
 * never hold the same pair (only the active instance analyses; a former
 * active instance cut off from NATS may overlap briefly, and the
 * `AlertKeyLock` — `PostgresAlertKeyLock`: an advisory lock per key and the
 * alignment of the key with `events` — keeps its alert operations
 * consistent).
 *
 * @method transhipment.candidate_queue
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.candidate_queue
 * @see be-legacy/src/repositories/illegal-transhipment/it-queue.repository.ts
 */
@Injectable()
export class TranshipmentPairsRepository extends TranshipmentPairStorage {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {
    super();
  }

  async accumulate(
    observations: readonly PairObservation[],
    now: Date,
    options: AccumulateOptions,
  ): Promise<void> {
    const rows = groupByPair(observations);
    if (rows.length === 0) return;
    const restartAfter = `${Math.max(0, Math.round(options.restartAfterMs))} milliseconds`;
    // A new accumulation: a finished pair, or a pending one not observed within the window.
    const fresh = sql`(p.status IN ('completed', 'failed')
      OR (p.status = 'pending' AND p.last_seen_at < EXCLUDED.last_seen_at - ${restartAfter}::interval))`;
    // The WHERE skips an observation not newer than the last one of the same
    // observing vessel (a position redelivered after a restart).
    await this.db.execute(sql`
      INSERT INTO transhipment_pairs AS p
        (mmsi_a, mmsi_b, priority, status, queued_at, first_seen_at, last_seen_at,
         last_seen_by_a_at, last_seen_by_b_at, last_distance_m, observations)
      SELECT u.mmsi_a, u.mmsi_b, u.priority, 'pending', ${now}::timestamptz, u.seen_at, u.seen_at,
             CASE WHEN u.observer = u.mmsi_a THEN u.seen_at END,
             CASE WHEN u.observer = u.mmsi_b THEN u.seen_at END,
             u.distance_m, 1
      FROM unnest(
        ${sql.param(rows.map((row) => row.mmsiA))}::integer[],
        ${sql.param(rows.map((row) => row.mmsiB))}::integer[],
        ${sql.param(rows.map((row) => row.observer))}::integer[],
        ${sql.param(rows.map((row) => row.priority))}::double precision[],
        ${sql.param(rows.map((row) => row.seenAt.toISOString()))}::timestamptz[],
        ${sql.param(rows.map((row) => (Number.isFinite(row.distanceM) ? row.distanceM : null)))}::double precision[]
      ) AS u(mmsi_a, mmsi_b, observer, priority, seen_at, distance_m)
      ON CONFLICT (mmsi_a, mmsi_b) DO UPDATE SET
        priority = CASE WHEN ${fresh} THEN EXCLUDED.priority ELSE p.priority + EXCLUDED.priority END,
        queued_at = CASE WHEN ${fresh} THEN EXCLUDED.queued_at ELSE p.queued_at END,
        first_seen_at = CASE WHEN ${fresh} THEN EXCLUDED.first_seen_at
                             ELSE LEAST(p.first_seen_at, EXCLUDED.first_seen_at) END,
        observations = CASE WHEN ${fresh} THEN 1 ELSE p.observations + 1 END,
        status = CASE WHEN p.status IN ('completed', 'failed') THEN 'pending' ELSE p.status END,
        last_seen_at = GREATEST(p.last_seen_at, EXCLUDED.last_seen_at),
        last_seen_by_a_at = GREATEST(p.last_seen_by_a_at, EXCLUDED.last_seen_by_a_at),
        last_seen_by_b_at = GREATEST(p.last_seen_by_b_at, EXCLUDED.last_seen_by_b_at),
        last_distance_m = COALESCE(EXCLUDED.last_distance_m, p.last_distance_m),
        updated_at = now()
      WHERE (EXCLUDED.last_seen_by_a_at IS NULL OR p.last_seen_by_a_at IS NULL
             OR EXCLUDED.last_seen_by_a_at > p.last_seen_by_a_at)
        AND (EXCLUDED.last_seen_by_b_at IS NULL OR p.last_seen_by_b_at IS NULL
             OR EXCLUDED.last_seen_by_b_at > p.last_seen_by_b_at)`);
  }

  async claim(options: ClaimOptions): Promise<ClaimedPair[]> {
    const analysedBefore = new Date(
      options.now.getTime() - options.reanalysisCooldownMs,
    );
    const { rows } = await this.db.execute<ClaimedRow>(sql`
      WITH next AS (
        SELECT mmsi_a, mmsi_b FROM transhipment_pairs
        WHERE status = 'pending'
          AND priority >= ${options.minPriority}
          AND (last_analysed_at IS NULL OR last_analysed_at <= ${analysedBefore})
        ORDER BY priority DESC, queued_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE transhipment_pairs AS p
      SET status = 'in_progress', claimed_at = ${options.now},
          claimed_priority = p.priority, updated_at = now()
      FROM next
      WHERE p.mmsi_a = next.mmsi_a AND p.mmsi_b = next.mmsi_b
      RETURNING p.mmsi_a, p.mmsi_b, p.claimed_at, p.priority, p.queued_at, p.first_seen_at,
                p.last_seen_at, p.observations, p.last_distance_m`);
    return rows
      .map((row) => ({
        mmsiA: row.mmsi_a,
        mmsiB: row.mmsi_b,
        claimedAt: rowDate(row.claimed_at),
        priority: row.priority,
        queuedAt: rowDate(row.queued_at),
        firstSeenAt: rowDate(row.first_seen_at),
        lastSeenAt: rowDate(row.last_seen_at),
        observations: row.observations,
        lastDistanceM: row.last_distance_m,
      }))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.queuedAt.getTime() - b.queuedAt.getTime(),
      );
  }

  async complete(
    pair: ClaimedPair,
    outcome: PairAnalysisOutcome,
    now: Date,
  ): Promise<boolean> {
    const analysed = outcome.outcome === 'analysed';
    const positive = analysed ? outcome.positive : undefined;
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`
        UPDATE transhipment_pairs SET
          priority = GREATEST(priority - COALESCE(claimed_priority, 0), 0),
          status = CASE WHEN priority - COALESCE(claimed_priority, 0) > 0
                        THEN 'pending' ELSE 'completed' END,
          queued_at = CASE WHEN priority - COALESCE(claimed_priority, 0) > 0
                           THEN ${now} ELSE queued_at END,
          last_analysed_at = CASE WHEN ${analysed}::boolean THEN ${now}::timestamptz ELSE last_analysed_at END,
          analyses = analyses + CASE WHEN ${analysed}::boolean THEN 1 ELSE 0 END,
          last_result = ${JSON.stringify({ outcome: outcome.outcome, ...outcome.result })}::jsonb,
          last_error = NULL,
          claimed_at = NULL,
          claimed_priority = NULL,
          updated_at = now()
        WHERE ${thisClaim(pair)}
        RETURNING mmsi_a`);
      if (rows.length === 0) return false;
      if (positive !== undefined) {
        await tx.insert(schema.transhipmentResults).values({
          id: positive.id,
          startAt: positive.startAt,
          endAt: positive.endAt,
          detectedAt: positive.detectedAt,
          mmsiA: positive.mmsiA,
          mmsiB: positive.mmsiB,
          eventId: positive.eventId,
          accuracy: positive.accuracy,
          averagePriority: positive.averagePriority,
          priorityDistribution: { ...positive.priorityDistribution },
          severity: positive.severity,
          geom:
            positive.position === null
              ? null
              : pointGeography(positive.position.lon, positive.position.lat),
          accumulatedPriority: positive.accumulatedPriority,
          observations: positive.observations,
          route1Points: positive.route1Points,
          route2Points: positive.route2Points,
          methodId: positive.methodId,
        });
      }
      return true;
    });
  }

  async fail(pair: ClaimedPair, error: string, now: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE transhipment_pairs SET
        status = 'failed', last_error = ${error.slice(0, 2_000)},
        last_analysed_at = ${now}, claimed_at = NULL, claimed_priority = NULL,
        updated_at = now()
      WHERE ${thisClaim(pair)}`);
  }

  async release(pairs: readonly ClaimedPair[]): Promise<void> {
    if (pairs.length === 0) return;
    await this.db.execute(sql`
      UPDATE transhipment_pairs AS p SET
        status = 'pending', claimed_at = NULL, claimed_priority = NULL, updated_at = now()
      FROM unnest(
        ${sql.param(pairs.map((pair) => pair.mmsiA))}::integer[],
        ${sql.param(pairs.map((pair) => pair.mmsiB))}::integer[],
        ${sql.param(pairs.map((pair) => pair.claimedAt.toISOString()))}::timestamptz[]
      ) AS u(mmsi_a, mmsi_b, claimed_at)
      WHERE p.mmsi_a = u.mmsi_a AND p.mmsi_b = u.mmsi_b AND p.status = 'in_progress'
        AND p.claimed_at = u.claimed_at`);
  }

  async recoverStale(claimedBefore: Date): Promise<number> {
    const { rowCount } = await this.db.execute(sql`
      UPDATE transhipment_pairs SET
        status = 'pending', claimed_at = NULL, claimed_priority = NULL, updated_at = now()
      WHERE status = 'in_progress' AND claimed_at < ${claimedBefore}`);
    return rowCount ?? 0;
  }

  async lastSeen(
    pairs: readonly (readonly [number, number])[],
  ): Promise<ReadonlyMap<string, Date>> {
    if (pairs.length === 0) return new Map();
    const { rows } = await this.db.execute<{
      mmsi_a: number;
      mmsi_b: number;
      last_seen_at: Date | string;
    }>(sql`
      SELECT p.mmsi_a, p.mmsi_b, p.last_seen_at
      FROM transhipment_pairs AS p
      JOIN unnest(
        ${sql.param(pairs.map(([a]) => a))}::integer[],
        ${sql.param(pairs.map(([, b]) => b))}::integer[]
      ) AS u(mmsi_a, mmsi_b) ON p.mmsi_a = u.mmsi_a AND p.mmsi_b = u.mmsi_b`);
    return new Map(
      rows.map((row) => [
        pairMapKey(row.mmsi_a, row.mmsi_b),
        rowDate(row.last_seen_at),
      ]),
    );
  }

  async prune(seenBefore: Date): Promise<number> {
    const { rowCount } = await this.db.execute(sql`
      DELETE FROM transhipment_pairs
      WHERE status <> 'in_progress' AND last_seen_at < ${seenBefore}`);
    return rowCount ?? 0;
  }

  async countByStatus(): Promise<
    Readonly<Partial<Record<TranshipmentPairStatus, number>>>
  > {
    const { rows } = await this.db.execute<{
      status: TranshipmentPairStatus;
      count: number;
    }>(
      sql`SELECT status, count(*)::integer AS count FROM transhipment_pairs GROUP BY status`,
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}
