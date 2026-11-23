import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  makeEnvelope,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  AlertEmitter,
  DetectorRegistry,
  makeTestZone,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AlertKeyLock } from '../src/detectors/shared/alert-key-lock.js';
import { SERVICE } from '../src/service.js';
import {
  Fixtures,
  minutesAgo,
  type PositionInput,
  positionPayload,
  publishWithoutApp,
  square,
  uniqueMmsi,
} from './support/fixtures.js';
import {
  type ServiceProcess,
  startServiceProcess,
} from './support/service-process.js';
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
 * started is pinned (active), the second is a hot standby. The kit
 * activates an instance at its first position after the pin (reloading the
 * open occurrences from `events`), runs ticks only on the active instance,
 * and a graceful stop releases the pin and publishes pending resolutions.
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
    // The standby was never activated: its ticks do not run.
    expect(active.app.get(DetectorRegistry).active).toBe(true);
    expect(standby.app.get(DetectorRegistry).active).toBe(false);
  });

  it('serializes an alert key across replicas: concurrent raises open one occurrence', async () => {
    const mmsi = uniqueMmsi();
    const dedupKey = `geofence:${mmsi}:${newId()}`;
    const raise = (service: TestService) =>
      service.app.get(AlertKeyLock).run(dedupKey, () =>
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
        .get(AlertKeyLock)
        .run(dedupKey, () =>
          service.app
            .get(AlertEmitter)
            .resolve(dedupKey, { reason: 'left the zone' }),
        );
    expect(await resolve(active)).toBe(true);
    // The standby forgets the occurrence (no second resolution, nothing published).
    expect(await resolve(standby)).toBe(false);
    expect(standby.app.get(AlertEmitter).isOpen(dedupKey)).toBe(false);
    expect(standby.app.get(AlertEmitter).pendingResolutionCount).toBe(0);
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
      // A second vessel enters and leaves again on the active instance: its
      // resolution waits for the alert cooldown (10 min) …
      const visitor = uniqueMmsi();
      const leftAt = minutesAgo(11);
      await fixtures.positions([
        {
          mmsi: visitor,
          lat: -3.95,
          lon: 118.06,
          sog: 5,
          time: minutesAgo(12),
        },
        { mmsi: visitor, lat: -4.2, lon: 118.06, sog: 5, time: leftAt },
      ]);
      await fixtures.waitForAlert('geofence', visitor);
      await waitFor(async () => {
        const [row] = await eventRows(`geofence:${visitor}:${zone.id}`);
        return row?.resolved_at ?? undefined;
      });
      expect(await fixtures.resolvedEvents('geofence', visitor)).toEqual([]);

      // Opened by the active instance after the standby booted.
      await fixtures.positions([{ ...inside, time: minutesAgo(10) }]);
      await fixtures.waitForAlert('geofence', mmsi);
      expect(standby.app.get(AlertEmitter).isOpen(dedupKey)).toBe(false);

      // … and a graceful stop publishes it (and releases the pin).
      await active.app.close();
      activeClosed = true;
      const survivor = new Fixtures(standby.app);
      const [published] = await survivor.resolvedEvents('geofence', visitor);
      expect(published).toMatchObject({
        dedupKey: `geofence:${visitor}:${zone.id}`,
        reason: 'left the zone',
        resolvedAt: leftAt.toISOString(),
        data: { code: 'left_zone' },
      });
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
      // Activated before that position: the reloaded occurrence is not raised again.
      expect(standby.app.get(DetectorRegistry).active).toBe(true);
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

/**
 * An active instance paused for longer than the pinned TTL (`SIGSTOP`, like
 * a hung process): the standby takes over and raises the positions
 * redelivered to it. Once the paused instance resumes, it still handles the
 * positions it had buffered under its old pin, with the occurrences it held
 * before the pause (the kit neither re-checks the pin nor reloads them). Its
 * raises run through the `AlertKeyLock`, which adopts the standby's
 * occurrences: one row and one `alert.raised.v1` per key.
 */
describe('replicas: an active instance paused past the pinned TTL', () => {
  const env = { NATS_DURABLE_PREFIX: `hap${Date.now().toString(36)}-` };
  const marker = uniqueMmsi();
  let zone: ZoneSnapshotV1;
  let paused: ServiceProcess | undefined;
  let standby: TestService | undefined;

  beforeAll(async () => {
    const infra = inject('infra');
    zone = makeTestZone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Paused instance zone',
      geometry: square(117, -5),
    });
    // Before any replica of this durable runs: the process loads the zone
    // with its snapshot, and the position is in its backlog, so the process
    // (started first) is pinned and activated before the standby exists.
    await publishWithoutApp(infra.natsUrl, [
      makeEnvelope({
        type: EVENT_TYPES.GEO_ZONE_UPSERTED,
        source: SERVICE.name,
        data: zone,
      }),
      makeEnvelope({
        type: EVENT_TYPES.AIS_POSITION_RECORDED,
        source: SERVICE.name,
        data: positionPayload({
          mmsi: marker,
          lat: -6,
          lon: 116,
          sog: 3,
          time: minutesAgo(5),
        }),
      }),
    ]);
    const child = await startServiceProcess({
      ...env,
      DATABASE_URL: infra.databaseUrl,
      NATS_URL: infra.natsUrl,
      DB_MIGRATE_ON_BOOT: 'true',
      DETECTORS: 'geofence',
    });
    paused = child;
    await waitFor(
      async () =>
        (await child.metric(
          'aisits_detector_activations_total',
          'outcome="completed"',
        )) >= 1,
      { timeoutMs: 60_000, message: 'The process was not activated' },
    );
    standby = await startTestService(env, { DETECTORS: 'geofence' });
  });

  afterAll(async () => {
    await paused?.stop();
    await standby?.app.close();
  });

  it(
    'opens each occurrence once when the paused instance handles its buffered positions',
    { timeout: 240_000 },
    async () => {
      if (paused === undefined || standby === undefined)
        throw new Error('replicas not started');
      const child = paused;
      const fixtures = new Fixtures(standby.app);
      const rowsOf = (dedupKey: string) =>
        fixtures.rows<{ id: string; resolved_at: Date | null }>(
          'SELECT id, resolved_at FROM events WHERE dedup_key = $1 ORDER BY created_at',
          [dedupKey],
        );
      expect(standby.app.get(ZoneIndex).has(zone.id)).toBe(true);
      // The process handled its backlog up to the marker.
      await waitFor(
        async () =>
          (
            await fixtures.rows('SELECT 1 FROM vessel_state WHERE mmsi = $1', [
              marker,
            ])
          ).length === 1,
        { timeoutMs: 60_000, message: 'The process did not handle the marker' },
      );
      expect(standby.app.get(DetectorRegistry).active).toBe(false);
      const handledBefore = await child.metric(
        'aisits_detector_positions_total',
      );

      const vessels = [uniqueMmsi(), uniqueMmsi(), uniqueMmsi()];
      const keys = vessels.map((mmsi) => `geofence:${mmsi}:${zone.id}`);
      child.pause();
      // Delivered to the paused process (still pinned): they wait in its buffer.
      await fixtures.positions(
        vessels.map((mmsi) => ({
          mmsi,
          lat: -4.95,
          lon: 117.05,
          sog: 5,
          time: minutesAgo(2),
        })),
      );
      // After the pinned TTL the standby takes over and raises them.
      await waitFor(
        async () => {
          const found = await Promise.all(keys.map((key) => rowsOf(key)));
          return found.every((rows) => rows.length === 1);
        },
        {
          timeoutMs: 150_000,
          intervalMs: 1_000,
          message: 'The standby did not take over',
        },
      );
      expect(standby.app.get(DetectorRegistry).active).toBe(true);

      child.resume();
      // The resumed process handles the positions it had buffered …
      await waitFor(
        async () =>
          (await child.metric('aisits_detector_positions_total')) >=
          handledBefore + vessels.length,
        {
          timeoutMs: 30_000,
          message: 'The resumed process did not handle its buffered positions',
        },
      );
      // … and adopts the standby's occurrences instead of raising them again.
      for (const [index, key] of keys.entries()) {
        const rows = await rowsOf(key);
        expect(rows, key).toHaveLength(1);
        expect(rows[0]?.resolved_at).toBeNull();
        expect(await fixtures.alertCount('geofence', vessels[index] ?? 0)).toBe(
          1,
        );
      }

      // The vessels leave: the active instance (the standby) ends every row.
      await fixtures.positions(
        vessels.map((mmsi) => ({
          mmsi,
          lat: -5.5,
          lon: 117.05,
          sog: 5,
          time: minutesAgo(1),
        })),
      );
      await waitFor(
        async () => {
          const found = await Promise.all(keys.map((key) => rowsOf(key)));
          return found.every(
            (rows) => rows.length === 1 && rows[0]?.resolved_at !== null,
          );
        },
        { timeoutMs: 30_000, message: 'The occurrences were not resolved' },
      );
    },
  );
});
