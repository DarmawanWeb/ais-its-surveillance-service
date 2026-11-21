import type { AlertSeverity } from '@darmawanweb/ais-its-contracts/domain';

import {
  headingPriority,
  locationPriority,
  speedPriority,
} from './priority.js';
import { fixAtTime, sampleRoute, type TrackFix } from './track.js';

/** Share of positive checks per priority category, percent (rounded). */
export interface PriorityDistribution {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

/** Outcome of {@link detectTranshipment} (legacy `IllegalTranshipmentResult`). */
export type TranshipmentDetection =
  | { readonly isIllegal: false }
  | {
      readonly isIllegal: true;
      /** Start of the first window reaching the threshold. */
      readonly startTimestamp: Date;
      /** End of that window (start + check duration). */
      readonly endTimestamp: Date;
      /** "Accuracy" score of the window, 0–100, rounded to 2 decimals. */
      readonly accuracy: number;
      /** Mean product priority of the positive checks, rounded to 2 decimals. */
      readonly averagePriority: number;
      readonly priorityDistribution: PriorityDistribution;
    };

/** Parameters of the legacy detection; the defaults are the legacy constants. */
export interface TranshipmentDetectionOptions {
  /** Window length, ms (legacy `checkDuration`, 30 min). */
  readonly checkDurationMs?: number;
  /** Minimum score of an illegal window, percent (legacy `weightedThreshold`, 70). */
  readonly accuracyThreshold?: number;
}

/** Legacy constants of `detectIllegalTranshipment` (not configurable: parity). */
export const TRANSHIPMENT_ANALYSIS_CONSTANTS = Object.freeze({
  // SOURCE: thesis — needs citation (all values below, legacy-mvp-backend).
  /** Routes longer than this are resampled. */
  maxRouteLength: 30,
  /** Resampling interval, ms (3 min). */
  sampleIntervalMs: 3 * 60_000,
  /** Window step, ms (10 min). */
  windowStepMs: 10 * 60_000,
  /** Check interval inside a window, ms (5 min). */
  checkIntervalMs: 5 * 60_000,
  /** Default window length, ms (30 min). */
  checkDurationMs: 30 * 60_000,
  /** Default threshold of the score, percent. */
  accuracyThreshold: 70,
  /** Weight of a check with the maximum product priority 27. */
  maxWeight: 10,
});

/**
 * Weight of a product priority, maximum 10:
 * `w(P) = {27→10, 18→8, 12→6, 9→5, 8→4, 6→3, 4→2, 3→1.5, 2→1, 1→0.5}`, else 0.
 *
 * @method transhipment.weighted_score
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.weighted_score
 * @see be-legacy/src/utils/illegal-transhipment.ts `calculateWeightedScore` (reference legacy-mvp-backend)
 */
export function weightedScore(priority: number): number {
  // SOURCE: thesis — needs citation (non-linear priority → weight mapping).
  if (priority === 27) return 10;
  if (priority === 18) return 8;
  if (priority === 12) return 6;
  if (priority === 9) return 5;
  if (priority === 8) return 4;
  if (priority === 6) return 3;
  if (priority === 4) return 2;
  if (priority === 3) return 1.5;
  if (priority === 2) return 1;
  if (priority === 1) return 0.5;
  return 0;
}

/**
 * Category of a product priority: `high` if `P ≥ 18`, `medium` if `P ≥ 6`,
 * else `low`.
 *
 * @method transhipment.priority_distribution
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.priority_distribution
 * @see be-legacy/src/utils/illegal-transhipment.ts `getPriorityCategory` (reference legacy-mvp-backend)
 */
export function priorityCategory(priority: number): keyof PriorityDistribution {
  // SOURCE: thesis — needs citation (category limits 18 / 6).
  if (priority >= 18) return 'high';
  if (priority >= 6) return 'medium';
  return 'low';
}

/** The parts of the transhipment score of one window. */
export interface TranshipmentScore {
  /** `A_w = Σw / (10 N) · 100`, percent. */
  readonly weightedPercentage: number;
  /** `A_p = N⁺ / N · 100`, percent. */
  readonly possibilityPercentage: number;
  /** `A = 0.7 A_w + 0.3 A_p`, percent (unrounded). */
  readonly accuracy: number;
}

/**
 * "Accuracy" score of a window (a confidence score, not a statistical
 * accuracy): `A_w = Σw(P) / (10 N) · 100`, `A_p = N⁺ / N · 100`,
 * `A = 0.7 A_w + 0.3 A_p` (percent), with `N` the checks where both vessels
 * have a position and `N⁺` those with `P > 0`.
 *
 * @method transhipment.accuracy
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.accuracy
 * @see be-legacy/src/utils/illegal-transhipment.ts `detectIllegalTranshipment` (reference legacy-mvp-backend)
 * @see https://doi.org/10.3389/fmars.2018.00240 (Miller et al. 2018, encounter definition for calibration)
 * @param totalWeight - `Σw(P)` over the positive checks
 * @param positiveChecks - `N⁺`
 * @param totalChecks - `N` (> 0)
 */
export function transhipmentScore(
  totalWeight: number,
  positiveChecks: number,
  totalChecks: number,
): TranshipmentScore {
  // SOURCE: thesis — needs citation (weights 0.7 / 0.3).
  const maxPossibleWeight =
    totalChecks * TRANSHIPMENT_ANALYSIS_CONSTANTS.maxWeight;
  const weightedPercentage = (totalWeight / maxPossibleWeight) * 100;
  const possibilityPercentage = (positiveChecks / totalChecks) * 100;
  return {
    weightedPercentage,
    possibilityPercentage,
    accuracy: weightedPercentage * 0.7 + possibilityPercentage * 0.3,
  };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The legacy interpolation-based transhipment detection over two routes:
 * both routes are resampled (> 30 fixes → one per 3 min), then windows of
 * `checkDurationMs` (30 min) advanced by 10 min across the union of both
 * routes are scored every 5 min (6 checks) with the product priority of the
 * interpolated fixes; the FIRST window whose score reaches the threshold
 * (70) is returned with its average priority and priority distribution.
 *
 * `W_k = [t_s + 10k, t_s + 10k + 30) min`, `t_s = min(t₀¹, t₀²)`,
 * `W_k^end ≤ max(t_last¹, t_last²)`; illegal ⇔ `N > 0 ∧ N⁺ > 0 ∧ A ≥ 70`;
 * `P̄ = ΣP / N⁺`; `%cat = round(100 · n_cat / N⁺)`.
 *
 * @method transhipment.sliding_window
 * @method transhipment.accuracy
 * @method transhipment.priority_distribution
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.sliding_window
 * @see be-legacy/src/utils/illegal-transhipment.ts `detectIllegalTranshipment` (reference legacy-mvp-backend)
 * @see be-legacy/src/workers/illegal-transhipment-child-worker.ts `processOne` (stores the distribution)
 * @param route1 - first vessel's fixes, time ascending, not empty
 * @param route2 - second vessel's fixes, time ascending, not empty
 * @throws RangeError when a route is empty (the legacy code threw a TypeError)
 */
export function detectTranshipment(
  route1: readonly TrackFix[],
  route2: readonly TrackFix[],
  options: TranshipmentDetectionOptions = {},
): TranshipmentDetection {
  const constants = TRANSHIPMENT_ANALYSIS_CONSTANTS;
  const checkDuration = options.checkDurationMs ?? constants.checkDurationMs;
  const threshold = options.accuracyThreshold ?? constants.accuracyThreshold;

  const sampled1 = sampleRoute(
    route1,
    constants.maxRouteLength,
    constants.sampleIntervalMs,
  );
  const sampled2 = sampleRoute(
    route2,
    constants.maxRouteLength,
    constants.sampleIntervalMs,
  );
  const first1 = sampled1[0];
  const first2 = sampled2[0];
  const last1 = sampled1[sampled1.length - 1];
  const last2 = sampled2[sampled2.length - 1];
  if (
    first1 === undefined ||
    first2 === undefined ||
    last1 === undefined ||
    last2 === undefined
  ) {
    throw new RangeError('detectTranshipment needs two non-empty routes');
  }

  const startTime = Math.min(first1.time.getTime(), first2.time.getTime());
  const endTime = Math.max(last1.time.getTime(), last2.time.getTime());

  for (
    let windowStart = startTime;
    windowStart + checkDuration <= endTime;
    windowStart += constants.windowStepMs
  ) {
    const distribution = { low: 0, medium: 0, high: 0 };
    let positiveChecks = 0;
    let totalWeight = 0;
    let totalPriority = 0;
    let totalChecks = 0;
    const windowEnd = windowStart + checkDuration;

    for (
      let checkTime = windowStart;
      checkTime < windowEnd;
      checkTime += constants.checkIntervalMs
    ) {
      const time = new Date(checkTime);
      const fix1 = fixAtTime(sampled1, time);
      const fix2 = fixAtTime(sampled2, time);
      if (fix1 === null || fix2 === null) continue;
      totalChecks++;
      const priority =
        speedPriority(fix1, fix2) *
        locationPriority(fix1, fix2) *
        headingPriority(fix1, fix2);
      if (priority > 0) {
        positiveChecks++;
        totalWeight += weightedScore(priority);
        totalPriority += priority;
        distribution[priorityCategory(priority)]++;
      }
    }

    if (totalChecks > 0 && positiveChecks > 0) {
      const { accuracy } = transhipmentScore(
        totalWeight,
        positiveChecks,
        totalChecks,
      );
      if (accuracy >= threshold) {
        return {
          isIllegal: true,
          startTimestamp: new Date(windowStart),
          endTimestamp: new Date(windowEnd),
          accuracy: round2(accuracy),
          averagePriority: round2(totalPriority / positiveChecks),
          priorityDistribution: {
            low: Math.round((distribution.low / positiveChecks) * 100),
            medium: Math.round((distribution.medium / positiveChecks) * 100),
            high: Math.round((distribution.high / positiveChecks) * 100),
          },
        };
      }
    }
  }
  return { isIllegal: false };
}

/**
 * Severity of a transhipment detection (v2 mapping; the registry type has no
 * graded levels): `critical` when the score reaches `criticalAccuracy`
 * (default 90), else `warning`.
 *
 * @method transhipment.accuracy
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.accuracy
 */
export function transhipmentSeverity(
  accuracy: number,
  criticalAccuracy: number,
): Extract<AlertSeverity, 'warning' | 'critical'> {
  return accuracy >= criticalAccuracy ? 'critical' : 'warning';
}
