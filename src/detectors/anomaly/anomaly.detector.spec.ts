import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { LocalAlertCoordinator } from '../shared/__testing__/local-alert-coordinator.js';
import { MemoryVesselStates } from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { AnomalyDetector, anomalyKey } from './anomaly.detector.js';

const MMSI = 525000201;
const START = new Date('2026-04-01T00:00:00Z');

function setup(
  env: Record<string, string> = {},
  states = new MemoryVesselStates(),
) {
  const recorder = new VesselStateRecorder(states, { writeIntervalMs: 60_000 });
  const harness = DetectorTestHarness.create({
    detectors: [
      new AnomalyDetector(recorder, states, new LocalAlertCoordinator()),
    ],
    env,
    now: START,
  });
  return { harness, states };
}

/** A vessel reporting "at anchor" (1) while predicted under way (0). */
const anomalous = {
  mmsi: MMSI,
  lat: 1.1,
  lon: 104.1,
  sog: 6,
  navstatus: 1,
  predictedNavstatus: 0,
} as const;
const consistent = { ...anomalous, navstatus: 0 } as const;

describe('AnomalyDetector', () => {
  it('raises after ANOMALY_MIN_POSITIONS consecutive anomalous positions', async () => {
    const { harness, states } = setup();
    await harness.track([anomalous, anomalous]);
    expect(harness.alerts).toEqual([]);
    expect(states.states.get(MMSI)?.anomalyStreak).toBe(2);

    await harness.position(anomalous);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]).toMatchObject({
      type: 'anomaly',
      severity: 'info',
      dedupKey: anomalyKey(MMSI),
      methodId: 'anomaly.navstatus_mismatch',
      data: { navstatus: 1, predictedNavstatus: 0, streak: 3 },
    });

    await harness.position(anomalous); // still the same occurrence
    expect(harness.alerts).toHaveLength(1);
  });

  it('resolves when the status is consistent again, and a break restarts the count', async () => {
    const { harness, states } = setup();
    await harness.track([anomalous, anomalous, anomalous, consistent]);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: 'navigational status consistent again',
      }),
    ]);
    expect(states.states.get(MMSI)?.anomalyStreak).toBe(0);

    harness.clearRecords();
    await harness.track([
      anomalous,
      anomalous,
      consistent,
      anomalous,
      anomalous,
    ]);
    expect(harness.alerts).toEqual([]);
  });

  it('flags "predicted at anchor" with any other reported status (legacy rule)', async () => {
    const { harness } = setup({ ANOMALY_MIN_POSITIONS: '1' });
    await harness.position({
      ...anomalous,
      sog: 0,
      navstatus: 5,
      predictedNavstatus: 1,
    });
    expect(harness.alertsOf('anomaly')).toHaveLength(1);
  });

  it('ignores excluded reported codes', async () => {
    const { harness } = setup({
      ANOMALY_MIN_POSITIONS: '1',
      ANOMALY_EXCLUDED_NAVSTATUS: '15',
    });
    await harness.position({
      ...anomalous,
      navstatus: 15,
      predictedNavstatus: 1,
    });
    expect(harness.alerts).toEqual([]);
  });

  it('continues a streak restored from vessel_state after a restart', async () => {
    const states = new MemoryVesselStates();
    await states.save(stored(START), [], { anomalyStreak: 2 });
    const { harness } = setup({}, states);
    await harness.position({ ...anomalous, time: minutesLater(1) });
    expect(harness.alertsOf('anomaly')).toHaveLength(1);
    expect(harness.alertsOf('anomaly')[0]).toMatchObject({
      data: { streak: 3 },
    });
  });

  it('does not count a position redelivered after a restart twice', async () => {
    const states = new MemoryVesselStates();
    // Two anomalous positions were counted before the crash, the second at START.
    await states.save(stored(START), [], { anomalyStreak: 2 });
    const { harness } = setup({}, states);
    // The unacknowledged second position comes again (same vessel and time).
    await harness.position({ ...anomalous, time: START });
    expect(harness.alertsOf('anomaly')).toEqual([]);
    expect(states.states.get(MMSI)?.anomalyStreak).toBe(2);

    await harness.position({ ...anomalous, time: minutesLater(1) });
    expect(harness.alertsOf('anomaly')).toHaveLength(1);
  });

  it('ignores an older position redelivered after the streak was reset', async () => {
    const states = new MemoryVesselStates();
    await states.save(stored(START), [], { anomalyStreak: 0 });
    const { harness } = setup({}, states);
    await harness.track([
      { ...anomalous, time: minutesLater(-1) }, // redelivered, already handled
      { ...anomalous, time: minutesLater(1) },
      { ...anomalous, time: minutesLater(2) },
    ]);
    expect(harness.alertsOf('anomaly')).toEqual([]);
    expect(states.states.get(MMSI)?.anomalyStreak).toBe(2);
  });

  it('stops rewriting vessel_state on every position once the anomaly is sustained', async () => {
    const { harness, states } = setup();
    for (let index = 0; index < 10; index++) {
      await harness.position({
        ...anomalous,
        time: new Date(START.getTime() + index * 10_000),
      });
    }
    expect(harness.alertsOf('anomaly')).toHaveLength(1);
    // Streak 1, 2, 3 (capped), then the 60 s throttle: one write at +80 s.
    expect(states.writes).toBe(4);
    expect(states.states.get(MMSI)?.anomalyStreak).toBe(3);
  });
});

/** Minutes after START. */
function minutesLater(minutes: number): Date {
  return new Date(START.getTime() + minutes * 60_000);
}

/** The anomalous position as stored before a restart. */
function stored(time: Date) {
  return {
    ...anomalous,
    time,
    source: 'primary',
    cog: 0,
    hdg: 511,
    coastDistanceM: null,
    previous: null,
  } as const;
}
