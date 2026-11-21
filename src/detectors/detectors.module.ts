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
import { TrackStorage, VesselStateStorage } from './shared/storage.js';
import { TrackPointsRepository } from './shared/track-points.repository.js';
import { VesselStateRecorder } from './shared/vessel-state.recorder.js';
import { VesselStateRepository } from './shared/vessel-state.repository.js';
import { TranshipmentPairsRepository } from './transhipment/transhipment-pairs.repository.js';
import { TranshipmentPairStorage } from './transhipment/transhipment-pairs.storage.js';
import { TranshipmentDetector } from './transhipment/transhipment.detector.js';

/**
 * Neighbour index window of the SDK `PairSearch`, ms: pruning keeps points
 * this long, so it bounds `TRANSHIPMENT_NEIGHBOUR_WINDOW_MIN` (≤ 30).
 */
const PAIR_SEARCH_MAX_AGE_MS = 30 * 60_000;

/**
 * Detector SDK wiring (spec §18). The runner consumes `AIS_POSITION`
 * (durable `surveillance-positions`), keeps the `GEO` and `FLEET` snapshots
 * in memory, runs the detectors enabled by `DETECTORS` and publishes their
 * alerts to `ALERTS` after `DetectorEventsRepository` stored them. Add a
 * detector: a folder under `src/detectors/`, its class in `providers`, its
 * method ids in the catalog and its `<ID>_*` variables in `.env.example`.
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
      persistence: { useClass: DetectorEventsRepository },
    }),
  ],
  controllers: [DetectorsController],
  providers: [
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
    TranshipmentDetector,
    AnomalyDetector,
    DarkDetector,
    GeofenceDetector,
    FishingDetector,
  ],
})
export class DetectorsModule {}
