-- 0002_review_hardening — idempotent detector state and stored transhipment results
-- (CHANGELOG 0.1.0, review fixes). Forward-only: never edit once applied.

-- ---------------------------------------------------------------------------
-- Anomaly streak: event time of the last position it counted. A position
-- redelivered after a restart that is not newer is never counted twice
-- (spec §7.1, idempotent handlers). Existing streaks are dated by the state.
-- ---------------------------------------------------------------------------
ALTER TABLE vessel_state ADD COLUMN anomaly_streak_at timestamptz;
UPDATE vessel_state SET anomaly_streak_at = time WHERE anomaly_streak > 0;
CREATE INDEX vessel_state_anomaly_at_idx ON vessel_state (anomaly_streak_at)
  WHERE anomaly_streak_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Transhipment candidate accumulation: the last observation made by each
-- vessel's position, so a redelivered position adds its priority once.
-- ---------------------------------------------------------------------------
ALTER TABLE transhipment_pairs
  ADD COLUMN last_seen_by_a_at timestamptz,
  ADD COLUMN last_seen_by_b_at timestamptz;

-- ---------------------------------------------------------------------------
-- Every positive analysis (legacy IllegalTranshipmentResult with
-- isIllegal = true, GET /surveillance/transhipments), linked to the event of
-- its occurrence. Hypertable on the start of the detected window (the
-- occurrence time, like events.time); append-only, same retention as events.
-- ---------------------------------------------------------------------------
CREATE TABLE transhipment_results (
  id                    uuid NOT NULL,
  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  detected_at           timestamptz NOT NULL,
  mmsi_a                integer NOT NULL,
  mmsi_b                integer NOT NULL,
  event_id              uuid NOT NULL,
  accuracy              double precision NOT NULL CHECK (accuracy BETWEEN 0 AND 100),
  average_priority      double precision NOT NULL,
  -- { "low", "medium", "high" }: share of the positive checks per priority category, percent.
  priority_distribution jsonb NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  geom                  geography(Point, 4326),
  accumulated_priority  double precision NOT NULL,
  observations          integer NOT NULL,
  route1_points         integer NOT NULL,
  route2_points         integer NOT NULL,
  method_id             text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, start_at),
  CHECK (mmsi_a < mmsi_b),
  CHECK (end_at >= start_at)
);

SELECT create_hypertable('transhipment_results', by_range('start_at', INTERVAL '30 days'));
SELECT add_retention_policy('transhipment_results', INTERVAL '2 years');

CREATE INDEX transhipment_results_time_id_idx ON transhipment_results (start_at DESC, id DESC);
CREATE INDEX transhipment_results_mmsi_a_idx ON transhipment_results (mmsi_a, start_at DESC);
CREATE INDEX transhipment_results_mmsi_b_idx ON transhipment_results (mmsi_b, start_at DESC);
CREATE INDEX transhipment_results_event_idx ON transhipment_results (event_id);
