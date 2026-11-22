// In-memory doubles of the detector storage ports for unit tests (excluded
// from the build). They follow the semantics of the PostgreSQL repositories.
import {
  geodesicDistanceM,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';

import type { TranshipmentPairStatus } from '../../../db/schema.js';
import type { PairObservation } from '../../../domain/transhipment/pairs.js';
import type { TrackFix } from '../../../domain/transhipment/track.js';
import {
  type AccumulateOptions,
  type ClaimedPair,
  type ClaimOptions,
  type PairAnalysisOutcome,
  pairMapKey,
  TranshipmentPairStorage,
  type TranshipmentResultRecord,
} from '../../transhipment/transhipment-pairs.storage.js';
import {
  type AnomalyStreak,
  type SilentVesselsQuery,
  type StoredNeighbour,
  type StoredNeighbourQuery,
  type StoredVesselState,
  TrackStorage,
  VesselStateStorage,
} from '../storage.js';

/** `vessel_state` in memory. */
export class MemoryVesselStates extends VesselStateStorage {
  readonly states = new Map<
    number,
    StoredVesselState & { anomalyStreak: number; anomalyStreakAt: Date | null }
  >();
  writes = 0;

  async save(
    position: VesselPosition,
    inZoneIds: readonly string[],
    patch: { readonly anomalyStreak?: number } = {},
  ): Promise<void> {
    await Promise.resolve();
    this.writes += 1;
    const known = this.states.get(position.mmsi);
    if (known !== undefined && known.time > position.time) return;
    const lastCounted = known?.anomalyStreakAt ?? null;
    const counts =
      patch.anomalyStreak !== undefined &&
      (lastCounted === null || position.time > lastCounted);
    this.states.set(position.mmsi, {
      mmsi: position.mmsi,
      time: position.time,
      source: position.source,
      lat: position.lat,
      lon: position.lon,
      sog: position.sog,
      cog: position.cog,
      hdg: position.hdg,
      navstatus: position.navstatus,
      predictedNavstatus: position.predictedNavstatus,
      inZoneIds: [...inZoneIds],
      anomalyStreak: counts
        ? (patch.anomalyStreak ?? 0)
        : (known?.anomalyStreak ?? 0),
      anomalyStreakAt: counts
        ? position.time
        : (known?.anomalyStreakAt ?? null),
    });
  }

  async anomalyStreaks(): Promise<ReadonlyMap<number, AnomalyStreak>> {
    await Promise.resolve();
    const counted = [...this.states.values()].filter(
      (state) => state.anomalyStreakAt !== null,
    );
    const newest = Math.max(
      ...counted.map((state) => state.anomalyStreakAt?.getTime() ?? 0),
    );
    return new Map(
      counted
        .filter(
          (state) =>
            state.anomalyStreak > 0 ||
            (state.anomalyStreakAt?.getTime() ?? 0) >= newest - 60 * 60_000,
        )
        .map((state) => [
          state.mmsi,
          {
            streak: state.anomalyStreak,
            at: state.anomalyStreakAt ?? new Date(0),
          },
        ]),
    );
  }

  async neighbours(query: StoredNeighbourQuery): Promise<StoredNeighbour[]> {
    await Promise.resolve();
    return [...this.states.values()]
      .filter(
        (state) =>
          state.mmsi !== query.mmsi &&
          state.time >= query.from &&
          state.time <= query.to &&
          (query.sources.includes(state.source) ||
            state.inZoneIds.some((id) => query.zoneIds.includes(id))),
      )
      .map((state) => ({ state, distanceM: geodesicDistanceM(query, state) }))
      .filter((neighbour) => neighbour.distanceM <= query.radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  async silent(query: SilentVesselsQuery): Promise<StoredVesselState[]> {
    await Promise.resolve();
    return [...this.states.values()]
      .filter(
        (state) =>
          state.time < query.seenBefore &&
          state.time >= query.seenAfter &&
          state.sog > query.minSogKn,
      )
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, query.limit);
  }
}

/** `track_points` in memory. */
export class MemoryTracks extends TrackStorage {
  readonly points = new Map<number, Map<number, TrackFix>>();
  failing = false;

  async append(position: VesselPosition): Promise<void> {
    await Promise.resolve();
    if (this.failing) throw new Error('track storage unavailable');
    let track = this.points.get(position.mmsi);
    if (track === undefined) {
      track = new Map();
      this.points.set(position.mmsi, track);
    }
    if (!track.has(position.time.getTime())) {
      track.set(position.time.getTime(), {
        time: position.time,
        lat: position.lat,
        lon: position.lon,
        sog: position.sog,
        cog: position.cog,
        hdg: position.hdg,
      });
    }
  }

  async route(
    mmsi: number,
    from: Date,
    to: Date,
    maxPoints: number,
  ): Promise<TrackFix[]> {
    await Promise.resolve();
    return [...(this.points.get(mmsi)?.values() ?? [])]
      .filter((fix) => fix.time >= from && fix.time <= to)
      .sort((a, b) => a.time.getTime() - b.time.getTime())
      .slice(-maxPoints);
  }
}

interface MemoryPair {
  mmsiA: number;
  mmsiB: number;
  priority: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  queuedAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenByAAt: Date | null;
  lastSeenByBAt: Date | null;
  observations: number;
  lastDistanceM: number | null;
  claimedAt: Date | null;
  claimedPriority: number | null;
  lastAnalysedAt: Date | null;
  analyses: number;
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
}

/** `transhipment_pairs` in memory. */
export class MemoryPairs extends TranshipmentPairStorage {
  readonly pairs = new Map<string, MemoryPair>();

  readonly results: TranshipmentResultRecord[] = [];

  async accumulate(
    observations: readonly PairObservation[],
    now: Date,
    options: AccumulateOptions,
  ): Promise<void> {
    await Promise.resolve();
    for (const observation of observations) {
      const key = pairMapKey(observation.mmsiA, observation.mmsiB);
      const known = this.pairs.get(key);
      const byA = observation.observer === observation.mmsiA;
      if (known === undefined) {
        this.pairs.set(key, {
          mmsiA: observation.mmsiA,
          mmsiB: observation.mmsiB,
          priority: observation.priority,
          status: 'pending',
          queuedAt: now,
          firstSeenAt: observation.seenAt,
          lastSeenAt: observation.seenAt,
          lastSeenByAAt: byA ? observation.seenAt : null,
          lastSeenByBAt: byA ? null : observation.seenAt,
          observations: 1,
          lastDistanceM: observation.distanceM,
          claimedAt: null,
          claimedPriority: null,
          lastAnalysedAt: null,
          analyses: 0,
          lastResult: null,
          lastError: null,
        });
        continue;
      }
      const lastOfObserver = byA ? known.lastSeenByAAt : known.lastSeenByBAt;
      if (lastOfObserver !== null && observation.seenAt <= lastOfObserver)
        continue;
      const fresh =
        known.status === 'completed' ||
        known.status === 'failed' ||
        (known.status === 'pending' &&
          known.lastSeenAt.getTime() <
            observation.seenAt.getTime() - options.restartAfterMs);
      known.priority = fresh
        ? observation.priority
        : known.priority + observation.priority;
      known.queuedAt = fresh ? now : known.queuedAt;
      known.firstSeenAt = fresh ? observation.seenAt : known.firstSeenAt;
      known.observations = fresh ? 1 : known.observations + 1;
      if (known.status === 'completed' || known.status === 'failed')
        known.status = 'pending';
      known.lastSeenAt =
        observation.seenAt > known.lastSeenAt
          ? observation.seenAt
          : known.lastSeenAt;
      if (byA) known.lastSeenByAAt = observation.seenAt;
      else known.lastSeenByBAt = observation.seenAt;
      known.lastDistanceM = observation.distanceM;
    }
  }

  async claim(options: ClaimOptions): Promise<ClaimedPair[]> {
    await Promise.resolve();
    const analysedBefore = options.now.getTime() - options.reanalysisCooldownMs;
    const claimable = [...this.pairs.values()]
      .filter(
        (pair) =>
          pair.status === 'pending' &&
          pair.priority >= options.minPriority &&
          (pair.lastAnalysedAt === null ||
            pair.lastAnalysedAt.getTime() <= analysedBefore),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.queuedAt.getTime() - b.queuedAt.getTime(),
      )
      .slice(0, options.limit);
    for (const pair of claimable) {
      pair.status = 'in_progress';
      pair.claimedAt = options.now;
      pair.claimedPriority = pair.priority;
    }
    return claimable.map((pair) => ({
      mmsiA: pair.mmsiA,
      mmsiB: pair.mmsiB,
      claimedAt: options.now,
      priority: pair.priority,
      queuedAt: pair.queuedAt,
      firstSeenAt: pair.firstSeenAt,
      lastSeenAt: pair.lastSeenAt,
      observations: pair.observations,
      lastDistanceM: pair.lastDistanceM,
    }));
  }

  async complete(
    pair: ClaimedPair,
    outcome: PairAnalysisOutcome,
    now: Date,
  ): Promise<boolean> {
    await Promise.resolve();
    const known = this.claimOf(pair);
    if (known === undefined) return false;
    const remaining = known.priority - (known.claimedPriority ?? 0);
    known.priority = Math.max(remaining, 0);
    known.status = remaining > 0 ? 'pending' : 'completed';
    if (remaining > 0) known.queuedAt = now;
    if (outcome.outcome === 'analysed') {
      known.lastAnalysedAt = now;
      known.analyses += 1;
    }
    known.lastResult = { outcome: outcome.outcome, ...outcome.result };
    known.claimedAt = null;
    known.claimedPriority = null;
    if (outcome.outcome === 'analysed' && outcome.positive !== undefined)
      this.results.push(outcome.positive);
    return true;
  }

  async fail(pair: ClaimedPair, error: string, now: Date): Promise<void> {
    await Promise.resolve();
    const known = this.claimOf(pair);
    if (known === undefined) return;
    known.status = 'failed';
    known.lastError = error;
    known.lastAnalysedAt = now;
    known.claimedAt = null;
    known.claimedPriority = null;
  }

  async release(pairs: readonly ClaimedPair[]): Promise<void> {
    await Promise.resolve();
    for (const pair of pairs) {
      const known = this.claimOf(pair);
      if (known !== undefined) {
        known.status = 'pending';
        known.claimedAt = null;
        known.claimedPriority = null;
      }
    }
  }

  async recoverStale(claimedBefore: Date): Promise<number> {
    await Promise.resolve();
    let recovered = 0;
    for (const pair of this.pairs.values()) {
      if (
        pair.status === 'in_progress' &&
        pair.claimedAt !== null &&
        pair.claimedAt < claimedBefore
      ) {
        pair.status = 'pending';
        pair.claimedAt = null;
        pair.claimedPriority = null;
        recovered += 1;
      }
    }
    return recovered;
  }

  async lastSeen(
    pairs: readonly (readonly [number, number])[],
  ): Promise<ReadonlyMap<string, Date>> {
    await Promise.resolve();
    const seen = new Map<string, Date>();
    for (const [a, b] of pairs) {
      const known = this.pairs.get(pairMapKey(a, b));
      if (known !== undefined) seen.set(pairMapKey(a, b), known.lastSeenAt);
    }
    return seen;
  }

  async prune(seenBefore: Date): Promise<number> {
    await Promise.resolve();
    let pruned = 0;
    for (const [key, pair] of this.pairs) {
      if (pair.status !== 'in_progress' && pair.lastSeenAt < seenBefore) {
        this.pairs.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  async countByStatus(): Promise<
    Readonly<Partial<Record<TranshipmentPairStatus, number>>>
  > {
    await Promise.resolve();
    const counts: Partial<Record<TranshipmentPairStatus, number>> = {};
    for (const pair of this.pairs.values())
      counts[pair.status] = (counts[pair.status] ?? 0) + 1;
    return counts;
  }

  /** The pair while `claim` holds it. */
  private claimOf(claim: ClaimedPair): MemoryPair | undefined {
    const known = this.pairs.get(pairMapKey(claim.mmsiA, claim.mmsiB));
    return known?.status === 'in_progress' &&
      known.claimedAt?.getTime() === claim.claimedAt.getTime()
      ? known
      : undefined;
  }

  /** The stored pair (tests). */
  get(a: number, b: number): MemoryPair | undefined {
    return this.pairs.get(pairMapKey(Math.min(a, b), Math.max(a, b)));
  }
}
