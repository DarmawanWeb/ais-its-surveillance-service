import type { AlertSeverity } from '@darmawanweb/ais-its-contracts/domain';

import type { TranshipmentPairStatus } from '../../db/schema.js';
import type { PriorityDistribution } from '../../domain/transhipment/analysis.js';
import type { PairObservation } from '../../domain/transhipment/pairs.js';

/** A candidate pair claimed by the analyser. */
export interface ClaimedPair {
  readonly mmsiA: number;
  readonly mmsiB: number;
  /** Time of this claim: only the claim it identifies can end it. */
  readonly claimedAt: Date;
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

/** Options of {@link TranshipmentPairStorage.accumulate}. */
export interface AccumulateOptions {
  /**
   * A pending pair last observed longer than this before an observation
   * starts over from that observation (priority, `queued_at`,
   * `first_seen_at`): brief encounters far apart never add up, ms
   * (`TRANSHIPMENT_ROUTE_WINDOW_MIN`).
   */
  readonly restartAfterMs: number;
}

/**
 * A positive analysis, stored in `transhipment_results` (legacy
 * `IllegalTranshipmentResult` with `isIllegal: true`: every positive
 * analysis is kept, not only the first of an occurrence).
 */
export interface TranshipmentResultRecord {
  readonly id: string;
  /** Event (alert id) of the occurrence the analysis belongs to. */
  readonly eventId: string;
  readonly mmsiA: number;
  readonly mmsiB: number;
  /** Wall-clock time of the analysis. */
  readonly detectedAt: Date;
  /** Window of the detection (legacy `startTimestamp` / `endTimestamp`). */
  readonly startAt: Date;
  readonly endAt: Date;
  /** Score, percent. */
  readonly accuracy: number;
  readonly averagePriority: number;
  readonly priorityDistribution: PriorityDistribution;
  readonly severity: AlertSeverity;
  /** Midpoint of the two vessels in the middle of the window. */
  readonly position: { readonly lat: number; readonly lon: number } | null;
  /** Accumulated candidate priority and observations at claim time. */
  readonly accumulatedPriority: number;
  readonly observations: number;
  readonly route1Points: number;
  readonly route2Points: number;
  readonly methodId: string;
}

/** How an analysis ended, stored as the pair's `last_result`. */
export type PairAnalysisOutcome =
  | {
      readonly outcome: 'analysed';
      readonly result: Readonly<Record<string, unknown>>;
      /** A positive analysis to store with the completion (one transaction). */
      readonly positive?: TranshipmentResultRecord;
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
   * `queued_at` = now); a pending or claimed pair accumulates `priority += P`,
   * except a pending pair not observed within `restartAfterMs`, which starts
   * over. An observation not newer than the last one of the same observing
   * vessel is ignored (redelivered positions count once).
   */
  abstract accumulate(
    observations: readonly PairObservation[],
    now: Date,
    options: AccumulateOptions,
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
   * cooldown, legacy `getLastDetection`) and store their `positive` result
   * in the same transaction. Returns `false` (and stores nothing) when the
   * claim is no longer this one (released as stale and claimed again).
   */
  abstract complete(
    pair: ClaimedPair,
    outcome: PairAnalysisOutcome,
    now: Date,
  ): Promise<boolean>;

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

  /**
   * Deletes the pairs not observed since `seenBefore` that are not being
   * analysed — pending ones below the threshold included; returns how many.
   */
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
