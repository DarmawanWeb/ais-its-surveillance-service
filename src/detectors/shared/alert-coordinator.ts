import { DEFAULT_PINNED_TTL_MS } from '@darmawanweb/ais-its-nest/nats';

/**
 * A pause in the positions this instance handles after which the open
 * occurrences are reloaded before the next one, ms: half the pinned TTL of
 * the exclusive position consumer (the service keeps the kit default, 30 s).
 * NATS moves the feed only after the active instance pulled nothing for the
 * whole TTL, so every takeover — also back to a former active instance —
 * follows a longer pause; a quiet feed costs one cheap reload.
 */
export const RESYNC_GAP_MS = DEFAULT_PINNED_TTL_MS / 2;

/**
 * An instance that handled no position for this long (detector clock) is a
 * standby for the ticks: the dark scan and the transhipment analyser pause
 * until it handles positions again, ms. Longer than the pinned TTL, so a
 * quiet feed does not stall the active instance; a former active instance
 * may tick for the difference after losing the feed, and its tick alert
 * operations stay consistent through {@link AlertCoordinator.exclusive}.
 */
export const ACTIVE_WINDOW_MS = 2 * 60_000;

/**
 * Keeps this instance's alert state consistent with the `events` table when
 * several replicas run (spec §18: one replica consumes positions, the others
 * are hot standbys).
 *
 * PLATFORM WORKAROUND (`@darmawanweb/ais-its-nest` 0.2.0, see the README,
 * "Platform issues"): the SDK keeps open occurrences in a per-instance
 * `AlertEmitter` restored only at bootstrap, runs `onTick` on every replica
 * and does not tell a detector whether its instance consumes positions. So
 * every detector reports each position here first: the first position after
 * a pause (a takeover, or the first one after startup) reloads the open
 * occurrences from the `events` table before any detector handles it, and
 * ticks raise alerts only while {@link isActive}. Alert operations of ticks
 * run through {@link exclusive}, which aligns the key with the `events` table
 * under a cluster-wide lock, so two replicas never open the same occurrence
 * twice nor miss a resolution made by the other one. Remove once the kit
 * reloads `loadOpen()` when a consumer gets pinned and pauses ticks on
 * standbys.
 */
export abstract class AlertCoordinator {
  private lastPositionAt: number | undefined;
  private reloading: Promise<void> | undefined;
  /** A failed reload is retried by the next position. */
  private stale = false;

  /**
   * Records that this instance is handling a position at `now` (detector
   * clock). After a pause of more than {@link RESYNC_GAP_MS} — or for the
   * first position — the open occurrences are reloaded first; every caller
   * waits for a running reload, so no detector acts on stale state.
   *
   * @throws when the reload fails (the next position retries it).
   */
  async positionSeen(now: Date): Promise<void> {
    const time = now.getTime();
    const resumed =
      this.lastPositionAt === undefined ||
      time - this.lastPositionAt > RESYNC_GAP_MS;
    if (this.lastPositionAt === undefined || time > this.lastPositionAt)
      this.lastPositionAt = time;
    if ((resumed || this.stale) && this.reloading === undefined) {
      this.stale = false;
      this.reloading = this.reload()
        .catch((error: unknown) => {
          this.stale = true;
          throw error;
        })
        .finally(() => {
          this.reloading = undefined;
        });
    }
    if (this.reloading !== undefined) await this.reloading;
  }

  /**
   * `true` while this instance consumes positions: it handled one within
   * {@link ACTIVE_WINDOW_MS} before `now` and its alert state is current.
   * Ticks that raise or resolve alerts (dark scan, transhipment analyser)
   * run only then — never on a standby.
   */
  isActive(now: Date): boolean {
    return (
      this.reloading === undefined &&
      !this.stale &&
      this.lastPositionAt !== undefined &&
      now.getTime() - this.lastPositionAt <= ACTIVE_WINDOW_MS
    );
  }

  /**
   * Runs an alert operation (raise / resolve) of `dedupKey` after aligning
   * the instance's state of that key with the `events` table, under a lock
   * that serializes the key across replicas until the operation finished.
   */
  abstract exclusive<T>(
    dedupKey: string,
    operation: () => Promise<T>,
  ): Promise<T>;

  /** Replaces the instance's open occurrences with those of the `events` table. */
  protected abstract reload(): Promise<void>;
}
