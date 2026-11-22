import { newId } from '@darmawanweb/ais-its-contracts/domain';
import type { VesselPosition } from '@darmawanweb/ais-its-nest/analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VesselStateStorage } from '../src/detectors/shared/storage.js';
import {
  type ClaimedPair,
  TranshipmentPairStorage,
  type TranshipmentResultRecord,
} from '../src/detectors/transhipment/transhipment-pairs.storage.js';
import type { PairObservation } from '../src/domain/transhipment/pairs.js';
import { Fixtures, minutesAgo, uniqueMmsi } from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

/** Restart window of the accumulation in these tests (the 60-minute route window). */
const ROUTE_WINDOW = { restartAfterMs: 60 * 60_000 };

function sortedPair(): [number, number] {
  return [uniqueMmsi(), uniqueMmsi()].sort((x, y) => x - y) as [number, number];
}

function observation(
  [mmsiA, mmsiB]: readonly [number, number],
  observer: number,
  seenAt: Date,
  priority = 27,
): PairObservation {
  return { mmsiA, mmsiB, observer, priority, distanceM: 20, seenAt };
}

describe('detector storage (PostgreSQL): idempotent state and stored results', () => {
  let service: TestService;
  let fixtures: Fixtures;
  let pairs: TranshipmentPairStorage;
  let states: VesselStateStorage;

  beforeAll(async () => {
    // No position feed: the repositories are used directly.
    service = await startTestService({}, { DETECTORS: 'geofence' });
    fixtures = new Fixtures(service.app);
    pairs = service.app.get(TranshipmentPairStorage);
    states = service.app.get(VesselStateStorage);
  });

  afterAll(async () => {
    await service.app.close();
  });

  const pairRow = async ([a, b]: readonly [number, number]) =>
    (
      await fixtures.rows<{
        priority: number;
        observations: number;
        status: string;
        first_seen_at: Date;
      }>(
        'SELECT priority, observations, status, first_seen_at FROM transhipment_pairs WHERE mmsi_a = $1 AND mmsi_b = $2',
        [a, b],
      )
    )[0];

  it('adds a redelivered observation once, each vessel side independently', async () => {
    const pair = sortedPair();
    const seenAt = minutesAgo(10);
    await pairs.accumulate(
      [observation(pair, pair[0], seenAt)],
      new Date(),
      ROUTE_WINDOW,
    );
    // The same position delivered again (restart, unacknowledged message).
    await pairs.accumulate(
      [observation(pair, pair[0], seenAt)],
      new Date(),
      ROUTE_WINDOW,
    );
    expect(await pairRow(pair)).toMatchObject({
      priority: 27,
      observations: 1,
    });

    // The other vessel's position at the same time is another observation.
    await pairs.accumulate(
      [observation(pair, pair[1], seenAt)],
      new Date(),
      ROUTE_WINDOW,
    );
    await pairs.accumulate(
      [observation(pair, pair[0], minutesAgo(9))],
      new Date(),
      ROUTE_WINDOW,
    );
    expect(await pairRow(pair)).toMatchObject({
      priority: 81,
      observations: 3,
    });
  });

  it('starts a pending accumulation over after the route window', async () => {
    const pair = sortedPair();
    await pairs.accumulate(
      [observation(pair, pair[0], minutesAgo(180), 9)],
      new Date(),
      ROUTE_WINDOW,
    );
    await pairs.accumulate(
      [observation(pair, pair[1], minutesAgo(179), 9)],
      new Date(),
      ROUTE_WINDOW,
    );
    const restartedAt = minutesAgo(30);
    await pairs.accumulate(
      [observation(pair, pair[0], restartedAt, 3)],
      new Date(),
      ROUTE_WINDOW,
    );
    expect(await pairRow(pair)).toMatchObject({
      status: 'pending',
      priority: 3,
      observations: 1,
      first_seen_at: restartedAt,
    });
  });

  it('stores a positive result with the completion of its own claim only', async () => {
    const pair = sortedPair();
    await pairs.accumulate(
      [observation(pair, pair[0], minutesAgo(5))],
      new Date(),
      ROUTE_WINDOW,
    );
    const claimed = await pairs.claim({
      now: new Date(),
      minPriority: 27,
      reanalysisCooldownMs: 0,
      limit: 500,
    });
    const claim = claimed.find((candidate) => candidate.mmsiA === pair[0]);
    if (claim === undefined) throw new Error('pair not claimed');

    const result = (id: string): TranshipmentResultRecord => ({
      id,
      eventId: newId(),
      mmsiA: pair[0],
      mmsiB: pair[1],
      detectedAt: new Date(),
      startAt: minutesAgo(40),
      endAt: minutesAgo(10),
      accuracy: 93,
      averagePriority: 22.5,
      priorityDistribution: { low: 0, medium: 0, high: 100 },
      severity: 'critical',
      position: { lat: 1.15, lon: 104.05 },
      accumulatedPriority: claim.priority,
      observations: claim.observations,
      route1Points: 31,
      route2Points: 31,
      methodId: 'transhipment.accuracy',
    });
    // A stale claim (released and claimed again elsewhere) stores nothing.
    const stale: ClaimedPair = { ...claim, claimedAt: minutesAgo(30) };
    const staleId = newId();
    expect(
      await pairs.complete(
        stale,
        { outcome: 'analysed', result: {}, positive: result(staleId) },
        new Date(),
      ),
    ).toBe(false);

    const id = newId();
    expect(
      await pairs.complete(
        claim,
        {
          outcome: 'analysed',
          result: { isIllegal: true },
          positive: result(id),
        },
        new Date(),
      ),
    ).toBe(true);
    const rows = await fixtures.rows<{
      id: string;
      accuracy: number;
      lat: number;
    }>(
      'SELECT id, accuracy, ST_Y(geom::geometry) AS lat FROM transhipment_results WHERE mmsi_a = $1 AND mmsi_b = $2',
      [pair[0], pair[1]],
    );
    expect(rows).toEqual([{ id, accuracy: 93, lat: 1.15 }]);
    expect(await pairRow(pair)).toMatchObject({
      status: 'completed',
      priority: 0,
    });
  });

  it('prunes pairs not observed within the retention, pending ones included', async () => {
    const old = sortedPair();
    const recent = sortedPair();
    await pairs.accumulate(
      [observation(old, old[0], minutesAgo(8 * 24 * 60))],
      new Date(),
      ROUTE_WINDOW,
    );
    await pairs.accumulate(
      [observation(recent, recent[0], minutesAgo(5))],
      new Date(),
      ROUTE_WINDOW,
    );
    expect(await pairs.prune(minutesAgo(7 * 24 * 60))).toBeGreaterThanOrEqual(
      1,
    );
    expect(await pairRow(old)).toBeUndefined();
    expect(await pairRow(recent)).toMatchObject({ status: 'pending' });
  });

  it('never counts an anomaly streak twice for the same position time', async () => {
    const mmsi = uniqueMmsi();
    const at = minutesAgo(20);
    const position = (time: Date): VesselPosition => ({
      mmsi,
      time,
      source: 'primary',
      lat: 0.5,
      lon: 105.5,
      sog: 6,
      cog: 90,
      hdg: 90,
      navstatus: 1,
      predictedNavstatus: 0,
      coastDistanceM: null,
      previous: null,
    });
    await states.save(position(at), [], { anomalyStreak: 2 });
    await states.save(position(at), [], { anomalyStreak: 3 }); // redelivered
    expect((await states.anomalyStreaks()).get(mmsi)).toEqual({
      streak: 2,
      at,
    });

    await states.save(position(minutesAgo(19)), [], { anomalyStreak: 3 });
    expect((await states.anomalyStreaks()).get(mmsi)?.streak).toBe(3);
  });

  it('restores zero streaks counted within the hour before the newest one', async () => {
    const [recentReset, oldReset] = [uniqueMmsi(), uniqueMmsi()];
    const position = (mmsi: number, time: Date): VesselPosition => ({
      mmsi,
      time,
      source: 'primary',
      lat: 0.6,
      lon: 105.6,
      sog: 6,
      cog: 90,
      hdg: 90,
      navstatus: 0,
      predictedNavstatus: 0,
      coastDistanceM: null,
      previous: null,
    });
    await states.save(position(uniqueMmsi(), new Date()), [], {
      anomalyStreak: 1,
    });
    await states.save(position(recentReset, minutesAgo(30)), [], {
      anomalyStreak: 0,
    });
    await states.save(position(oldReset, minutesAgo(300)), [], {
      anomalyStreak: 0,
    });
    const restored = await states.anomalyStreaks();
    expect(restored.get(recentReset)).toEqual({
      streak: 0,
      at: expect.any(Date) as Date,
    });
    expect(restored.has(oldReset)).toBe(false);
  });
});
