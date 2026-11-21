import type {
  AisSource,
  PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { VesselPosition } from '@darmawanweb/ais-its-nest/analytics';

import type { TrackFix } from '../../domain/transhipment/track.js';

/** A vessel's latest state as stored in `vessel_state`. */
export interface StoredVesselState {
  readonly mmsi: number;
  readonly time: Date;
  readonly source: AisSource;
  readonly lat: number;
  readonly lon: number;
  /** Knots. */
  readonly sog: number;
  /** Degrees. */
  readonly cog: number;
  /** Degrees (511 = not available). */
  readonly hdg: number;
  /** Reported AIS navigational status (0–15). */
  readonly navstatus: VesselPosition['navstatus'];
  readonly predictedNavstatus: PredictedNavStatus;
  readonly inZoneIds: readonly string[];
}

/** A stored neighbour of the candidate search with its distance. */
export interface StoredNeighbour {
  readonly state: StoredVesselState;
  /** Geodesic distance (`ST_Distance` on geography), metres. */
  readonly distanceM: number;
}

/** Neighbour query on `vessel_state` (`ST_DWithin`). */
export interface StoredNeighbourQuery {
  readonly mmsi: number;
  readonly lat: number;
  readonly lon: number;
  readonly radiusM: number;
  /** Only states seen within this time range. */
  readonly from: Date;
  readonly to: Date;
  /** Only vessels from these sources or inside these zones. */
  readonly sources: readonly AisSource[];
  readonly zoneIds: readonly string[];
}

/** Vessels whose latest state is older than `seenBefore` (dark-vessel scan). */
export interface SilentVesselsQuery {
  /** Last seen before this time … */
  readonly seenBefore: Date;
  /** … but after this one (older states are ignored). */
  readonly seenAfter: Date;
  /** Last speed above this, knots. */
  readonly minSogKn: number;
  readonly limit: number;
}

/**
 * The `vessel_state` table as the detectors use it (an abstract class: the
 * Nest token of the Postgres repository and the contract of the in-memory
 * test double).
 */
export abstract class VesselStateStorage {
  /**
   * Stores the vessel's latest position (ignored when the stored one is
   * newer) and the zones containing it; `anomalyStreak` also updates the
   * anomaly counter (otherwise it is kept).
   */
  abstract save(
    position: VesselPosition,
    inZoneIds: readonly string[],
    patch?: { readonly anomalyStreak?: number },
  ): Promise<void>;

  /** Vessels with a non-zero anomaly streak (restored at startup). */
  abstract anomalyStreaks(): Promise<ReadonlyMap<number, number>>;

  /** Candidate neighbours within a radius and a time range (`ST_DWithin`). */
  abstract neighbours(query: StoredNeighbourQuery): Promise<StoredNeighbour[]>;

  /**
   * Vessels last seen in `[seenAfter, seenBefore)` while moving faster than
   * `minSogKn`, most recently seen first (the vessels that just went silent
   * are examined even when more than `limit` qualify).
   */
  abstract silent(query: SilentVesselsQuery): Promise<StoredVesselState[]>;
}

/** The `track_points` hypertable as the pair and pattern detectors use it. */
export abstract class TrackStorage {
  /** Appends a position (idempotent per vessel and time). */
  abstract append(position: VesselPosition): Promise<void>;

  /**
   * The last `maxPoints` fixes of a vessel in `[from, to]`, time ascending
   * (legacy `getShipRouteByMMSI` + `slice(-60)`).
   */
  abstract route(
    mmsi: number,
    from: Date,
    to: Date,
    maxPoints: number,
  ): Promise<TrackFix[]>;
}
