import type { TranshipmentPairStatus } from '../../db/schema.js';
import type { PairObservation } from '../../domain/transhipment/pairs.js';

/** A candidate pair claimed by the analyser. */
export interface ClaimedPair {
  readonly mmsiA: number;
  readonly mmsiB: number;
  /** Accumulated priority at claim time. */
  readonly priority: number;
  readonly queuedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly observations: number;
  readonly lastDistanceM: number | null;
}

/** Options of {@link TranshipmentPairStorage.claim}. */
export interface ClaimOptions {
  /** Wall-clock time of the claim. */
  readonly now: Date;
  /** Only pairs whose accumulated priority reaches this. */
  readonly minPriority: number;
  /** Pairs analysed less than this long before `now` are skipped (kept pending), ms. */
  readonly reanalysisCooldownMs: number;
  readonly limit: number;
}

/** How an analysis ended, stored as the pair's `last_result`. */
export type PairAnalysisOutcome =
  | {
      readonly outcome: 'analysed';
      readonly result: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: 'insufficient_data';
      readonly result: Readonly<Record<string, unknown>>;
    };

/**
 * The `transhipment_pairs` queue (replaces the legacy Mongo
 * `IllegalTranshipmentQueue`): accumulation by the detector, claims with
 * `FOR UPDATE SKIP LOCKED` by the scheduled analyser.
 */
export abstract class TranshipmentPairStorage {
  /**
   * Adds each observation's priority to its pair: a new or finished pair
   * (completed / failed) is queued again (`pending`, priority = P,
   * `queued_at` = now); a pending or claimed pair accumulates `priority += P`.
   */
  abstract accumulate(
    observations: readonly PairObservation[],
    now: Date,
  ): Promise<void>;

  /**
   * Claims up to `limit` pending pairs, priority DESC then `queued_at` ASC
   * (legacy `getAllSorted`), skipping pairs analysed within the cooldown;
   * claimed pairs are `in_progress`.
   */
  abstract claim(options: ClaimOptions): Promise<ClaimedPair[]>;

  /**
   * Ends a claim: the claimed priority is consumed (the legacy queue entry
   * was deleted after the analysis), what accumulated meanwhile stays
   * queued; `analysed` outcomes also set `last_analysed_at` (re-analysis
   * cooldown, legacy `getLastDetection`).
   */
  abstract complete(
    pair: ClaimedPair,
    outcome: PairAnalysisOutcome,
    now: Date,
  ): Promise<void>;

  /** Marks a claimed pair `failed` (re-queued by its next observation). */
  abstract fail(pair: ClaimedPair, error: string, now: Date): Promise<void>;

  /** Returns claimed pairs to `pending` (claims abandoned on shutdown or timeout). */
  abstract release(pairs: readonly ClaimedPair[]): Promise<void>;

  /** Releases claims older than `claimedBefore` (crashed analysers); returns how many. */
  abstract recoverStale(claimedBefore: Date): Promise<number>;

  /** Event time of the latest observation of each pair (missing pairs are absent). */
  abstract lastSeen(
    pairs: readonly (readonly [number, number])[],
  ): Promise<ReadonlyMap<string, Date>>;

  /** Deletes finished pairs not observed since `seenBefore`; returns how many. */
  abstract prune(seenBefore: Date): Promise<number>;

  /** Number of pairs per queue status (statuses without pairs are absent). */
  abstract countByStatus(): Promise<
    Readonly<Partial<Record<TranshipmentPairStatus, number>>>
  >;
}

/** Map key of a pair in {@link TranshipmentPairStorage.lastSeen} results. */
export function pairMapKey(mmsiA: number, mmsiB: number): string {
  return `${mmsiA}:${mmsiB}`;
}
