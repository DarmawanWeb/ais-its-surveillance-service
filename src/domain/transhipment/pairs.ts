import { candidatePriorities } from './priority.js';
import type { TrackFix } from './track.js';

/** A vessel fix with its identity, as compared by the candidate search. */
export interface CandidateFix extends Pick<
  TrackFix,
  'time' | 'lat' | 'lon' | 'sog' | 'hdg'
> {
  readonly mmsi: number;
}

/** A neighbour of the candidate search with its distance. */
export interface CandidateNeighbour {
  readonly fix: CandidateFix;
  /** Distance to the current vessel, metres. */
  readonly distanceM: number;
}

/** One scored observation of a candidate pair (accumulated into `transhipment_pairs`). */
export interface PairObservation {
  /** Smaller MMSI of the pair. */
  readonly mmsiA: number;
  /** Larger MMSI of the pair. */
  readonly mmsiB: number;
  /** Product priority of this observation, > 0. */
  readonly priority: number;
  /** Distance between the two fixes, metres. */
  readonly distanceM: number;
  /** Event time of the observation (the current vessel's fix). */
  readonly seenAt: Date;
}

/**
 * The pair key of two vessels: their MMSIs in ascending order (legacy
 * `sortMMSI`; numeric and lexicographic order agree for 9-digit MMSIs).
 *
 * @method transhipment.candidate_queue
 * @see be-legacy/src/repositories/illegal-transhipment/it-queue.repository.ts `sortMMSI`
 */
export function pairOf(
  first: number,
  second: number,
): readonly [number, number] {
  return first < second ? [first, second] : [second, first];
}

/** Deduplication key of a transhipment occurrence (`transhipment:<minMmsi>:<maxMmsi>`). */
export function transhipmentKey(first: number, second: number): string {
  const [a, b] = pairOf(first, second);
  return `transhipment:${a}:${b}`;
}

/**
 * Merges the neighbours of the in-memory search with neighbours read from
 * the database (cold start): one entry per vessel, the newer fix wins (the
 * in-memory one on a tie), nearest first. The current vessel is excluded.
 */
export function mergeNeighbours(
  currentMmsi: number,
  ...sources: readonly (readonly CandidateNeighbour[])[]
): CandidateNeighbour[] {
  const byMmsi = new Map<number, CandidateNeighbour>();
  for (const source of sources) {
    for (const neighbour of source) {
      const { mmsi } = neighbour.fix;
      if (mmsi === currentMmsi) continue;
      const known = byMmsi.get(mmsi);
      if (
        known === undefined ||
        neighbour.fix.time.getTime() > known.fix.time.getTime()
      ) {
        byMmsi.set(mmsi, neighbour);
      }
    }
  }
  return [...byMmsi.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Scores the current vessel against its candidate neighbours (their newest
 * fix within the neighbour window) with the legacy product priority and
 * returns one observation per pair with `P > 0`, keyed by the sorted pair.
 * The caller adds `P` to the pair's accumulated priority
 * (`Q(min m, max m) ← Q + P`, legacy `it-queue` create / updatePriority).
 *
 * @method transhipment.candidate_queue
 * @see ../../../../../docs/METHODOLOGY.md#transhipment.candidate_queue
 * @see be-legacy/src/services/illegal-transhipment/illegal-transhipment.service.ts `detectIllegalTranshipment`
 */
export function candidateObservations(
  current: CandidateFix,
  neighbours: readonly CandidateNeighbour[],
): PairObservation[] {
  const distances = new Map<number, number>();
  for (const neighbour of neighbours)
    distances.set(neighbour.fix.mmsi, neighbour.distanceM);
  return candidatePriorities(
    current,
    neighbours
      .filter((neighbour) => neighbour.fix.mmsi !== current.mmsi)
      .map((neighbour) => ({ mmsi: neighbour.fix.mmsi, fix: neighbour.fix })),
  ).map(({ mmsi, priority }) => {
    const [mmsiA, mmsiB] = pairOf(current.mmsi, mmsi);
    return {
      mmsiA,
      mmsiB,
      priority,
      distanceM: distances.get(mmsi) ?? Number.NaN,
      seenAt: current.time,
    };
  });
}

/** Midpoint of two fixes (degrees): the location of a pair's event. */
export function midpoint(
  first: Pick<TrackFix, 'lat' | 'lon'>,
  second: Pick<TrackFix, 'lat' | 'lon'>,
): { readonly lat: number; readonly lon: number } {
  return {
    lat: (first.lat + second.lat) / 2,
    lon: (first.lon + second.lon) / 2,
  };
}
