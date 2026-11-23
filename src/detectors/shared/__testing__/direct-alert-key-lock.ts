// AlertKeyLock of the unit tests (excluded from the build): a single instance
// needs no cross-replica lock, so operations run directly; keys are recorded.
import { AlertKeyLock } from '../alert-key-lock.js';

/**
 * An {@link AlertKeyLock} without replicas: runs the operation, records its
 * key. `align` stands in for the alignment with `events` (e.g. adopting an
 * occurrence "another replica" opened, with `replaceOpen`), `endedAt` for the
 * end of each key's latest occurrence stored in `events`.
 */
export class DirectAlertKeyLock extends AlertKeyLock {
  readonly keys: string[] = [];
  readonly endedAt = new Map<string, Date>();
  align: ((dedupKey: string) => Promise<void>) | undefined;

  async run<T>(dedupKey: string, operation: () => Promise<T>): Promise<T> {
    this.keys.push(dedupKey);
    await this.align?.(dedupKey);
    return operation();
  }

  protected lastEndedAt(dedupKey: string): Promise<Date | null> {
    return Promise.resolve(this.endedAt.get(dedupKey) ?? null);
  }
}
