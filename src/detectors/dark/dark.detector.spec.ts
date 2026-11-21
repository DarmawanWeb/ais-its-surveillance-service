import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { MemoryVesselStates } from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { DarkDetector, darkKey } from './dark.detector.js';

const START = new Date('2026-04-01T00:00:00Z');
const DARK = 525000301;
const LIVE = 525000302;
const at = (minutes: number): Date =>
  new Date(START.getTime() + minutes * 60_000);

function setup(env: Record<string, string> = {}) {
  const states = new MemoryVesselStates();
  const recorder = new VesselStateRecorder(states, { writeIntervalMs: 60_000 });
  const harness = DetectorTestHarness.create({
    detectors: [new DarkDetector(recorder, states)],
    env,
    now: START,
  });
  return { harness, states };
}

/** A second vessel keeps reporting, so the feed's event time advances. */
async function liveFeed(
  harness: DetectorTestHarness,
  untilMinute: number,
): Promise<void> {
  for (let minute = 1; minute <= untilMinute; minute += 5) {
    await harness.position({
      mmsi: LIVE,
      time: at(minute),
      lat: 0.5,
      lon: 108,
      sog: 8,
    });
  }
  await harness.position({
    mmsi: LIVE,
    time: at(untilMinute),
    lat: 0.5,
    lon: 108,
    sog: 8,
  });
}

describe('DarkDetector', () => {
  it('reports a moving vessel silent for more than 30 min away from harbours', async () => {
    const { harness } = setup();
    await harness.position({
      mmsi: DARK,
      time: at(0),
      lat: 1.5,
      lon: 105,
      sog: 6,
      cog: 80,
    });
    await liveFeed(harness, 29);
    await harness.tick(at(29));
    expect(harness.alerts).toEqual([]);

    await liveFeed(harness, 31);
    await harness.tick(at(31));
    expect(harness.alertsOf('dark')).toHaveLength(1);
    expect(harness.alertsOf('dark')[0]).toMatchObject({
      dedupKey: darkKey(DARK),
      mmsi: DARK,
      severity: 'warning',
      methodId: 'dark.ais_gap',
      occurredAt: at(0).toISOString(),
      data: { lastSogKn: 6, gapThresholdMin: 30 },
    });
  });

  it('resolves when the vessel reappears', async () => {
    const { harness } = setup();
    await harness.position({
      mmsi: DARK,
      time: at(0),
      lat: 1.5,
      lon: 105,
      sog: 6,
    });
    await liveFeed(harness, 45);
    await harness.tick(at(45));
    await harness.position({
      mmsi: DARK,
      time: at(50),
      lat: 1.6,
      lon: 105.1,
      sog: 6,
    });
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.resolutions[0]).toMatchObject({
      reason: 'AIS reports resumed',
      data: { gapMin: 50 },
    });
  });

  it('ignores slow vessels and vessels near a port or anchorage', async () => {
    const { harness } = setup();
    await harness.zone({
      kind: 'port',
      geometry: { type: 'Point', coordinates: [104.0, 1.0] },
    });
    await harness.position({
      mmsi: DARK,
      time: at(0),
      lat: 1.02,
      lon: 104.0,
      sog: 6,
    }); // ≈ 2.2 km from the port
    await harness.position({
      mmsi: DARK + 10,
      time: at(0),
      lat: 1.5,
      lon: 105,
      sog: 0.8,
    });
    await liveFeed(harness, 60);
    await harness.tick(at(60));
    expect(harness.alerts).toEqual([]);
  });

  it('does not report anything before the feed delivered a position (outage, restart)', async () => {
    const { harness, states } = setup();
    await states.save(
      {
        mmsi: DARK,
        time: at(-120),
        source: 'primary',
        lat: 1.5,
        lon: 105,
        sog: 6,
        cog: 0,
        hdg: 0,
        navstatus: 0,
        predictedNavstatus: 0,
        coastDistanceM: null,
        previous: null,
      },
      [],
    );
    await harness.tick(at(0));
    expect(harness.alerts).toEqual([]);
  });

  it('reads its thresholds from DARK_*', async () => {
    const { harness } = setup({
      DARK_GAP_MIN: '10',
      DARK_CHECK_INTERVAL_S: '1',
    });
    await harness.position({
      mmsi: DARK,
      time: at(0),
      lat: 1.5,
      lon: 105,
      sog: 6,
    });
    await liveFeed(harness, 11);
    await harness.tick(at(11));
    expect(harness.alertsOf('dark')).toHaveLength(1);
  });
});
