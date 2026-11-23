import { AsyncLocalStorage } from 'node:async_hooks';

import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { AlertEmitter } from '@darmawanweb/ais-its-nest/analytics';
import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../config.js';
import type * as schema from '../../db/schema.js';
import {
  findLastEndedAt,
  findOpenOccurrence,
} from '../detector-events.repository.js';
import { AlertKeyLock } from './alert-key-lock.js';

/**
 * Namespace of the advisory locks of alert keys (two-key form
 * `pg_advisory_xact_lock(namespace, hashtext(dedupKey))`, a key space apart
 * from single-key locks such as the migrator's).
 */
export const ALERT_LOCK_NAMESPACE = 7_301_840;

/**
 * Operations that may hold a key's lock at once on one instance: each holds
 * one pooled connection for its transaction and needs a second one at a time
 * (alignment, persistence), so at most `(poolMax - 1) / 2` hold one and the
 * pool always has a connection left for them and for other work.
 */
export function alertLockHolders(poolMax: number): number {
  return Math.max(1, Math.floor((poolMax - 1) / 2));
}

/** A FIFO counting semaphore: at most `available` tasks run at once. */
export class LockPermits {
  private readonly waiting: (() => void)[] = [];

  constructor(private available: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.available += 1;
      else next();
    }
  }
}

/**
 * {@link AlertKeyLock} on PostgreSQL: a transaction-scoped advisory lock per
 * key, taken inside the key's `AlertEmitter.withKey` turn. Alignment uses the
 * kit's hook-free state APIs: `replaceOpen` scoped to the key adopts the
 * stored occurrence, `forget` drops one the table no longer has open (no
 * persistence call, no `alert.resolved.v1`: the instance that ended it
 * published it).
 *
 * `run()` holds one pooled connection while the operation persists and
 * publishes on others; ticks and the transitions of position-driven
 * detectors (a new occurrence or an escalation, see
 * {@link AlertKeyLock.raiseFromPosition}) use it, so the holders per instance
 * are capped by {@link alertLockHolders} (`DATABASE_POOL_MAX` ≥ 2; others
 * wait in turn, holding no connection). A nested `run()` of the same key runs
 * the operation at once; never nest different keys.
 */
@Injectable()
export class PostgresAlertKeyLock extends AlertKeyLock {
  private readonly permits: LockPermits;
  /** Keys whose lock the current async context holds. */
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(
    @InjectPool() private readonly pool: Pool,
    @InjectDb() private readonly db: Database<typeof schema>,
    private readonly emitter: AlertEmitter,
    @InjectConfig() config: Config,
  ) {
    super();
    this.permits = new LockPermits(alertLockHolders(config.DATABASE_POOL_MAX));
  }

  run<T>(dedupKey: string, operation: () => Promise<T>): Promise<T> {
    const held = this.held.getStore();
    if (held?.has(dedupKey) === true) return operation();
    return this.emitter.withKey(dedupKey, () =>
      this.permits.run(() =>
        withTransaction(this.pool, async (client) => {
          await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
            ALERT_LOCK_NAMESPACE,
            dedupKey,
          ]);
          await this.align(dedupKey);
          return this.held.run(new Set([...(held ?? []), dedupKey]), operation);
        }),
      ),
    );
  }

  protected lastEndedAt(dedupKey: string, mmsi: number): Promise<Date | null> {
    return findLastEndedAt(this.db, dedupKey, mmsi);
  }

  /** Makes the emitter's state of one key that of the `events` table. */
  private async align(dedupKey: string): Promise<void> {
    const stored = await findOpenOccurrence(this.db, dedupKey);
    if (stored !== undefined) {
      const local = this.emitter.get(dedupKey);
      if (
        local?.alertId !== stored.alertId ||
        local.severity !== stored.severity
      )
        await this.emitter.replaceOpen([stored], {
          filter: (alert) => alert.dedupKey === dedupKey,
        });
      return;
    }
    // Ended in the table (by another instance): drop the local occurrence.
    if (this.emitter.isOpen(dedupKey)) await this.emitter.forget(dedupKey);
  }
}
