import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as schema from '../src/db/schema.js';
import { DetectorEventsRepository } from '../src/detectors/detector-events.repository.js';
import {
  readLegacyViolations,
  seedFishingViolations,
} from '../src/modules/fishing-violations/fishing-violations.seed.js';
import { SERVICE } from '../src/service.js';
import { Fixtures, uniqueMmsi } from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

const BASE = `/api/v2/${SERVICE.name}`;
const ORG_A = '0190d6b4-0000-7000-8000-0000000000a1';
const ORG_B = '0190d6b4-0000-7000-8000-0000000000b2';
/** All events of this file lie in this box, far from the detector tests. */
const BBOX = '130,-12,132,-10';
/**
 * … and ten days ago (inside the 30-day default range of the lists), so the
 * time-windowed statistics never count the detector tests' recent events.
 */
const T0 = Date.now() - 10 * 24 * 60 * 60_000;

interface Page<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

interface EventBody {
  readonly id: string;
  readonly type: string;
  readonly mmsi: number;
  readonly relatedMmsi: number | null;
  readonly status: string;
  readonly vesselName: string | null;
  readonly reviewedBy: string | null;
  readonly note: string | null;
}

describe('surveillance API: events, review, tenancy, heatmap, stats, seeds', () => {
  let service: TestService;
  let fixtures: Fixtures;
  const vesselA = uniqueMmsi(); // org A
  const vesselB = uniqueMmsi(); // org B
  const unregistered = uniqueMmsi();
  const ids: Record<
    'geofenceA' | 'darkB' | 'transhipmentAB' | 'anomalyX',
    string
  > = {
    geofenceA: newId(),
    darkB: newId(),
    transhipmentAB: newId(),
    anomalyX: newId(),
  };
  const resultId = newId();
  /** An older analysis of the same occurrence (outside the 30-day default range). */
  const oldResultId = newId();
  const zoneId = newId();

  /** An alert as the Detector SDK would persist it. */
  function alert(
    overrides: Partial<AlertRaisedV1> &
      Pick<AlertRaisedV1, 'id' | 'type' | 'mmsi'>,
    minutes: number,
  ): AlertRaisedV1 {
    return {
      domain: 'surveillance',
      severity: 'warning',
      relatedMmsi: null,
      title: `${overrides.type} test`,
      message: `${overrides.type} test event`,
      lat: -11,
      lon: 131,
      occurredAt: new Date(T0 + minutes * 60_000).toISOString(),
      dedupKey: `${overrides.type}:${overrides.mmsi}:${overrides.id}`,
      zoneId: null,
      methodId: 'geo.geofence_enter',
      data: {},
      ...overrides,
    };
  }

  const get = async (
    url: string,
    claims: Parameters<TestService['authorization']>[0],
  ) =>
    service.app.inject({
      method: 'GET',
      url,
      headers: await service.authorization(claims),
    });

  beforeAll(async () => {
    service = await startTestService();
    fixtures = new Fixtures(service.app);
    await fixtures.vessel({ mmsi: vesselA, orgId: ORG_A, name: 'KM Alpha' });
    await fixtures.vessel({ mmsi: vesselB, orgId: ORG_B, name: 'KM Bravo' });
    await waitFor(async () => {
      const rows = await fixtures.rows(
        'SELECT 1 FROM vessels WHERE mmsi = ANY($1)',
        [[vesselA, vesselB]],
      );
      return rows.length === 2 ? true : undefined;
    });

    const events = service.app.get(DetectorEventsRepository);
    await events.onRaised(
      alert(
        {
          id: ids.geofenceA,
          type: 'geofence',
          mmsi: vesselA,
          severity: 'critical',
          lat: -11.01,
          lon: 131.01,
          zoneId,
        },
        0,
      ),
      'raised',
    );
    await events.onRaised(
      alert(
        {
          id: ids.darkB,
          type: 'dark',
          mmsi: vesselB,
          methodId: 'dark.ais_gap',
          lat: -11.02,
          lon: 131.02,
        },
        5,
      ),
      'raised',
    );
    await events.onRaised(
      alert(
        {
          id: ids.transhipmentAB,
          type: 'transhipment',
          mmsi: Math.min(vesselA, vesselB),
          relatedMmsi: Math.max(vesselA, vesselB),
          methodId: 'transhipment.accuracy',
          lat: -10.5,
          lon: 130.5,
          data: {
            isIllegal: true,
            accuracy: 87.4,
            startTimestamp: new Date(T0).toISOString(),
            endTimestamp: new Date(T0 + 30 * 60_000).toISOString(),
            averagePriority: 19.8,
            priorityDistribution: { low: 0, medium: 20, high: 80 },
          },
        },
        10,
      ),
      'raised',
    );
    // The analysis behind the transhipment event (transhipment_results).
    await fixtures.rows(
      `INSERT INTO transhipment_results
         (id, start_at, end_at, detected_at, mmsi_a, mmsi_b, event_id, accuracy,
          average_priority, priority_distribution, severity, geom,
          accumulated_priority, observations, route1_points, route2_points, method_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 87.4, 19.8,
               '{"low":0,"medium":20,"high":80}', 'warning',
               ST_SetSRID(ST_MakePoint(130.5, -10.5), 4326)::geography,
               540, 30, 60, 60, 'transhipment.accuracy')`,
      [
        resultId,
        new Date(T0),
        new Date(T0 + 30 * 60_000),
        new Date(T0 + 40 * 60_000),
        Math.min(vesselA, vesselB),
        Math.max(vesselA, vesselB),
        ids.transhipmentAB,
      ],
    );
    await fixtures.rows(
      `INSERT INTO transhipment_results
         (id, start_at, end_at, detected_at, mmsi_a, mmsi_b, event_id, accuracy,
          average_priority, priority_distribution, severity,
          accumulated_priority, observations, route1_points, route2_points, method_id)
       VALUES ($1, $2, $3, $3, $4, $5, $6, 75, 12, '{"low":10,"medium":40,"high":50}',
               'warning', 120, 10, 30, 30, 'transhipment.accuracy')`,
      [
        oldResultId,
        new Date(T0 - 30 * 24 * 60 * 60_000),
        new Date(T0 - 30 * 24 * 60 * 60_000 + 30 * 60_000),
        Math.min(vesselA, vesselB),
        Math.max(vesselA, vesselB),
        ids.transhipmentAB,
      ],
    );
    await events.onRaised(
      alert(
        {
          id: ids.anomalyX,
          type: 'anomaly',
          mmsi: unregistered,
          severity: 'info',
          methodId: 'anomaly.navstatus_mismatch',
          lat: -11.5,
          lon: 131.5,
        },
        15,
      ),
      'raised',
    );
  });

  afterAll(async () => {
    await service.app.close();
  });

  const listIds = async (
    claims: Parameters<TestService['authorization']>[0],
  ): Promise<string[]> => {
    const response = await get(`${BASE}/events?bbox=${BBOX}&limit=500`, claims);
    expect(response.statusCode).toBe(200);
    return response.json<Page<EventBody>>().data.map((event) => event.id);
  };

  it('shows authority users every event, newest first, with vessel names', async () => {
    const response = await get(`${BASE}/events?bbox=${BBOX}`, {
      roles: ['authority'],
    });
    const page = response.json<Page<EventBody>>();
    expect(page.data.map((event) => event.id)).toEqual([
      ids.anomalyX,
      ids.transhipmentAB,
      ids.darkB,
      ids.geofenceA,
    ]);
    expect(
      page.data.find((event) => event.id === ids.geofenceA)?.vesselName,
    ).toBe('KM Alpha');
  });

  it('shows other roles only the events of their organization’s vessels (mmsi or relatedMmsi)', async () => {
    expect(await listIds({ roles: ['viewer'], orgId: ORG_A })).toEqual([
      ids.transhipmentAB,
      ids.geofenceA,
    ]);
    expect(await listIds({ roles: ['fleet_manager'], orgId: ORG_B })).toEqual([
      ids.transhipmentAB,
      ids.darkB,
    ]);
    expect(await listIds({ roles: ['viewer'] })).toEqual([]);

    const hidden = await get(`${BASE}/events/${ids.darkB}`, {
      roles: ['viewer'],
      orgId: ORG_A,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({
      code: 'SURVEILLANCE_EVENT_NOT_FOUND',
    });
    const visible = await get(`${BASE}/events/${ids.geofenceA}`, {
      roles: ['viewer'],
      orgId: ORG_A,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({
      id: ids.geofenceA,
      type: 'geofence',
      methodId: 'geo.geofence_enter',
      lat: -11.01,
      lon: 131.01,
    });
  });

  it('filters by type, severity and mmsi and pages with a cursor', async () => {
    const typed = await get(`${BASE}/events?bbox=${BBOX}&type=dark`, {
      roles: ['authority'],
    });
    expect(typed.json<Page<EventBody>>().data.map((event) => event.id)).toEqual(
      [ids.darkB],
    );
    const severe = await get(`${BASE}/events?bbox=${BBOX}&severity=critical`, {
      roles: ['authority'],
    });
    expect(
      severe.json<Page<EventBody>>().data.map((event) => event.id),
    ).toEqual([ids.geofenceA]);
    const byVessel = await get(`${BASE}/events?mmsi=${vesselB}`, {
      roles: ['authority'],
    });
    expect(
      byVessel.json<Page<EventBody>>().data.map((event) => event.id),
    ).toEqual([ids.transhipmentAB, ids.darkB]);

    const first = (
      await get(`${BASE}/events?bbox=${BBOX}&limit=3`, { roles: ['authority'] })
    ).json<Page<EventBody>>();
    expect(first.data).toHaveLength(3);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    const second = await get(
      `${BASE}/events?bbox=${BBOX}&limit=3&cursor=${first.page.nextCursor ?? ''}`,
      { roles: ['authority'] },
    );
    expect(second.json<Page<EventBody>>()).toMatchObject({
      data: [{ id: ids.geofenceA }],
      page: { nextCursor: null },
    });

    const invalid = await get(`${BASE}/events?severity=fatal&cursor=***`, {
      roles: ['authority'],
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lets reviewers confirm, dismiss and reopen events, and records an audit entry', async () => {
    const url = `${BASE}/events/${ids.darkB}`;
    const viewer = await service.app.inject({
      method: 'PATCH',
      url,
      headers: await service.authorization({ roles: ['viewer'], orgId: ORG_B }),
      payload: { status: 'confirmed' },
    });
    expect(viewer.statusCode).toBe(403);

    const reviewer = await service.jwt.issue({ roles: ['authority'] });
    const headers = { authorization: `Bearer ${reviewer.token}` };
    const confirmed = await service.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'confirmed', note: 'Verified with patrol' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      status: 'confirmed',
      note: 'Verified with patrol',
      reviewedBy: reviewer.principal.id,
    });

    const { manager } = service.app.get(NatsClient);
    const audit = await waitFor(() =>
      manager.streams.getMessage('AUDIT', {
        last_by_subj: subjects.audit(SERVICE.name),
      }),
    );
    const parsed = parseEnvelope(audit.data);
    expect(parsed.success && parsed.envelope.data).toMatchObject({
      action: 'surveillance_event.review',
      targetId: ids.darkB,
      meta: {
        from: 'open',
        to: 'confirmed',
        noteChanged: true,
        previousNote: null,
        note: 'Verified with patrol',
      },
    });

    // A verdict without a note keeps the patrol's note …
    const dismissed = await service.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'dismissed' },
    });
    expect(dismissed.json()).toMatchObject({
      status: 'dismissed',
      note: 'Verified with patrol',
    });
    const reopened = await service.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'open' },
    });
    expect(reopened.json()).toMatchObject({
      status: 'open',
      note: 'Verified with patrol',
    });
    // … an explicit null clears it, and the audit entry keeps the old text.
    const cleared = await service.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'open', note: null },
    });
    expect(cleared.json()).toMatchObject({ status: 'open', note: null });
    const clearedAudit = await waitFor(async () => {
      const stored = await manager.streams.getMessage('AUDIT', {
        last_by_subj: subjects.audit(SERVICE.name),
      });
      if (stored === null) return undefined;
      const envelope = parseEnvelope(stored.data);
      if (
        !envelope.success ||
        envelope.envelope.type !== EVENT_TYPES.AUDIT_RECORDED
      )
        return undefined;
      return envelope.envelope.data.meta.noteChanged === true &&
        envelope.envelope.data.meta.note === null
        ? envelope.envelope.data
        : undefined;
    });
    expect(clearedAudit.meta).toMatchObject({
      noteChanged: true,
      previousNote: 'Verified with patrol',
      note: null,
    });

    const resolved = await service.app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'resolved' },
    });
    expect(resolved.statusCode).toBe(400);
    const unknown = await service.app.inject({
      method: 'PATCH',
      url: `${BASE}/events/${newId()}`,
      headers,
      payload: { status: 'dismissed' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('keeps a review verdict when the detector resolves the occurrence', async () => {
    const reviewer = await service.authorization({ roles: ['super_admin'] });
    await service.app.inject({
      method: 'PATCH',
      url: `${BASE}/events/${ids.geofenceA}`,
      headers: reviewer,
      payload: { status: 'dismissed' },
    });
    const events = service.app.get(DetectorEventsRepository);
    const [open] = (await events.loadOpen()).filter(
      (occurrence) => occurrence.alertId === ids.geofenceA,
    );
    expect(open).toMatchObject({ detector: 'geofence' }); // still owned and restored after a restart
    if (open === undefined) throw new Error('missing open occurrence');
    await events.onResolved({
      alert: open,
      resolvedAt: new Date(),
      reason: 'left the zone',
      data: {},
    });
    const response = await get(`${BASE}/events/${ids.geofenceA}`, {
      roles: ['authority'],
    });
    expect(response.json()).toMatchObject({
      status: 'dismissed',
      resolvedAt: expect.any(String) as string,
      // The stable code is stored with the English reason.
      resolution: { reason: 'left the zone', code: 'left_zone' },
      // Written without a message key: derived on read from the row.
      data: {
        messageKey: 'surveillance.geofence.entered',
        messageParams: { mmsi: vesselA, vesselName: 'KM Alpha' },
      },
    });
  });

  it('filters by detector lifecycle (active), zone and vessel search', async () => {
    const idsOf = async (query: string): Promise<string[]> => {
      const response = await get(`${BASE}/events?bbox=${BBOX}&${query}`, {
        roles: ['authority'],
      });
      expect(response.statusCode).toBe(200);
      return response.json<Page<EventBody>>().data.map((event) => event.id);
    };
    // geofenceA was resolved by the previous test; the others are still open.
    expect(await idsOf('active=false')).toEqual([ids.geofenceA]);
    expect(await idsOf('active=true')).toEqual([
      ids.anomalyX,
      ids.transhipmentAB,
      ids.darkB,
    ]);
    expect(await idsOf(`zoneId=${zoneId}`)).toEqual([ids.geofenceA]);
    // Name of either vessel (case-insensitive) or the digits of an MMSI.
    expect(await idsOf('q=bRaVo')).toEqual([ids.transhipmentAB, ids.darkB]);
    expect(await idsOf(`q=${unregistered}`)).toEqual([ids.anomalyX]);
    // LIKE wildcards are matched literally.
    expect(await idsOf('q=%25%25')).toEqual([]);
    expect(await idsOf('q=k_')).toEqual([]);
    // Tenancy still applies to a search.
    const orgA = await get(`${BASE}/events?bbox=${BBOX}&q=bravo`, {
      roles: ['viewer'],
      orgId: ORG_A,
    });
    expect(orgA.json<Page<EventBody>>().data.map((event) => event.id)).toEqual([
      ids.transhipmentAB,
    ]);

    // `q` is validated trimmed: a blank search is refused, never ignored.
    for (const invalid of [
      'q=a',
      'q=%20%20',
      'q=%20a%20',
      'zoneId=zone-1',
      'active=yes',
    ]) {
      const response = await get(`${BASE}/events?${invalid}`, {
        roles: ['authority'],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('returns transhipments in the legacy result shape', async () => {
    const response = await get(`${BASE}/transhipments?mmsi=${vesselA}`, {
      roles: ['viewer'],
      orgId: ORG_A,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Page<unknown>>().data).toEqual([
      {
        id: resultId,
        eventId: ids.transhipmentAB,
        ship1MMSI: Math.min(vesselA, vesselB),
        ship2MMSI: Math.max(vesselA, vesselB),
        ship1Name: vesselA < vesselB ? 'KM Alpha' : 'KM Bravo',
        ship2Name: vesselA < vesselB ? 'KM Bravo' : 'KM Alpha',
        isIllegal: true,
        startTimestamp: new Date(T0).toISOString(),
        endTimestamp: new Date(T0 + 30 * 60_000).toISOString(),
        accuracy: 87.4,
        averagePriority: 19.8,
        priorityDistribution: { low: 0, medium: 20, high: 80 },
        detectedAt: new Date(T0 + 40 * 60_000).toISOString(),
        severity: 'warning',
        status: 'open',
        lat: -10.5,
        lon: 130.5,
        methodId: 'transhipment.accuracy',
      },
    ]);
    // Tenancy: a third organization sees neither vessel's results.
    const other = await get(`${BASE}/transhipments?mmsi=${vesselA}`, {
      roles: ['viewer'],
      orgId: newId(),
    });
    expect(other.json<Page<unknown>>().data).toEqual([]);
  });

  it('lists every analysis of one event, whatever its window, with eventId', async () => {
    const resultIds = async (query: string) =>
      (await get(`${BASE}/transhipments?${query}`, { roles: ['authority'] }))
        .json<Page<{ id: string; eventId: string }>>()
        .data.map((result) => result.id);
    expect(await resultIds(`eventId=${ids.transhipmentAB}`)).toEqual([
      resultId,
      oldResultId,
    ]);
    // An explicit range still applies.
    expect(
      await resultIds(
        `eventId=${ids.transhipmentAB}&from=${new Date(T0 - 60_000).toISOString()}`,
      ),
    ).toEqual([resultId]);
    expect(await resultIds(`eventId=${newId()}`)).toEqual([]);
    const invalid = await get(`${BASE}/transhipments?eventId=x`, {
      roles: ['authority'],
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('aggregates a heatmap with ST_SnapToGrid, respecting tenancy', async () => {
    const authority = await get(`${BASE}/heatmap?bbox=${BBOX}&cellKm=50`, {
      roles: ['authority'],
    });
    expect(authority.statusCode).toBe(200);
    const body = authority.json<{
      cells: { lat: number; lon: number; count: number }[];
      total: number;
      cellDeg: number;
    }>();
    expect(body.total).toBe(4);
    expect(body.cellDeg).toBeCloseTo(50 / 111.32);
    // Geofence and dark events are 1.4 km apart: one cell of 50 km.
    expect(body.cells[0]).toMatchObject({ count: 2 });

    const orgA = await get(
      `${BASE}/heatmap?bbox=${BBOX}&cellKm=50&type=geofence`,
      { roles: ['viewer'], orgId: ORG_A },
    );
    expect(orgA.json<{ total: number }>().total).toBe(1);
    const tooSmall = await get(`${BASE}/heatmap?cellKm=0.1`, {
      roles: ['authority'],
    });
    expect(tooSmall.statusCode).toBe(400);
  });

  it('counts events by type, severity and status', async () => {
    const from = new Date(T0 - 60_000).toISOString();
    const to = new Date(T0 + 20 * 60_000).toISOString();
    const orgB = await get(`${BASE}/stats?from=${from}&to=${to}`, {
      roles: ['viewer'],
      orgId: ORG_B,
    });
    expect(orgB.json()).toMatchObject({
      total: 2,
      byType: { dark: 1, transhipment: 1 },
      transhipmentQueue: null,
    });
    const authority = await get(`${BASE}/stats?from=${from}&to=${to}`, {
      roles: ['authority'],
    });
    expect(authority.json()).toMatchObject({
      byType: { geofence: 1, dark: 1, transhipment: 1, anomaly: 1 },
      transhipmentQueue: { pending: expect.any(Number) as number },
    });
  });

  it('returns a time series of counts per hour or local day in one request', async () => {
    interface Series {
      readonly from: string;
      readonly to: string;
      readonly bucket: string;
      readonly timeZone: string;
      readonly buckets: {
        readonly from: string;
        readonly to: string;
        readonly total: number;
        readonly byType: Record<string, number>;
        readonly bySeverity: Record<string, number>;
      }[];
    }
    const from = new Date(T0 - 60_000).toISOString();
    const to = new Date(T0 + 20 * 60_000).toISOString();
    const series = async (
      query: string,
      claims: Parameters<TestService['authorization']>[0] = {
        roles: ['authority'],
      },
    ): Promise<Series> => {
      const response = await get(
        `${BASE}/stats/series?from=${from}&to=${to}&${query}`,
        claims,
      );
      expect(response.statusCode).toBe(200);
      return response.json<Series>();
    };
    const sum = (
      body: Series,
      pick: (bucket: Series['buckets'][number]) => number,
    ) => body.buckets.reduce((total, bucket) => total + pick(bucket), 0);

    const hourly = await series('bucket=hour');
    expect(hourly).toMatchObject({ from, to, bucket: 'hour', timeZone: 'UTC' });
    expect(hourly.buckets[0]?.from).toBe(from);
    expect(hourly.buckets.at(-1)?.to).toBe(to);
    // Contiguous buckets that add up to the counts of GET /stats.
    for (const [index, bucket] of hourly.buckets.entries()) {
      expect(Date.parse(bucket.from)).toBeLessThan(Date.parse(bucket.to));
      const next = hourly.buckets[index + 1];
      if (next !== undefined) expect(next.from).toBe(bucket.to);
    }
    expect(sum(hourly, (bucket) => bucket.total)).toBe(4);
    expect(sum(hourly, (bucket) => bucket.byType.dark ?? 0)).toBe(1);
    expect(sum(hourly, (bucket) => bucket.bySeverity.critical ?? 0)).toBe(1);

    // Local days of WIB (UTC+7) start at 17:00 UTC; tenancy as /stats.
    const daily = await series('bucket=day&tz=Asia/Jakarta&type=dark', {
      roles: ['viewer'],
      orgId: ORG_B,
    });
    expect(sum(daily, (bucket) => bucket.total)).toBe(1);
    for (const bucket of daily.buckets.slice(1))
      expect(bucket.from).toMatch(/T17:00:00\.000Z$/);

    const tooMany = await get(
      `${BASE}/stats/series?from=${new Date(T0 - 60 * 24 * 60 * 60_000).toISOString()}&to=${to}&bucket=hour`,
      { roles: ['authority'] },
    );
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'bucket' })],
    });
    // UTC offsets are refused (PostgreSQL would read `+07:00` as UTC-07:00),
    // and so are zones ICU knows but the database's tzdata dropped: 400 on
    // `tz`, never a 500 from the query.
    for (const tz of [
      'Mars/Base',
      '+07:00',
      '-03:00',
      'US/Pacific-New',
      'Canada/East-Saskatchewan',
    ]) {
      const badZone = await get(
        `${BASE}/stats/series?tz=${encodeURIComponent(tz)}`,
        { roles: ['authority'] },
      );
      expect(badZone.statusCode, tz).toBe(400);
      expect(badZone.json(), tz).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ field: 'tz' })],
      });
    }
    // Names in any case, echoed in the database's spelling; Etc/GMT-7 is UTC+7.
    const lowerCase = await series('bucket=day&tz=asia/jakarta');
    expect(lowerCase.timeZone).toBe('Asia/Jakarta');
    const threeDays = await get(
      `${BASE}/stats/series?from=${new Date(T0 - 3 * 24 * 60 * 60_000).toISOString()}&to=${to}&bucket=day&tz=Etc/GMT-7`,
      { roles: ['authority'] },
    );
    expect(threeDays.statusCode).toBe(200);
    const etc = threeDays.json<Series>();
    expect(etc.timeZone).toBe('Etc/GMT-7');
    expect(etc.buckets.length).toBeGreaterThan(2);
    for (const bucket of etc.buckets.slice(1))
      expect(bucket.from).toMatch(/T17:00:00\.000Z$/);
  });

  it('follows daylight saving time: a repeated hour is two buckets, a skipped hour none', async () => {
    const events = service.app.get(DetectorEventsRepository);
    const mmsi = uniqueMmsi();
    // Europe/Berlin: 2025-10-26 03:00 CEST → 02:00 CET and 2026-03-29
    // 02:00 CET → 03:00 CEST, both at 01:00 UTC.
    const times = [
      '2025-10-26T00:30:00.000Z', // 02:30 CEST
      '2025-10-26T01:30:00.000Z', // 02:30 CET (the repeated hour)
      '2026-03-29T00:30:00.000Z', // 01:30 CET
      '2026-03-29T01:30:00.000Z', // 03:30 CEST (02:xx does not exist)
    ];
    for (const occurredAt of times)
      await events.onRaised(
        { ...alert({ id: newId(), type: 'fishing', mmsi }, 0), occurredAt },
        'raised',
      );
    interface Bucket {
      readonly from: string;
      readonly to: string;
      readonly total: number;
    }
    const buckets = async (query: string): Promise<Bucket[]> => {
      const response = await get(
        `${BASE}/stats/series?type=fishing&tz=Europe/Berlin&${query}`,
        { roles: ['authority'] },
      );
      expect(response.statusCode).toBe(200);
      return response.json<{ buckets: Bucket[] }>().buckets;
    };
    const shape = (list: Bucket[]) =>
      list.map(({ from, to, total }) => [
        from.slice(11, 16),
        to.slice(11, 16),
        total,
      ]);

    // 01:00 CEST, 02:00 CEST, 02:00 CET: three hours of 60 minutes.
    expect(
      shape(
        await buckets(
          'bucket=hour&from=2025-10-25T23:00:00.000Z&to=2025-10-26T02:00:00.000Z',
        ),
      ),
    ).toEqual([
      ['23:00', '00:00', 0],
      ['00:00', '01:00', 1],
      ['01:00', '02:00', 1],
    ]);
    // 00:00 CET, 01:00 CET, 03:00 CEST: each event counted once.
    expect(
      shape(
        await buckets(
          'bucket=hour&from=2026-03-28T23:00:00.000Z&to=2026-03-29T02:00:00.000Z',
        ),
      ),
    ).toEqual([
      ['23:00', '00:00', 0],
      ['00:00', '01:00', 1],
      ['01:00', '02:00', 1],
    ]);
    // 26 October 2025 in Berlin is 25 hours long.
    const [day, next] = await buckets(
      'bucket=day&from=2025-10-25T22:00:00.000Z&to=2025-10-27T22:00:00.000Z',
    );
    expect(day).toEqual({
      from: '2025-10-25T22:00:00.000Z',
      to: '2025-10-26T23:00:00.000Z',
      total: 2,
      byType: { fishing: 2 },
      bySeverity: { warning: 2 },
    });
    expect(next).toMatchObject({ from: '2025-10-26T23:00:00.000Z', total: 0 });
  });

  it('seeds the historical fishing violations idempotently and serves them', async () => {
    const db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    const records = await readLegacyViolations();
    expect(records).toHaveLength(403);
    expect(await seedFishingViolations(db, records)).toEqual({
      inserted: 403,
      updated: 0,
      total: 403,
    });
    expect(await seedFishingViolations(db, records)).toEqual({
      inserted: 0,
      updated: 403,
      total: 403,
    });

    const year = await get(`${BASE}/fishing-violations?year=2016&pageSize=5`, {
      roles: ['viewer'],
    });
    expect(year.statusCode).toBe(200);
    expect(year.json()).toMatchObject({
      meta: { page: 1, pageSize: 5, total: 163 },
    });
    const [first] = year.json<{ data: Record<string, unknown>[] }>().data;
    expect(first).toMatchObject({
      year: 2016,
      methodId: 'fishing.apprehensions_2015_2017',
      source: expect.stringContaining('ilegal.json') as string,
    });

    const batam = await get(
      `${BASE}/fishing-violations?bbox=103.9,0.3,104.3,0.6&pageSize=100`,
      { roles: ['viewer'] },
    );
    const near = batam.json<{ data: { lat: number; lon: number }[] }>().data;
    expect(near.length).toBeGreaterThan(0);
    expect(
      near.every((record) => record.lon >= 103.9 && record.lon <= 104.3),
    ).toBe(true);

    // Year facets and the historical heat layer, without paging the records.
    const years = await get(`${BASE}/fishing-violations/years`, {
      roles: ['viewer'],
    });
    expect(years.statusCode).toBe(200);
    const facets = years.json<{
      years: { year: number; count: number }[];
      total: number;
    }>();
    expect(facets.total).toBe(403);
    expect(facets.years).toContainEqual({ year: 2016, count: 163 });
    expect(facets.years.map((entry) => entry.year)).toEqual(
      [...facets.years.map((entry) => entry.year)].sort((a, b) => a - b),
    );
    const heat = await get(
      `${BASE}/fishing-violations/heatmap?year=2016&cellKm=50`,
      { roles: ['viewer'] },
    );
    expect(heat.statusCode).toBe(200);
    expect(heat.json()).toMatchObject({ year: 2016, cellKm: 50, total: 163 });
    const local = await get(
      `${BASE}/fishing-violations/heatmap?bbox=103.9,0.3,104.3,0.6&cellKm=5`,
      { roles: ['viewer'] },
    );
    expect(local.json<{ total: number }>().total).toBe(near.length);
  });

  it('requires surveillance:read', async () => {
    const anonymous = await service.app.inject({
      method: 'GET',
      url: `${BASE}/events`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
