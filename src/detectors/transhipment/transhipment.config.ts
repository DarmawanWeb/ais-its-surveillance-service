import * as z from 'zod';

import { TRANSHIPMENT_ANALYSIS_CONSTANTS } from '../../domain/transhipment/analysis.js';
import {
  aisSourceList,
  boundedInteger,
  optionalZoneKindList,
  positiveNumber,
} from '../shared/config-schemas.js';

/**
 * `TRANSHIPMENT_*` variables without the prefix (spec §13.8, legacy defaults
 * of `services/illegal-transhipment/*` and `utils/illegal-transhipment.ts`).
 */
export const transhipmentConfigSchema = z
  .object({
    /** Vessels from these AIS sources are candidates (legacy `isBatam`). */
    SOURCES: aisSourceList('batam'),
    /** Vessels inside zones of these kinds are candidates too. */
    ZONE_KINDS: optionalZoneKindList('transhipment_area'),
    /** Candidate search radius, metres (location priority 0 beyond 600 m). */
    NEIGHBOUR_RADIUS_M: positiveNumber(600),
    /** Neighbours must have been seen within this window, minutes (legacy 5). */
    NEIGHBOUR_WINDOW_MIN: boundedInteger(5, 1, 30),
    /** Accumulated priority a pair needs to be analysed (legacy: every queued pair, P ≥ 1). */
    MIN_PRIORITY: positiveNumber(1),
    /** Interval of the scheduled analyser, seconds. */
    ANALYSIS_INTERVAL_S: boundedInteger(30, 1, 3_600),
    /** Pairs analysed per run. */
    ANALYSIS_BATCH: boundedInteger(10, 1, 500),
    /** A pair analysed less than this ago is not analysed again, minutes (legacy 15). */
    REANALYSIS_COOLDOWN_MIN: boundedInteger(15, 0, 1_440),
    /** Track window of the analysis, minutes (legacy 60). */
    ROUTE_WINDOW_MIN: boundedInteger(60, 10, 1_440),
    /** Track fixes per vessel in the analysis (legacy 60, newest kept). */
    ROUTE_MAX_POINTS: boundedInteger(60, 2, 10_000),
    /** Sliding-window length, minutes (legacy `checkDuration` 30). */
    CHECK_DURATION_MIN: boundedInteger(
      TRANSHIPMENT_ANALYSIS_CONSTANTS.checkDurationMs / 60_000,
      5,
      720,
    ),
    /** Minimum score of an illegal transhipment, percent (legacy 70). */
    ACCURACY_THRESHOLD: z.coerce
      .number()
      .min(0)
      .max(100)
      .default(TRANSHIPMENT_ANALYSIS_CONSTANTS.accuracyThreshold),
    /** Score from which the event is critical, percent. */
    CRITICAL_ACCURACY: z.coerce.number().min(0).max(100).default(90),
    /** An open occurrence is resolved when the pair was not observed for this long, minutes. */
    PAIR_EXPIRY_MIN: boundedInteger(60, 1, 10_080),
    /** Claims older than this are returned to the queue (crashed analyser), minutes. */
    CLAIM_TIMEOUT_MIN: boundedInteger(5, 1, 1_440),
  })
  .refine(
    (config) => config.SOURCES.length > 0 || config.ZONE_KINDS.length > 0,
    {
      message: 'Set TRANSHIPMENT_SOURCES or TRANSHIPMENT_ZONE_KINDS',
      path: ['SOURCES'],
    },
  );

/** Parsed `TRANSHIPMENT_*` configuration. */
export type TranshipmentConfig = z.output<typeof transhipmentConfigSchema>;
