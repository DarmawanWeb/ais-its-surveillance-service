import { DetectorRunnerModule } from '@darmawanweb/ais-its-nest/analytics';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { Module } from '@nestjs/common';

import type { Config } from '../config.js';
import { AnomalyDetector } from './anomaly/anomaly.detector.js';
import { DarkDetector } from './dark/dark.detector.js';
import { DetectorEventsRepository } from './detector-events.repository.js';
import { DetectorsController } from './detectors.controller.js';
import { FishingDetector } from './fishing/fishing.detector.js';
import { GeofenceDetector } from './geofence/geofence.detector.js';
import { AlertKeyLock } from './shared/alert-key-lock.js';
import { PostgresAlertKeyLock } from './shared/postgres-alert-key-lock.js';
import { TrackStorage, VesselStateStorage } from './shared/storage.js';
import { TrackPointsRepository } from './shared/track-points.repository.js';
import { VesselStateRecorder } from './shared/vessel-state.recorder.js';
import { VesselStateRepository } from './shared/vessel-state.repository.js';
import { TranshipmentPairsRepository } from './transhipment/transhipment-pairs.repository.js';
import { TranshipmentPairStorage } from './transhipment/transhipment-pairs.storage.js';
import { TranshipmentDetector } from './transhipment/transhipment.detector.js';
import { TranshipmentMetrics } from './transhipment/transhipment.metrics.js';

/**
 * Neighbour index window of the SDK `PairSearch`, ms: pruning keeps points
 * this long, so it bounds `TRANSHIPMENT_NEIGHBOUR_WINDOW_MIN` (≤ 30).
 */
const PAIR_SEARCH_MAX_AGE_MS = 30 * 60_000;

/**
 * Detector SDK wiring (spec §18). The runner consumes `AIS_POSITION`
 * (durable `surveillance-positions`, exclusive: one active instance, hot
 * standbys take over and reload the open occurrences from `events`), keeps
 * the `GEO` and `FLEET` snapshots in memory, runs the detectors enabled by
 * `DETECTORS` and publishes their alerts (`alert.raised.v1`) and resolutions
 * (`alert.resolved.v1`, after the alert cooldown) to `ALERTS` once
 * `DetectorEventsRepository` stored them. The tick analysers raise and
 * resolve through the `AlertKeyLock`, the position-driven detectors open (or
 * escalate) occurrences through `AlertKeyLock.raiseFromPosition` (one
 * occurrence per key across replicas, also when a paused instance resumes).
 * Add a detector: a folder under `src/detectors/`, its class in `providers`
 * (`onActivated` for local state, `context.isActive()` in zone or vessel
 * hooks that raise or resolve, raises through the `AlertKeyLock`), its method
 * ids in the catalog, its message key in `src/domain/messages.ts` and its
 * `<ID>_*` variables in `.env.example`.
 */
@Module({
  imports: [
    DetectorRunnerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Config) => ({
        positions: 'surveillance-positions',
        concurrency: config.DETECTOR_CONCURRENCY,
        alertCooldownMs: config.ALERT_COOLDOWN_MIN * 60_000,
        pairSearch: { cellSizeM: 1_000, maxAgeMs: PAIR_SEARCH_MAX_AGE_MS },
      }),
      // Provides the class itself and ALERT_PERSISTENCE (one instance):
      // never list it in `providers` as well.
      persistence: { useClass: DetectorEventsRepository },
    }),
  ],
  controllers: [DetectorsController],
  providers: [
    { provide: AlertKeyLock, useClass: PostgresAlertKeyLock },
    { provide: VesselStateStorage, useClass: VesselStateRepository },
    { provide: TrackStorage, useClass: TrackPointsRepository },
    { provide: TranshipmentPairStorage, useClass: TranshipmentPairsRepository },
    {
      provide: VesselStateRecorder,
      inject: [VesselStateStorage, APP_CONFIG],
      useFactory: (storage: VesselStateStorage, config: Config) =>
        new VesselStateRecorder(storage, {
          writeIntervalMs: config.VESSEL_STATE_WRITE_INTERVAL_S * 1_000,
        }),
    },
    TranshipmentMetrics,
    TranshipmentDetector,
    AnomalyDetector,
    DarkDetector,
    GeofenceDetector,
    FishingDetector,
  ],
})
export class DetectorsModule {}
