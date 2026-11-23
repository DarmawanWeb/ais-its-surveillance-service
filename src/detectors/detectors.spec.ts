import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { describe, expect, it } from 'vitest';

import { AnomalyDetector } from './anomaly/anomaly.detector.js';
import { DarkDetector } from './dark/dark.detector.js';
import { FishingDetector } from './fishing/fishing.detector.js';
import { GeofenceDetector } from './geofence/geofence.detector.js';
import { DirectAlertKeyLock } from './shared/__testing__/direct-alert-key-lock.js';
import {
  MemoryPairs,
  MemoryTracks,
  MemoryVesselStates,
} from './shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from './shared/vessel-state.recorder.js';
import { TranshipmentDetector } from './transhipment/transhipment.detector.js';
import { TranshipmentMetrics } from './transhipment/transhipment.metrics.js';

const SQUARE: ZoneSnapshotV1['geometry'] = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};

function allDetectors(tracks = new MemoryTracks()) {
  const states = new MemoryVesselStates();
  const recorder = new VesselStateRecorder(states, { writeIntervalMs: 60_000 });
  const lock = new DirectAlertKeyLock();
  return {
    states,
    lock,
    detectors: [
      new TranshipmentDetector(
        recorder,
        states,
        tracks,
        new MemoryPairs(),
        new TranshipmentMetrics(new MetricsService()),
        lock,
      ),
      new AnomalyDetector(recorder, states, lock),
      new DarkDetector(recorder, states, lock),
      new GeofenceDetector(recorder, lock),
      new FishingDetector(recorder, tracks, lock),
    ],
  };
}

describe('surveillance detectors together', () => {
  it('isolates a failing detector: the others still raise their alerts', async () => {
    const tracks = new MemoryTracks();
    tracks.failing = true; // transhipment and fishing cannot store track points
    const harness = DetectorTestHarness.create({
      detectors: allDetectors(tracks).detectors,
      env: { ANOMALY_MIN_POSITIONS: '1' },
    });
    await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.position({
      mmsi: 525000601,
      lat: 1.05,
      lon: 104.05,
      source: 'batam',
      sog: 5,
      navstatus: 1,
      predictedNavstatus: 0,
    });

    expect(harness.alerts.map((alert) => alert.type).sort()).toEqual([
      'anomaly',
      'geofence',
    ]);
    expect(
      harness.logs.some(
        (line) =>
          line.startsWith('error') &&
          line.includes('track storage unavailable'),
      ),
    ).toBe(true);
    expect(await harness.metricsText()).toMatch(
      /aisits_detector_errors_total\{detector="transhipment",hook="onPosition"\} 1/,
    );
  });

  it('enables the DETECTORS subset only', () => {
    const harness = DetectorTestHarness.create({
      detectors: allDetectors().detectors,
      env: { DETECTORS: 'geofence,dark' },
    });
    expect(
      harness.describe().map(({ id, enabled }) => ({ id, enabled })),
    ).toEqual(
      expect.arrayContaining([
        { id: 'geofence', enabled: true },
        { id: 'dark', enabled: true },
        { id: 'transhipment', enabled: false },
        { id: 'anomaly', enabled: false },
        { id: 'fishing', enabled: false },
      ]),
    );
  });

  it('writes vessel_state at most once per interval of event time per vessel', async () => {
    const { detectors, states } = allDetectors();
    const harness = DetectorTestHarness.create({
      detectors,
      env: { DETECTORS: 'dark,geofence' },
    });
    for (let index = 0; index < 12; index++) {
      await harness.position({
        mmsi: 525000602,
        lat: 1.5,
        lon: 105 + index * 0.001,
        sog: 6,
      });
    }
    // 12 positions 10 s apart (110 s): written at 0 s and 60 s only, shared by both detectors.
    expect(states.writes).toBe(2);
  });

  it('declares registry alert types and catalogued method ids', () => {
    const harness = DetectorTestHarness.create({
      detectors: allDetectors().detectors,
    });
    expect(
      harness.logs.filter((line) =>
        line.includes('missing from the methodology catalog'),
      ),
    ).toEqual([]);
    expect(harness.describe().map((detector) => detector.alertTypes)).toEqual([
      ['transhipment'],
      ['anomaly'],
      ['dark'],
      ['geofence'],
      ['fishing'],
    ]);
  });
});
