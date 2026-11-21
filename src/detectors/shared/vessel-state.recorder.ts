import type {
  VesselPosition,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';

import type { VesselStateStorage } from './storage.js';

/** Options of {@link VesselStateRecorder}. */
export interface VesselStateRecorderOptions {
  /** Minimum event-time interval between two writes of a vessel, ms (`VESSEL_STATE_WRITE_INTERVAL_S`). */
  readonly writeIntervalMs: number;
  /** Vessels remembered for the throttle before old entries are dropped. Default 250 000. */
  readonly maxTracked?: number;
}

/** Entries kept for at least this event-time window when the throttle map is trimmed, ms. */
const TRIM_WINDOW_MS = 60 * 60_000;

/**
 * Writes the vessels' latest state to `vessel_state` (latest position, zones
 * containing it) at most once per `writeIntervalMs` of event time per vessel,
 * or on every position when forced (transhipment candidates, whose stored
 * state feeds the `ST_DWithin` candidate search). Every detector calls it for
 * the positions it sees; the calls of one position share a single write
 * (the first call wins, a forced call still writes a position that an
 * earlier unforced call skipped).
 */
export class VesselStateRecorder {
  private readonly written = new Map<number, number>();
  private readonly maxTracked: number;

  constructor(
    private readonly storage: VesselStateStorage,
    private readonly options: VesselStateRecorderOptions,
  ) {
    this.maxTracked = options.maxTracked ?? 250_000;
  }

  /** Records `position` unless the vessel was written recently (event time). */
  async observe(
    zones: ZoneIndex,
    position: VesselPosition,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const time = position.time.getTime();
    const last = this.written.get(position.mmsi);
    if (last !== undefined) {
      if (last >= time) return;
      if (options.force !== true && time - last < this.options.writeIntervalMs)
        return;
    }
    this.remember(position.mmsi, time);
    await this.storage.save(position, this.zoneIdsAt(zones, position));
  }

  /** Records `position` with a new anomaly streak (always written). */
  async saveAnomalyStreak(
    zones: ZoneIndex,
    position: VesselPosition,
    streak: number,
  ): Promise<void> {
    this.remember(position.mmsi, position.time.getTime());
    await this.storage.save(position, this.zoneIdsAt(zones, position), {
      anomalyStreak: streak,
    });
  }

  private zoneIdsAt(zones: ZoneIndex, position: VesselPosition): string[] {
    return zones.zonesAt(position).map((zone) => zone.id);
  }

  private remember(mmsi: number, time: number): void {
    this.written.set(mmsi, time);
    if (this.written.size <= this.maxTracked) return;
    // Forget vessels not written within the last hour of event time.
    const cutoff = time - TRIM_WINDOW_MS;
    for (const [vessel, writtenAt] of this.written) {
      if (writtenAt < cutoff) this.written.delete(vessel);
    }
  }
}
