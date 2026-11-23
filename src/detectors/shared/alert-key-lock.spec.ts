import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  AlertEmitter,
  type DetectorAlerts,
  type DetectorAlertSignal,
  type OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { DirectAlertKeyLock } from './__testing__/direct-alert-key-lock.js';
import { alertLockHolders, LockPermits } from './postgres-alert-key-lock.js';

const MMSI = 525000901;
const ZONE_ID = newId();
const KEY = `geofence:${MMSI}:${ZONE_ID}`;
const T0 = new Date('2026-04-01T00:00:00Z');
const minutes = (count: number): Date =>
  new Date(T0.getTime() + count * 60_000);

/** `DetectorContext.alerts` of a geofence detector over a bare emitter. */
function setup() {
  const published: string[] = [];
  const emitter = new AlertEmitter({
    clock: () => T0,
    publish: (alert) => {
      published.push(alert.id);
      return Promise.resolve();
    },
  });
  const alerts: DetectorAlerts = {
    raise: (signal) =>
      emitter.raise('surveillance', {
        ...signal,
        methodId: signal.methodId ?? 'geo.geofence_enter',
        detector: 'geofence',
      }),
    resolve: (key, options) => emitter.resolve(key, options),
    forget: (key) => emitter.forget(key),
    get: (key) => emitter.get(key),
    isOpen: (key) => emitter.isOpen(key),
    open: (filter) => emitter.openAlerts(filter),
  };
  return { emitter, alerts, published, lock: new DirectAlertKeyLock() };
}

const signal = (
  severity: DetectorAlertSignal['severity'] = 'warning',
): DetectorAlertSignal => ({
  type: 'geofence',
  dedupKey: KEY,
  severity,
  mmsi: MMSI,
  title: 'Entered Zona A',
  message: 'Vessel entered Zona A',
  occurredAt: minutes(5),
  zoneId: ZONE_ID,
});

/** An occurrence of {@link KEY} another replica opened (as `loadOpen` returns it). */
const storedOccurrence = (): OpenAlert => ({
  alertId: newId(),
  dedupKey: KEY,
  type: 'geofence',
  mmsi: MMSI,
  relatedMmsi: null,
  zoneId: ZONE_ID,
  severity: 'warning',
  publishedSeverity: 'warning',
  openedAt: minutes(1),
  publishedAt: minutes(1),
  lastSeenAt: minutes(1),
  domain: 'surveillance',
  methodId: 'geo.geofence_enter',
  detector: 'geofence',
});

describe('AlertKeyLock.raiseFromPosition', () => {
  it('opens a new occurrence under the key lock', async () => {
    const { alerts, published, lock } = setup();
    await expect(
      lock.raiseFromPosition(alerts, signal(), minutes(5)),
    ).resolves.toBe('raised');
    expect(lock.keys).toEqual([KEY]);
    expect(published).toHaveLength(1);
  });

  it('adopts the occurrence another instance opened instead of opening a second one', async () => {
    const { emitter, alerts, published, lock } = setup();
    const stored = storedOccurrence();
    // The alignment under the lock finds the other instance's open row.
    lock.align = async (dedupKey) => {
      await emitter.replaceOpen([stored], {
        filter: (alert) => alert.dedupKey === dedupKey,
      });
    };
    await expect(
      lock.raiseFromPosition(alerts, signal(), minutes(5)),
    ).resolves.toBe('unchanged');
    expect(published).toEqual([]);
    expect(alerts.get(KEY)?.alertId).toBe(stored.alertId);
  });

  it('opens nothing for a position not newer than the end of the latest occurrence', async () => {
    const { alerts, published, lock } = setup();
    // Another instance handled the vessel past this position: it left at minute 7.
    lock.endedAt.set(KEY, minutes(7));
    await expect(
      lock.raiseFromPosition(alerts, signal(), minutes(5)),
    ).resolves.toBe('stale');
    await expect(
      lock.raiseFromPosition(alerts, signal(), minutes(7)),
    ).resolves.toBe('stale');
    expect(published).toEqual([]);
    expect(alerts.isOpen(KEY)).toBe(false);
    // A later position is a new occurrence.
    await expect(
      lock.raiseFromPosition(alerts, signal(), minutes(8)),
    ).resolves.toBe('raised');
    expect(published).toHaveLength(1);
  });

  it('takes no lock for an open occurrence that does not escalate, and the lock for an escalation', async () => {
    const { alerts, published, lock } = setup();
    await lock.raiseFromPosition(alerts, signal('warning'), minutes(5));
    expect(lock.keys).toEqual([KEY]);

    await expect(
      lock.raiseFromPosition(alerts, signal('warning'), minutes(6)),
    ).resolves.toBe('unchanged');
    await expect(
      lock.raiseFromPosition(alerts, signal('info'), minutes(7)),
    ).resolves.toBe('de-escalated');
    expect(lock.keys).toEqual([KEY]);

    await expect(
      lock.raiseFromPosition(alerts, signal('critical'), minutes(8)),
    ).resolves.toBe('escalated');
    expect(lock.keys).toEqual([KEY, KEY]);
    expect(published).toHaveLength(2);
  });
});

describe('PostgresAlertKeyLock holders', () => {
  it('keeps a pooled connection free for every holder', () => {
    expect(alertLockHolders(10)).toBe(4);
    expect(alertLockHolders(3)).toBe(1);
    expect(alertLockHolders(2)).toBe(1);
    expect(alertLockHolders(1)).toBe(1);
  });

  it('runs at most the permitted operations at once, in arrival order', async () => {
    const permits = new LockPermits(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const tasks = [0, 1, 2, 3].map((index) =>
      permits.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(index);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('releases the permit of a failed operation', async () => {
    const permits = new LockPermits(1);
    await expect(
      permits.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(permits.run(() => Promise.resolve('next'))).resolves.toBe(
      'next',
    );
  });
});

describe('documentation of the key lock', () => {
  it('names the AlertKeyLock, never the removed AlertCoordinator', async () => {
    const sources = fileURLToPath(new URL('../../', import.meta.url));
    const files = (await readdir(sources, { recursive: true })).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
    );
    const stale: string[] = [];
    for (const file of files) {
      const text = await readFile(join(sources, file), 'utf8');
      if (text.includes('AlertCoordinator')) stale.push(file);
    }
    expect(stale).toEqual([]);
  });
});
