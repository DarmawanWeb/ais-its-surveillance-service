import { describe, expect, it } from 'vitest';

import { LocalAlertCoordinator } from './__testing__/local-alert-coordinator.js';
import { ACTIVE_WINDOW_MS, RESYNC_GAP_MS } from './alert-coordinator.js';

const START = new Date('2026-05-01T00:00:00Z');
const later = (ms: number): Date => new Date(START.getTime() + ms);

describe('AlertCoordinator', () => {
  it('is a standby until it handles a position, active within the window after one', async () => {
    const coordinator = new LocalAlertCoordinator();
    expect(coordinator.isActive(START)).toBe(false);

    await coordinator.positionSeen(START);
    expect(coordinator.isActive(later(ACTIVE_WINDOW_MS))).toBe(true);
    expect(coordinator.isActive(later(ACTIVE_WINDOW_MS + 1))).toBe(false);
  });

  it('reloads the open occurrences for the first position and after a pause (takeover)', async () => {
    const coordinator = new LocalAlertCoordinator();
    await coordinator.positionSeen(START);
    await coordinator.positionSeen(later(RESYNC_GAP_MS));
    await coordinator.positionSeen(later(2 * RESYNC_GAP_MS));
    expect(coordinator.reloads).toBe(1);

    // Any takeover follows a pause of at least the pinned TTL (30 s).
    await coordinator.positionSeen(later(2 * RESYNC_GAP_MS + 30_000));
    expect(coordinator.reloads).toBe(2);
    expect(RESYNC_GAP_MS).toBeLessThan(30_000);
    expect(ACTIVE_WINDOW_MS).toBeGreaterThan(30_000);
  });

  it('makes concurrent calls wait for one reload and stays inactive meanwhile', async () => {
    const coordinator = new LocalAlertCoordinator();
    const calls = [
      coordinator.positionSeen(START),
      coordinator.positionSeen(START),
      coordinator.positionSeen(later(1_000)),
    ];
    expect(coordinator.isActive(START)).toBe(false);
    await Promise.all(calls);
    expect(coordinator.reloads).toBe(1);
    expect(coordinator.isActive(later(1_000))).toBe(true);
  });

  it('retries a failed reload with the next position', async () => {
    const coordinator = new LocalAlertCoordinator();
    coordinator.failNextReload = true;
    await expect(coordinator.positionSeen(START)).rejects.toThrow(
      'events table unavailable',
    );
    expect(coordinator.isActive(START)).toBe(false);

    await coordinator.positionSeen(later(1_000));
    expect(coordinator.reloads).toBe(2);
    expect(coordinator.isActive(later(1_000))).toBe(true);
  });
});
