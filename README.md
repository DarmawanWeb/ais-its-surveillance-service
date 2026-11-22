# ais-its-surveillance-service

Illegal-activity analytics of **AIS Maritime Intelligence** v2 (service `surveillance`, port 3007,
schema `surveillance`): illegal transhipment, navigational-status anomalies, dark vessels (AIS
gaps), geofence violations and fishing loitering, built on the Detector SDK of the platform kit
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest)
(NestJS 12 + Fastify, PostgreSQL 17 + TimescaleDB + PostGIS, NATS JetStream). The normative
engineering spec is [`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) (§13.8 for this
service, §18 for the Detector SDK) in the central repository
([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose and responsibilities

- Runs five **detectors** on the live AIS position feed and turns their findings into persisted
  **events** and `alert.raised.v1` alerts (domain `surveillance`) for the notification service.
- Replaces the legacy illegal-transhipment pipeline (Mongo queue + forked polling worker) with
  PostGIS candidate search, a PostgreSQL queue and a scheduled analyser, keeping the legacy
  scoring and detection **numerically identical** (golden tests).
- Moves the legacy web app's navstatus anomaly rule server-side and adds the v2 detectors dark
  vessel, geofence and fishing loitering (spec §15 items 7–8).
- Serves the surveillance read model to the web app: events with their review lifecycle,
  transhipments in the legacy result shape, a heatmap, statistics, the historical fishing
  violations layer and the detector catalogue.

Not owned here: zones (geo service, `GEO` stream projection), vessels and their organizations
(fleet service, `FLEET` projection), AIS positions (ais-pipeline), alert inbox and delivery
(notification service). Events are **not** served through Martin: the map loads them through the
REST API so that the tenancy rules apply (spec §8.5, §13.8).

## Architecture

```mermaid
flowchart LR
  subgraph NATS["NATS JetStream"]
    POS["AIS_POSITION<br/>ais.position.v1.&lt;p&gt;.&lt;mmsi&gt;"]
    GEO["GEO<br/>geo.zone.v1.&lt;zoneId&gt;"]
    FLEET["FLEET<br/>fleet.vessel.v1.&lt;vesselId&gt;"]
    ALERTS["ALERTS<br/>alert.v1.&lt;type&gt;.&lt;mmsi&gt;"]
    AUDIT["AUDIT<br/>audit.v1.surveillance"]
  end
  subgraph SVC["surveillance :3007"]
    RUNNER["DetectorRunner (SDK)<br/>VesselStateStore · PairSearch · ZoneIndex · FleetDirectory"]
    DET["detectors<br/>transhipment · anomaly · dark · geofence · fishing"]
    EMIT["AlertEmitter<br/>dedupKey · cool-down · escalation"]
    COORD["AlertCoordinator<br/>replica alert state (reload · advisory lock)"]
    PROJ["ProjectionsConsumer"]
    API["REST /api/v2/surveillance/*<br/>controller → service → repository"]
  end
  subgraph PG["PostgreSQL schema surveillance"]
    VS[("vessel_state<br/>GiST")]
    TP[("track_points<br/>hypertable 7 d")]
    PAIRS[("transhipment_pairs")]
    TR[("transhipment_results<br/>hypertable 2 y")]
    EV[("events<br/>hypertable 2 y")]
    PZ[("zones · vessels<br/>projections")]
    FV[("fishing_violations")]
  end
  POS -- "durable surveillance-positions" --> RUNNER
  GEO -- "ordered surveillance-geo-projection" --> RUNNER
  FLEET -- "ordered surveillance-fleet-projection" --> RUNNER
  GEO -- "durable surveillance-zones" --> PROJ
  FLEET -- "durable surveillance-fleet" --> PROJ
  RUNNER --> DET
  DET --> VS & TP & PAIRS & TR
  DET --> COORD --> EMIT
  COORD -- "open occurrences" --> EV
  EMIT -- "persist first (AlertPersistence)" --> EV
  EMIT -- "alert.raised.v1" --> ALERTS
  PROJ --> PZ
  API --> EV & PZ & FV & PAIRS & TR
  API -- "audit.recorded.v1 (review)" --> AUDIT
```

- **Boot** (kit lifecycle rule): connect, migrate and ensure the produced streams (`ALERTS`,
  `AUDIT`) in `onModuleInit` → the SDK restores open occurrences from `events` (`loadOpen`),
  loads the complete `GEO` and `FLEET` snapshots into memory, then starts the position consumer,
  the ticks and the projections → the port opens. On `SIGTERM` readiness turns `503`, consumers
  drain, NATS drains and the pool closes.
- **Per position** the SDK updates the vessel state and the neighbour index (stale and duplicate
  positions are dropped), then calls every enabled detector concurrently; a detector that throws
  or times out is logged and counted and never blocks the others or redelivers the message.
  Positions go to **one active instance** (`exclusive`), further replicas are hot standbys;
  scale out by splitting detectors over deployments with `DETECTORS`.
- **Replicas** (`src/detectors/shared/alert-coordinator.ts`, a workaround of the kit, see
  _Operations_): every detector reports each position to the `AlertCoordinator` first. The first
  position after a pause of more than 15 s (half the 30 s pinned TTL, so every takeover) or after
  startup reloads the open occurrences from `events` into the SDK `AlertEmitter` before any
  detector handles it: a new active instance adopts what the previous one opened and drops what it
  ended.
- **Ticks**: the transhipment analyser (every `TRANSHIPMENT_ANALYSIS_INTERVAL_S`) and the dark
  scan (every `DARK_CHECK_INTERVAL_S`) run on timers between positions, **only on the instance
  consuming positions** (one handled within the last 2 min); their raises and resolutions run
  under a per-`dedupKey` PostgreSQL advisory lock after aligning the key with `events`, so two
  replicas never open one occurrence twice.

| Path                                          | What                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`                                 | pure rules with `@method` TSDoc (transhipment, anomaly, dark, geofence, fishing)                                       |
| `src/detectors/<id>/`                         | one `@RegisterDetector()` class per detector, its config schema and tests                                              |
| `src/detectors/shared/`                       | `vessel_state` / `track_points` storage ports, repositories, recorder and the `AlertCoordinator` (replica alert state) |
| `src/detectors/detector-events.repository.ts` | SDK `AlertPersistence`: the `events` table                                                                             |
| `src/consumers/`                              | durable `GEO` / `FLEET` projections into `zones` / `vessels`                                                           |
| `src/modules/<feature>/`                      | events, transhipments, statistics, fishing-violations, methodology                                                     |
| `src/tenancy/event-visibility.ts`             | spec §8.5 visibility of events as SQL                                                                                  |
| `src/seed.ts`, `seeds/`                       | `pnpm seed`: historical fishing violations                                                                             |
| `migrations/`                                 | forward-only SQL migrations (`0001_init.sql`, `0002_review_hardening.sql`)                                             |
| `test/`                                       | integration tests against real containers                                                                              |

## Detectors

| Detector       | Trigger                                                                                                                                                            | Resolution                                                                                | Severity                                                                          | `dedupKey`                         | Event `methodId`             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| `transhipment` | analysed pair reaches the legacy score threshold (70 %)                                                                                                            | later negative analysis, or pair not observed together for `TRANSHIPMENT_PAIR_EXPIRY_MIN` | `critical` when the score ≥ `TRANSHIPMENT_CRITICAL_ACCURACY` (90), else `warning` | `transhipment:<minMmsi>:<maxMmsi>` | `transhipment.accuracy`      |
| `anomaly`      | `(predicted = 0 ∧ navstatus = 1) ∨ (predicted = 1 ∧ navstatus ≠ 1)` for `ANOMALY_MIN_POSITIONS` (3) consecutive positions                                          | first consistent position                                                                 | `info` (registry default)                                                         | `anomaly:<mmsi>`                   | `anomaly.navstatus_mismatch` |
| `dark`         | last seen > `DARK_GAP_MIN` (30) min before the feed watermark, last SOG > 1 kn, > 5 km from any **global** `port` / `anchorage` zone (org-owned zones never count) | next position of the vessel                                                               | `warning` (registry default)                                                      | `dark:<mmsi>`                      | `dark.ais_gap`               |
| `geofence`     | inside an active `restricted` / `mpa` / `custom` zone with `alertOnEnter` (buffer included), global zones for every vessel, organization zones for its own vessels | leaves the zone; zone deleted, deactivated or no longer alerting                          | `critical` for `GEOFENCE_CRITICAL_KINDS` (`restricted`), else `warning`           | `geofence:<mmsi>:<zoneId>`         | `geo.geofence_enter`         |
| `fishing`      | ≥ 30 min, ≥ 6 fixes at 0.5–4 kn with a mean course-change rate ≥ 3 °/min (fixes ≥ 3 min apart, gaps ≤ 10 min) inside a `fishing_ground` / `restricted` zone        | leaves the zone, or `FISHING_RESOLVE_AFTER_MIN` without a qualifying fix                  | `critical` for `FISHING_CRITICAL_KINDS` (`restricted`), else `warning`            | `fishing:<mmsi>:<zoneId>`          | `fishing.loitering`          |

Alert semantics come from the SDK `AlertEmitter`: one open occurrence per `dedupKey`; a higher
severity escalates (new alert id, the superseded row is ended), the same severity is unchanged, a
lower one de-escalates silently; re-raising within `ALERT_COOLDOWN_MIN` (10) after a publication
or a resolution is **suppressed** (the row is reopened, nothing is published). Every alert and
event carries `methodId`, `dedupKey` and `zoneId` where relevant. Event `data` carries **no
organization ids**: ownership is derived at query time from the FLEET projection, so an
organization's viewer of one vessel never learns who owns the other vessel of a pair (spec §8.5).
Zones follow the tenancy of spec §8.5 too: rules that _raise_ (geofence, fishing, transhipment
candidates) use global zones and the vessel's own organization's zones; the dark rule, which an
organization's zone could only _silence_, uses global (curated) zones only.

### transhipment in detail

1. **Candidates** — a position of a vessel from an AIS source in `TRANSHIPMENT_SOURCES` (`batam`,
   legacy `isBatam`) or inside an active zone of `TRANSHIPMENT_ZONE_KINDS` (`transhipment_area`)
   that is global or its own organization's is stored in `vessel_state` and `track_points`. Its
   neighbours that are candidates by the same rule, seen within `TRANSHIPMENT_NEIGHBOUR_WINDOW_MIN`
   (5) and within `TRANSHIPMENT_NEIGHBOUR_RADIUS_M` (600 m), come from the SDK `PairSearch` — and,
   until the in-memory index has seen one full window after a restart, also from `ST_DWithin` on
   `vessel_state` (GiST; `in_zone_ids` holds global and own-organization zones only, and the
   stored neighbours are checked with the in-memory rule).
2. **Scoring** — each neighbour's newest fix is scored with the legacy product priority
   `P = P_speed × P_location × P_heading` (each 0–3; distance with the legacy haversine,
   R = 3438 nm); pairs with `P > 0` add `P` to `transhipment_pairs.priority` (sorted MMSIs,
   legacy `sortMMSI`; a finished pair is queued again with `P`). Each vessel's observations count
   once (`last_seen_by_a_at` / `last_seen_by_b_at`: a position redelivered after a restart adds
   nothing), and a pending pair not observed within `TRANSHIPMENT_ROUTE_WINDOW_MIN` starts over,
   so brief encounters far apart never add up to the threshold.
3. **Analyser** — on the instance consuming positions only, every run returns stale claims,
   claims up to `TRANSHIPMENT_ANALYSIS_BATCH`
   pending pairs with priority ≥ `TRANSHIPMENT_MIN_PRIORITY`, ordered `priority DESC, queued_at
ASC` (legacy `getAllSorted`) with `FOR UPDATE SKIP LOCKED`, skipping pairs analysed within
   `TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN` (15, legacy `getLastDetection`). For each pair it reads
   the last `TRANSHIPMENT_ROUTE_MAX_POINTS` (60) fixes of both tracks within
   `TRANSHIPMENT_ROUTE_WINDOW_MIN` (60) before the pair's last observation and runs the legacy
   detection (resampling > 30 fixes to 3 min, 30-min windows every 10 min, a check every 5 min
   on interpolated fixes, `A = 0.7·A_w + 0.3·A_p ≥ 70`). The claimed priority is consumed (the
   legacy queue entry was deleted), priority accumulated meanwhile stays queued.
4. **Result** — every positive analysis is stored in `transhipment_results` (window, accuracy,
   average priority, distribution, severity, position, linked to the occurrence's event; in the
   transaction that completes the claim) and served by `GET /surveillance/transhipments` in the
   legacy result shape. The first one opens the occurrence: an event at the window start with
   `data` `{ isIllegal, accuracy, startTimestamp, endTimestamp, averagePriority,
priorityDistribution: { low, medium, high }, accumulatedPriority, observations, lastDistanceM,
route1Points, route2Points, methodIds }`, located at the midpoint of the two vessels in the
   middle of the window; `mmsi` is the smaller, `relatedMmsi` the larger MMSI. Later positive
   analyses keep it open (or escalate it) and add results; a negative one resolves it.

## Data model

Schema `surveillance`, owned by `surveillance_svc`; [`migrations/`](migrations) are forward-only
and checksummed (never edit an applied file — add `NNNN_<change>.sql`); `src/db/schema.ts`
mirrors them for drizzle.

| Table                  | Kind                                                                                        | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vessel_state`         | table, GiST on `geom`                                                                       | latest position per MMSI (`geography(Point)`, SOG/COG/HDG, navstatus, predicted navstatus, source), `in_zone_ids uuid[]` (global and own-organization zones), `anomaly_streak` (capped at `ANOMALY_MIN_POSITIONS`) with `anomaly_streak_at` (time of its last counted position), `last_alerts jsonb` (last alert per type); written at most every `VESSEL_STATE_WRITE_INTERVAL_S` per vessel, on every position for transhipment candidates and on streak changes |
| `track_points`         | hypertable (1 day chunks), compressed after 2 days (`segmentby mmsi`), retention **7 days** | positions of transhipment candidates and of vessels inside fishing zones only                                                                                                                                                                                                                                                                                                                                                                                     |
| `transhipment_pairs`   | table, PK `(mmsi_a, mmsi_b)` with `mmsi_a < mmsi_b`                                         | accumulated priority, status `pending → in_progress → completed / failed`, queue time, first/last observation and the last observation of each vessel, claim, analyses, last result / error; pairs not observed for 7 days are pruned (pending ones too)                                                                                                                                                                                                          |
| `transhipment_results` | hypertable on `start_at` (30 day chunks), retention **2 years**, append-only                | every positive analysis: window `start_at`/`end_at`, `detected_at`, pair, `event_id` of the occurrence, accuracy, average priority, `priority_distribution`, severity, `geography(Point)`, accumulated priority, observations, route sizes, `method_id`                                                                                                                                                                                                           |
| `events`               | hypertable on `time` (7 day chunks), retention **2 years**                                  | one row per published alert: type, detector, severity (published / current), mmsi, related_mmsi, zone_id, `geography(Point)`, title, message, method_id, dedup_key, data, review `status` (`open`, `confirmed`, `dismissed`, `resolved`), `reviewed_by/at`, `note`, detector lifecycle `opened_at`, `last_seen_at`, `resolved_at`, `resolution`                                                                                                                   |
| `zones`                | projection of `GEO`                                                                         | id, org (null = global), code, name, kind, `geography(Geometry)`, buffer, active, alert_on_enter, properties; applied only when newer, deletions are tombstones                                                                                                                                                                                                                                                                                                   |
| `vessels`              | projection of `FLEET`                                                                       | id, mmsi, org (tenancy), name, imo, flag, type code, status; one live vessel per MMSI                                                                                                                                                                                                                                                                                                                                                                             |
| `fishing_violations`   | table                                                                                       | historical illegal-fishing apprehensions (`pnpm seed`), with source, provenance note and `method_id`                                                                                                                                                                                                                                                                                                                                                              |
| `events_tiles`         | view (geometry)                                                                             | events as `geometry(Point)` for an authority-only tile endpoint — **not** granted to `tiles_ro`                                                                                                                                                                                                                                                                                                                                                                   |

The review status (`status`) is kept apart from the detector lifecycle (`resolved_at`): the
detector marks an `open` row `resolved` when the occurrence ends, but a reviewer's `confirmed` /
`dismissed` verdict survives; `PATCH {status: "open"}` withdraws a verdict.

## API

Routes live under `/api/v2` (OpenAPI UI `/docs`, JSON `/openapi.json`, committed as
[`openapi.json`](openapi.json)); errors are RFC 9457 problem details. Every route needs a user
access token (no API keys). Tenancy (spec §8.5): `authority` and `super_admin` see every event;
other roles only events whose `mmsi` or `relatedMmsi` belongs to a vessel of their active
organization (from the FLEET projection, never from the client); without an organization, none.

| Method  | Path                                      | Permission            | What                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/api/v2/surveillance/events`             | `surveillance:read`   | events newest first; `type`, `severity`, `status`, `mmsi` (also related), `from`/`to` (default 30 days, max 366), `bbox`, `cursor`, `limit` ≤ 500                                                                                                                                                                                                      |
| `GET`   | `/api/v2/surveillance/events/:id`         | `surveillance:read`   | one event (`404 SURVEILLANCE_EVENT_NOT_FOUND` when unknown or not visible)                                                                                                                                                                                                                                                                             |
| `PATCH` | `/api/v2/surveillance/events/:id`         | `surveillance:review` | `{ status: confirmed \| dismissed \| open, note? }` — without `note` the stored note is kept, `null` clears it; records `surveillance_event.review` in the audit log (`from`, `to`, `noteChanged`, and the previous and new note when it changed)                                                                                                      |
| `GET`   | `/api/v2/surveillance/transhipments`      | `surveillance:read`   | every positive analysis in the legacy result shape (`ship1MMSI`, `ship2MMSI`, `isIllegal`, `startTimestamp`, `endTimestamp`, `accuracy`, `averagePriority`, `priorityDistribution`, `detectedAt`) plus `id` (result), `eventId`, `severity`, review `status`, `lat`/`lon`, `methodId`; newest window first; `from`/`to` (window start), `mmsi`, cursor |
| `GET`   | `/api/v2/surveillance/heatmap`            | `surveillance:read`   | `{ cells: [{ lat, lon, count }], cellKm, cellDeg, from, to, total }` with `ST_SnapToGrid`; `type`, `bbox`, `from`, `to`, `cellKm` (0.5–500, default 10)                                                                                                                                                                                                |
| `GET`   | `/api/v2/surveillance/fishing-violations` | `surveillance:read`   | historical apprehensions (shared layer), `bbox`, `year`, page-based                                                                                                                                                                                                                                                                                    |
| `GET`   | `/api/v2/surveillance/stats`              | `surveillance:read`   | counts by type, severity and status, active occurrences, fishing violations; the transhipment queue for authority users                                                                                                                                                                                                                                |
| `GET`   | `/api/v2/surveillance/detectors`          | `surveillance:read`   | enabled detectors, method ids, alert types and active thresholds (SDK `DetectorRegistry.describe()`)                                                                                                                                                                                                                                                   |
| `GET`   | `/api/v2/surveillance/methodology`        | any signed-in user    | methods of the catalog implemented here, with their sources                                                                                                                                                                                                                                                                                            |

Outside the prefix: `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`,
`GET /openapi.json`.

## Events

| Direction | Stream         | Subject                              | Type                                                                                                       | Consumer                                                                                              | Use                                                                |
| --------- | -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| consumes  | `AIS_POSITION` | `ais.position.v1.<partition>.<mmsi>` | `ais.position.recorded.v1`                                                                                 | durable `surveillance-positions` (`surveillance-positions-<ids>` for a `DETECTORS` subset), exclusive | detector feed                                                      |
| consumes  | `GEO`          | `geo.zone.v1.<zoneId>`               | `geo.zone.upserted.v1`, `geo.zone.deleted.v1`                                                              | ordered `surveillance-geo-projection` (last per subject)                                              | SDK `ZoneIndex` (every instance)                                   |
| consumes  | `GEO`          | `geo.zone.v1.<zoneId>`               | `geo.zone.upserted.v1`, `geo.zone.deleted.v1`                                                              | durable `surveillance-zones`                                                                          | `zones` table (zone names, SQL)                                    |
| consumes  | `FLEET`        | `fleet.vessel.v1.<vesselId>`         | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1`                                                      | ordered `surveillance-fleet-projection` (last per subject)                                            | SDK `FleetDirectory` (`orgOf`: zone tenancy of the rules)          |
| consumes  | `FLEET`        | `fleet.vessel.v1.<vesselId>`         | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1`                                                      | durable `surveillance-fleet`                                                                          | `vessels` table (tenancy, vessel names)                            |
| publishes | `ALERTS`       | `alert.v1.<type>.<mmsi>`             | `alert.raised.v1` (`domain: surveillance`; types `transhipment`, `anomaly`, `dark`, `geofence`, `fishing`) | `notification-alerts`                                                                                 | stored in `events` first; envelope id = alert id (JetStream dedup) |
| publishes | `AUDIT`        | `audit.v1.surveillance`              | `audit.recorded.v1` (`surveillance_event.review`)                                                          | `auth-audit`                                                                                          | review trail                                                       |

Handlers are idempotent (spec §7.1): projections apply snapshots only when newer (deletions are
tombstones), the persistence hook inserts with `ON CONFLICT DO NOTHING` and updates by alert id,
the SDK drops positions not newer than the vessel's state within a run, and across restarts a
redelivered position is recognised by its natural key: the anomaly streak ignores positions not
newer than `anomaly_streak_at`, the pair accumulation those not newer than the observing vessel's
last observation, `track_points` and `vessel_state` writes are keyed by vessel and time, and the
fishing run is rebuilt from `track_points` before the position.

## Configuration

Every variable is listed with its default in [`.env.example`](.env.example); the service refuses
to start on invalid values and prints every problem (the detector namespaces are validated by the
SDK with each detector's zod schema; lists accept `none` for "no entries").

| Variable                                    | Default                                                              | Notes                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `NODE_ENV`                                  | `development`                                                        | `development` \| `test` \| `production`                |
| `SERVICE_NAME` / `SERVICE_VERSION`          | `surveillance` / `package.json` version                              | logs, metrics, event `source`, `audit.v1.<service>`    |
| `HOST` / `PORT`                             | `0.0.0.0` / `3007`                                                   | spec §3                                                |
| `LOG_LEVEL` / `LOG_PRETTY`                  | `info` / `true` in development                                       | pino                                                   |
| `SHUTDOWN_TIMEOUT_MS`                       | `30000`                                                              | graceful shutdown deadline                             |
| `TRUSTED_PROXIES`                           | `loopback,linklocal,uniquelocal`                                     | trusted `X-Forwarded-*` sources                        |
| `DATABASE_URL`                              | `postgres://surveillance_svc:surveillance_svc@localhost:5432/aisits` | required in production                                 |
| `DATABASE_SCHEMA`                           | `surveillance`                                                       | `search_path=surveillance,public`                      |
| `DATABASE_POOL_MAX`                         | `10`                                                                 |                                                        |
| `DATABASE_STATEMENT_TIMEOUT_MS`             | `30000`                                                              |                                                        |
| `DB_MIGRATE_ON_BOOT`                        | `true`                                                               | also `pnpm migrate`                                    |
| `NATS_URL`                                  | `nats://localhost:4222`                                              | comma separated list allowed                           |
| `NATS_DURABLE_PREFIX`                       | empty                                                                | prefix of durable names (tests)                        |
| `REDIS_URL`                                 | `redis://localhost:6379`                                             | base schema only; Valkey is not used                   |
| `AUTH_JWKS_URL`                             | `http://localhost:3001/.well-known/jwks.json`                        | tokens verified locally                                |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`             | `ais-its-auth` / `ais-its-api`                                       |                                                        |
| `AUTH_INTERNAL_URL`                         | `http://localhost:3001`                                              | API-key introspection (unused: no API-key routes)      |
| `INTERNAL_TOKEN`                            | `dev-internal-token-change-me`                                       | ≥ 16 characters in production                          |
| `CORS_ORIGINS`                              | `http://localhost:5173,http://localhost:8000`                        |                                                        |
| `PUBLIC_BASE_URL`                           | `http://localhost:8000`                                              |                                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`               | unset                                                                | OTLP/HTTP tracing when set                             |
| `DETECTOR_CONCURRENCY`                      | `8`                                                                  | positions in parallel (per-vessel order kept)          |
| `ALERT_COOLDOWN_MIN`                        | `10`                                                                 | SDK alert cool-down per `dedupKey`                     |
| `VESSEL_STATE_WRITE_INTERVAL_S`             | `60`                                                                 | `vessel_state` write throttle per vessel (event time)  |
| `DETECTORS`                                 | all                                                                  | subset of `transhipment,anomaly,dark,geofence,fishing` |
| `TRANSHIPMENT_SOURCES`                      | `batam`                                                              | candidate AIS sources (legacy `isBatam`)               |
| `TRANSHIPMENT_ZONE_KINDS`                   | `transhipment_area`                                                  | candidate zone kinds (`none` = sources only)           |
| `TRANSHIPMENT_NEIGHBOUR_RADIUS_M`           | `600`                                                                | candidate search radius                                |
| `TRANSHIPMENT_NEIGHBOUR_WINDOW_MIN`         | `5`                                                                  | neighbours seen within (1–30)                          |
| `TRANSHIPMENT_MIN_PRIORITY`                 | `1`                                                                  | accumulated priority to analyse a pair                 |
| `TRANSHIPMENT_ANALYSIS_INTERVAL_S`          | `30`                                                                 | analyser interval                                      |
| `TRANSHIPMENT_ANALYSIS_BATCH`               | `10`                                                                 | pairs per analyser run                                 |
| `TRANSHIPMENT_REANALYSIS_COOLDOWN_MIN`      | `15`                                                                 | legacy re-analysis cool-down                           |
| `TRANSHIPMENT_ROUTE_WINDOW_MIN`             | `60`                                                                 | track window of the analysis (legacy 60)               |
| `TRANSHIPMENT_ROUTE_MAX_POINTS`             | `60`                                                                 | newest fixes per track (legacy 60)                     |
| `TRANSHIPMENT_CHECK_DURATION_MIN`           | `30`                                                                 | sliding-window length (legacy 30)                      |
| `TRANSHIPMENT_ACCURACY_THRESHOLD`           | `70`                                                                 | score threshold, percent (legacy 70)                   |
| `TRANSHIPMENT_CRITICAL_ACCURACY`            | `90`                                                                 | score of a `critical` event                            |
| `TRANSHIPMENT_PAIR_EXPIRY_MIN`              | `60`                                                                 | resolve when not observed together for                 |
| `TRANSHIPMENT_CLAIM_TIMEOUT_MIN`            | `5`                                                                  | stale claims go back to the queue                      |
| `ANOMALY_MIN_POSITIONS`                     | `3`                                                                  | consecutive mismatching positions                      |
| `ANOMALY_EXCLUDED_NAVSTATUS`                | `none`                                                               | navstatus codes that never count (e.g. `15`)           |
| `DARK_GAP_MIN`                              | `30`                                                                 | silence of a dark vessel                               |
| `DARK_MIN_SOG_KN`                           | `1`                                                                  | last SOG must exceed                                   |
| `DARK_HARBOUR_DISTANCE_KM`                  | `5`                                                                  | distance from harbour zones                            |
| `DARK_HARBOUR_ZONE_KINDS`                   | `port,anchorage`                                                     | harbour zone kinds (global zones only)                 |
| `DARK_MAX_GAP_H`                            | `24`                                                                 | older states are not reported                          |
| `DARK_CHECK_INTERVAL_S`                     | `60`                                                                 | scan interval                                          |
| `DARK_SCAN_LIMIT`                           | `5000`                                                               | vessels per scan                                       |
| `GEOFENCE_KINDS`                            | `restricted,mpa,custom`                                              | watched zone kinds                                     |
| `GEOFENCE_CRITICAL_KINDS`                   | `restricted`                                                         | `critical` kinds (`none` = all warning)                |
| `GEOFENCE_USE_BUFFER`                       | `true`                                                               | count the zone buffer as inside                        |
| `FISHING_ZONE_KINDS`                        | `fishing_ground,restricted`                                          | zones where the pattern is reported                    |
| `FISHING_CRITICAL_KINDS`                    | `restricted`                                                         | `critical` kinds (`none` = all warning)                |
| `FISHING_MIN_SOG_KN` / `FISHING_MAX_SOG_KN` | `0.5` / `4`                                                          | speed band                                             |
| `FISHING_MIN_DURATION_MIN`                  | `30`                                                                 | minimum duration                                       |
| `FISHING_MIN_POSITIONS`                     | `6`                                                                  | minimum fixes                                          |
| `FISHING_MAX_GAP_MIN`                       | `10`                                                                 | largest gap inside a run                               |
| `FISHING_SAMPLE_MIN`                        | `3`                                                                  | course changes measured between fixes this far apart   |
| `FISHING_MIN_COURSE_CHANGE_DEG_PER_MIN`     | `3`                                                                  | minimum mean course-change rate                        |
| `FISHING_WINDOW_MIN`                        | `60`                                                                 | evaluation window                                      |
| `FISHING_RESOLVE_AFTER_MIN`                 | `30`                                                                 | resolve after no qualifying fix for                    |

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10.28 (`corepack enable`), Docker. `@darmawanweb/*`
packages come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir ../.. infra:up      # postgres (schema + role from infra/postgres/bootstrap.sql), nats, …
pnpm dev                       # watch mode (SWC, decorator metadata); migrations apply on boot
pnpm build && pnpm seed        # historical fishing violations (idempotent)
curl -s localhost:3007/health/ready
open http://localhost:3007/docs
```

Zones come from the geo service (`pnpm seed` there creates the pipeline and the Batam
transhipment area) and vessels from the fleet service; without them the detectors still run
(transhipment on `batam` positions, anomaly and dark everywhere).

| Script                                          | What                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                                      | watch mode (`nest start --watch --builder swc`)                                            |
| `pnpm build` / `pnpm start` / `pnpm start:prod` | compile to `dist/` / run it / run it with `NODE_ENV=production`                            |
| `pnpm migrate`                                  | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`)                          |
| `pnpm seed`                                     | upsert `seeds/fishing-violations-2015-2017.json` into `fishing_violations` (after `build`) |
| `pnpm openapi` / `pnpm openapi:check`           | write `openapi.json` without any infrastructure / fail when it is stale (CI)               |
| `pnpm test` / `pnpm test:int` / `pnpm test:all` | unit tests / integration tests (Docker) / both                                             |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`  | ESLint, `tsc --noEmit`, Prettier                                                           |

## Testing

- **Unit** (`pnpm test`, no Docker, `src/**/*.spec.ts`): pure rules of every detector, the
  transhipment **golden tests** (`src/domain/transhipment/legacy-golden.spec.ts` against
  `__fixtures__/legacy-golden.json`: 14 speed, 54 location, 18 heading, 29 weight/category cases,
  candidate scoring, interpolation, resampling and 39 complete detections, computed once by
  running the verbatim legacy `utils/illegal-transhipment.ts` and `utils/cii/speed-calculation.ts`),
  and every detector with synthetic tracks and zones through the SDK `DetectorTestHarness` with
  in-memory storage doubles (`src/detectors/shared/__testing__`), including failure isolation and
  `DETECTORS` subsets.
- **Integration** (`pnpm test:int`, `test/*.int.test.ts`): the real `AppModule` against
  `timescale/timescaledb-ha:pg17` and `nats:2.11-alpine` started once by
  `test/support/global-setup.ts`, signed test JWTs: zone, fleet and position events → `events`
  rows and `alert.raised.v1` for each detector, the cool-down (suppressed re-entry), the review
  flow with its audit record (notes kept unless changed), tenancy filtering, cursors, stored
  transhipment results, heatmap, statistics, the idempotent seed, the platform behaviour (health,
  migrations, 401, OpenAPI, metrics), the storage SQL (idempotent accumulation and streaks,
  restart of stale accumulations, pruning, claim-guarded completion with its result) and two
  **replicas** on one durable (`test/ha.int.test.ts`: the standby never analyses, concurrent
  raises of one key open one occurrence, a takeover adopts the occurrences the previous active
  instance opened and resolves them). Set
  `TESTCONTAINERS_RYUK_DISABLED=true` where Ryuk is unavailable; the global teardown stops the
  containers.

## Operations

- **Image** `ghcr.io/darmawanweb/ais-its-surveillance-service` (`node:24-alpine`, non-root `node`,
  production dependencies only, `HEALTHCHECK` on `/health/live`; contains `migrations/` and
  `seeds/`). CI pushes `main` and `sha-<commit>`, releases push `<version>`, `<major>.<minor>`
  and `latest`. Local build (the `ca` secret only behind a TLS-intercepting proxy):

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-surveillance-service .
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-surveillance-service .
  docker run --rm --env-file .env ais-its-surveillance-service node dist/seed.js   # seed from the image
  ```

- **Health**: `/health/live` (process up), `/health/ready` (database, NATS; `503` while shutting
  down). The port opens only after the migrations ran and the GEO/FLEET snapshots were loaded.
- **Replicas and failover**: run one replica per `DETECTORS` set for throughput and extra ones for
  failover. Only the instance pinned to the position consumer handles positions; when it stops
  pulling for 30 s (pinned TTL) a standby takes over, reloads the open occurrences from `events`
  (log `Alert state reloaded: adopted …, dropped …`) and its ticks start; the former instance's
  ticks stop within 2 min. The dark scan and the transhipment analyser hold a transaction-scoped
  advisory lock (`pg_advisory_xact_lock(7301840, hashtext(dedupKey))`) per alert operation.
- **Metrics** (`/metrics`, prefix `aisits_`): HTTP RED metrics; event metrics
  (`aisits_events_consumed_total{stream,consumer,outcome}`, `aisits_events_invalid_total`,
  `aisits_event_handler_duration_seconds`, `aisits_events_published_total`); SDK detector metrics
  (`aisits_detector_evaluations_total{detector}`, `aisits_detector_duration_seconds{detector}`,
  `aisits_detector_alerts_total{detector,severity}`, `aisits_detector_errors_total{detector,hook}`,
  `aisits_detector_skipped_total{detector,hook}`, `aisits_detector_positions_total{outcome}`);
  domain metrics `aisits_surveillance_transhipment_observations_total`,
  `aisits_surveillance_transhipment_analyses_total{outcome}` (`illegal`, `clean`,
  `insufficient_data`, `failed`) and `aisits_surveillance_transhipment_pairs{status}`.
- **Troubleshooting**
  - _Boot stops with a detector configuration error_: an unknown `DETECTORS` entry or an invalid
    `<ID>_*` value; the log lists every problem.
  - _No alerts at all_: check `aisits_detector_positions_total` (is the feed arriving?) and
    `GET /api/v2/surveillance/detectors` (enabled detectors and thresholds); with a `DETECTORS`
    subset the durable is `surveillance-positions-<ids>`.
  - _A detector errors_: `aisits_detector_errors_total{detector,hook}` and the `Detector:<id>`
    log context; the other detectors keep running.
  - _Transhipment never fires_: candidates need source `batam` or a `transhipment_area` zone
    (geo seed); `aisits_surveillance_transhipment_observations_total` shows scored pairs,
    `…_analyses_total{outcome="insufficient_data"}` missing tracks, a growing
    `…_pairs{status="pending"}` an analyser that falls behind (raise
    `TRANSHIPMENT_ANALYSIS_BATCH` or lower `TRANSHIPMENT_ANALYSIS_INTERVAL_S`); `failed` pairs
    carry `last_error` in `transhipment_pairs`.
  - _Every vessel looks dark after an outage_: it does not — the dark scan uses the feed's
    event-time watermark, not the wall clock, and starts only after the first position.
  - _An alert re-raised within 10 minutes is missing_: that is the cool-down (`suppressed`,
    the row is reopened); see `ALERT_COOLDOWN_MIN`.
  - _No transhipment analyses on a replica_: expected on standbys —
    `aisits_surveillance_transhipment_analyses_total` grows only on the instance consuming
    positions (`aisits_detector_positions_total` grows there too).
- **Platform issues** (worked around here, reported to the kit): the Detector SDK of
  `@darmawanweb/ais-its-nest` 0.2.0 restores the `AlertEmitter` only at bootstrap, runs `onTick`
  on every replica and exposes no "standby" state to detectors (`ConsumerHealth.standby` of the
  position consumer is reachable only through the internal `NatsConsumerRuntime`). `src/detectors/shared/alert-coordinator.ts` (`AlertCoordinator`, implemented by
  `PostgresAlertCoordinator`) fills the gap until the kit reloads `loadOpen()` on
  `consumer_pinned` and pauses ticks on standbys.
- **Known limitations**
  - Detector state is per instance: replicas give failover, not throughput (exclusive consumer).
  - After a restart the transhipment candidate search also reads `vessel_state` (`ST_DWithin`)
    until the in-memory `PairSearch` covers one neighbour window; `vessel_state` is written at
    most every `VESSEL_STATE_WRITE_INTERVAL_S` (60 s) per vessel (transhipment candidates and
    streak changes always), so right after a restart the dark scan may see a state up to 60 s
    older than the vessel's last position (negligible against the 30-minute gap).
  - A dark resolution reports `lastSeenAt` / `gapMin` as `null` when the pipeline sends
    `previous: null` (it sends the last recorded position for every known vessel).
  - Dark, fishing and anomaly-persistence thresholds are v2 design defaults that need domain
    validation (`needsCitation` in the catalog).
  - The heatmap grid is square in degrees (`cellKm / 111.32`): within 2 % of square in km at
    Indonesian latitudes (11° S – 6° N), more elongated far from the equator.
  - Event and result time filters select by occurrence (event `time`, result window start), not
    by detection time (`created_at` / `detectedAt`).
  - `pnpm seed` / `node dist/seed.js` validate the full service configuration: run them with the
    service's environment (e.g. a real `INTERNAL_TOKEN` in production).

## Legacy parity

Sources: `be-legacy/src/utils/illegal-transhipment.ts`, `services/illegal-transhipment/*`,
`workers/illegal-transhipment-child-worker.ts`, `repositories/illegal-transhipment/*`,
`models/illegal-transhipment/*`, `controllers/illegal-transhipment.controller.ts` and
`fe-legacy/src/pages/anomaly/components/navstatus-anomaly-card.tsx`.

**Kept exactly** (golden tests): speed (`Δv < 0.5 → 3`, `< 2 → 2`, `≤ 10 → 1`), location
(legacy haversine R = 3438 nm: `≤ 27 m → 3`, `≤ 34 m → 2`, `≤ 600 m → 1`) and heading
(`≤ 6° → 3`, `≤ 174° → 2`, `≤ 186° → 1`, HDG 511 used as a number) priorities and their
product; the accumulation `Q ← Q + P` per sorted pair; the queue order `priority DESC, createdAt
ASC`; the 15-minute re-analysis cool-down; route window 60 min / last 60 fixes; resampling
(> 30 fixes → every 3 min), linear interpolation without heading wrap, 30-min windows every
10 min with checks every 5 min, weights `27→10 … 1→0.5`, `accuracy = 0.7·A_w + 0.3·A_p`
(rounded to 2 decimals), threshold 70, average priority and `low/medium/high` distribution
(rounded percent); the navstatus anomaly rule.

**Intentional changes** (spec §15 item 7 and this service's design):

| Legacy                                                                                                        | v2                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mongo queue, forked child worker polling every 2 s – 2 min                                                    | `transhipment_pairs` + scheduled analyser with `FOR UPDATE SKIP LOCKED` claims and stale-claim recovery                                                                                                                              |
| candidates only when the current vessel `isBatam`, all Batam ships of the last 5 min (no distance pre-filter) | source `batam` **or** inside a `transhipment_area` zone; neighbours within 600 m (the location priority is 0 beyond anyway) and 5 min, PostGIS / `PairSearch`                                                                        |
| route window relative to the wall clock                                                                       | relative to the pair's last observation (event time), so a backlog is analysed correctly                                                                                                                                             |
| skip within 15 min: the child worker **deleted** the queue entry (the older `det.service` kept it)            | the pair stays queued and is analysed after the cool-down                                                                                                                                                                            |
| a failed analysis left the entry `failed` forever                                                             | the next observation queues the pair again                                                                                                                                                                                           |
| every result (also `isIllegal: false`) stored; `GET /results` returned the illegal ones                       | every **positive** analysis stored in `transhipment_results` and served by `GET /transhipments` in the legacy shape; the first opens an event (alert + row), a negative analysis resolves it (kept only as the pair's `last_result`) |
| no severity, no deduplication, no review                                                                      | severity mapping, `dedupKey`, cool-down, review lifecycle                                                                                                                                                                            |
| anomaly evaluated in the browser on the latest position of each vessel                                        | server-side on every position, sustained for 3 positions, resolved by a consistent one                                                                                                                                               |
| fishing heatmap from a bundled JSON file                                                                      | `fishing_violations` table (`pnpm seed`) + `GET /fishing-violations`; heatmap of live events                                                                                                                                         |

## Methodology & references

Every formula, constant, threshold and rule is traceable to its source (spec §17): the
implementing function carries a `@method <id>` TSDoc tag, values without a verified source are
marked `// SOURCE: thesis — needs citation` (and `needsCitation` in the catalog), the ids are
listed in [`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/surveillance/methodology`, detectors by `GET …/detectors`) and described in
[`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) and `docs/references/methods.json`.

| Method id                                                                                            | Implemented by                                                               | Original sources                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`transhipment.speed_priority`](../../docs/METHODOLOGY.md#transhipment.speed_priority)               | `src/domain/transhipment/priority.ts` `speedPriority`                        | legacy MVP backend; context [Miller et al. 2018](https://doi.org/10.3389/fmars.2018.00240) — needs citation                                                                                                                                                                                                                           |
| [`transhipment.location_priority`](../../docs/METHODOLOGY.md#transhipment.location_priority)         | `priority.ts` `locationPriority`                                             | legacy MVP backend; [haversine](https://movable-type.co.uk/scripts/latlong.html); [Miller et al. 2018](https://doi.org/10.3389/fmars.2018.00240) — needs citation                                                                                                                                                                     |
| [`transhipment.heading_priority`](../../docs/METHODOLOGY.md#transhipment.heading_priority)           | `priority.ts` `headingPriority`                                              | legacy MVP backend; [ITU-R M.1371-5](https://www.itu.int/rec/R-REC-M.1371-5-201402-I) (HDG 511) — needs citation                                                                                                                                                                                                                      |
| [`transhipment.candidate_queue`](../../docs/METHODOLOGY.md#transhipment.candidate_queue)             | `priority.ts` `pairPriority`, `pairs.ts`, `transhipment-pairs.repository.ts` | legacy MVP backend; [Miller et al. 2018](https://doi.org/10.3389/fmars.2018.00240), [Boerder et al. 2018](https://doi.org/10.1126/sciadv.aat7159), [GFW events](https://globalfishingwatch.org/our-apis/documentation), [Permen KP 57/2014](https://peraturan.bpk.go.id/Download/150880/Permen%20KKP%20Nomor%2057%20Tahun%202014.pdf) |
| [`transhipment.route_interpolation`](../../docs/METHODOLOGY.md#transhipment.route_interpolation)     | `src/domain/transhipment/track.ts`                                           | legacy MVP backend — needs citation                                                                                                                                                                                                                                                                                                   |
| [`transhipment.sliding_window`](../../docs/METHODOLOGY.md#transhipment.sliding_window)               | `src/domain/transhipment/analysis.ts` `detectTranshipment`                   | legacy MVP backend; [Miller et al. 2018](https://doi.org/10.3389/fmars.2018.00240) — needs citation                                                                                                                                                                                                                                   |
| [`transhipment.weighted_score`](../../docs/METHODOLOGY.md#transhipment.weighted_score)               | `analysis.ts` `weightedScore`                                                | legacy MVP backend — needs citation                                                                                                                                                                                                                                                                                                   |
| [`transhipment.accuracy`](../../docs/METHODOLOGY.md#transhipment.accuracy)                           | `analysis.ts` `transhipmentScore`, `transhipmentSeverity`                    | legacy MVP backend; [Miller et al. 2018](https://doi.org/10.3389/fmars.2018.00240), [GFW events](https://globalfishingwatch.org/our-apis/documentation) — needs citation                                                                                                                                                              |
| [`transhipment.priority_distribution`](../../docs/METHODOLOGY.md#transhipment.priority_distribution) | `analysis.ts` `priorityCategory`, `detectTranshipment`                       | legacy MVP backend — needs citation                                                                                                                                                                                                                                                                                                   |
| [`geo.haversine_distance`](../../docs/METHODOLOGY.md#geo.haversine_distance)                         | contracts `haversineDistance` (R = 3438 nm) used by `locationPriority`       | [Sinnott 1984 / Veness](https://movable-type.co.uk/scripts/latlong.html), [Aviation Formulary](https://www.edwilliams.org/avform.txt), [NIST SP 811](https://www.nist.gov/pml/special-publication-811/nist-guide-si-footnotes)                                                                                                        |
| [`anomaly.navstatus_mismatch`](../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch)                 | `src/domain/anomaly.ts`, `src/detectors/anomaly/`                            | legacy MVP frontend; [IMO A.1106(29)](<https://wwwcdn.imo.org/localresources/en/OurWork/Safety/Documents/AIS/Resolution%20A.1106(29).pdf>), [Harati-Mokhtari et al. 2007](https://doi.org/10.1017/S0373463307004298), [Pallotta et al. 2013](https://doi.org/10.3390/e15062218) — k = 3 needs citation                                |
| [`dark.ais_gap`](../../docs/METHODOLOGY.md#dark.ais_gap)                                             | `src/domain/dark.ts`, `src/detectors/dark/`                                  | v2 design; [Welch et al. 2022](https://doi.org/10.1126/sciadv.abq2109), [GFW events](https://globalfishingwatch.org/our-apis/documentation), [IMO A.1106(29)](<https://wwwcdn.imo.org/localresources/en/OurWork/Safety/Documents/AIS/Resolution%20A.1106(29).pdf>) — thresholds need citation                                         |
| [`geo.geofence_enter`](../../docs/METHODOLOGY.md#geo.geofence_enter)                                 | `src/domain/geofence.ts`, `src/detectors/geofence/`                          | v2 design (platform spec §13.8)                                                                                                                                                                                                                                                                                                       |
| [`fishing.loitering`](../../docs/METHODOLOGY.md#fishing.loitering)                                   | `src/domain/fishing.ts`, `src/detectors/fishing/`                            | v2 design; [de Souza et al. 2016](https://doi.org/10.1371/journal.pone.0158248), [Natale et al. 2015](https://doi.org/10.1371/journal.pone.0130746), [Kroodsma et al. 2018](https://doi.org/10.1126/science.aao5646) — band, duration and course-change rate need citation                                                            |
| [`fishing.apprehensions_2015_2017`](../../docs/METHODOLOGY.md#fishing.apprehensions_2015_2017)       | `src/modules/fishing-violations/fishing-violations.seed.ts`                  | legacy MVP frontend `ilegal.json`; candidate origin [KKP Ditjen PSDKP 2017](https://ppid.kkp.go.id/media/uploads/document_information_public/Laporan_Kinerja_DJPSDKP_2017.pdf), [Kontan 2016](https://industri.kontan.co.id/news/kkp-tangkap-163-kapal-ikan-ilegal-sepanjang-2016) — provenance needs citation                        |

The fishing course-change rate (`FISHING_MIN_COURSE_CHANGE_DEG_PER_MIN` = 3 °/min between fixes
≥ 3 min apart) is this service's operational definition of the catalog's "frequent course
changes" (left unspecified in `docs/METHODOLOGY.md` §14.1) and needs domain validation.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build. Add a
detector as a folder under `src/detectors/<id>/` (class with `id`, `domain`, `methodIds`,
`configSchema`), list it in `DetectorsModule`, document its `<ID>_*` variables here and in
`.env.example`, add its method ids to the catalog and `implemented-methods.ts`, and test it with
the `DetectorTestHarness`.
