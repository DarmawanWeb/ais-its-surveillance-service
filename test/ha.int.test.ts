import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { AlertEmitter, ZoneIndex } from '@darmawanweb/ais-its-nest/analytics';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AlertCoordinator } from '../src/detectors/shared/alert-coordinator.js';
import {
  Fixtures,
  minutesAgo,
  type PositionInput,
  square,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

const DETECTOR_ENV = {
  DETECTORS: 'transhipment,geofence',
  TRANSHIPMENT_ANALYSIS_INTERVAL_S: '1',
  TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN: '0',
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two replicas on one durable position consumer (spec §18): the first one
 * started is pinned (active), the second is a hot standby that takes over
 * when the active one stops (after the pinned TTL, 30 s).
 */
describe('replicas: active instance, hot standby and takeover', () => {
  let active: TestService;
  let standby: TestService;
  let fixtures: Fixtures;
  let activeClosed = false;

  beforeAll(async () => {
    // A durable of this file only: the replicas never share a feed with other tests.
    const env = { NATS_DURABLE_PREFIX: `ha${Date.now().toString(36)}-` };
    active = await startTestService(env, DETECTOR_ENV);
    standby = await startTestService(env, DETECTOR_ENV);
    fixtures = new Fixtures(active.app);
  });

  afterAll(async () => {
    await standby.app.close();
    if (!activeClosed) await active.app.close();
  });

  const eventRows = (dedupKey: string, from: Fixtures = fixtures) =>
    from.rows<{ id: string; resolved_at: Date | null }>(
      'SELECT id, resolved_at FROM events WHERE dedup_key = $1 ORDER BY created_at',
      [dedupKey],
    );

  const metric = async (
    service: TestService,
    name: string,
  ): Promise<number> => {
    const response = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    return response.body
      .split('\n')
      .filter((line) => line.startsWith(name))
      .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
  };

  it('analyses transhipment pairs on the active instance only: one occurrence, one alert', async () => {
    const [a, b] = [uniqueMmsi(), uniqueMmsi()].sort((x, y) => x - y) as [
      number,
      number,
    ];
    // Away from the other files' Batam pairs: this file's new durable replays the stream.
    const positions: PositionInput[] = [];
    for (let minute = 62; minute >= 1; minute--) {
      const drift = (62 - minute) * 0.000_05;
      positions.push(
        {
          mmsi: a,
          time: minutesAgo(minute),
          source: 'batam',
          lat: 2.65 + drift,
          lon: 106.55,
          sog: 0.4,
          cog: 45,
          hdg: 45,
        },
        {
          mmsi: b,
          time: new Date(minutesAgo(minute).getTime() + 15_000),
          source: 'batam',
          lat: 2.65018 + drift,
          lon: 106.55,
          sog: 0.5,
          cog: 46,
          hdg: 46,
        },
      );
    }
    await fixtures.positions(positions);
    await fixtures.waitForAlert('transhipment', a, 40_000);
    // Several analyser runs on both replicas.
    await sleep(4_000);

    const rows = await eventRows(`transhipment:${a}:${b}`);
    expect(rows).toHaveLength(1);
    expect(await fixtures.alertCount('transhipment', a)).toBe(1);
    expect(
      await metric(active, 'aisits_surveillance_transhipment_analyses_total'),
    ).toBeGreaterThan(0);
    expect(
      await metric(standby, 'aisits_surveillance_transhipment_analyses_total'),
    ).toBe(0);
  });

  it('serializes an alert key across replicas: concurrent raises open one occurrence', async () => {
    const mmsi = uniqueMmsi();
    const dedupKey = `geofence:${mmsi}:${newId()}`;
    const raise = (service: TestService) =>
      service.app.get(AlertCoordinator).exclusive(dedupKey, () =>
        service.app.get(AlertEmitter).raise('surveillance', {
          type: 'geofence',
          dedupKey,
          severity: 'warning',
          mmsi,
          title: 'Concurrent raise',
          message: 'Raised by both replicas at once',
          methodId: 'geo.geofence_enter',
          detector: 'geofence',
        }),
      );
    const outcomes = await Promise.all([raise(active), raise(standby)]);
    expect([...outcomes].sort()).toEqual(['raised', 'unchanged']);
    expect(await eventRows(dedupKey)).toHaveLength(1);
    expect(await fixtures.alertCount('geofence', mmsi)).toBe(1);

    // A resolution by one replica is seen by the other one.
    const resolve = (service: TestService) =>
      service.app
        .get(AlertCoordinator)
        .exclusive(dedupKey, () =>
          service.app.get(AlertEmitter).resolve(dedupKey, { reason: 'test' }),
        );
    expect(await resolve(active)).toBe(true);
    expect(await resolve(standby)).toBe(false);
    expect(standby.app.get(AlertEmitter).isOpen(dedupKey)).toBe(false);
    expect((await eventRows(dedupKey))[0]?.resolved_at).toBeInstanceOf(Date);
  });

  it(
    'takes over without re-raising the occurrences the previous active instance opened',
    { timeout: 150_000 },
    async () => {
      const zone = await fixtures.zone({
        kind: 'restricted',
        alertOnEnter: true,
        name: 'HA restricted zone',
        geometry: square(118, -4),
      });
      await waitFor(() => active.app.get(ZoneIndex).has(zone.id));
      await waitFor(() => standby.app.get(ZoneIndex).has(zone.id));
      const mmsi = uniqueMmsi();
      const dedupKey = `geofence:${mmsi}:${zone.id}`;
      const inside = { mmsi, lat: -3.95, lon: 118.05, sog: 5 };

      // Opened by the active instance after the standby booted.
      await fixtures.positions([{ ...inside, time: minutesAgo(10) }]);
      await fixtures.waitForAlert('geofence', mmsi);
      expect(standby.app.get(AlertEmitter).isOpen(dedupKey)).toBe(false);

      await active.app.close();
      activeClosed = true;
      const survivor = new Fixtures(standby.app);
      const resumedAt = minutesAgo(9);
      await survivor.positions([{ ...inside, time: resumedAt }]);
      // The standby gets the position once the pin moved to it.
      await waitFor(
        async () => {
          const [state] = await survivor.rows<{ time: Date }>(
            'SELECT time FROM vessel_state WHERE mmsi = $1',
            [mmsi],
          );
          return state?.time.getTime() === resumedAt.getTime()
            ? true
            : undefined;
        },
        { timeoutMs: 120_000 },
      );
      expect(standby.app.get(AlertEmitter).isOpen(dedupKey)).toBe(true);
      expect(await survivor.alertCount('geofence', mmsi)).toBe(1);

      // … and it resolves that occurrence when the vessel leaves the zone.
      await survivor.positions([
        { mmsi, lat: -4.2, lon: 118.05, sog: 5, time: minutesAgo(8) },
      ]);
      const rows = await waitFor(async () => {
        const found = await eventRows(dedupKey, survivor);
        return found[0]?.resolved_at === null ? undefined : found;
      });
      expect(rows).toHaveLength(1);
    },
  );
});
