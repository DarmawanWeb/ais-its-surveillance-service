import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  DetectorTestHarness,
  type TestPositionInput,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { DirectAlertKeyLock } from '../shared/__testing__/direct-alert-key-lock.js';
import {
  MemoryTracks,
  MemoryVesselStates,
} from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { FishingDetector, fishingKey } from './fishing.detector.js';

const MMSI = 525000501;
const START = new Date('2026-04-01T00:00:00Z');
const GROUND: ZoneSnapshotV1['geometry'] = {
  type: 'Polygon',
  coordinates: [
    [
      [106, -6],
      [106.5, -6],
      [106.5, -5.5],
      [106, -5.5],
      [106, -6],
    ],
  ],
};
const at = (minutes: number): Date =>
  new Date(START.getTime() + minutes * 60_000);

/** A zigzag inside the ground: 2.5 kn, course alternating 40°/160° every 3 min. */
function zigzag(minutes: number, fromMinute = 0): TestPositionInput[] {
  return Array.from({ length: Math.floor(minutes / 3) + 1 }, (_, index) => ({
    mmsi: MMSI,
    time: at(fromMinute + index * 3),
    lat: -5.8 + index * 0.0005,
    lon: 106.2 + (index % 2) * 0.0005,
    sog: 2.5,
    cog: index % 2 === 0 ? 40 : 160,
  }));
}

function setup(
  env: Record<string, string> = {},
  tracks = new MemoryTracks(),
  lock = new DirectAlertKeyLock(),
) {
  const recorder = new VesselStateRecorder(new MemoryVesselStates(), {
    writeIntervalMs: 60_000,
  });
  const harness = DetectorTestHarness.create({
    detectors: [new FishingDetector(recorder, tracks, lock)],
    env,
    now: START,
  });
  return { harness, tracks, lock };
}

describe('FishingDetector', () => {
  it('raises a warning after 30 min of loitering in a fishing ground', async () => {
    const { harness, tracks } = setup();
    const zone = await harness.zone({
      kind: 'fishing_ground',
      name: 'WPP 712',
      geometry: GROUND,
    });
    await harness.track(zigzag(27));
    expect(harness.alerts).toEqual([]);

    await harness.track(zigzag(3, 30).slice(0, 1));
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]).toMatchObject({
      type: 'fishing',
      severity: 'warning',
      zoneId: zone.id,
      dedupKey: fishingKey(MMSI, zone.id),
      methodId: 'fishing.loitering',
      occurredAt: at(0).toISOString(),
      data: { zoneKind: 'fishing_ground', positions: 11, durationMin: 30 },
    });
    expect(tracks.points.get(MMSI)?.size).toBe(11);
  });

  it('opens an occurrence through the key lock, never from a position older than its last end', async () => {
    const lock = new DirectAlertKeyLock();
    const { harness } = setup({}, new MemoryTracks(), lock);
    const zone = await harness.zone({
      kind: 'fishing_ground',
      name: 'WPP 713',
      geometry: GROUND,
    });
    const key = fishingKey(MMSI, zone.id);
    // Another instance ended the occurrence at minute 31 (it handled newer fixes).
    lock.endedAt.set(key, at(31));
    await harness.track(zigzag(30));
    expect(lock.keys).toEqual([key]);
    expect(harness.alerts).toEqual([]);

    // A newer fix opens it (the staleness check uses the position, not the run start).
    await harness.track(zigzag(3, 33).slice(0, 1));
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        dedupKey: key,
        occurredAt: at(0).toISOString(),
      }),
    ]);
  });

  it('is critical in a restricted zone', async () => {
    const { harness } = setup();
    await harness.zone({ kind: 'restricted', geometry: GROUND });
    await harness.track(zigzag(33));
    expect(harness.alerts.map((alert) => alert.severity)).toEqual(['critical']);
  });

  it('ignores straight transits, fast vessels and positions outside the zones', async () => {
    const { harness } = setup();
    await harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await harness.track(zigzag(60).map((fix) => ({ ...fix, cog: 90 })));
    await harness.track(
      zigzag(60).map((fix) => ({ ...fix, mmsi: MMSI + 1, sog: 9 })),
    );
    await harness.track(
      zigzag(60).map((fix) => ({ ...fix, mmsi: MMSI + 2, lat: -4 })),
    );
    expect(harness.alerts).toEqual([]);
  });

  it('resolves when the vessel leaves the zone', async () => {
    const { harness } = setup();
    await harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await harness.track(zigzag(33));
    await harness.position({
      mmsi: MMSI,
      time: at(40),
      lat: -4,
      lon: 106.2,
      sog: 8,
    });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'left the zone' }),
    ]);
  });

  it('resolves when the pattern stopped for FISHING_RESOLVE_AFTER_MIN', async () => {
    const { harness } = setup({ FISHING_RESOLVE_AFTER_MIN: '10' });
    await harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await harness.track(zigzag(33));
    await harness.position({
      mmsi: MMSI,
      time: at(36),
      lat: -5.7,
      lon: 106.2,
      sog: 7,
    });
    expect(harness.resolutions).toEqual([]);
    await harness.position({
      mmsi: MMSI,
      time: at(44),
      lat: -5.69,
      lon: 106.2,
      sog: 7,
    });
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'loitering pattern ended' }),
    ]);
  });

  it('rebuilds the run from stored track points after a restart', async () => {
    const tracks = new MemoryTracks();
    const first = setup({}, tracks);
    await first.harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await first.harness.track(zigzag(24));
    expect(first.harness.alerts).toEqual([]);

    const restarted = setup({}, tracks);
    await restarted.harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await restarted.harness.track(zigzag(6, 27));
    expect(restarted.harness.alertsOf('fishing')).toHaveLength(1);
  });

  it("rebuilds the run from the stored track after a takeover (the other instance's fixes count)", async () => {
    const { harness, tracks } = setup();
    await harness.zone({ kind: 'fishing_ground', geometry: GROUND });
    await harness.track(zigzag(9)); // minutes 0–9 in this instance's run
    await harness.deactivate();
    // The other instance handled minutes 12–27 and stored them.
    for (const fix of zigzag(15, 12).map((fix, index) => ({
      ...fix,
      lat: -5.8 + (index + 4) * 0.0005,
    })))
      await tracks.append({
        ...fix,
        time: fix.time ?? START,
        source: 'primary',
        sog: fix.sog ?? 0,
        cog: fix.cog ?? 0,
        hdg: 511,
        navstatus: 0,
        predictedNavstatus: 0,
        coastDistanceM: null,
        previous: null,
      });
    await harness.activate();
    await harness.track(zigzag(3, 30).slice(0, 1));
    expect(harness.alertsOf('fishing')).toEqual([
      expect.objectContaining({
        occurredAt: at(0).toISOString(),
        data: expect.objectContaining({
          durationMin: 30,
          messageKey: 'surveillance.fishing.loitering',
        }) as unknown,
      }),
    ]);
  });
});
