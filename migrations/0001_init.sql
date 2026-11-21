-- 0001_init — initial schema of ais-its-surveillance-service (docs/PLATFORM_SPEC.md §6, §13.8).
--
-- Runs inside schema "surveillance" (search_path=surveillance,public) as the role
-- surveillance_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0002_<change>.sql instead.

COMMENT ON SCHEMA surveillance IS 'surveillance service — owned by surveillance_svc';

-- ---------------------------------------------------------------------------
-- Projections of other services' data (spec §6: cross-service data arrives by
-- events). Soft deletes keep a tombstone so a late, older snapshot can never
-- resurrect a deleted entity (snapshots apply only when newer).
-- ---------------------------------------------------------------------------

-- GEO stream (durable consumer surveillance-zones): zones owned by the geo service.
CREATE TABLE zones (
  id                uuid PRIMARY KEY,
  org_id            uuid,
  code              text NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('pipeline', 'transhipment_area', 'fishing_ground',
                      'mpa', 'restricted', 'anchorage', 'port', 'tss_lane', 'shallow_water', 'custom')),
  geom              geography(Geometry, 4326) NOT NULL,
  buffer_m          double precision NOT NULL DEFAULT 0,
  active            boolean NOT NULL,
  alert_on_enter    boolean NOT NULL,
  properties        jsonb NOT NULL DEFAULT '{}',
  -- ZoneSnapshotV1.updatedAt: snapshots are applied only when newer.
  source_updated_at timestamptz NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zones_geom_idx ON zones USING gist (geom);
CREATE INDEX zones_kind_idx ON zones (kind) WHERE deleted_at IS NULL;

-- FLEET stream (durable consumer surveillance-fleet): mmsi → vessel, organization (tenancy, spec §8.5).
CREATE TABLE vessels (
  id                uuid PRIMARY KEY,
  mmsi              integer NOT NULL,
  org_id            uuid,
  name              text NOT NULL,
  imo               text,
  flag              text,
  type_code         text,
  status            text NOT NULL CHECK (status IN ('active', 'inactive', 'laid_up')),
  -- VesselSnapshotV1.updatedAt: snapshots are applied only when newer.
  source_updated_at timestamptz NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vessels_mmsi_key ON vessels (mmsi) WHERE deleted_at IS NULL;
CREATE INDEX vessels_org_idx ON vessels (org_id, mmsi) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Detector state
-- ---------------------------------------------------------------------------

-- Latest kinematic state per vessel (written by the detectors, throttled per
-- vessel; every position of transhipment candidates). GiST on the geography for
-- the ST_DWithin candidate search; time index for the dark-vessel scan.
CREATE TABLE vessel_state (
  mmsi           integer PRIMARY KEY,
  time           timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('primary', 'batam', 'pusher')),
  geom           geography(Point, 4326) NOT NULL,
  sog            double precision NOT NULL,
  cog            double precision NOT NULL,
  hdg            double precision NOT NULL,
  navstatus      smallint NOT NULL CHECK (navstatus BETWEEN 0 AND 15),
  pred_navstatus smallint NOT NULL CHECK (pred_navstatus IN (0, 1)),
  -- Active zones (any kind, buffer included) containing the position.
  in_zone_ids    uuid[] NOT NULL DEFAULT '{}',
  -- Consecutive navstatus anomalies (anomaly detector, ANOMALY_MIN_POSITIONS).
  anomaly_streak integer NOT NULL DEFAULT 0 CHECK (anomaly_streak >= 0),
  -- Last alert per type: { "<type>": { "alertId", "dedupKey", "severity", "at" } }.
  last_alerts    jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vessel_state_geom_idx ON vessel_state USING gist (geom);
CREATE INDEX vessel_state_time_idx ON vessel_state (time);
CREATE INDEX vessel_state_anomaly_idx ON vessel_state (mmsi) WHERE anomaly_streak > 0;

-- Track history of the vessels relevant to the pair/pattern detectors only
-- (transhipment candidates, vessels inside fishing zones), 7 days.
CREATE TABLE track_points (
  time      timestamptz NOT NULL,
  mmsi      integer NOT NULL,
  source    text NOT NULL CHECK (source IN ('primary', 'batam', 'pusher')),
  geom      geography(Point, 4326) NOT NULL,
  sog       double precision NOT NULL,
  cog       double precision NOT NULL,
  hdg       double precision NOT NULL,
  navstatus smallint NOT NULL,
  PRIMARY KEY (mmsi, time)
);

SELECT create_hypertable('track_points', by_range('time', INTERVAL '1 day'));
ALTER TABLE track_points SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('track_points', INTERVAL '2 days');
SELECT add_retention_policy('track_points', INTERVAL '7 days');

-- Transhipment candidate pairs: replaces the legacy Mongo queue
-- (IllegalTranshipmentQueue). mmsi_a < mmsi_b (legacy sortMMSI); priority is
-- the accumulated legacy product priority; the analyser claims pending pairs
-- by priority DESC, queued_at ASC with FOR UPDATE SKIP LOCKED.
CREATE TABLE transhipment_pairs (
  mmsi_a           integer NOT NULL,
  mmsi_b           integer NOT NULL,
  priority         double precision NOT NULL DEFAULT 0 CHECK (priority >= 0),
  status           text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  -- Legacy createdAt of the queue entry: tie-break of the queue order.
  queued_at        timestamptz NOT NULL,
  -- Event times of the first and latest candidate observation of the pair.
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  last_distance_m  double precision,
  observations     integer NOT NULL DEFAULT 0,
  claimed_at       timestamptz,
  claimed_priority double precision,
  last_analysed_at timestamptz,
  analyses         integer NOT NULL DEFAULT 0,
  last_result      jsonb,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi_a, mmsi_b),
  CHECK (mmsi_a < mmsi_b)
);

CREATE INDEX transhipment_pairs_queue_idx ON transhipment_pairs (priority DESC, queued_at)
  WHERE status = 'pending';
CREATE INDEX transhipment_pairs_claimed_idx ON transhipment_pairs (claimed_at)
  WHERE status = 'in_progress';
CREATE INDEX transhipment_pairs_seen_idx ON transhipment_pairs (last_seen_at);

-- ---------------------------------------------------------------------------
-- Detector events: one row per published alert (AlertPersistence, spec §18).
-- `status` is the review lifecycle (open → confirmed | dismissed by a reviewer
-- with surveillance:review, resolved when the detector ends the occurrence);
-- `resolved_at` is set when the detector ends the occurrence, whatever the review.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               uuid NOT NULL,
  time             timestamptz NOT NULL,
  detector         text NOT NULL,
  type             text NOT NULL,
  domain           text NOT NULL CHECK (domain IN ('safety', 'surveillance')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  current_severity text NOT NULL CHECK (current_severity IN ('info', 'warning', 'critical')),
  mmsi             integer NOT NULL,
  related_mmsi     integer,
  zone_id          uuid,
  geom             geography(Point, 4326),
  title            text NOT NULL,
  message          text NOT NULL,
  method_id        text NOT NULL,
  dedup_key        text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('open', 'confirmed', 'dismissed', 'resolved')),
  opened_at        timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolution       jsonb,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, time)
);

SELECT create_hypertable('events', by_range('time', INTERVAL '7 days'));
SELECT add_retention_policy('events', INTERVAL '2 years');

CREATE INDEX events_active_idx ON events (dedup_key) WHERE resolved_at IS NULL;
CREATE INDEX events_time_id_idx ON events (time DESC, id DESC);
CREATE INDEX events_mmsi_time_idx ON events (mmsi, time DESC);
CREATE INDEX events_related_mmsi_time_idx ON events (related_mmsi, time DESC)
  WHERE related_mmsi IS NOT NULL;
CREATE INDEX events_type_time_idx ON events (type, time DESC);
CREATE INDEX events_geom_idx ON events USING gist ((geom::geometry));

-- Map layer of the events (geometry, not geography). Deliberately NOT granted
-- to tiles_ro: Martin cannot apply the tenancy rules of spec §8.5 and spec
-- §13.8 keeps events out of Martin — the web map loads them through the REST
-- API. Grant it only to a tile endpoint restricted to authority users.
CREATE VIEW events_tiles AS
  SELECT id, time, detector, type, severity, status, mmsi, related_mmsi, zone_id,
         geom::geometry(Point, 4326) AS geom
  FROM events
  WHERE geom IS NOT NULL;

COMMENT ON VIEW events_tiles IS
  'Surveillance events as geometry points; not granted to tiles_ro (tenancy, spec 8.5 / 13.8)';

-- ---------------------------------------------------------------------------
-- Historical illegal-fishing records (pnpm seed; legacy apps/web/src/data/ilegal.json).
-- ---------------------------------------------------------------------------
CREATE TABLE fishing_violations (
  id           uuid PRIMARY KEY,
  -- Dataset id and the record's position in it: the idempotency key of the seed.
  dataset      text NOT NULL,
  record_no    integer NOT NULL CHECK (record_no >= 0),
  vessel_name  text NOT NULL,
  flag_country text NOT NULL,
  year         integer NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  violation    text NOT NULL,
  action       text NOT NULL,
  geom         geography(Point, 4326) NOT NULL,
  source       text NOT NULL,
  source_note  text NOT NULL,
  method_id    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset, record_no)
);

CREATE INDEX fishing_violations_geom_idx ON fishing_violations USING gist ((geom::geometry));
CREATE INDEX fishing_violations_year_idx ON fishing_violations (year);
