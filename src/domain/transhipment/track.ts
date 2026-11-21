/**
 * A fix of a vessel track as the legacy transhipment rules read it (legacy
 * `IAisPosition`: `timestamp` → `time`).
 */
export interface TrackFix {
  /** Position time. */
  readonly time: Date;
  /** Latitude, WGS84 degrees. */
  readonly lat: number;
  /** Longitude, WGS84 degrees. */
  readonly lon: number;
  /** Speed over ground, knots. */
  readonly sog: number;
  /** Course over ground, degrees (carried along, never interpolated — legacy parity). */
  readonly cog: number;
  /** True heading, degrees; `511` (not available) is used as is (legacy parity). */
  readonly hdg: number;
}

/**
 * Linear interpolation of a vessel fix between two surrounding fixes.
 *
 * `x(t) = x₁ + (x₂ − x₁) · (t − t₁) / (t₂ − t₁)` for `x ∈ {lat, lon, sog, hdg}`
 * (degrees, knots), times in ms; every other field is taken from the earlier
 * fix. Headings are interpolated without the 0/360 wrap (350° → 10° passes
 * through 180°), exactly like the legacy code.
 *
 * @method transhipment.route_interpolation
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.route_interpolation
 * @see be-legacy/src/utils/illegal-transhipment.ts `interpolatePositions` (reference legacy-mvp-backend)
 * @param before - fix at `t₁ < time`
 * @param after - fix at `t₂ > time`
 * @param time - target time `t`
 */
export function interpolateFix(
  before: TrackFix,
  after: TrackFix,
  time: Date,
): TrackFix {
  const time1 = before.time.getTime();
  const time2 = after.time.getTime();
  const ratio = (time.getTime() - time1) / (time2 - time1);
  const interpolate = (start: number, end: number): number =>
    start + (end - start) * ratio;
  return {
    ...before,
    lat: interpolate(before.lat, after.lat),
    lon: interpolate(before.lon, after.lon),
    sog: interpolate(before.sog, after.sog),
    hdg: interpolate(before.hdg, after.hdg),
    time,
  };
}

/**
 * The fix of a route at a time: an exact match, else the interpolation
 * between the last fix before and the first fix after it, else `null`
 * (outside the route). The route must be sorted by time ascending.
 *
 * @method transhipment.route_interpolation
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.route_interpolation
 * @see be-legacy/src/utils/illegal-transhipment.ts `getPositionAtTime` (reference legacy-mvp-backend)
 */
export function fixAtTime(
  route: readonly TrackFix[],
  time: Date,
): TrackFix | null {
  const target = time.getTime();
  const exact = route.find((fix) => fix.time.getTime() === target);
  if (exact !== undefined) return exact;

  let before: TrackFix | null = null;
  let after: TrackFix | null = null;
  for (const fix of route) {
    const fixTime = fix.time.getTime();
    if (fixTime < target) {
      before = fix;
    } else if (fixTime > target) {
      after = fix;
      break;
    }
  }
  return before !== null && after !== null
    ? interpolateFix(before, after, time)
    : null;
}

/**
 * Resamples a long route: a route of at most `maxLength` fixes is returned as
 * is; otherwise one fix every `intervalMs` from its first fix (exact or
 * interpolated), at most `maxLength` of them (the last `maxLength` fixes when
 * no sample exists). Legacy constants: 30 fixes, 3 min.
 *
 * @method transhipment.route_interpolation
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.route_interpolation
 * @see be-legacy/src/utils/illegal-transhipment.ts `sampleRoute` (reference legacy-mvp-backend)
 * @param route - fixes sorted by time ascending
 * @param maxLength - maximum number of fixes
 * @param intervalMs - sampling interval, ms
 */
export function sampleRoute(
  route: readonly TrackFix[],
  maxLength: number,
  intervalMs: number,
): readonly TrackFix[] {
  if (route.length <= maxLength) return route;
  const first = route[0];
  const last = route[route.length - 1];
  if (first === undefined || last === undefined) return route;

  const sampled: TrackFix[] = [];
  const endTime = last.time.getTime();
  let currentTime = first.time.getTime();
  while (currentTime <= endTime && sampled.length < maxLength) {
    const fix = fixAtTime(route, new Date(currentTime));
    if (fix !== null) sampled.push(fix);
    currentTime += intervalMs;
  }
  return sampled.length > 0 ? sampled : route.slice(-maxLength);
}
