import { compareAlertSeverity } from '@darmawanweb/ais-its-contracts/domain';
import type {
  AlertOutcome,
  DetectorAlerts,
  DetectorAlertSignal,
} from '@darmawanweb/ais-its-nest/analytics';

/**
 * Outcome of {@link AlertKeyLock.raiseFromPosition}: the emitter's, or
 * `'stale'` when the position is not newer than the end of the key's latest
 * occurrence (nothing is raised).
 */
export type PositionRaiseOutcome = AlertOutcome | 'stale';

/**
 * Serializes the alert operations of one `dedupKey` across replicas.
 *
 * The Detector SDK (`@darmawanweb/ais-its-nest` 0.3) runs ticks only on the
 * active instance and reloads the open occurrences when an instance takes
 * over, so in normal operation one instance writes alerts. Two writers remain
 * possible:
 *
 * - an instance cut off from NATS but not from PostgreSQL: the kit keeps it
 *   active (missed heartbeats do not deactivate it) while the server pins
 *   another instance after the pinned TTL, and both run ticks;
 * - an active instance paused or hung for longer than the pinned TTL
 *   (SIGSTOP, a blocked event loop): the standby takes over and handles the
 *   redelivered positions, and the paused instance, once it resumes, still
 *   handles the positions it had buffered. They carry its old pin, so the kit
 *   neither re-checks the pin nor reloads the open occurrences (kit gap, see
 *   the README, _Platform issues_): it acts on the state it held before the
 *   pause.
 *
 * The `events` table cannot enforce one open occurrence per key itself (it is
 * a hypertable, whose unique indexes must include `time`), so every tick
 * raise or resolution runs through {@link run}, and every position-driven
 * raise that would publish (a new occurrence or an escalation) through
 * {@link raiseFromPosition}: under a cluster-wide lock of the key, the
 * instance first aligns its emitter state of the key with `events` (adopting
 * an occurrence another instance opened, forgetting one it ended), then acts.
 * Signals of an occurrence the instance holds open that do not escalate, and
 * position-driven resolutions, take no lock: they never add a row (ending an
 * occurrence another instance already ended changes nothing in `events`).
 */
export abstract class AlertKeyLock {
  /**
   * Runs an alert operation (raise / resolve) of `dedupKey` inside the key's
   * turn of the `AlertEmitter` (`withKey`, re-entrant for the operation's
   * own calls), after aligning the key with the `events` table under a lock
   * that serializes the key across replicas until the operation finished.
   */
  abstract run<T>(dedupKey: string, operation: () => Promise<T>): Promise<T>;

  /**
   * Raises a signal of a position-driven detector; `positionTime` is the
   * event time of the position that produced it. A signal of an occurrence
   * this instance holds open that does not escalate goes straight to the
   * emitter (no lock). One that would publish — a new occurrence or an
   * escalation — runs through {@link run}: after the alignment, a key that is
   * open (here or, adopted now, on another instance) gets the signal as
   * usual; a key that is not open is raised only when its latest occurrence
   * in `events` ended before `positionTime`. A position that is not newer
   * than that end was already handled past by another instance (positions a
   * paused instance buffered) and opens nothing: `'stale'`.
   */
  async raiseFromPosition(
    alerts: DetectorAlerts,
    signal: DetectorAlertSignal,
    positionTime: Date,
  ): Promise<PositionRaiseOutcome> {
    const open = alerts.get(signal.dedupKey);
    if (
      open !== undefined &&
      compareAlertSeverity(signal.severity, open.severity) <= 0
    )
      return alerts.raise(signal);
    return this.run(signal.dedupKey, async () => {
      if (!alerts.isOpen(signal.dedupKey)) {
        const endedAt = await this.lastEndedAt(signal.dedupKey, signal.mmsi);
        if (endedAt !== null && endedAt.getTime() >= positionTime.getTime())
          return 'stale';
      }
      return alerts.raise(signal);
    });
  }

  /**
   * When the latest occurrence of `dedupKey` (an alert of vessel `mmsi`)
   * ended in `events` (event time), `null` when it never ended or the key has
   * no occurrence. Called inside {@link run} of the key.
   */
  protected abstract lastEndedAt(
    dedupKey: string,
    mmsi: number,
  ): Promise<Date | null>;
}
