import { type AisSource, newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Detector,
  type DetectorCall,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';

import {
  detectTranshipment,
  type TranshipmentDetection,
  transhipmentSeverity,
} from '../../domain/transhipment/analysis.js';
import {
  type CandidateFix,
  type CandidateNeighbour,
  candidateObservations,
  mergeNeighbours,
  midpoint,
  pairOf,
  transhipmentKey,
} from '../../domain/transhipment/pairs.js';
import { fixAtTime, type TrackFix } from '../../domain/transhipment/track.js';
import { AlertCoordinator } from '../shared/alert-coordinator.js';
import { TrackStorage, VesselStateStorage } from '../shared/storage.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';
import {
  type TranshipmentConfig,
  transhipmentConfigSchema,
} from './transhipment.config.js';
import {
  type ClaimedPair,
  pairMapKey,
  TranshipmentPairStorage,
  type TranshipmentResultRecord,
} from './transhipment-pairs.storage.js';
import { TranshipmentMetrics } from './transhipment.metrics.js';

/** Alert type of the detector (contracts `ALERT_TYPES.transhipment`). */
export const TRANSHIPMENT_ALERT = 'transhipment';

/** Method ids of the detector, in the order of the methodology (§10). */
export const TRANSHIPMENT_METHOD_IDS = [
  'transhipment.candidate_queue',
  'transhipment.speed_priority',
  'transhipment.location_priority',
  'transhipment.heading_priority',
  'transhipment.route_interpolation',
  'transhipment.sliding_window',
  'transhipment.weighted_score',
  'transhipment.accuracy',
  'transhipment.priority_distribution',
  'geo.haversine_distance',
] as const;

/** Method id of the events: the score threshold decides "illegal". */
export const TRANSHIPMENT_EVENT_METHOD = 'transhipment.accuracy';

/** Base tick; the analyser runs every `TRANSHIPMENT_ANALYSIS_INTERVAL_S`. */
const TICK_INTERVAL_MS = 5_000;
/** The neighbour radius is widened by this factor: the legacy haversine (3438 nm sphere) decides. */
const SEARCH_MARGIN = 1.02;
/** Pairs not observed for this long are deleted, whatever their accumulated priority (track retention), ms. */
const PAIR_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Analyser runs between two prunes of finished pairs. */
const PRUNE_EVERY_RUNS = 120;

/**
 * Illegal transhipment (legacy `services/illegal-transhipment/*`,
 * `utils/illegal-transhipment.ts`, `workers/illegal-transhipment-child-worker.ts`)
 * without the Mongo queue and polling:
 *
 * 1. **Candidates** — for every position of a candidate vessel (source
 *    `batam`, or inside a `transhipment_area` zone) the vessel's state and
 *    track point are stored and its neighbours within 600 m seen within
 *    5 min (SDK `PairSearch`, plus `ST_DWithin` on `vessel_state` until the
 *    in-memory index covers a full window after a restart) are scored with
 *    the legacy speed × location × heading priority; pairs with `P > 0`
 *    accumulate `P` in `transhipment_pairs` (each vessel's observations
 *    count once: a redelivered position is ignored; an accumulation not
 *    continued within `TRANSHIPMENT_ROUTE_WINDOW_MIN` starts over). A
 *    vessel is a candidate through a `transhipment_area` zone only when the
 *    zone is global or its own organization's (spec §8.5).
 * 2. **Analyser** (tick, only on the instance consuming positions) — claims
 *    the pending pairs above `TRANSHIPMENT_MIN_PRIORITY` (priority DESC,
 *    queued_at ASC, `SKIP LOCKED`; pairs analysed within 15 min are
 *    skipped), runs the legacy interpolation / sliding-window detection over
 *    the last 60 min (≤ 60 fixes) of both tracks from `track_points`, stores
 *    every positive analysis in `transhipment_results` and raises a
 *    `transhipment` event (accuracy, window, average priority, distribution)
 *    when the score reaches 70; a negative analysis or a pair not observed
 *    for `TRANSHIPMENT_PAIR_EXPIRY_MIN` resolves the open occurrence. Every
 *    raise / resolve runs through the {@link AlertCoordinator}, so replicas
 *    never open an occurrence twice or miss one opened by another replica.
 *
 * Severity: `critical` when the score reaches `TRANSHIPMENT_CRITICAL_ACCURACY`
 * (90), else `warning`. Dedup key `transhipment:<minMmsi>:<maxMmsi>`.
 *
 * @method transhipment.candidate_queue
 * @method transhipment.sliding_window
 * @method transhipment.accuracy
 * @see ../../../../../docs/METHODOLOGY.md#10-transhipment-surveillance-detektor-transhipment
 */
@RegisterDetector()
@Injectable()
export class TranshipmentDetector implements Detector<TranshipmentConfig> {
  readonly id = 'transhipment';
  readonly domain = 'surveillance';
  readonly methodIds: readonly string[] = TRANSHIPMENT_METHOD_IDS;
  readonly alertTypes = [TRANSHIPMENT_ALERT] as const;
  readonly configSchema = transhipmentConfigSchema;
  readonly tickIntervalMs = TICK_INTERVAL_MS;

  /** Event time of the first position after startup (cold-start window). */
  private firstPositionAt: number | undefined;
  private lastAnalysisAt: number | undefined;
  private analysisRuns = 0;

  constructor(
    private readonly recorder: VesselStateRecorder,
    private readonly states: VesselStateStorage,
    private readonly tracks: TrackStorage,
    private readonly pairs: TranshipmentPairStorage,
    private readonly metrics: TranshipmentMetrics,
    private readonly coordinator: AlertCoordinator,
  ) {}

  async onPosition(
    context: DetectorContext<TranshipmentConfig>,
    position: VesselPosition,
  ): Promise<void> {
    await this.coordinator.positionSeen(context.now());
    const eligible = this.isCandidate(context, position);
    await this.recorder.observe(context, position, { force: eligible });
    if (!eligible) return;

    await this.tracks.append(position);
    const neighbours = await this.neighbours(context, position);
    const observations = candidateObservations(position, neighbours);
    if (observations.length === 0) return;
    await this.pairs.accumulate(observations, context.now(), {
      restartAfterMs: context.config.ROUTE_WINDOW_MIN * 60_000,
    });
    this.metrics.observed(observations.length);
  }

  async onTick(
    context: DetectorContext<TranshipmentConfig>,
    now: Date,
    call: DetectorCall,
  ): Promise<void> {
    const { config } = context;
    if (
      this.lastAnalysisAt !== undefined &&
      now.getTime() - this.lastAnalysisAt < config.ANALYSIS_INTERVAL_S * 1_000
    ) {
      return;
    }
    // Only the instance consuming positions analyses (never a standby).
    if (!this.coordinator.isActive(now)) return;
    this.lastAnalysisAt = now.getTime();

    const recovered = await this.pairs.recoverStale(
      new Date(now.getTime() - config.CLAIM_TIMEOUT_MIN * 60_000),
    );
    if (recovered > 0)
      context.logger.warn(`Returned ${recovered} stale claim(s) to the queue`);

    const claimed = await this.pairs.claim({
      now,
      minPriority: config.MIN_PRIORITY,
      reanalysisCooldownMs: config.REANALYSIS_COOLDOWN_MIN * 60_000,
      limit: config.ANALYSIS_BATCH,
    });
    for (const [index, pair] of claimed.entries()) {
      if (call.signal.aborted) {
        await this.pairs.release(claimed.slice(index));
        return;
      }
      await this.analyse(context, pair, now);
    }

    await this.expireOccurrences(context, now);
    this.analysisRuns += 1;
    if (this.analysisRuns % PRUNE_EVERY_RUNS === 0) {
      await this.pairs.prune(new Date(now.getTime() - PAIR_RETENTION_MS));
    }
    this.metrics.queue(await this.pairs.countByStatus());
  }

  /** Candidate vessel: from a watched AIS source or inside a watched zone. */
  private isCandidate(
    context: DetectorContext<TranshipmentConfig>,
    vessel: Pick<VesselPosition, 'mmsi' | 'lat' | 'lon'> & {
      readonly source: AisSource;
    },
  ): boolean {
    const { config } = context;
    if (config.SOURCES.includes(vessel.source)) return true;
    if (config.ZONE_KINDS.length === 0) return false;
    return (
      context.zones.zonesAt(vessel, {
        kinds: config.ZONE_KINDS,
        orgId: context.fleet.orgOf(vessel.mmsi) ?? null,
      }).length > 0
    );
  }

  /** Candidate neighbours of a position (memory, plus the database while cold). */
  private async neighbours(
    context: DetectorContext<TranshipmentConfig>,
    position: VesselPosition,
  ): Promise<CandidateNeighbour[]> {
    const { config } = context;
    const windowMs = config.NEIGHBOUR_WINDOW_MIN * 60_000;
    const radiusM = config.NEIGHBOUR_RADIUS_M * SEARCH_MARGIN;
    const memory = context.pairs
      .neighbours(position, {
        radiusM,
        maxAgeMs: windowMs,
        filter: (state) => this.isCandidate(context, state),
      })
      .map((neighbour) => ({
        fix: neighbour.point,
        distanceM: neighbour.distanceM,
      }));

    const time = position.time.getTime();
    this.firstPositionAt ??= time;
    if (time - this.firstPositionAt >= windowMs)
      return mergeNeighbours(position.mmsi, memory);

    // Cold start: the in-memory index has not seen a full window yet.
    const zoneIds =
      config.ZONE_KINDS.length === 0
        ? []
        : context.zones
            .all({ kinds: config.ZONE_KINDS })
            .map((zone) => zone.id);
    const stored = await this.states.neighbours({
      mmsi: position.mmsi,
      lat: position.lat,
      lon: position.lon,
      radiusM,
      from: new Date(time - windowMs),
      to: new Date(time + windowMs),
      sources: config.SOURCES,
      zoneIds,
    });
    return mergeNeighbours(
      position.mmsi,
      memory,
      stored
        // The same rule as in memory: zones of the neighbour's own organization only.
        .filter(({ state }) => this.isCandidate(context, state))
        .map(({ state, distanceM }): CandidateNeighbour => ({
          fix: state satisfies CandidateFix,
          distanceM,
        })),
    );
  }

  /** Runs the legacy detection for one claimed pair and records the outcome. */
  private async analyse(
    context: DetectorContext<TranshipmentConfig>,
    pair: ClaimedPair,
    now: Date,
  ): Promise<void> {
    const { config } = context;
    const key = transhipmentKey(pair.mmsiA, pair.mmsiB);
    try {
      const to = pair.lastSeenAt;
      const from = new Date(to.getTime() - config.ROUTE_WINDOW_MIN * 60_000);
      const [route1, route2] = await Promise.all([
        this.tracks.route(pair.mmsiA, from, to, config.ROUTE_MAX_POINTS),
        this.tracks.route(pair.mmsiB, from, to, config.ROUTE_MAX_POINTS),
      ]);
      const sizes = {
        route1Points: route1.length,
        route2Points: route2.length,
      };
      if (route1.length === 0 || route2.length === 0) {
        await this.pairs.complete(
          pair,
          { outcome: 'insufficient_data', result: sizes },
          now,
        );
        this.metrics.analysed('insufficient_data');
        return;
      }

      const detection = detectTranshipment(route1, route2, {
        checkDurationMs: config.CHECK_DURATION_MIN * 60_000,
        accuracyThreshold: config.ACCURACY_THRESHOLD,
      });
      const result = { ...serialize(detection), ...sizes };
      if (detection.isIllegal) {
        const positive = await this.coordinator.exclusive(key, () =>
          this.raise(context, pair, detection, route1, route2, now),
        );
        const completed = await this.pairs.complete(
          pair,
          { outcome: 'analysed', result, positive },
          now,
        );
        if (!completed)
          context.logger.warn(
            `Claim of ${pair.mmsiA}-${pair.mmsiB} expired during its analysis: result discarded (the new claim analyses again)`,
          );
      } else {
        await this.coordinator.exclusive(key, () =>
          context.alerts.resolve(key, {
            at: pair.lastSeenAt,
            reason: 'analysis no longer positive',
          }),
        );
        await this.pairs.complete(pair, { outcome: 'analysed', result }, now);
      }
      this.metrics.analysed(detection.isIllegal ? 'illegal' : 'clean');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.error(
        `Analysis of ${pair.mmsiA}-${pair.mmsiB} failed: ${message}`,
      );
      await this.pairs.fail(pair, message, now);
      this.metrics.analysed('failed');
    }
  }

  /**
   * Raises (or keeps open) the pair's occurrence and returns the analysis
   * as a result row of that occurrence (legacy `IllegalTranshipmentResult`).
   */
  private async raise(
    context: DetectorContext<TranshipmentConfig>,
    pair: ClaimedPair,
    detection: Extract<TranshipmentDetection, { isIllegal: true }>,
    route1: readonly TrackFix[],
    route2: readonly TrackFix[],
    now: Date,
  ): Promise<TranshipmentResultRecord> {
    const { config } = context;
    const middle = new Date(
      (detection.startTimestamp.getTime() + detection.endTimestamp.getTime()) /
        2,
    );
    const fix1 = fixAtTime(route1, middle) ?? route1[route1.length - 1];
    const fix2 = fixAtTime(route2, middle) ?? route2[route2.length - 1];
    const position =
      fix1 === undefined || fix2 === undefined ? null : midpoint(fix1, fix2);
    const [mmsiA, mmsiB] = pairOf(pair.mmsiA, pair.mmsiB);
    const key = transhipmentKey(mmsiA, mmsiB);
    const severity = transhipmentSeverity(
      detection.accuracy,
      config.CRITICAL_ACCURACY,
    );

    await context.alerts.raise({
      type: TRANSHIPMENT_ALERT,
      dedupKey: key,
      severity,
      mmsi: mmsiA,
      relatedMmsi: mmsiB,
      title: `Suspected transhipment between ${mmsiA} and ${mmsiB}`,
      message:
        `Vessels ${mmsiA} and ${mmsiB} stayed together from ` +
        `${detection.startTimestamp.toISOString()} to ${detection.endTimestamp.toISOString()} ` +
        `(score ${detection.accuracy} %, average priority ${detection.averagePriority})`,
      position,
      occurredAt: detection.startTimestamp,
      methodId: TRANSHIPMENT_EVENT_METHOD,
      // No organization ids: an org viewer of one vessel must not learn who owns the other (spec §8.5).
      data: {
        ...serialize(detection),
        accuracyThreshold: config.ACCURACY_THRESHOLD,
        accumulatedPriority: pair.priority,
        observations: pair.observations,
        lastDistanceM: pair.lastDistanceM,
        route1Points: route1.length,
        route2Points: route2.length,
        methodIds: [...this.methodIds],
      },
    });
    const occurrence = context.alerts.get(key);
    if (occurrence === undefined)
      throw new Error(`The occurrence ${key} is not open after its raise`);
    return {
      id: newId(),
      eventId: occurrence.alertId,
      mmsiA,
      mmsiB,
      detectedAt: now,
      startAt: detection.startTimestamp,
      endAt: detection.endTimestamp,
      accuracy: detection.accuracy,
      averagePriority: detection.averagePriority,
      priorityDistribution: { ...detection.priorityDistribution },
      severity,
      position,
      accumulatedPriority: pair.priority,
      observations: pair.observations,
      route1Points: route1.length,
      route2Points: route2.length,
      methodId: TRANSHIPMENT_EVENT_METHOD,
    };
  }

  /** Resolves open occurrences of pairs no longer observed together. */
  private async expireOccurrences(
    context: DetectorContext<TranshipmentConfig>,
    now: Date,
  ): Promise<void> {
    const open = context.alerts
      .open()
      .filter((alert) => alert.relatedMmsi !== null);
    if (open.length === 0) return;
    const eventTime = context.pairs.eventTime;
    const reference =
      eventTime !== undefined && eventTime < now ? eventTime : now;
    const expiryMs = context.config.PAIR_EXPIRY_MIN * 60_000;
    const lastSeen = await this.pairs.lastSeen(
      open.map((alert) => pairOf(alert.mmsi, alert.relatedMmsi ?? alert.mmsi)),
    );
    for (const alert of open) {
      const [mmsiA, mmsiB] = pairOf(
        alert.mmsi,
        alert.relatedMmsi ?? alert.mmsi,
      );
      const seen = lastSeen.get(pairMapKey(mmsiA, mmsiB)) ?? alert.lastSeenAt;
      if (reference.getTime() - seen.getTime() > expiryMs) {
        await this.coordinator.exclusive(alert.dedupKey, () =>
          context.alerts.resolve(alert.dedupKey, {
            at: reference,
            reason: 'pair no longer observed together',
            data: { lastSeenAt: seen.toISOString() },
          }),
        );
      }
    }
  }
}

/** JSON form of a detection (event data, pair `last_result`). */
function serialize(detection: TranshipmentDetection): Record<string, unknown> {
  if (!detection.isIllegal) return { isIllegal: false };
  return {
    isIllegal: true,
    accuracy: detection.accuracy,
    startTimestamp: detection.startTimestamp.toISOString(),
    endTimestamp: detection.endTimestamp.toISOString(),
    averagePriority: detection.averagePriority,
    priorityDistribution: { ...detection.priorityDistribution },
  };
}
