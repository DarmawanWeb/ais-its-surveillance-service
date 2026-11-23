import {
  DetectorDescriptionDto,
  type DetectorDescription,
} from '@darmawanweb/ais-its-nest/analytics';
import { ApiProperty } from '@nestjs/swagger';

/** Units of the detector thresholds (`null`: lists, flags and plain numbers). */
export const THRESHOLD_UNITS = [
  'm',
  'km',
  's',
  'min',
  'h',
  'kn',
  'percent',
  'deg_per_min',
  'count',
] as const;

/** A {@link THRESHOLD_UNITS} value. */
export type ThresholdUnit = (typeof THRESHOLD_UNITS)[number];

/** Unit and English description of one `<ID>_<KEY>` variable. */
interface ThresholdInfo {
  readonly unit: ThresholdUnit | null;
  readonly description: string;
}

/**
 * Units and descriptions of every configuration key of the detectors, in
 * the order of `.env.example` (a unit test checks them against the config
 * schemas).
 */
export const DETECTOR_THRESHOLDS: Readonly<
  Record<string, Readonly<Record<string, ThresholdInfo>>>
> = {
  transhipment: {
    SOURCES: {
      unit: null,
      description: 'AIS sources whose vessels are candidates (legacy isBatam)',
    },
    ZONE_KINDS: {
      unit: null,
      description:
        "Zone kinds whose vessels are candidates (global zones and the vessel's own organization's)",
    },
    NEIGHBOUR_RADIUS_M: {
      unit: 'm',
      description: 'Candidate search radius (location priority 0 beyond 600 m)',
    },
    NEIGHBOUR_WINDOW_MIN: {
      unit: 'min',
      description: 'Neighbours must have been seen within this window',
    },
    MIN_PRIORITY: {
      unit: null,
      description: 'Accumulated priority a pair needs to be analysed',
    },
    ANALYSIS_INTERVAL_S: {
      unit: 's',
      description: 'Interval of the scheduled analyser',
    },
    ANALYSIS_BATCH: { unit: 'count', description: 'Pairs analysed per run' },
    REANALYSIS_COOLDOWN_MIN: {
      unit: 'min',
      description: 'A pair analysed less than this ago is not analysed again',
    },
    ROUTE_WINDOW_MIN: {
      unit: 'min',
      description: 'Track window of the analysis',
    },
    ROUTE_MAX_POINTS: {
      unit: 'count',
      description: 'Track fixes per vessel in the analysis',
    },
    CHECK_DURATION_MIN: { unit: 'min', description: 'Sliding-window length' },
    ACCURACY_THRESHOLD: {
      unit: 'percent',
      description: 'Minimum score of an illegal transhipment',
    },
    CRITICAL_ACCURACY: {
      unit: 'percent',
      description: 'Score from which the event is critical',
    },
    PAIR_EXPIRY_MIN: {
      unit: 'min',
      description:
        'An open occurrence ends when the pair was not observed together for this long',
    },
    CLAIM_TIMEOUT_MIN: {
      unit: 'min',
      description: 'Claims older than this go back to the queue',
    },
  },
  anomaly: {
    MIN_POSITIONS: {
      unit: 'count',
      description: 'Consecutive mismatching positions before an event',
    },
    EXCLUDED_NAVSTATUS: {
      unit: null,
      description: 'Reported navigational status codes that never count',
    },
  },
  dark: {
    GAP_MIN: {
      unit: 'min',
      description: 'Silence after which a moving vessel is dark',
    },
    MIN_SOG_KN: {
      unit: 'kn',
      description: 'The last speed over ground must exceed this',
    },
    HARBOUR_DISTANCE_KM: {
      unit: 'km',
      description:
        'The last position must be farther than this from a global harbour zone',
    },
    HARBOUR_ZONE_KINDS: {
      unit: null,
      description: 'Zone kinds counted as harbours (global zones only)',
    },
    MAX_GAP_H: {
      unit: 'h',
      description: 'Vessels silent for longer than this are no longer reported',
    },
    CHECK_INTERVAL_S: { unit: 's', description: 'Interval of the scan' },
    SCAN_LIMIT: { unit: 'count', description: 'Vessels examined per scan' },
  },
  geofence: {
    KINDS: {
      unit: null,
      description: 'Watched zone kinds (with alertOnEnter)',
    },
    CRITICAL_KINDS: {
      unit: null,
      description: 'Kinds whose entry is critical (others: warning)',
    },
    USE_BUFFER: {
      unit: null,
      description: "The zone's buffer counts as inside",
    },
  },
  fishing: {
    ZONE_KINDS: {
      unit: null,
      description: 'Zone kinds where the pattern is reported',
    },
    CRITICAL_KINDS: {
      unit: null,
      description: 'Kinds where the event is critical (others: warning)',
    },
    MIN_SOG_KN: { unit: 'kn', description: 'Lower end of the speed band' },
    MAX_SOG_KN: { unit: 'kn', description: 'Upper end of the speed band' },
    MIN_DURATION_MIN: {
      unit: 'min',
      description: 'Minimum duration of the pattern',
    },
    MAX_GAP_MIN: {
      unit: 'min',
      description: 'Largest gap between two fixes of one run',
    },
    MIN_POSITIONS: { unit: 'count', description: 'Minimum fixes of a run' },
    SAMPLE_MIN: {
      unit: 'min',
      description:
        'Course changes are measured between fixes at least this far apart',
    },
    MIN_COURSE_CHANGE_DEG_PER_MIN: {
      unit: 'deg_per_min',
      description: 'Minimum mean course-change rate',
    },
    WINDOW_MIN: {
      unit: 'min',
      description: 'Evaluation window (the most recent part of the run)',
    },
    RESOLVE_AFTER_MIN: {
      unit: 'min',
      description:
        'An occurrence ends after this long without a qualifying fix',
    },
  },
};

/** A threshold value: a number, flag, text or list. */
export type ThresholdValue =
  number | string | boolean | readonly (string | number)[];

/** One active threshold of a detector. */
export interface DetectorThreshold {
  readonly key: string;
  readonly value: ThresholdValue;
  readonly unit: ThresholdUnit | null;
  readonly description: string;
}

/** OpenAPI model of {@link DetectorThreshold}. */
export class DetectorThresholdDto implements DetectorThreshold {
  @ApiProperty({
    example: 'ACCURACY_THRESHOLD',
    description:
      'Configuration key (the variable is `<DETECTOR ID>_<KEY>`, e.g. TRANSHIPMENT_ACCURACY_THRESHOLD)',
  })
  readonly key!: string;

  @ApiProperty({
    oneOf: [
      { type: 'number' },
      { type: 'string' },
      { type: 'boolean' },
      {
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    ],
    example: 70,
    description: 'Active value',
  })
  readonly value!: ThresholdValue;

  @ApiProperty({
    enum: THRESHOLD_UNITS,
    nullable: true,
    description: 'Unit (null for lists, flags and plain numbers)',
  })
  readonly unit!: ThresholdUnit | null;

  @ApiProperty({ example: 'Minimum score of an illegal transhipment' })
  readonly description!: string;
}

/** The active thresholds of a detector (`[]` while it is disabled). */
export function thresholdsOf(
  detectorId: string,
  config: unknown,
): DetectorThreshold[] {
  if (typeof config !== 'object' || config === null) return [];
  const values = config as Readonly<Record<string, unknown>>;
  const known = DETECTOR_THRESHOLDS[detectorId] ?? {};
  return Object.entries(values).flatMap(([key, value]) => {
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !Array.isArray(value)
    )
      return [];
    const info = known[key];
    return [
      {
        key,
        value: Array.isArray(value)
          ? (value as (string | number)[]).slice()
          : value,
        unit: info?.unit ?? null,
        description: info?.description ?? key,
      },
    ];
  });
}

/**
 * One entry of `GET /surveillance/detectors`: the SDK's description
 * (`config` as the raw `<ID>_*` map, kept for older clients) plus the
 * thresholds with units and descriptions.
 */
export class SurveillanceDetectorDto extends DetectorDescriptionDto {
  @ApiProperty({
    type: [DetectorThresholdDto],
    description:
      'The active configuration with units and descriptions (empty while disabled)',
  })
  readonly thresholds: readonly DetectorThreshold[];

  constructor(description: DetectorDescription) {
    super(description);
    this.thresholds = thresholdsOf(description.id, description.config);
  }
}
