import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { describe, expect, it, vi } from 'vitest';

import { DirectAlertKeyLock } from '../shared/__testing__/direct-alert-key-lock.js';
import {
  MemoryPairs,
  MemoryTracks,
  MemoryVesselStates,
} from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { TranshipmentDetector } from './transhipment.detector.js';
import { TranshipmentMetrics } from './transhipment.metrics.js';

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
  const metrics = new MetricsService();
  const lock = new DirectAlertKeyLock();
  const harness = DetectorTestHarness.create({
    detectors: [
      new TranshipmentDetector(
        recorder,
        states,
        tracks,
        pairs,
        new TranshipmentMetrics(metrics),
        lock,
      ),
    ],
    env,
    now: START,
  });
  return { harness, states, tracks, pairs, metrics, lock };
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
    const { harness, pairs, tracks, metrics } = setup();
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
    const exposition = await metrics.render();
    expect(exposition).toContain(
      'aisits_surveillance_transhipment_observations_total 121',
    );
    expect(exposition).toContain(
      'aisits_surveillance_transhipment_analyses_total{outcome="illegal"} 1',
    );
    expect(exposition).toContain(
      'aisits_surveillance_transhipment_pairs{status="completed"} 1',
    );
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

    // A vessel elsewhere keeps the feed moving: this instance is still the active one.
    await harness.position({
      mmsi: C + 1,
      time: at(56.5),
      source: 'primary',
      lat: 2,
      lon: 105,
      sog: 10,
      cog: 0,
      hdg: 0,
    });
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

  describe('cold-start candidate search (tenancy, spec §8.5)', () => {
    const AREA: ZoneSnapshotV1['geometry'] = {
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
    };

    /** B was stored (inside the zone) before a restart; A (Batam) reports next to it. */
    async function coldStart(neighbourOrgId: string, zoneOrgId: string) {
      const { harness, states, pairs } = setup();
      const zone = await harness.zone({
        kind: 'transhipment_area',
        orgId: zoneOrgId,
        geometry: AREA,
      });
      await harness.vessel({ mmsi: B, orgId: neighbourOrgId });
      await states.save(
        {
          mmsi: B,
          time: at(0),
          source: 'primary',
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
        // As written before the tenancy fix (any organization's zone).
        [zone.id],
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
      return pairs.get(A, B);
    }

    it("counts a stored neighbour inside its own organization's area", async () => {
      const orgId = newId();
      expect(await coldStart(orgId, orgId)).toMatchObject({ priority: 27 });
    });

    it("ignores a stored neighbour inside another tenant's private area", async () => {
      expect(await coldStart(newId(), newId())).toBeUndefined();
    });
  });

  it('analyses only on the active instance, at the first tick after a takeover', async () => {
    const { harness, pairs, lock } = setup();
    await sideBySide(harness, 60);
    // Another instance took over: ticks do nothing here.
    await harness.deactivate();
    await harness.tick(at(66));
    expect(pairs.get(A, B)).toMatchObject({ status: 'pending', analyses: 0 });
    expect(harness.alertsOf('transhipment')).toEqual([]);

    await harness.activate();
    await harness.tick(at(67));
    expect(pairs.get(A, B)).toMatchObject({ analyses: 1 });
    expect(lock.keys).toEqual([`transhipment:${A}:${B}`]);
    expect(harness.alertsOf('transhipment')[0]?.data).toMatchObject({
      messageKey: 'surveillance.transhipment.suspected',
      messageParams: { mmsi: A, relatedMmsi: B, accuracy: 100 },
    });
  });

  it("searches stored neighbours again after a takeover (the index missed the other instance's positions)", async () => {
    const { harness, states, pairs } = setup();
    // Active for longer than the cold-start window (C is a candidate far away).
    for (const minute of [0, 10])
      await harness.position({
        mmsi: C,
        time: at(minute),
        source: 'batam',
        lat: 2,
        lon: 105,
        sog: 10,
      });
    await harness.deactivate();
    // Meanwhile the other instance handled B and stored its state.
    await states.save(
      {
        mmsi: B,
        time: at(20),
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
    await harness.activate();
    await harness.position({
      mmsi: A,
      time: at(21),
      source: 'batam',
      lat: 1.15,
      lon: 104.05,
      sog: 0.4,
      cog: 45,
      hdg: 45,
    });
    expect(pairs.get(A, B)).toMatchObject({ priority: 27 });
  });

  it('stores every positive analysis as a result of the occurrence', async () => {
    const { harness, pairs } = setup({
      TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN: '0',
      TRANSHIPMENT_PAIR_EXPIRY_MIN: '120',
    });
    await sideBySide(harness, 40);
    await harness.tick(at(41));
    await sideBySide(harness, 39, { offsetMin: 41, lat: 1.15 + 40 * 0.000_05 });
    await harness.tick(at(81));

    const [alert] = harness.alertsOf('transhipment');
    expect(harness.alertsOf('transhipment')).toHaveLength(1);
    expect(pairs.results).toHaveLength(2);
    expect(pairs.results.map((result) => result.eventId)).toEqual([
      alert?.id,
      alert?.id,
    ]);
    const [first, second] = pairs.results;
    expect(first).toMatchObject({
      mmsiA: A,
      mmsiB: B,
      accuracy: 100,
      averagePriority: 27,
      priorityDistribution: { low: 0, medium: 0, high: 100 },
      severity: 'critical',
      methodId: 'transhipment.accuracy',
    });
    // One result per analysis (legacy): the second covers the later window
    // while the occurrence (and its event data) stays the first one.
    expect(second?.startAt.getTime()).toBeGreaterThan(
      first?.startAt.getTime() ?? Infinity,
    );
    expect(alert?.data.startTimestamp).toBe(first?.startAt.toISOString());
    expect(alert?.data).not.toHaveProperty('orgId');
    expect(alert?.data).not.toHaveProperty('relatedOrgId');
  });

  it('counts a redelivered position once (restart with the same queue)', async () => {
    const { harness, pairs, states, tracks } = setup();
    await sideBySide(harness, 2);
    const before = pairs.get(A, B);
    expect(before).toMatchObject({ observations: 5, priority: 5 * 27 });

    // A new instance (empty SDK state) receives B's last position again.
    const restarted = DetectorTestHarness.create({
      detectors: [
        new TranshipmentDetector(
          new VesselStateRecorder(states, { writeIntervalMs: 60_000 }),
          states,
          tracks,
          pairs,
          new TranshipmentMetrics(new MetricsService()),
          new DirectAlertKeyLock(),
        ),
      ],
      now: at(3),
    });
    await restarted.position({
      mmsi: B,
      time: new Date(at(2).getTime() + 15_000),
      source: 'batam',
      lat: 1.15 + 2 * 0.000_05 + 0.000_18,
      lon: 104.05,
      sog: 0.5,
      cog: 46,
      hdg: 46,
    });
    expect(pairs.get(A, B)).toMatchObject({
      observations: 5,
      priority: 5 * 27,
    });
  });

  it('starts a pending accumulation over when the pair was not observed within the route window', async () => {
    const { harness, pairs } = setup({ TRANSHIPMENT_MIN_PRIORITY: '1000' });
    await sideBySide(harness, 2);
    expect(pairs.get(A, B)).toMatchObject({ status: 'pending', priority: 135 });

    // A brief encounter two hours later does not add up with the first one.
    await sideBySide(harness, 1, { offsetMin: 120 });
    expect(pairs.get(A, B)).toMatchObject({
      status: 'pending',
      priority: 3 * 27,
      observations: 3,
      // B's first fix of the new encounter observes A.
      firstSeenAt: new Date(at(120).getTime() + 15_000),
    });
  });

  it('marks a pair failed without the values a failed statement bound', async () => {
    const { harness, pairs, tracks, metrics } = setup();
    await sideBySide(harness, 60);
    // drizzle's DrizzleQueryError: its message and params list every bound value.
    const driver = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014', severity: 'ERROR' },
    );
    const failed = Object.assign(
      new Error(
        'Failed query: SELECT time FROM track_points WHERE mmsi = $1\nparams: 525000101,KM Rahasia',
      ),
      {
        query: 'SELECT time FROM track_points WHERE mmsi = $1',
        params: [A, 'KM Rahasia'],
        cause: driver,
      },
    );
    vi.spyOn(tracks, 'route').mockRejectedValue(failed);

    await harness.tick(at(61));

    const pair = pairs.get(A, B);
    expect(pair).toMatchObject({
      status: 'failed',
      lastError: 'canceling statement due to statement timeout',
    });
    expect(harness.alertsOf('transhipment')).toEqual([]);
    expect(await metrics.render()).toContain(
      'aisits_surveillance_transhipment_analyses_total{outcome="failed"} 1',
    );
  });
});
