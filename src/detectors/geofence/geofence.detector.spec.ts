import { readFile } from 'node:fs/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { DirectAlertKeyLock } from '../shared/__testing__/direct-alert-key-lock.js';
import { MemoryVesselStates } from '../shared/__testing__/memory-storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import { GeofenceDetector, geofenceKey } from './geofence.detector.js';

const MMSI = 525000401;
const START = new Date('2026-04-01T00:00:00Z');
const SQUARE: ZoneSnapshotV1['geometry'] = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};
const inside = { mmsi: MMSI, lat: 1.05, lon: 104.05, sog: 5 };
const outside = { mmsi: MMSI, lat: 1.2, lon: 104.2, sog: 5 };

function setup(
  env: Record<string, string> = {},
  lock = new DirectAlertKeyLock(),
) {
  const recorder = new VesselStateRecorder(new MemoryVesselStates(), {
    writeIntervalMs: 60_000,
  });
  return DetectorTestHarness.create({
    detectors: [new GeofenceDetector(recorder, lock)],
    env,
    now: START,
  });
}

describe('GeofenceDetector', () => {
  it('raises on entering a restricted zone (critical) and resolves on leaving', async () => {
    const harness = setup();
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Zona A',
      geometry: SQUARE,
    });
    await harness.track([outside, inside, inside]);
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        type: 'geofence',
        severity: 'critical',
        zoneId: zone.id,
        dedupKey: geofenceKey(MMSI, zone.id),
        methodId: 'geo.geofence_enter',
      }),
    ]);
    await harness.position(outside);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'left the zone' }),
    ]);
  });

  it('grades mpa/custom zones as warning and ignores zones without alertOnEnter or other kinds', async () => {
    const harness = setup();
    await harness.zone({ kind: 'mpa', alertOnEnter: true, geometry: SQUARE });
    await harness.zone({
      kind: 'custom',
      alertOnEnter: false,
      geometry: SQUARE,
    });
    await harness.zone({
      kind: 'fishing_ground',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.position(inside);
    expect(harness.alerts.map((alert) => alert.severity)).toEqual(['warning']);
  });

  it('applies organization zones to the vessels of that organization only', async () => {
    const harness = setup();
    const orgId = '0190d6b4-0000-7000-8000-000000000001';
    await harness.zone({
      kind: 'custom',
      alertOnEnter: true,
      orgId,
      geometry: SQUARE,
    });
    await harness.position(inside);
    expect(harness.alerts).toEqual([]);

    await harness.vessel({ mmsi: MMSI + 1, orgId });
    await harness.position({ ...inside, mmsi: MMSI + 1 });
    expect(harness.alerts).toEqual([
      expect.objectContaining({ mmsi: MMSI + 1 }),
    ]);
  });

  it('resolves open occurrences when the zone is deleted or stops alerting', async () => {
    const harness = setup();
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.position(inside);
    await harness.removeZone(zone.id);
    expect(harness.resolutions).toEqual([
      expect.objectContaining({ reason: 'zone deleted' }),
    ]);
  });

  it('suppresses a re-entry within the alert cooldown', async () => {
    const harness = setup();
    await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    await harness.track([inside, outside, inside]);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.updates).toEqual([
      expect.objectContaining({ reason: 'suppressed', reopened: true }),
    ]);

    harness.advance(11 * 60_000);
    await harness.track([outside, inside]);
    expect(harness.alerts).toHaveLength(2);
  });

  it('measures the cooldown from the raise: a later re-entry opens a new occurrence, even right after the exit', async () => {
    const harness = setup();
    await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: SQUARE,
    });
    const at = (minutes: number): Date =>
      new Date(START.getTime() + minutes * 60_000);
    harness.setTime(at(0));
    await harness.position({ ...inside, time: at(0) });
    harness.setTime(at(9));
    await harness.position({ ...outside, time: at(9) });
    // The resolution waits for the cooldown since the raise (10 min).
    expect(harness.resolvedEvents).toEqual([]);

    // Back 2 min after the exit, 11 min after the raise: not suppressed.
    harness.setTime(at(11));
    await harness.position({ ...inside, time: at(11) });
    expect(harness.updates).toEqual([]);
    expect(harness.alerts).toHaveLength(2);
    // The end of the first occurrence went out before the new alert.
    expect(harness.resolvedEvents.map((event) => event.alertId)).toEqual([
      harness.alerts[0]?.id,
    ]);
  });

  it('is documented as measured from the raise, never from the resolution (README)', async () => {
    const readme = (
      await readFile(new URL('../../../README.md', import.meta.url), 'utf8')
    ).replace(/\s+/g, ' ');
    // Alert semantics and the troubleshooting entry state what the test above shows.
    expect(readme).not.toMatch(/or a resolution is \*\*suppressed\*\*/);
    expect(readme).toContain(
      "a re-raise within `ALERT_COOLDOWN_MIN` (10) of the occurrence's last publication (its raise or escalation) is **suppressed**",
    );
    expect(readme).toContain(
      "_A re-entry shows no new alert_: that is the cool-down — a re-raise within `ALERT_COOLDOWN_MIN` (10) of the occurrence's last publication (its raise or escalation) is `suppressed`",
    );
    expect(readme).toContain(
      'A later re-raise, even minutes after the resolution, is a new occurrence: the inbox gets `resolved`, then a new `raised`',
    );
  });

  it('counts the zone buffer unless GEOFENCE_USE_BUFFER=false', async () => {
    const nearby = { ...outside, lat: 1.1005, lon: 104.05 }; // ≈ 55 m north of the edge
    const buffered = setup();
    await buffered.zone({
      kind: 'restricted',
      alertOnEnter: true,
      bufferM: 100,
      geometry: SQUARE,
    });
    await buffered.position(nearby);
    expect(buffered.alerts).toHaveLength(1);

    const strict = setup({ GEOFENCE_USE_BUFFER: 'false' });
    await strict.zone({
      kind: 'restricted',
      alertOnEnter: true,
      bufferM: 100,
      geometry: SQUARE,
    });
    await strict.position(nearby);
    expect(strict.alerts).toEqual([]);
  });

  it('leaves zone changes to the active instance and ends stale occurrences on a takeover', async () => {
    const harness = setup();
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Zona C',
      geometry: SQUARE,
    });
    await harness.track([outside, inside]);
    expect(harness.alertsOf('geofence')[0]?.data).toMatchObject({
      messageKey: 'surveillance.geofence.entered',
      messageParams: { mmsi: MMSI, zoneName: 'Zona C', zoneKind: 'restricted' },
    });

    // A standby skips the deletion (the active instance ends the occurrence) …
    await harness.deactivate();
    await harness.removeZone(zone.id);
    expect(harness.resolutions).toEqual([]);

    // … and when it takes over, it ends what nobody ended while it waited.
    await harness.activate();
    expect(harness.resolutions).toEqual([
      expect.objectContaining({
        reason: 'zone deleted',
        data: { code: 'zone_deleted' },
      }),
    ]);
  });
  it('adopts the occurrence another instance opened while this one was paused (no second alert)', async () => {
    const lock = new DirectAlertKeyLock();
    const harness = setup({}, lock);
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Zona D',
      geometry: SQUARE,
    });
    const key = geofenceKey(MMSI, zone.id);
    const otherAlertId = newId();
    // The alignment under the key's lock finds the row the other instance
    // opened for the same entry (redelivered to it during the pause).
    lock.align = async (dedupKey) => {
      await harness.services.alerts.replaceOpen(
        [
          {
            alertId: otherAlertId,
            dedupKey,
            type: 'geofence',
            mmsi: MMSI,
            relatedMmsi: null,
            zoneId: zone.id,
            severity: 'critical',
            publishedSeverity: 'critical',
            openedAt: START,
            publishedAt: START,
            lastSeenAt: START,
            domain: 'surveillance',
            methodId: 'geo.geofence_enter',
            detector: 'geofence',
          },
        ],
        { filter: (alert) => alert.dedupKey === dedupKey },
      );
    };
    await harness.track([outside, inside, inside]);
    expect(lock.keys).toEqual([key]);
    expect(harness.alerts).toEqual([]);
    expect(harness.services.alerts.get(key)?.alertId).toBe(otherAlertId);

    // It ends the adopted occurrence when the vessel leaves.
    await harness.position(outside);
    expect(
      harness.resolutions.map(({ alert, data }) => [alert.alertId, data]),
    ).toEqual([[otherAlertId, { code: 'left_zone' }]]);
  });

  it('opens nothing for a buffered entry older than the end of the latest occurrence', async () => {
    const lock = new DirectAlertKeyLock();
    const harness = setup({}, lock);
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      name: 'Zona E',
      geometry: SQUARE,
    });
    const key = geofenceKey(MMSI, zone.id);
    // Another instance already handled the entry and the exit after it.
    lock.endedAt.set(key, new Date(START.getTime() + 5 * 60_000));
    await harness.track([
      { ...outside, time: START },
      { ...inside, time: new Date(START.getTime() + 60_000) },
    ]);
    expect(harness.alerts).toEqual([]);
    expect(harness.services.alerts.isOpen(key)).toBe(false);

    // A re-entry after that end is a new occurrence.
    await harness.position({
      ...inside,
      time: new Date(START.getTime() + 6 * 60_000),
    });
    expect(harness.alerts).toEqual([
      expect.objectContaining({ dedupKey: key, severity: 'critical' }),
    ]);
  });
});
