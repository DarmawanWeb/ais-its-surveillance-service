# Changelog

All notable changes to `ais-its-surveillance-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `transhipment_results` (migration `0002_review_hardening`, hypertable on the window start,
  2-year retention): every positive analysis is stored with its window, accuracy, average
  priority, distribution, severity and position, linked to the event of its occurrence, in the
  same transaction as the completion of its claim (legacy parity: the child worker stored a result
  per analysis).
- `AlertCoordinator` (platform workaround, see the README): the first position an instance handles
  after a pause reloads the open occurrences from `events` (a takeover adopts what the previous
  active instance opened and drops what it ended); the dark scan and the transhipment analyser run
  only on the instance consuming positions, and their raises / resolutions are serialized per
  `dedupKey` across replicas with a PostgreSQL advisory lock after aligning the key with `events`.

### Changed

- `GET /surveillance/transhipments` lists the stored results (one per positive analysis, newest
  window first) instead of one stale entry per occurrence; `id` is the result id, the new
  `eventId` links the occurrence, `status` (the occurrence's review status) is nullable.
- `PATCH /surveillance/events/:id` changes the note only when the body has `note` (`null` clears
  it); the audit record carries `noteChanged`, and the previous and new note when it changed.
- Event and alert `data` no longer carry organization ids (`orgId`, `relatedOrgId`,
  `zoneOrgId`): ownership is derived at query time from the FLEET projection (spec §8.5).
- The anomaly streak is capped at `ANOMALY_MIN_POSITIONS`, so a persistently anomalous vessel no
  longer rewrites `vessel_state` on every position.

### Fixed

- Tenancy (spec §8.5): the dark rule counts only global (curated) `port` / `anchorage` zones, so
  an organization's private zone can no longer silence it; `vessel_state.in_zone_ids` holds only
  global and own-organization zones, and the transhipment cold-start search applies the in-memory
  candidate rule (zones of the neighbour's own organization) to stored neighbours.
- Hot standbys no longer run the transhipment analyser, which raised a second occurrence (second
  `alert.raised.v1`) for pairs opened by the active instance and left them open after a negative
  analysis.
- Redelivered positions after a restart are counted once (spec §7.1): the anomaly streak stores
  the time of its last counted position (`vessel_state.anomaly_streak_at`), and the pair
  accumulation the last observation of each vessel (`last_seen_by_a_at` / `last_seen_by_b_at`).
- Pending transhipment pairs below `TRANSHIPMENT_MIN_PRIORITY` no longer accumulate brief
  encounters days apart (an accumulation not continued within `TRANSHIPMENT_ROUTE_WINDOW_MIN`
  starts over) and are pruned with the finished ones after the 7-day track retention.
- A claim released as stale and claimed again can no longer be completed, failed or released by
  its previous holder.

## [0.1.0] - 2026-11-21

### Added

- Illegal-activity analytics of spec §13.8 on the Detector SDK (§18): five detectors registered
  with `@RegisterDetector()`, enabled per instance with `DETECTORS`, configured through their
  `<ID>_*` namespaces (zod, spec defaults) and isolated from each other's failures.
- **transhipment** — legacy illegal-transhipment parity without the Mongo queue and polling:
  candidate vessels (source `batam` or inside `transhipment_area` zones) seen within 5 min within
  600 m (SDK `PairSearch`, plus `ST_DWithin` on `vessel_state` while the index is cold) scored
  with the legacy speed × location × heading priorities and accumulated in `transhipment_pairs`;
  a scheduled analyser claims pairs by priority (`FOR UPDATE SKIP LOCKED`, legacy queue order
  and 15-min re-analysis cool-down) and runs the legacy interpolation / sliding-window detection
  over `track_points`; results become events with accuracy, window, average priority and
  priority distribution. Pure functions in `src/domain/transhipment` with golden tests computed
  from the legacy code.
- **anomaly** — navstatus anomaly (legacy web app rule) sustained for `ANOMALY_MIN_POSITIONS`
  consecutive positions, resolved by the first consistent position; streak persisted in
  `vessel_state.anomaly_streak`.
- **dark** — AIS gap: last seen more than 30 min before the feed's event-time watermark while
  moving faster than 1 kn and more than 5 km from any `port` / `anchorage` zone; resolved when
  the vessel reappears.
- **geofence** — entry into active `restricted` / `mpa` / `custom` zones with `alertOnEnter`
  (global zones for every vessel, organization zones for the organization's vessels), resolved
  on exit or when the zone stops alerting.
- **fishing** — loitering pattern (0.5–4 kn, mean course-change rate ≥ 3 °/min between fixes
  ≥ 3 min apart, ≥ 30 min, ≥ 6 fixes) inside `fishing_ground` / `restricted` zones.
- Events: `events` hypertable written by the SDK persistence hook before `alert.raised.v1` is
  published (`alert.v1.<type>.<mmsi>`), every event with `methodId`, a stable `dedupKey`, the SDK
  cool-down and a documented severity mapping; review lifecycle `open → confirmed | dismissed`
  kept apart from the detector lifecycle (`resolved_at`).
- Projections `zones` (GEO, durable `surveillance-zones`) and `vessels` (FLEET, durable
  `surveillance-fleet`), idempotent by snapshot time with tombstones.
- API (`/api/v2/surveillance`): `GET /events`, `GET /events/:id`, `PATCH /events/:id`
  (`surveillance:review`, audited), `GET /transhipments` (legacy result shape), `GET /heatmap`
  (`ST_SnapToGrid`, `cellKm`), `GET /fishing-violations`, `GET /stats`, `GET /detectors`,
  `GET /methodology`; tenancy of spec §8.5 enforced in SQL from the FLEET projection.
- `pnpm seed`: idempotent import of the 403 historical fishing apprehensions of the legacy web app
  (`ilegal.json`) into `fishing_violations` with provenance notes.
- `events_tiles` view (geometry) for an authority-only tile endpoint; deliberately not granted to
  `tiles_ro` (spec §13.8: events stay out of Martin).
- Domain metrics `aisits_surveillance_transhipment_observations_total`,
  `aisits_surveillance_transhipment_analyses_total{outcome}` and
  `aisits_surveillance_transhipment_pairs{status}`, next to the SDK detector metrics.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-surveillance-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-surveillance-service/releases/tag/v0.1.0
