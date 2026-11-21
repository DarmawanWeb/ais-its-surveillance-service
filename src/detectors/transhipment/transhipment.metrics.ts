import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';

import type { TranshipmentPairStatus } from '../../db/schema.js';

/** How the analysis of a claimed pair ended. */
export type TranshipmentAnalysisOutcome =
  /** The legacy detection reached the threshold: an event was raised. */
  | 'illegal'
  /** Analysed, below the threshold (an open occurrence is resolved). */
  | 'clean'
  /** A track was empty in the route window: nothing analysed. */
  | 'insufficient_data'
  /** The analysis threw; the pair is marked `failed`. */
  | 'failed';

const PAIR_STATUSES: readonly TranshipmentPairStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
];

/** Creates (or gets) the instruments; their types are inferred from the kit. */
function instruments(metrics: MetricsService) {
  return {
    observations: metrics.counter({
      name: 'surveillance_transhipment_observations_total',
      help: 'Transhipment candidate pair observations (priority > 0) accumulated',
    }),
    analyses: metrics.counter({
      name: 'surveillance_transhipment_analyses_total',
      help: 'Transhipment pair analyses by outcome',
      labelNames: ['outcome'],
    }),
    pairs: metrics.gauge({
      name: 'surveillance_transhipment_pairs',
      help: 'Transhipment candidate pairs per queue status (latest analyser run)',
      labelNames: ['status'],
    }),
  };
}

/**
 * Domain metrics of the transhipment detector (spec §10, prefix `aisits_`),
 * next to the SDK's per-detector metrics:
 *
 * - `aisits_surveillance_transhipment_observations_total` — candidate pair
 *   observations with `P > 0` accumulated into `transhipment_pairs`;
 * - `aisits_surveillance_transhipment_analyses_total{outcome}` — analyses of
 *   claimed pairs by outcome (`illegal`, `clean`, `insufficient_data`, `failed`);
 * - `aisits_surveillance_transhipment_pairs{status}` — pairs per queue status
 *   after the latest analyser run (a growing `pending` count means the analyser
 *   falls behind: raise `TRANSHIPMENT_ANALYSIS_BATCH`).
 */
@Injectable()
export class TranshipmentMetrics {
  private readonly metrics: ReturnType<typeof instruments>;

  constructor(metrics: MetricsService) {
    this.metrics = instruments(metrics);
  }

  /** Counts accumulated candidate observations. */
  observed(count: number): void {
    if (count > 0) this.metrics.observations.inc(count);
  }

  /** Counts one finished analysis. */
  analysed(outcome: TranshipmentAnalysisOutcome): void {
    this.metrics.analyses.inc({ outcome });
  }

  /** Publishes the queue size per status (missing statuses are 0). */
  queue(
    counts: Readonly<Partial<Record<TranshipmentPairStatus, number>>>,
  ): void {
    for (const status of PAIR_STATUSES)
      this.metrics.pairs.set({ status }, counts[status] ?? 0);
  }
}
