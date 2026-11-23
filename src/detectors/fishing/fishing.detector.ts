import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import {
  evaluateLoitering,
  extendRun,
  fishingSeverity,
  isInFishingBand,
  type LoiteringFix,
  type LoiteringThresholds,
  trimRun,
} from '../../domain/fishing.js';
import { fishingText, resolution } from '../../domain/messages.js';
import { AlertKeyLock } from '../shared/alert-key-lock.js';
import {
  boundedInteger,
  optionalZoneKindList,
  positiveNumber,
  zoneKindList,
} from '../shared/config-schemas.js';
import { TrackStorage } from '../shared/storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';

/** Alert type of the detector (contracts `ALERT_TYPES.fishing`). */
export const FISHING_ALERT = 'fishing';

/** `FISHING_*` variables without the prefix (spec §13.8 band and duration). */
export const fishingConfigSchema = z
  .object({
    /** Zone kinds where the pattern is reported. */
    ZONE_KINDS: zoneKindList('fishing_ground,restricted'),
    /** Kinds where the event is critical (others: warning). */
    CRITICAL_KINDS: optionalZoneKindList('restricted'),
    /** Speed band, knots. */
    MIN_SOG_KN: positiveNumber(0.5),
    MAX_SOG_KN: positiveNumber(4),
    /** Minimum duration of the pattern, minutes. */
    MIN_DURATION_MIN: boundedInteger(30, 1, 1_440),
    /** Largest gap between two fixes of one run, minutes. */
    MAX_GAP_MIN: boundedInteger(10, 1, 120),
    /** Minimum fixes of a run. */
    MIN_POSITIONS: boundedInteger(6, 2, 10_000),
    /** Course changes are measured between fixes at least this far apart, minutes. */
    SAMPLE_MIN: boundedInteger(3, 0, 60),
    /** Minimum mean course-change rate, degrees per minute. */
    MIN_COURSE_CHANGE_DEG_PER_MIN: positiveNumber(3),
    /** Evaluation window (the most recent part of the run), minutes. */
    WINDOW_MIN: boundedInteger(60, 1, 1_440),
    /** An occurrence is resolved after this long without a qualifying fix, minutes. */
    RESOLVE_AFTER_MIN: boundedInteger(30, 1, 1_440),
  })
  .refine((config) => config.MIN_SOG_KN < config.MAX_SOG_KN, {
    message: 'Must be below FISHING_MAX_SOG_KN',
    path: ['MIN_SOG_KN'],
  })
  .refine((config) => config.MIN_DURATION_MIN <= config.WINDOW_MIN, {
    message: 'Must not exceed FISHING_WINDOW_MIN',
    path: ['MIN_DURATION_MIN'],
  });

/** Parsed `FISHING_*` configuration. */
export type FishingConfig = z.output<typeof fishingConfigSchema>;

/** Deduplication key of one vessel's pattern in one zone. */
export function fishingKey(mmsi: number, zoneId: string): string {
  return `${FISHING_ALERT}:${mmsi}:${zoneId}`;
}

/** Vessels whose run was rebuilt from `track_points`, remembered at most. */
const MAX_WARMED = 100_000;

/** The pattern state of one vessel. */
interface VesselRun {
  readonly fixes: readonly LoiteringFix[];
  /** Time of the last qualifying fix, ms. */
  readonly lastQualifyingAt: number | undefined;
}

function thresholdsOf(config: FishingConfig): LoiteringThresholds {
  return {
    minSogKn: config.MIN_SOG_KN,
    maxSogKn: config.MAX_SOG_KN,
    minDurationMs: config.MIN_DURATION_MIN * 60_000,
    maxGapMs: config.MAX_GAP_MIN * 60_000,
    minPositions: config.MIN_POSITIONS,
    sampleIntervalMs: config.SAMPLE_MIN * 60_000,
    minCourseChangeDegPerMin: config.MIN_COURSE_CHANGE_DEG_PER_MIN,
  };
}

/**
 * Fishing loitering: speed in the band (0.5–4 kn) with frequent course
 * changes (mean rate ≥ 3 °/min between fixes ≥ 3 min apart) for at least
 * 30 min inside a `fishing_ground` / `restricted` zone (`FISHING_ZONE_KINDS`).
 * The run lives in memory and is rebuilt from `track_points` (where the
 * positions inside those zones are stored) after a restart or a takeover
 * (`onActivated` drops the runs built while another instance was active).
 * Resolved when
 * the vessel leaves the zone or after `FISHING_RESOLVE_AFTER_MIN` without a
 * qualifying fix. Severity: `critical` in `FISHING_CRITICAL_KINDS`
 * (restricted), else `warning`. Dedup key `fishing:<mmsi>:<zoneId>`. A new
 * occurrence opens through the `AlertKeyLock` (aligned with `events`; a
 * position not newer than the key's last resolution opens nothing).
 *
 * @method fishing.loitering
 * @see ../../../../../docs/METHODOLOGY.md#fishing.loitering
 */
@RegisterDetector()
@Injectable()
export class FishingDetector implements Detector<FishingConfig> {
  readonly id = 'fishing';
  readonly domain = 'surveillance';
  readonly methodIds = ['fishing.loitering'];
  readonly alertTypes = [FISHING_ALERT] as const;
  readonly configSchema = fishingConfigSchema;

  private readonly runs = new Map<number, VesselRun>();
  private readonly warmed = new Set<number>();

  constructor(
    private readonly recorder: VesselStateRecorder,
    private readonly tracks: TrackStorage,
    private readonly lock: AlertKeyLock,
  ) {}

  async onPosition(
    context: DetectorContext<FishingConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const { config } = context;
    const thresholds = thresholdsOf(config);
    await this.recorder.observe(context, position);
    const zones = this.zonesOf(context, position);

    if (zones.length > 0) {
      await this.tracks.append(position);
      if (!this.runs.has(position.mmsi) && !this.warmed.has(position.mmsi))
        await this.warmUp(context, position, thresholds);
    }

    const qualifies =
      zones.length > 0 && isInFishingBand(position.sog, thresholds);
    const previous = this.runs.get(position.mmsi);
    const fix: LoiteringFix = {
      time: position.time,
      sog: position.sog,
      cog: position.cog,
    };
    const fixes = trimRun(
      extendRun(previous?.fixes ?? [], fix, qualifies, thresholds),
      position.time,
      config.WINDOW_MIN * 60_000,
    );
    const lastQualifyingAt = qualifies
      ? position.time.getTime()
      : previous?.lastQualifyingAt;
    const resolveAfterMs = config.RESOLVE_AFTER_MIN * 60_000;
    const idle =
      lastQualifyingAt === undefined ||
      position.time.getTime() - lastQualifyingAt >= resolveAfterMs;
    if (fixes.length === 0 && idle) this.runs.delete(position.mmsi);
    else this.runs.set(position.mmsi, { fixes, lastQualifyingAt });

    const evaluation = evaluateLoitering(fixes, thresholds);
    if (evaluation.loitering) {
      const vesselName = context.fleet.byMmsi(position.mmsi)?.name;
      for (const zone of zones) {
        const { title, message, messageKey, messageParams } = fishingText({
          mmsi: position.mmsi,
          vesselName,
          zoneName: zone.name,
          zoneKind: zone.kind,
          zoneCode: zone.code,
          durationMin: evaluation.durationMin,
          meanSogKn: evaluation.meanSogKn,
          courseChangeRateDegPerMin: evaluation.courseChangeRateDegPerMin,
          positions: evaluation.positions,
        });
        await this.lock.raiseFromPosition(
          context.alerts,
          {
            type: FISHING_ALERT,
            dedupKey: fishingKey(position.mmsi, zone.id),
            severity: fishingSeverity(zone.kind, config.CRITICAL_KINDS),
            mmsi: position.mmsi,
            title,
            message,
            position,
            occurredAt: fixes[0]?.time ?? position.time,
            zoneId: zone.id,
            data: {
              zoneKind: zone.kind,
              zoneCode: zone.code,
              zoneName: zone.name,
              durationMin: evaluation.durationMin,
              positions: evaluation.positions,
              meanSogKn: evaluation.meanSogKn,
              courseChangeRateDegPerMin: evaluation.courseChangeRateDegPerMin,
              totalCourseChangeDeg: evaluation.totalCourseChangeDeg,
              messageKey,
              messageParams,
            },
          },
          position.time,
        );
      }
    }

    const insideIds = new Set(zones.map((zone) => zone.id));
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (open.zoneId === null || !insideIds.has(open.zoneId)) {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          ...resolution('left_zone'),
        });
      } else if (!evaluation.loitering && idle) {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          ...resolution('loitering_ended'),
        });
      }
    }
  }

  /**
   * A takeover: the runs in memory stem from this instance's previous active
   * period (the other instance handled the positions since). Drop them, so
   * each vessel's run is rebuilt from `track_points` at its next position.
   */
  onActivated(): void {
    this.runs.clear();
    this.warmed.clear();
  }

  private zonesOf(
    context: DetectorContext<FishingConfig>,
    point: Pick<VesselPosition, 'mmsi' | 'lat' | 'lon'>,
  ): ZoneSnapshotV1[] {
    return context.zones.zonesAt(point, {
      kinds: context.config.ZONE_KINDS,
      useBuffer: false,
      orgId: context.fleet.orgOf(point.mmsi) ?? null,
    });
  }

  /** Rebuilds a vessel's run from its stored track (first sight after a restart). */
  private async warmUp(
    context: DetectorContext<FishingConfig>,
    position: VesselPosition,
    thresholds: LoiteringThresholds,
  ): Promise<void> {
    if (this.warmed.size >= MAX_WARMED) this.warmed.clear();
    this.warmed.add(position.mmsi);
    const windowMs = context.config.WINDOW_MIN * 60_000;
    const stored = await this.tracks.route(
      position.mmsi,
      new Date(position.time.getTime() - windowMs),
      new Date(position.time.getTime() - 1),
      10_000,
    );
    let fixes: LoiteringFix[] = [];
    let lastQualifyingAt: number | undefined;
    for (const fix of stored) {
      const qualifies =
        this.zonesOf(context, { ...fix, mmsi: position.mmsi }).length > 0 &&
        isInFishingBand(fix.sog, thresholds);
      fixes = extendRun(fixes, fix, qualifies, thresholds);
      if (qualifies) lastQualifyingAt = fix.time.getTime();
    }
    if (fixes.length > 0 || lastQualifyingAt !== undefined)
      this.runs.set(position.mmsi, { fixes, lastQualifyingAt });
  }
}
