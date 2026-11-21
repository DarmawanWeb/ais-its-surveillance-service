import {
  isNavStatusAnomaly,
  type PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';

/**
 * `true` when a position's reported navigational status contradicts the
 * predicted one — the legacy web app rule
 * `(n̂ = 0 ∧ n = 1) ∨ (n̂ = 1 ∧ n ≠ 1)` (contracts `isNavStatusAnomaly`),
 * with `n` the reported AIS status code and `n̂` the predicted status
 * (1 = at anchor). Reported codes listed in `excluded` never count (none by
 * default — legacy parity; e.g. 15 "not defined" for Class B units).
 *
 * @method anomaly.navstatus_mismatch
 * @see ../../../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch
 * @see fe-legacy/src/pages/anomaly/components/navstatus-anomaly-card.tsx `anomalies` (reference legacy-mvp-frontend)
 * @see https://wwwcdn.imo.org/localresources/en/OurWork/Safety/Documents/AIS/Resolution%20A.1106(29).pdf (reported status is manual input)
 * @see https://doi.org/10.1017/S0373463307004298 (Harati-Mokhtari et al. 2007, AIS data reliability)
 */
export function isAnomalousPosition(
  navstatus: number,
  predictedNavstatus: PredictedNavStatus,
  excluded: readonly number[] = [],
): boolean {
  return (
    !excluded.includes(navstatus) &&
    isNavStatusAnomaly(navstatus, predictedNavstatus)
  );
}

/**
 * The anomaly streak after a position: consecutive anomalous positions are
 * counted, any consistent position resets the streak to 0.
 *
 * @method anomaly.navstatus_mismatch
 * @see ../../../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch
 */
export function nextAnomalyStreak(
  previous: number,
  anomalous: boolean,
): number {
  return anomalous ? previous + 1 : 0;
}

/**
 * `true` when the anomaly is sustained: at least `minPositions`
 * (`ANOMALY_MIN_POSITIONS`, default 3) consecutive anomalous positions
 * (v2 persistence rule, spec §13.8).
 *
 * @method anomaly.navstatus_mismatch
 * @see ../../../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch
 */
export function isSustainedAnomaly(
  streak: number,
  minPositions: number,
): boolean {
  // SOURCE: thesis — needs citation (v2 design choice k = 3, platform-spec-v1-1).
  return streak >= minPositions;
}
