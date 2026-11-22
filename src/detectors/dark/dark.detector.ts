import {
  type Detector,
  type DetectorCall,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import {
  type DarkThresholds,
  darkReferenceTime,
  isDarkVessel,
  minutesBetween,
} from '../../domain/dark.js';
import { AlertCoordinator } from '../shared/alert-coordinator.js';
import {
  boundedInteger,
  positiveNumber,
  zoneKindList,
} from '../shared/config-schemas.js';
import {
  type StoredVesselState,
  VesselStateStorage,
} from '../shared/storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';

/** Alert type of the detector (contracts `ALERT_TYPES.dark`). */
export const DARK_ALERT = 'dark';

/** `DARK_*` variables without the prefix (spec §13.8 defaults). */
export const darkConfigSchema = z.object({
  /** Silence after which a moving vessel is dark, minutes. */
  GAP_MIN: boundedInteger(30, 1, 10_080),
  /** The last speed over ground must exceed this, knots. */
  MIN_SOG_KN: z.coerce.number().min(0).default(1),
  /** The last position must be farther than this from a harbour zone, kilometres. */
  HARBOUR_DISTANCE_KM: positiveNumber(5),
  /** Zone kinds counted as harbours (global zones only, never org-owned ones). */
  HARBOUR_ZONE_KINDS: zoneKindList('port,anchorage'),
  /** Vessels silent for longer than this are no longer reported (stale states), hours. */
  MAX_GAP_H: boundedInteger(24, 1, 720),
  /** Interval of the scan, seconds. */
  CHECK_INTERVAL_S: boundedInteger(60, 1, 3_600),
  /** Vessels examined per scan. */
  SCAN_LIMIT: boundedInteger(5_000, 1, 100_000),
});

/** Parsed `DARK_*` configuration. */
export type DarkConfig = z.output<typeof darkConfigSchema>;

/** Deduplication key of a vessel's AIS gap. */
export function darkKey(mmsi: number): string {
  return `${DARK_ALERT}:${mmsi}`;
}

/** Base tick; the scan runs every `DARK_CHECK_INTERVAL_S`. */
const TICK_INTERVAL_MS = 5_000;

/**
 * Dark vessel / AIS gap (v2): a scan of `vessel_state` finds vessels last
 * seen more than `DARK_GAP_MIN` (30) minutes before the feed's event-time
 * watermark while their last SOG exceeded `DARK_MIN_SOG_KN` (1) and they were
 * farther than `DARK_HARBOUR_DISTANCE_KM` (5) from any `port` / `anchorage`
 * zone; the occurrence is resolved by the vessel's next position. Only
 * global (curated, `orgId: null`) harbour zones count: the rule serves the
 * authorities, so a tenant's private zone must never silence it (spec §8.5).
 * The watermark (newest processed position, never ahead of the wall clock)
 * keeps a feed outage or a restart backlog from reporting every vessel; the
 * scan runs only on the instance consuming positions and raises through the
 * {@link AlertCoordinator} (one occurrence across replicas). Severity
 * `warning` (registry default). Dedup key `dark:<mmsi>`.
 *
 * @method dark.ais_gap
 * @see ../../../../../docs/METHODOLOGY.md#dark.ais_gap
 */
@RegisterDetector()
@Injectable()
export class DarkDetector implements Detector<DarkConfig> {
  readonly id = 'dark';
  readonly domain = 'surveillance';
  readonly methodIds = ['dark.ais_gap'];
  readonly alertTypes = [DARK_ALERT] as const;
  readonly configSchema = darkConfigSchema;
  readonly tickIntervalMs = TICK_INTERVAL_MS;

  private lastScanAt: number | undefined;

  constructor(
    private readonly recorder: VesselStateRecorder,
    private readonly states: VesselStateStorage,
    private readonly coordinator: AlertCoordinator,
  ) {}

  async onPosition(
    context: DetectorContext<DarkConfig>,
    position: VesselPosition,
  ): Promise<void> {
    await this.coordinator.positionSeen(context.now());
    await this.recorder.observe(context, position);
    const key = darkKey(position.mmsi);
    if (!context.alerts.isOpen(key)) return;
    // The pipeline's `previous` is the last position before the gap (the
    // occurrence's `openedAt` is the raise time, not the last sighting).
    const lastSeen = position.previous?.time ?? null;
    await context.alerts.resolve(key, {
      at: position.time,
      reason: 'AIS reports resumed',
      data: {
        reappearedAt: position.time.toISOString(),
        lastSeenAt: lastSeen?.toISOString() ?? null,
        gapMin:
          lastSeen === null ? null : minutesBetween(lastSeen, position.time),
        lat: position.lat,
        lon: position.lon,
      },
    });
  }

  async onTick(
    context: DetectorContext<DarkConfig>,
    now: Date,
    call: DetectorCall,
  ): Promise<void> {
    const { config } = context;
    if (
      this.lastScanAt !== undefined &&
      now.getTime() - this.lastScanAt < config.CHECK_INTERVAL_S * 1_000
    ) {
      return;
    }
    // Standbys (and an instance that lost the feed) never scan.
    if (!this.coordinator.isActive(now)) return;
    const reference = darkReferenceTime(now, context.pairs.eventTime);
    if (reference === null) return;
    this.lastScanAt = now.getTime();

    const thresholds: DarkThresholds = {
      gapMs: config.GAP_MIN * 60_000,
      minSogKn: config.MIN_SOG_KN,
      harbourDistanceM: config.HARBOUR_DISTANCE_KM * 1_000,
    };
    const silent = await this.states.silent({
      seenBefore: new Date(reference.getTime() - thresholds.gapMs),
      seenAfter: new Date(reference.getTime() - config.MAX_GAP_H * 3_600_000),
      minSogKn: thresholds.minSogKn,
      limit: config.SCAN_LIMIT,
    });
    for (const stored of silent) {
      if (call.signal.aborted) return;
      await this.evaluate(context, stored, reference, thresholds);
    }
  }

  private async evaluate(
    context: DetectorContext<DarkConfig>,
    stored: StoredVesselState,
    reference: Date,
    thresholds: DarkThresholds,
  ): Promise<void> {
    const key = darkKey(stored.mmsi);
    if (context.alerts.isOpen(key)) return;
    // vessel_state writes are throttled: the in-memory state may be newer.
    const memory = context.vessels.get(stored.mmsi);
    const last =
      memory !== undefined && memory.time > stored.time ? memory : stored;
    const harbour = context.zones.nearest(last, {
      kinds: context.config.HARBOUR_ZONE_KINDS,
      maxDistanceM: thresholds.harbourDistanceM,
      // Curated global zones only: org-owned zones never silence the rule.
      orgId: null,
    });
    const harbourDistanceM = harbour?.distanceM ?? null;
    if (!isDarkVessel(last, harbourDistanceM, reference, thresholds)) return;

    const gapMin = minutesBetween(last.time, reference);
    await this.coordinator.exclusive(key, async () => {
      // Another replica may have opened it (the key is aligned now).
      if (context.alerts.isOpen(key)) return;
      await context.alerts.raise({
        type: DARK_ALERT,
        dedupKey: key,
        severity: 'warning',
        mmsi: last.mmsi,
        title: `AIS gap of ${last.mmsi}`,
        message: `Vessel ${last.mmsi} stopped reporting at ${last.time.toISOString()} while under way at ${last.sog.toFixed(1)} kn (silent for ${Math.round(gapMin)} min)`,
        position: last,
        occurredAt: last.time,
        data: {
          lastSeenAt: last.time.toISOString(),
          lastSogKn: last.sog,
          lastCogDeg: last.cog,
          gapMin,
          gapThresholdMin: context.config.GAP_MIN,
          nearestHarbourM: harbourDistanceM,
        },
      });
    });
  }
}
