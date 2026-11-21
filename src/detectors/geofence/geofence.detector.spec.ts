import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { MemoryVesselStates } from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { GeofenceDetector, geofenceKey } from './geofence.detector.js';

const MMSI = 525000401;
const START = new Date('2026-04-01T00:00:00Z');
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
const inside = { mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 5 };
const outside = { mmsi: MMSI, lat: 1.2, lon: 104.2, sog: 5 };

function setup(env: Record<string, string> = {}) {
  const recorder = new VesselStateRecorder(new MemoryVesselStates(), {
    writeIntervalMs: 60_000,
  });
  return DetectorTestHarness.create({
    detectors: [new GeofenceDetector(recorder)],
    env,
    now: START,
  });
}

describe('GeofenceDetector', () => {
  it('raises on entering a restricted zone (critical) and resolves on leaving', async () => {
    const harness = setup();
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Zona A',
      geometry: SQUARE,
    });
    await harness.track([outside, inside, inside]);
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        type: 'geofence',
        severity: 'critical',
        zoneId: zone.id,
        dedupKey: geofenceKey(MMSI, zone.id),
        methodId: 'geo.geofence_enter',
      }),
    ]);
    await harness.position(outside);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'left the zone' }),
    ]);
  });

  it('grades mpa/custom zones as warning and ignores zones without alertOnEnter or other kinds', async () => {
    const harness = setup();
    await harness.zone({ kind: 'mpa', alertOnEnter: true, geometry: SQUARE });
    await harness.zone({
      kind: 'custom',
      alertOnEnter: false,
      geometry: SQUARE,
    });
    await harness.zone({
      kind: 'fishing_ground',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.position(inside);
    expect(harness.alerts.map((alert) => alert.severity)).toEqual(['warning']);
  });

  it('applies organization zones to the vessels of that organization only', async () => {
    const harness = setup();
    const orgId = '0190d6b4-0000-7000-8000-000000000001';
    await harness.zone({
      kind: 'custom',
      alertOnEnter: true,
      orgId,
      geometry: SQUARE,
    });
    await harness.position(inside);
    expect(harness.alerts).toEqual([]);

    await harness.vessel({ mmsi: MMSI + 1, orgId });
    await harness.position({ ...inside, mmsi: MMSI + 1 });
    expect(harness.alerts).toEqual([
      expect.objectContaining({ mmsi: MMSI + 1 }),
    ]);
  });

  it('resolves open occurrences when the zone is deleted or stops alerting', async () => {
    const harness = setup();
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.position(inside);
    await harness.removeZone(zone.id);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'zone deleted' }),
    ]);
  });

  it('suppresses a re-entry within the alert cooldown', async () => {
    const harness = setup();
    await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.track([inside, outside, inside]);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.updates).toEqual([
      expect.objectContaining({ reason: 'suppressed', reopened: true }),
    ]);

    harness.advance(11 * 60_000);
    await harness.track([outside, inside]);
    expect(harness.alerts).toHaveLength(2);
  });

  it('counts the zone buffer unless GEOFENCE_USE_BUFFER=false', async () => {
    const nearby = { ...outside, lat: 1.1005, lon: 104.05 }; // ≈ 55 m north of the edge
    const buffered = setup();
    await buffered.zone({
      kind: 'restricted',
      alertOnEnter: true,
      bufferM: 100,
      geometry: SQUARE,
    });
    await buffered.position(nearby);
    expect(buffered.alerts).toHaveLength(1);

    const strict = setup({ GEOFENCE_USE_BUFFER: 'false' });
    await strict.zone({
      kind: 'restricted',
      alertOnEnter: true,
      bufferM: 100,
      geometry: SQUARE,
    });
    await strict.position(nearby);
    expect(strict.alerts).toEqual([]);
  });
});
