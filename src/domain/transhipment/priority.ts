import { haversineDistance } from '@darmawanweb/ais-its-contracts/domain';

import type { TrackFix } from './track.js';

/** An ordinal priority of the legacy transhipment rules (0 = rules the pair out). */
export type OrdinalPriority = 0 | 1 | 2 | 3;

/**
 * Speed-difference priority of a vessel pair.
 *
 * `Δv = |SOG₂ − SOG₁|` (knots): `3` if `Δv < 0.5`, `2` if `0.5 ≤ Δv < 2`,
 * `1` if `2 ≤ Δv ≤ 10`, else `0`.
 *
 * @method transhipment.speed_priority
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.speed_priority
 * @see be-legacy/src/utils/illegal-transhipment.ts `checkSpeed` (reference legacy-mvp-backend)
 * @see https://doi.org/10.3389/fmars.2018.00240 (Miller et al. 2018, context: GFW encounters use an absolute speed)
 */
export function speedPriority(
  first: Pick<TrackFix, 'sog'>,
  second: Pick<TrackFix, 'sog'>,
): OrdinalPriority {
  // SOURCE: thesis — needs citation (limits 0.5 / 2 / 10 kn).
  const speedDifference = Math.abs(second.sog - first.sog);
  if (speedDifference < 0.5) return 3;
  if (speedDifference >= 0.5 && speedDifference < 2) return 2;
  if (speedDifference >= 2 && speedDifference <= 10) return 1;
  return 0;
}

/**
 * Proximity priority of a vessel pair from the legacy haversine distance
 * (`R = 3438 nm`, metres): `3` if `d ≤ 27`, `2` if `27 < d ≤ 34`, `1` if
 * `34 < d ≤ 600`, else `0`.
 *
 * @method transhipment.location_priority
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.location_priority
 * @see ../../../../../docs/METHODOLOGY.md#geo.haversine_distance
 * @see be-legacy/src/utils/illegal-transhipment.ts `checkLocation` (reference legacy-mvp-backend)
 * @see https://movable-type.co.uk/scripts/latlong.html (haversine, Sinnott 1984)
 */
export function locationPriority(
  first: Pick<TrackFix, 'lat' | 'lon'>,
  second: Pick<TrackFix, 'lat' | 'lon'>,
): OrdinalPriority {
  // SOURCE: thesis — needs citation (limits 27 / 34 / 600 m).
  const distanceInMeters = haversineDistance(first, second).meters;
  if (distanceInMeters <= 27) return 3;
  if (distanceInMeters > 27 && distanceInMeters <= 34) return 2;
  if (distanceInMeters > 34 && distanceInMeters <= 600) return 1;
  return 0;
}

/**
 * Heading priority of a vessel pair.
 *
 * `Δh = |HDG₁ − HDG₂|`, `Δh' = 360 − Δh` when `Δh > 180` (degrees): `3` if
 * `Δh' ≤ 6`, `2` if `6 < Δh' ≤ 174`, `1` if `174 < Δh' ≤ 186`, else `0`.
 * HDG 511 (not available) is used as a number, as in the legacy code (it
 * yields a negative `Δh'` that scores 3).
 *
 * @method transhipment.heading_priority
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.heading_priority
 * @see be-legacy/src/utils/illegal-transhipment.ts `checkHeading` (reference legacy-mvp-backend)
 * @see https://www.itu.int/rec/R-REC-M.1371-5-201402-I (HDG 511 = not available)
 */
export function headingPriority(
  first: Pick<TrackFix, 'hdg'>,
  second: Pick<TrackFix, 'hdg'>,
): OrdinalPriority {
  // SOURCE: thesis — needs citation (limits 6 / 174 / 186 degrees).
  const headingDifference = Math.abs(first.hdg - second.hdg);
  const normalized =
    headingDifference > 180 ? 360 - headingDifference : headingDifference;
  if (normalized <= 6) return 3;
  if (normalized > 6 && normalized <= 174) return 2;
  if (normalized > 174 && normalized <= 186) return 1;
  return 0;
}

/**
 * Product priority of a vessel pair, `P = P_s · P_l · P_h ∈ {0, 1, 2, 3, 4,
 * 6, 8, 9, 12, 18, 27}` (dimensionless): the candidate score of the queue
 * and of every check of the sliding-window analysis.
 *
 * @method transhipment.candidate_queue
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.candidate_queue
 * @see be-legacy/src/utils/illegal-transhipment.ts `checkIlegalTranshipmentPossibility` (reference legacy-mvp-backend)
 */
export function pairPriority(
  first: Pick<TrackFix, 'sog' | 'lat' | 'lon' | 'hdg'>,
  second: Pick<TrackFix, 'sog' | 'lat' | 'lon' | 'hdg'>,
): number {
  return (
    speedPriority(first, second) *
    locationPriority(first, second) *
    headingPriority(first, second)
  );
}

/** Another vessel's newest fix, as compared with the current vessel. */
export interface CandidateVessel {
  readonly mmsi: number;
  /** Its newest fix within the neighbour window; `null` when it has none. */
  readonly fix: Pick<TrackFix, 'sog' | 'lat' | 'lon' | 'hdg'> | null;
}

/** A vessel scored against the current one. */
export interface CandidatePriority {
  readonly mmsi: number;
  /** Product priority, > 0. */
  readonly priority: number;
}

/**
 * Scores the current vessel's fix against the newest fix of every other
 * candidate vessel and keeps the pairs with `P > 0`, in input order (legacy
 * `checkIlegalTranshipmentPossibility`).
 *
 * @method transhipment.candidate_queue
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.candidate_queue
 * @see be-legacy/src/utils/illegal-transhipment.ts `checkIlegalTranshipmentPossibility` (reference legacy-mvp-backend)
 */
export function candidatePriorities(
  current: Pick<TrackFix, 'sog' | 'lat' | 'lon' | 'hdg'>,
  others: readonly CandidateVessel[],
): CandidatePriority[] {
  const result: CandidatePriority[] = [];
  for (const other of others) {
    if (other.fix === null) continue;
    const priority = pairPriority(current, other.fix);
    if (priority > 0) result.push({ mmsi: other.mmsi, priority });
  }
  return result;
}
