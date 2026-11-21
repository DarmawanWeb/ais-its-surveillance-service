import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import {
  MemoryPairs,
  MemoryTracks,
  MemoryVesselStates,
} from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { TranshipmentDetector } from './transhipment.detector.js';

const START = new Date('2026-03-01T00:00:00.000Z');
const A = 525000101;
const B = 525000102;
const C = 525000103;
const at = (minutes: number): Date =>
  new Date(START.getTime() + minutes * 60_000);

function setup(env: Record<string, string> = {}) {
  const states = new MemoryVesselStates();
  const tracks = new MemoryTracks();
  const pairs = new MemoryPairs();
  const recorder = new VesselStateRecorder(states, { writeIntervalMs: 60_000 });
  const harness = DetectorTestHarness.create({
    detectors: [new TranshipmentDetector(recorder, states, tracks, pairs)],
    env,
    now: START,
  });
  return { harness, states, tracks, pairs };
}

/** Two vessels drifting side by side (≈ 20 m apart), one fix per minute each. */
async function sideBySide(
  harness: DetectorTestHarness,
  minutes: number,
  options: {
    source?: 'batam' | 'primary';
    lat?: number;
    offsetMin?: number;
  } = {},
): Promise<void> {
  const lat = options.lat ?? 1.15;
  for (let minute = 0; minute <= minutes; minute++) {
    const time = at((options.offsetMin ?? 0) + minute);
    const drift = minute * 0.000_05;
    await harness.position({
      mmsi: A,
      time,
      source: options.source ?? 'batam',
      lat: lat + drift,
      lon: 104.05,
      sog: 0.4,
      cog: 45,
      hdg: 45,
    });
    await harness.position({
      mmsi: B,
      time: new Date(time.getTime() + 15_000),
      source: options.source ?? 'batam',
      lat: lat + drift + 0.000_18,
      lon: 104.05,
      sog: 0.5,
      cog: 46,
      hdg: 46,
    });
  }
}

describe('TranshipmentDetector', () => {
  it('accumulates candidate priorities and raises an event from the analysis', async () => {
    const { harness, pairs, tracks } = setup();
    await sideBySide(harness, 60);

    const pair = pairs.get(A, B);
    expect(pair).toMatchObject({ status: 'pending', mmsiA: A, mmsiB: B });
    // 121 observations (every fix after the first one of A), legacy product 27 each.
    expect(pair?.observations).toBe(121);
    expect(pair?.priority).toBe(121 * 27);
    expect(tracks.points.get(A)?.size).toBe(61);

    await harness.tick(at(61));
    const [alert] = harness.alertsOf('transhipment');
    expect(alert).toMatchObject({
      type: 'transhipment',
      domain: 'surveillance',
      dedupKey: `transhipment:${A}:${B}`,
      mmsi: A,
      relatedMmsi: B,
      methodId: 'transhipment.accuracy',
      severity: 'critical',
      data: {
        isIllegal: true,
        accuracy: 100,
        averagePriority: 27,
        priorityDistribution: { low: 0, medium: 0, high: 100 },
        accumulatedPriority: 121 * 27,
        route1Points: 60,
        route2Points: 60,
      },
    });
    expect(alert?.data.startTimestamp).toEqual(expect.any(String));
    expect(pairs.get(A, B)).toMatchObject({
      status: 'completed',
      priority: 0,
      analyses: 1,
    });
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([]);
  });

  it('ignores vessels that are not candidates (other sources, outside transhipment areas)', async () => {
    const { harness, pairs, tracks } = setup();
    await sideBySide(harness, 10, { source: 'primary' });
    expect(pairs.pairs.size).toBe(0);
    expect(tracks.points.size).toBe(0);
  });

  it('treats vessels inside a transhipment_area zone as candidates', async () => {
    const { harness, pairs } = setup();
    await harness.zone({
      kind: 'transhipment_area',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [104, 1.1],
            [104.1, 1.1],
            [104.1, 1.2],
            [104, 1.2],
            [104, 1.1],
          ],
        ],
      },
    });
    await sideBySide(harness, 5, { source: 'primary' });
    expect(pairs.get(A, B)?.priority).toBeGreaterThan(0);
  });

  it('keeps the legacy queue order and skips pairs analysed within the cooldown', async () => {
    const { harness, pairs } = setup({ TRANSHIPMENT_ANALYSIS_BATCH: '1' });
    await sideBySide(harness, 40);
    // A weaker pair: C near A only at the end (location priority 1).
    await harness.position({
      mmsi: C,
      time: at(40.5),
      source: 'batam',
      lat: 1.15 + 40 * 0.000_05 + 0.003,
      lon: 104.05,
      sog: 0.4,
      cog: 45,
      hdg: 45,
    });
    await harness.position({
      mmsi: A,
      time: at(40.6),
      source: 'batam',
      lat: 1.15 + 40 * 0.000_05,
      lon: 104.05,
      sog: 0.4,
      cog: 45,
      hdg: 45,
    });
    expect(pairs.get(A, C)?.priority).toBeLessThan(
      pairs.get(A, B)?.priority ?? 0,
    );

    await harness.tick(at(41));
    expect(pairs.get(A, B)?.status).toBe('completed'); // highest priority first
    expect(pairs.get(A, C)?.status).toBe('pending');

    // New observations re-queue A-B, but it was analysed less than 15 min ago.
    await sideBySide(harness, 1, { offsetMin: 41, lat: 1.15 + 40 * 0.000_05 });
    expect(pairs.get(A, B)?.status).toBe('pending');
    await harness.tick(at(42));
    expect(pairs.get(A, C)?.status).toBe('completed');
    expect(pairs.get(A, B)).toMatchObject({ status: 'pending', analyses: 1 });

    await harness.tick(at(57));
    expect(pairs.get(A, B)).toMatchObject({ analyses: 2 });
  });

  it('resolves the occurrence when a later analysis is negative or the pair expires', async () => {
    const { harness } = setup({
      TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN: '0',
      TRANSHIPMENT_PAIR_EXPIRY_MIN: '30',
    });
    await sideBySide(harness, 40);
    await harness.tick(at(41));
    expect(harness.alertsOf('transhipment')).toHaveLength(1);

    // Another vessel keeps the feed moving; A and B are no longer observed together.
    for (let minute = 42; minute <= 80; minute += 2) {
      await harness.position({
        mmsi: C,
        time: at(minute),
        source: 'primary',
        lat: 2,
        lon: 105,
        sog: 10,
        cog: 0,
        hdg: 0,
      });
    }
    await harness.tick(at(81));
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'pair no longer observed together' }),
    ]);
  });

  it('uses stored vessel states while the in-memory index is cold', async () => {
    const { harness, states, pairs } = setup();
    // B was stored before a restart; the detector only sees A after it.
    await states.save(
      {
        mmsi: B,
        time: at(0),
        source: 'batam',
        lat: 1.15018,
        lon: 104.05,
        sog: 0.5,
        cog: 46,
        hdg: 46,
        navstatus: 0,
        predictedNavstatus: 0,
        coastDistanceM: null,
        previous: null,
      },
      [],
    );
    await harness.position({
      mmsi: A,
      time: at(1),
      source: 'batam',
      lat: 1.15,
      lon: 104.05,
      sog: 0.4,
      cog: 45,
      hdg: 45,
    });
    expect(pairs.get(A, B)).toMatchObject({ priority: 27, observations: 1 });
  });

  it('describes its methods and thresholds', () => {
    const { harness } = setup({ TRANSHIPMENT_ACCURACY_THRESHOLD: '75' });
    const [description] = harness.describe();
    expect(description).toMatchObject({
      id: 'transhipment',
      enabled: true,
      config: {
        ACCURACY_THRESHOLD: 75,
        NEIGHBOUR_RADIUS_M: 600,
        SOURCES: ['batam'],
      },
    });
    expect(description?.methodIds).toEqual(
      expect.arrayContaining([
        'transhipment.candidate_queue',
        'transhipment.route_interpolation',
      ]),
    );
  });

  it('refuses a configuration without candidates', () => {
    expect(() =>
      setup({ TRANSHIPMENT_SOURCES: 'none', TRANSHIPMENT_ZONE_KINDS: 'none' }),
    ).toThrow(/TRANSHIPMENT_SOURCES/);
  });
});
