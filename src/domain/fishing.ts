import type {
  AlertSeverity,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';

/** Thresholds of the loitering rule (`FISHING_*`). */
export interface LoiteringThresholds {
  /** Lower bound of the speed band, knots (0.5). */
  readonly minSogKn: number;
  /** Upper bound of the speed band, knots (4). */
  readonly maxSogKn: number;
  /** Minimum duration of the pattern, ms (30 min). */
  readonly minDurationMs: number;
  /** Largest gap between two fixes of one run, ms (10 min). */
  readonly maxGapMs: number;
  /** Minimum number of fixes of a run (6). */
  readonly minPositions: number;
  /** Course changes are measured between fixes at least this far apart, ms (3 min). */
  readonly sampleIntervalMs: number;
  /** Minimum mean course-change rate, degrees per minute (3). */
  readonly minCourseChangeDegPerMin: number;
}

/** A fix of a vessel as the loitering rule reads it. */
export interface LoiteringFix {
  readonly time: Date;
  /** Speed over ground, knots. */
  readonly sog: number;
  /** Course over ground, degrees (360 = not available). */
  readonly cog: number;
}

/** Evaluation of a run of fixes. */
export interface LoiteringEvaluation {
  readonly loitering: boolean;
  /** Run duration, minutes. */
  readonly durationMin: number;
  /** Fixes in the run. */
  readonly positions: number;
  /** Sum of the course changes between decimated fixes, degrees. */
  readonly totalCourseChangeDeg: number;
  /** Mean course-change rate, degrees per minute. */
  readonly courseChangeRateDegPerMin: number;
  /** Mean speed over ground, knots. */
  readonly meanSogKn: number;
}

/** COG value meaning "not available" (ITU-R M.1371). */
const COG_NOT_AVAILABLE = 360;

/**
 * `true` when the speed is in the fishing band `0.5 ≤ SOG ≤ 4` kn.
 *
 * @method fishing.loitering
 * @see ../../../../docs/METHODOLOGY.md#fishing.loitering
 */
export function isInFishingBand(
  sogKn: number,
  thresholds: Pick<LoiteringThresholds, 'minSogKn' | 'maxSogKn'>,
): boolean {
  // SOURCE: thesis — needs citation (v2 design band 0.5–4 kn, platform-spec-v1-1).
  return sogKn >= thresholds.minSogKn && sogKn <= thresholds.maxSogKn;
}

/**
 * Absolute course change between two courses, degrees in `[0, 180]`;
 * `null` when a course is not available (360) or not finite.
 *
 * @method fishing.loitering
 */
export function courseChangeDeg(from: number, to: number): number | null {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= COG_NOT_AVAILABLE ||
    to >= COG_NOT_AVAILABLE
  ) {
    return null;
  }
  const difference = Math.abs(to - from) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * Extends the vessel's current run of qualifying fixes (inside a watched zone
 * and in the speed band): a non-qualifying fix or a gap above `maxGapMs`
 * starts over (a non-qualifying fix leaves an empty run).
 *
 * @method fishing.loitering
 */
export function extendRun(
  run: readonly LoiteringFix[],
  fix: LoiteringFix,
  qualifies: boolean,
  thresholds: Pick<LoiteringThresholds, 'maxGapMs'>,
): LoiteringFix[] {
  if (!qualifies) return [];
  const last = run[run.length - 1];
  if (
    last === undefined ||
    fix.time.getTime() - last.time.getTime() > thresholds.maxGapMs
  ) {
    return [fix];
  }
  if (fix.time.getTime() <= last.time.getTime()) return [...run];
  return [...run, fix];
}

/**
 * Fishing loitering pattern (v2 operational definition of "SOG 0.5–4 kn with
 * frequent course changes for ≥ 30 min"): a run of consecutive qualifying
 * fixes (inside a fishing_ground/restricted zone, speed in the band, gaps
 * ≤ 10 min) spanning `T ≥ 30 min` with `n ≥ 6` fixes, whose mean
 * course-change rate `Ċ = Σ|ΔCOG| / T` — measured between fixes decimated
 * to at least 3 min apart so GPS course jitter at low speed is not summed —
 * reaches 3 °/min.
 *
 * @method fishing.loitering
 * @see ../../../../docs/METHODOLOGY.md#fishing.loitering
 * @see https://doi.org/10.1371/journal.pone.0158248 (de Souza et al. 2016, fishing patterns from AIS)
 * @see https://doi.org/10.1371/journal.pone.0130746 (Natale et al. 2015, speed profiles of fishing)
 * @see https://globalfishingwatch.org/our-apis/documentation (GFW loitering / fishing events)
 */
export function evaluateLoitering(
  run: readonly LoiteringFix[],
  thresholds: LoiteringThresholds,
): LoiteringEvaluation {
  // SOURCE: thesis — needs citation (v2 design defaults 30 min, 6 fixes, 3 min, 3 deg/min).
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) {
    return {
      loitering: false,
      durationMin: 0,
      positions: 0,
      totalCourseChangeDeg: 0,
      courseChangeRateDegPerMin: 0,
      meanSogKn: 0,
    };
  }
  const durationMs = last.time.getTime() - first.time.getTime();
  const durationMin = durationMs / 60_000;

  let totalCourseChangeDeg = 0;
  let anchor = first;
  for (const fix of run.slice(1)) {
    if (
      fix.time.getTime() - anchor.time.getTime() <
      thresholds.sampleIntervalMs
    )
      continue;
    const change = courseChangeDeg(anchor.cog, fix.cog);
    if (change !== null) totalCourseChangeDeg += change;
    anchor = fix;
  }
  const courseChangeRateDegPerMin =
    durationMin > 0 ? totalCourseChangeDeg / durationMin : 0;
  const meanSogKn = run.reduce((sum, fix) => sum + fix.sog, 0) / run.length;

  return {
    loitering:
      durationMs >= thresholds.minDurationMs &&
      run.length >= thresholds.minPositions &&
      courseChangeRateDegPerMin >= thresholds.minCourseChangeDegPerMin,
    durationMin,
    positions: run.length,
    totalCourseChangeDeg,
    courseChangeRateDegPerMin,
    meanSogKn,
  };
}

/**
 * Severity of a fishing event (v2 mapping): `critical` inside the zone kinds
 * in `criticalKinds` (`FISHING_CRITICAL_KINDS`, default `restricted`), else
 * `warning` (registry default).
 *
 * @method fishing.loitering
 */
export function fishingSeverity(
  kind: ZoneKind,
  criticalKinds: readonly ZoneKind[],
): Extract<AlertSeverity, 'warning' | 'critical'> {
  return criticalKinds.includes(kind) ? 'critical' : 'warning';
}

/**
 * Keeps the fixes of a run within the evaluation window ending at `now`
 * (`FISHING_WINDOW_MIN`), so the course-change rate describes the recent
 * pattern rather than the whole stay.
 *
 * @method fishing.loitering
 */
export function trimRun(
  run: readonly LoiteringFix[],
  now: Date,
  windowMs: number,
): LoiteringFix[] {
  const from = now.getTime() - windowMs;
  return run.filter((fix) => fix.time.getTime() >= from);
}
