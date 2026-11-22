import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { ALERT_PERSISTENCE } from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as schema from '../src/db/schema.js';
import type { DetectorEventsRepository } from '../src/detectors/detector-events.repository.js';
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

    const events = service.app.get<unknown, DetectorEventsRepository>(
      ALERT_PERSISTENCE,
    );
    await events.onRaised(
      alert(
        {
          id: ids.geofenceA,
          type: 'geofence',
          mmsi: vesselA,
          severity: 'critical',
          lat: -11.01,
          lon: 131.01,
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
    const events = service.app.get<unknown, DetectorEventsRepository>(
      ALERT_PERSISTENCE,
    );
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
      resolution: { reason: 'left the zone' },
    });
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
  });

  it('requires surveillance:read', async () => {
    const anonymous = await service.app.inject({
      method: 'GET',
      url: `${BASE}/events`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
