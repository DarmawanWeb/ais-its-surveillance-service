import { navStatusLabel } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import {
  isAnomalousPosition,
  isSustainedAnomaly,
  nextAnomalyStreak,
} from '../../domain/anomaly.js';
import { AlertCoordinator } from '../shared/alert-coordinator.js';
import { boundedInteger, navStatusList } from '../shared/config-schemas.js';
import { VesselStateStorage } from '../shared/storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';

/** Alert type of the detector (contracts `ALERT_TYPES.anomaly`). */
export const ANOMALY_ALERT = 'anomaly';

/** `ANOMALY_*` variables without the prefix. */
export const anomalyConfigSchema = z.object({
  /** Consecutive anomalous positions before an event (spec §13.8: 3). */
  MIN_POSITIONS: boundedInteger(3, 1, 1_000),
  /** Reported navstatus codes that never count (none: legacy parity). */
  EXCLUDED_NAVSTATUS: navStatusList('none'),
});

/** Parsed `ANOMALY_*` configuration. */
export type AnomalyConfig = z.output<typeof anomalyConfigSchema>;

/** Deduplication key of a vessel's navstatus anomaly. */
export function anomalyKey(mmsi: number): string {
  return `${ANOMALY_ALERT}:${mmsi}`;
}

/** A vessel's streak in memory: the count and the event time of its last counted position, ms. */
interface StreakState {
  readonly streak: number;
  readonly at: number;
}

/** Streaks remembered before zero streaks older than {@link ZERO_STREAK_MEMORY_MS} are dropped. */
const MAX_TRACKED_STREAKS = 250_000;
/** Zero streaks are remembered this long (event time) to ignore redelivered positions, ms. */
const ZERO_STREAK_MEMORY_MS = 60 * 60_000;

/**
 * Navigational status anomaly (legacy web app rule, now server-side): the
 * reported AIS status contradicts the predicted one —
 * `(predicted = 0 ∧ navstatus = 1) ∨ (predicted = 1 ∧ navstatus ≠ 1)` — for
 * `ANOMALY_MIN_POSITIONS` consecutive positions; resolved by the first
 * consistent position. The streak (capped at `ANOMALY_MIN_POSITIONS`) and the
 * event time of its last counted position live in
 * `vessel_state.anomaly_streak` / `anomaly_streak_at` (restored at startup):
 * a position redelivered after a restart that is not newer than the last
 * counted one is evaluated but never counted twice. Severity `info`
 * (registry default). Dedup key `anomaly:<mmsi>`.
 *
 * @method anomaly.navstatus_mismatch
 * @see ../../../../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch
 */
@RegisterDetector()
@Injectable()
export class AnomalyDetector implements Detector<AnomalyConfig> {
  readonly id = 'anomaly';
  readonly domain = 'surveillance';
  readonly methodIds = ['anomaly.navstatus_mismatch'];
  readonly alertTypes = [ANOMALY_ALERT] as const;
  readonly configSchema = anomalyConfigSchema;

  private streaks: Map<number, StreakState> | undefined;
  private loading: Promise<Map<number, StreakState>> | undefined;

  constructor(
    private readonly recorder: VesselStateRecorder,
    private readonly states: VesselStateStorage,
    private readonly coordinator: AlertCoordinator,
  ) {}

  async onPosition(
    context: DetectorContext<AnomalyConfig>,
    position: VesselPosition,
  ): Promise<void> {
    await this.coordinator.positionSeen(context.now());
    const { config } = context;
    const streaks = await this.loadStreaks();
    const known = streaks.get(position.mmsi);
    const previous = known?.streak ?? 0;
    const time = position.time.getTime();
    // Redelivered after a restart (the SDK drops repeats within a run).
    const counted = known !== undefined && time <= known.at;
    const anomalous = isAnomalousPosition(
      position.navstatus,
      position.predictedNavstatus,
      config.EXCLUDED_NAVSTATUS,
    );
    const streak = counted
      ? previous
      : nextAnomalyStreak(previous, anomalous, config.MIN_POSITIONS);

    if (streak === previous) {
      await this.recorder.observe(context, position);
    } else {
      await this.recorder.saveAnomalyStreak(context, position, streak);
      this.remember(streaks, position.mmsi, { streak, at: time });
    }

    const key = anomalyKey(position.mmsi);
    if (isSustainedAnomaly(streak, config.MIN_POSITIONS)) {
      const reported = navStatusLabel(position.navstatus);
      const predicted =
        position.predictedNavstatus === 1 ? 'at anchor' : 'under way';
      await context.alerts.raise({
        type: ANOMALY_ALERT,
        dedupKey: key,
        severity: 'info',
        mmsi: position.mmsi,
        title: `Navigational status anomaly of ${position.mmsi}`,
        message: `Vessel ${position.mmsi} reports "${reported}" (${position.navstatus}) while its motion predicts ${predicted}, ${streak} positions in a row`,
        position,
        occurredAt: position.time,
        data: {
          navstatus: position.navstatus,
          predictedNavstatus: position.predictedNavstatus,
          streak,
          minPositions: config.MIN_POSITIONS,
          sogKn: position.sog,
        },
      });
    } else if (streak === 0 && context.alerts.isOpen(key)) {
      await context.alerts.resolve(key, {
        at: position.time,
        reason: 'navigational status consistent again',
        data: {
          navstatus: position.navstatus,
          predictedNavstatus: position.predictedNavstatus,
        },
      });
    }
  }

  /** The persisted streaks, loaded once (concurrent first calls share the query). */
  private async loadStreaks(): Promise<Map<number, StreakState>> {
    if (this.streaks !== undefined) return this.streaks;
    this.loading ??= this.states.anomalyStreaks().then(
      (stored) => {
        this.streaks = new Map(
          [...stored].map(([mmsi, { streak, at }]) => [
            mmsi,
            { streak, at: at.getTime() },
          ]),
        );
        return this.streaks;
      },
      (error: unknown) => {
        this.loading = undefined;
        throw error;
      },
    );
    return this.loading;
  }

  /** Stores a vessel's new streak; drops old zero streaks when too many are remembered. */
  private remember(
    streaks: Map<number, StreakState>,
    mmsi: number,
    state: StreakState,
  ): void {
    streaks.set(mmsi, state);
    if (streaks.size <= MAX_TRACKED_STREAKS) return;
    const cutoff = state.at - ZERO_STREAK_MEMORY_MS;
    for (const [vessel, known] of streaks) {
      if (known.streak === 0 && known.at < cutoff) streaks.delete(vessel);
    }
  }
}
