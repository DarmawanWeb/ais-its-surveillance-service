// Single-instance AlertCoordinator for unit tests (excluded from the build):
// the activity rules of the base class, no database.
import { AlertCoordinator } from '../alert-coordinator.js';

/** An {@link AlertCoordinator} without replicas: reloads are counted, operations run directly. */
export class LocalAlertCoordinator extends AlertCoordinator {
  reloads = 0;
  failNextReload = false;
  readonly exclusiveKeys: string[] = [];

  async exclusive<T>(
    dedupKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.exclusiveKeys.push(dedupKey);
    return operation();
  }

  protected async reload(): Promise<void> {
    await Promise.resolve();
    this.reloads += 1;
    if (this.failNextReload) {
      this.failNextReload = false;
      throw new Error('events table unavailable');
    }
  }
}
