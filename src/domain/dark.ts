/** Thresholds of the AIS gap rule (`DARK_*`, spec §13.8 defaults). */
export interface DarkThresholds {
  /** Minimum silence, ms (`DARK_GAP_MIN` = 30 min). */
  readonly gapMs: number;
  /** The last speed over ground must exceed this, knots (`DARK_MIN_SOG_KN` = 1). */
  readonly minSogKn: number;
  /** The last position must be farther than this from any port/anchorage zone, metres (`DARK_HARBOUR_DISTANCE_KM` = 5 km). */
  readonly harbourDistanceM: number;
}

/** The last known state of a vessel, as the AIS gap rule reads it. */
export interface LastSeen {
  /** Time of the last position. */
  readonly time: Date;
  /** Last speed over ground, knots. */
  readonly sog: number;
}

/**
 * Reference time of the AIS gap rule: the event-time watermark of the
 * position feed (the newest position processed), never later than the wall
 * clock. `null` before any position was processed: a feed outage or a
 * backlog after a restart is not "every vessel went dark".
 *
 * @method dark.ais_gap
 * @see ../../../../docs/METHODOLOGY.md#dark.ais_gap
 */
export function darkReferenceTime(
  now: Date,
  eventTime: Date | undefined,
): Date | null {
  if (eventTime === undefined) return null;
  return eventTime.getTime() < now.getTime() ? eventTime : now;
}

/**
 * Dark vessel (AIS gap) rule, v2: the last position is older than the gap
 * while the last speed exceeded the minimum and the vessel was away from
 * ports and anchorages:
 * `t_ref − t_last > 30 min ∧ SOG_last > 1 kn ∧ d(p_last, Z_port ∪ Z_anchorage) > 5 km`.
 * `harbourDistanceM` is the distance to the nearest port/anchorage zone
 * within the threshold, or `null` when none is that close.
 *
 * @method dark.ais_gap
 * @see ../../../../docs/METHODOLOGY.md#dark.ais_gap
 * @see https://doi.org/10.1126/sciadv.abq2109 (Welch et al. 2022: gaps ≥ 12 h far from shore — calibration context)
 * @see https://globalfishingwatch.org/our-apis/documentation (GFW AIS-gap events)
 * @param last - the vessel's last position (time, SOG in knots)
 * @param harbourDistanceM - metres to the nearest port/anchorage zone, `null` if none within the threshold
 * @param reference - see {@link darkReferenceTime}
 */
export function isDarkVessel(
  last: LastSeen,
  harbourDistanceM: number | null,
  reference: Date,
  thresholds: DarkThresholds,
): boolean {
  // SOURCE: thesis — needs citation (v2 design defaults 30 min / 1 kn / 5 km, platform-spec-v1-1).
  const silentMs = reference.getTime() - last.time.getTime();
  return (
    silentMs > thresholds.gapMs &&
    last.sog > thresholds.minSogKn &&
    (harbourDistanceM === null ||
      harbourDistanceM > thresholds.harbourDistanceM)
  );
}

/** Minutes between two times (gap durations reported in events). */
export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}
