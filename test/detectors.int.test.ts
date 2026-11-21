import { ZoneIndex } from '@darmawanweb/ais-its-nest/analytics';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from '../src/service.js';
import {
  Fixtures,
  minutesAgo,
  type PositionInput,
  square,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

/** Event rows of a vessel, oldest first. */
interface EventRow extends Record<string, unknown> {
  id: string;
  type: string;
  detector: string;
  status: string;
  severity: string;
  method_id: string;
  dedup_key: string;
  resolved_at: Date | null;
  data: Record<string, unknown>;
}

describe('detectors: zone, fleet and position events → events + alert.raised.v1', () => {
  let service: TestService;
  let fixtures: Fixtures;

  beforeAll(async () => {
    service = await startTestService(
      {},
      {
        DARK_CHECK_INTERVAL_S: '1',
        TRANSHIPMENT_ANALYSIS_INTERVAL_S: '1',
        // Re-analyse as the track grows (live: 15 min between analyses).
        TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN: '0',
      },
    );
    fixtures = new Fixtures(service.app);
  });

  afterAll(async () => {
    await service.app.close();
  });

  const eventsOf = (mmsi: number): Promise<EventRow[]> =>
    fixtures.rows<EventRow>(
      'SELECT id, type, detector, status, severity, method_id, dedup_key, resolved_at, data FROM events WHERE mmsi = $1 ORDER BY created_at',
      [mmsi],
    );

  it('lists the five detectors with their method ids', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/${SERVICE.name}/detectors`,
      headers: await service.authorization({ roles: ['viewer'] }),
    });
    expect(response.statusCode).toBe(200);
    const detectors =
      response.json<{ id: string; enabled: boolean; methodIds: string[] }[]>();
    expect(detectors.map((detector) => detector.id).sort()).toEqual([
      'anomaly',
      'dark',
      'fishing',
      'geofence',
      'transhipment',
    ]);
    expect(detectors.every((detector) => detector.enabled)).toBe(true);
  });

  it('projects zones and vessels into their tables', async () => {
    const zone = await fixtures.zone({
      kind: 'mpa',
      name: 'Projected MPA',
      geometry: square(120, -8),
    });
    const mmsi = uniqueMmsi();
    const vessel = await fixtures.vessel({
      mmsi,
      orgId: '0190d6b4-0000-7000-8000-00000000000a',
    });
    const zones = await waitFor(async () => {
      const rows = await fixtures.rows(
        'SELECT id, kind, ST_GeometryType(geom::geometry) AS type FROM zones WHERE id = $1',
        [zone.id],
      );
      return rows.length > 0 ? rows : undefined;
    });
    expect(zones).toEqual([{ id: zone.id, kind: 'mpa', type: 'ST_Polygon' }]);
    const vessels = await waitFor(async () => {
      const rows = await fixtures.rows(
        'SELECT id, mmsi, org_id FROM vessels WHERE mmsi = $1',
        [mmsi],
      );
      return rows.length > 0 ? rows : undefined;
    });
    expect(vessels).toEqual([{ id: vessel.id, mmsi, org_id: vessel.orgId }]);
  });

  it('geofence: raises on entry, resolves on exit, suppresses a re-entry within the cool-down', async () => {
    const zone = await fixtures.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Restricted test zone',
      geometry: square(110, -2),
    });
    await waitFor(() => service.app.get(ZoneIndex).has(zone.id));
    const mmsi = uniqueMmsi();
    const outside = { mmsi, lat: -2.2, lon: 110.05, sog: 6 };
    const inside = { mmsi, lat: -1.95, lon: 110.05, sog: 6 };

    await fixtures.positions([
      { ...outside, time: minutesAgo(10) },
      { ...inside, time: minutesAgo(9) },
    ]);
    const alert = await fixtures.waitForAlert('geofence', mmsi);
    expect(alert).toMatchObject({
      type: 'geofence',
      domain: 'surveillance',
      severity: 'critical',
      zoneId: zone.id,
      dedupKey: `geofence:${mmsi}:${zone.id}`,
      methodId: 'geo.geofence_enter',
    });
    const [stored] = await eventsOf(mmsi);
    expect(stored).toMatchObject({
      id: alert.id,
      detector: 'geofence',
      status: 'open',
      resolved_at: null,
    });

    await fixtures.positions([{ ...outside, time: minutesAgo(8) }]);
    await waitFor(
      async () => (await eventsOf(mmsi))[0]?.resolved_at ?? undefined,
    );
    expect((await eventsOf(mmsi))[0]).toMatchObject({ status: 'resolved' });

    // Re-entry 2 min after the first alert: within ALERT_COOLDOWN_MIN (10).
    await fixtures.positions([{ ...inside, time: minutesAgo(7) }]);
    await waitFor(async () =>
      (await eventsOf(mmsi))[0]?.resolved_at === null ? true : undefined,
    );
    expect(await eventsOf(mmsi)).toEqual([
      expect.objectContaining({ id: alert.id, status: 'open' }),
    ]);
    expect(await fixtures.alertCount('geofence', mmsi)).toBe(1);
  });

  it('anomaly: three consecutive mismatching positions raise an event', async () => {
    const mmsi = uniqueMmsi();
    const anomalous = {
      mmsi,
      lat: 3.5,
      lon: 112,
      sog: 7,
      navstatus: 1,
      predictedNavstatus: 0,
    } as const;
    await fixtures.positions([
      { ...anomalous, time: minutesAgo(6) },
      { ...anomalous, time: minutesAgo(5) },
      { ...anomalous, time: minutesAgo(4) },
    ]);
    const alert = await fixtures.waitForAlert('anomaly', mmsi);
    expect(alert).toMatchObject({
      severity: 'info',
      methodId: 'anomaly.navstatus_mismatch',
      dedupKey: `anomaly:${mmsi}`,
    });
    expect(alert.data).toMatchObject({
      streak: 3,
      navstatus: 1,
      predictedNavstatus: 0,
    });
    const [state] = await fixtures.rows<{ anomaly_streak: number }>(
      'SELECT anomaly_streak FROM vessel_state WHERE mmsi = $1',
      [mmsi],
    );
    expect(state?.anomaly_streak).toBe(3);
  });

  it('fishing: a 33-minute zigzag inside a fishing ground raises an event and stores the track', async () => {
    const zone = await fixtures.zone({
      kind: 'fishing_ground',
      name: 'WPP test',
      geometry: square(115, -9, 0.5),
    });
    await waitFor(() => service.app.get(ZoneIndex).has(zone.id));
    const mmsi = uniqueMmsi();
    const track: PositionInput[] = Array.from({ length: 12 }, (_, index) => ({
      mmsi,
      time: minutesAgo(40 - index * 3),
      lat: -8.8 + index * 0.0005,
      lon: 115.2 + (index % 2) * 0.0005,
      sog: 2.5,
      cog: index % 2 === 0 ? 40 : 160,
    }));
    await fixtures.positions(track);
    const alert = await fixtures.waitForAlert('fishing', mmsi);
    expect(alert).toMatchObject({
      severity: 'warning',
      zoneId: zone.id,
      methodId: 'fishing.loitering',
    });
    const [count] = await fixtures.rows<{ count: number }>(
      'SELECT count(*)::int AS count FROM track_points WHERE mmsi = $1',
      [mmsi],
    );
    expect(count?.count).toBe(12);
  });

  it('dark: a moving vessel silent for more than 30 min is reported, and resolved when it reappears', async () => {
    const mmsi = uniqueMmsi();
    const live = uniqueMmsi();
    await fixtures.positions([
      { mmsi, time: minutesAgo(45), lat: 5.5, lon: 125, sog: 6, cog: 90 },
      { mmsi: live, time: minutesAgo(1), lat: 5.9, lon: 126, sog: 9 },
    ]);
    const alert = await fixtures.waitForAlert('dark', mmsi);
    expect(alert).toMatchObject({
      severity: 'warning',
      methodId: 'dark.ais_gap',
      dedupKey: `dark:${mmsi}`,
    });
    expect(alert.data).toMatchObject({ lastSogKn: 6 });

    await fixtures.positions([
      { mmsi, time: new Date(), lat: 5.6, lon: 125.2, sog: 6 },
    ]);
    const resolved = await waitFor(
      async () => (await eventsOf(mmsi))[0]?.resolved_at ?? undefined,
    );
    expect(resolved).toBeInstanceOf(Date);
  });

  it('transhipment: two Batam vessels side by side for an hour are analysed and reported', async () => {
    const [a, b] = [uniqueMmsi(), uniqueMmsi()].sort((x, y) => x - y) as [
      number,
      number,
    ];
    const positions: PositionInput[] = [];
    for (let minute = 62; minute >= 1; minute--) {
      const drift = (62 - minute) * 0.000_05;
      positions.push(
        {
          mmsi: a,
          time: minutesAgo(minute),
          source: 'batam',
          lat: 1.15 + drift,
          lon: 104.05,
          sog: 0.4,
          cog: 45,
          hdg: 45,
        },
        {
          mmsi: b,
          time: new Date(minutesAgo(minute).getTime() + 15_000),
          source: 'batam',
          lat: 1.15018 + drift,
          lon: 104.05,
          sog: 0.5,
          cog: 46,
          hdg: 46,
        },
      );
    }
    await fixtures.positions(positions);

    const alert = await fixtures.waitForAlert('transhipment', a, 40_000);
    expect(alert).toMatchObject({
      mmsi: a,
      relatedMmsi: b,
      dedupKey: `transhipment:${a}:${b}`,
      methodId: 'transhipment.accuracy',
      severity: 'critical',
    });
    expect(alert.data).toMatchObject({
      isIllegal: true,
      accuracy: 100,
      priorityDistribution: { low: 0, medium: 0, high: 100 },
    });

    const [pair] = await fixtures.rows<{
      status: string;
      analyses: number;
      observations: number;
    }>(
      'SELECT status, analyses, observations FROM transhipment_pairs WHERE mmsi_a = $1 AND mmsi_b = $2',
      [a, b],
    );
    expect(pair?.analyses).toBeGreaterThanOrEqual(1);
    expect(pair?.observations).toBeGreaterThan(0);

    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/${SERVICE.name}/transhipments?mmsi=${b}`,
      headers: await service.authorization({ roles: ['authority'] }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data).toEqual([
      expect.objectContaining({
        id: alert.id,
        ship1MMSI: a,
        ship2MMSI: b,
        isIllegal: true,
        accuracy: 100,
        averagePriority: 27,
        priorityDistribution: { low: 0, medium: 0, high: 100 },
      }),
    ]);

    const metrics = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metrics.body).toMatch(
      /aisits_surveillance_transhipment_analyses_total\{outcome="illegal"\} [1-9]/,
    );
    expect(metrics.body).toMatch(
      /aisits_detector_alerts_total\{detector="transhipment",severity="critical"\} 1/,
    );
  });
});
