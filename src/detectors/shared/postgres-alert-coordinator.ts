import { AlertEmitter } from '@darmawanweb/ais-its-nest/analytics';
import {
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable, Logger } from '@nestjs/common';

import { DetectorEventsRepository } from '../detector-events.repository.js';
import { AlertCoordinator } from './alert-coordinator.js';

/**
 * Namespace of the advisory locks of alert keys (two-key form
 * `pg_advisory_xact_lock(namespace, hashtext(dedupKey))`, a key space apart
 * from single-key locks such as the migrator's).
 */
const ALERT_LOCK_NAMESPACE = 7_301_840;

/** Resolution reason of an occurrence another replica already ended. */
const ENDED_ELSEWHERE = 'ended by another instance';

/**
 * {@link AlertCoordinator} on the `events` table (PLATFORM WORKAROUND, see
 * there): reloads the open occurrences into the SDK `AlertEmitter` when this
 * instance (re)starts consuming positions, and serializes tick alert
 * operations per key with a transaction-scoped PostgreSQL advisory lock.
 *
 * `exclusive()` holds one pooled connection while the operation persists
 * and publishes on others, so it is used only by the sequential ticks (at
 * most one holder per ticking detector), never per position.
 */
@Injectable()
export class PostgresAlertCoordinator extends AlertCoordinator {
  private readonly logger = new Logger('AlertCoordinator');

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly emitter: AlertEmitter,
    private readonly events: DetectorEventsRepository,
  ) {
    super();
  }

  async exclusive<T>(
    dedupKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        ALERT_LOCK_NAMESPACE,
        dedupKey,
      ]);
      await this.align(dedupKey);
      return operation();
    });
  }

  /**
   * Adopts every stored open occurrence the emitter does not hold (opened by
   * another instance), and ends the local ones the table no longer has open
   * (ended by another instance). Occurrences this instance published after
   * the snapshot was taken are kept as they are.
   */
  protected async reload(): Promise<void> {
    const snapshotAt = Date.now();
    const stored = await this.events.loadOpen();
    const open = new Map(stored.map((alert) => [alert.dedupKey, alert]));
    const adopted = stored.filter((alert) => {
      const local = this.emitter.get(alert.dedupKey);
      return (
        local === undefined ||
        (local.alertId !== alert.alertId &&
          local.publishedAt.getTime() < snapshotAt)
      );
    });
    this.emitter.restore(adopted);
    let ended = 0;
    for (const local of this.emitter.openAlerts()) {
      if (open.has(local.dedupKey) || local.publishedAt.getTime() >= snapshotAt)
        continue;
      if (
        await this.emitter.resolve(local.dedupKey, { reason: ENDED_ELSEWHERE })
      )
        ended += 1;
    }
    if (adopted.length > 0 || ended > 0)
      this.logger.log(
        `Alert state reloaded: adopted ${adopted.length} open occurrence(s), dropped ${ended} ended elsewhere`,
      );
  }

  /** Makes the emitter's state of one key that of the `events` table. */
  private async align(dedupKey: string): Promise<void> {
    const stored = await this.events.openOccurrence(dedupKey);
    const local = this.emitter.get(dedupKey);
    if (stored !== undefined) {
      const current =
        local?.alertId === stored.alertId && local.severity === stored.severity;
      if (!current) this.emitter.restore([stored]);
      return;
    }
    // Already resolved in the table: the hook's update is a no-op there.
    if (local !== undefined)
      await this.emitter.resolve(dedupKey, { reason: ENDED_ELSEWHERE });
  }
}
