import { newId } from '@darmawanweb/ais-its-contracts/domain';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import { ZoneIndex } from '@darmawanweb/ais-its-nest/analytics';
import { type Database, DRIZZLE_DB } from '@darmawanweb/ais-its-nest/db';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as schema from '../src/db/schema.js';
import {
  DetectorEventsRepository,
  findLastEndedAt,
} from '../src/detectors/detector-events.repository.js';
import { SERVICE } from '../src/service.js';
import {
  Fixtures,
  minutesAgo,
  square,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

/**
 * `alert.resolved.v1` (contracts 0.4, kit 0.3): a detector's resolution is
 * persisted and published on the raise's subject `alert.v1.<type>.<mmsi>`
 * once the alert cooldown since the raise passed — at once here
 * (`ALERT_COOLDOWN_MIN=0`), so notification can close the inbox alert.
 */
describe('resolutions: alert.resolved.v1 after the alert cooldown', () => {
  let service: TestService;
  let fixtures: Fixtures;

  beforeAll(async () => {
    service = await startTestService({ ALERT_COOLDOWN_MIN: '0' });
    fixtures = new Fixtures(service.app);
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('publishes the end of a geofence occurrence with its code, and the API shows it', async () => {
    const zone = await fixtures.zone({
      kind: 'mpa',
      alertOnEnter: true,
      name: 'Resolution test MPA',
      geometry: square(121, -6),
    });
    await waitFor(() => service.app.get(ZoneIndex).has(zone.id));
    const mmsi = uniqueMmsi();
    await fixtures.vessel({ mmsi, name: 'KM Resolusi' });
    const enteredAt = minutesAgo(6);
    const leftAt = minutesAgo(5);
    await fixtures.positions([
      { mmsi, lat: -5.95, lon: 121.05, sog: 4, time: enteredAt },
      { mmsi, lat: -6.3, lon: 121.05, sog: 4, time: leftAt },
    ]);

    const raised = await fixtures.waitForAlert('geofence', mmsi);
    expect(raised.data).toMatchObject({
      messageKey: 'surveillance.geofence.entered',
      messageParams: {
        mmsi,
        zoneName: 'Resolution test MPA',
        zoneKind: 'mpa',
      },
    });
    const resolved = await fixtures.waitForResolution('geofence', mmsi);
    expect(resolved).toMatchObject({
      alertId: raised.id,
      type: 'geofence',
      domain: 'surveillance',
      severity: 'warning',
      mmsi,
      relatedMmsi: null,
      zoneId: zone.id,
      dedupKey: `geofence:${mmsi}:${zone.id}`,
      openedAt: enteredAt.toISOString(),
      resolvedAt: leftAt.toISOString(),
      reason: 'left the zone',
      methodId: 'geo.geofence_enter',
      data: { code: 'left_zone' },
    });
    // Published once (raise and resolution share the subject, in order).
    expect(
      (await fixtures.alertMessages('geofence', mmsi)).map(
        (message) => message.kind,
      ),
    ).toEqual(['raised', 'resolved']);

    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/${SERVICE.name}/events/${raised.id}`,
      headers: await service.authorization({ roles: ['authority'] }),
    });
    expect(response.json()).toMatchObject({
      status: 'resolved',
      resolvedAt: leftAt.toISOString(),
      resolution: { code: 'left_zone', reason: 'left the zone' },
      data: { messageKey: 'surveillance.geofence.entered' },
    });
  });

  it('stores event time as last_seen_at for repeated signals (never moving backwards)', async () => {
    const mmsi = uniqueMmsi();
    const anomalous = {
      mmsi,
      lat: 3.6,
      lon: 112.2,
      sog: 7,
      navstatus: 1,
      predictedNavstatus: 0,
    } as const;
    // Three positions raise; later ones repeat the open occurrence (throttled to 60 s of event time).
    await fixtures.positions(
      [9, 8, 7, 5, 3].map((minutes) => ({
        ...anomalous,
        time: minutesAgo(minutes),
      })),
    );
    const raised = await fixtures.waitForAlert('anomaly', mmsi);
    const lastSeen = await waitFor(async () => {
      const [row] = await fixtures.rows<{ last_seen_at: Date }>(
        'SELECT last_seen_at FROM events WHERE id = $1',
        [raised.id],
      );
      return row !== undefined &&
        row.last_seen_at.getTime() > Date.parse(raised.occurredAt)
        ? row.last_seen_at
        : undefined;
    });
    // An event time of the feed, not the clock of the instance.
    expect(lastSeen.getTime()).toBeLessThan(Date.now() - 2 * 60_000);
  });

  it('ends the duplicate open rows of a key with its occurrence, never with a repeated resolution', async () => {
    const events = service.app.get(DetectorEventsRepository);
    const db = service.app.get<unknown, Database<typeof schema>>(DRIZZLE_DB);
    const mmsi = uniqueMmsi();
    const dedupKey = `geofence:${mmsi}:${newId()}`;
    const raise = async (minutes: number): Promise<AlertRaisedV1> => {
      const alert: AlertRaisedV1 = {
        id: newId(),
        type: 'geofence',
        domain: 'surveillance',
        severity: 'warning',
        mmsi,
        relatedMmsi: null,
        title: 'Duplicate test',
        message: 'Duplicate test',
        lat: 1,
        lon: 104,
        occurredAt: minutesAgo(minutes).toISOString(),
        dedupKey,
        zoneId: null,
        methodId: 'geo.geofence_enter',
        data: {},
      };
      await events.onRaised(alert, 'raised');
      return alert;
    };
    const openOfKey = async () =>
      (await events.loadOpen()).filter((alert) => alert.dedupKey === dedupKey);
    const rowsOfKey = () =>
      fixtures.rows<{
        id: string;
        resolved_at: Date | null;
        resolution: Record<string, unknown> | null;
      }>(
        'SELECT id, resolved_at, resolution FROM events WHERE dedup_key = $1 ORDER BY created_at',
        [dedupKey],
      );

    // Two open rows of one key (a second writer's duplicate): `loadOpen`
    // lists the newest last, so the SDK (last of a key wins) keeps it.
    const first = await raise(10);
    const second = await raise(9);
    const open = await openOfKey();
    expect(open.map((alert) => alert.alertId)).toEqual([first.id, second.id]);
    const [duplicate, occurrence] = open;
    if (duplicate === undefined || occurrence === undefined)
      throw new Error('two open rows expected');
    expect(await findLastEndedAt(db, dedupKey, mmsi)).toBeNull();

    // Ending the occurrence ends its duplicate too.
    const resolvedAt = minutesAgo(5);
    await events.onResolved({
      alert: occurrence,
      resolvedAt,
      reason: 'left the zone',
      data: { code: 'left_zone' },
    });
    const ended = await rowsOfKey();
    expect(ended.map((row) => row.resolved_at?.getTime())).toEqual([
      resolvedAt.getTime(),
      resolvedAt.getTime(),
    ]);
    expect(ended[0]?.resolution).toMatchObject({
      code: 'left_zone',
      duplicateOf: second.id,
    });
    expect(ended[1]?.resolution).not.toHaveProperty('duplicateOf');
    expect((await findLastEndedAt(db, dedupKey, mmsi))?.getTime()).toBe(
      resolvedAt.getTime(),
    );

    // A stale instance repeating the resolution of an ended row ends nothing
    // else: the occurrence opened since stays open.
    const third = await raise(3);
    await events.onResolved({
      alert: duplicate,
      resolvedAt: minutesAgo(2),
      reason: 'left the zone',
      data: { code: 'left_zone' },
    });
    expect((await openOfKey()).map((alert) => alert.alertId)).toEqual([
      third.id,
    ]);
  });
});
