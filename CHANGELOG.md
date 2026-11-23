# Changelog

All notable changes to `ais-its-surveillance-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-22

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0 (the
platform workarounds of kit 0.2 are gone), published resolutions, localizable texts and the
backend gaps reported by the web app, on top of the review hardening of 0.1.0. **Deploy after
notification** (contracts 0.4 with its `alert.resolved.v1` handler): an older notification
acknowledges and skips the new event type, so resolutions published before it is upgraded never
close inbox alerts.

### Added

- **Published resolutions**: the end of an occurrence is announced as `alert.resolved.v1` on the
  raise's subject `alert.v1.<type>.<mmsi>` (kit default), once `ALERT_COOLDOWN_MIN` since the
  occurrence's last publication has passed (a re-raise within it cancels it), and on graceful
  stop and deactivation; `data.code` names the reason.
- **Resolution codes**: `resolution.code` (`escalated`, `ais_resumed`, `navstatus_consistent`,
  `left_zone`, `loitering_ended`, `analysis_negative`, `pair_separated`, `zone_deleted`,
  `zone_no_longer_alerts`, `legacy_import`, `other`) in `events.resolution`, the API and
  `alert.resolved.v1`; the English `reason` is unchanged; rows without a code (written before
  0.2.0, legacy imports) get the code of their reason on read.
- **Localizable texts** (cross-service convention): every alert carries `data.messageKey`
  (`surveillance.<detector>.<situation>`) and flat `data.messageParams` (vessel names, MMSIs,
  zone names, minutes, knots); the English `title` / `message` are rendered from the documented
  templates (README "Messages"); the API derives them on read for older rows and legacy imports.
- `GET /surveillance/stats/series?from&to&bucket=hour|day&tz&type`: counts by type and severity
  per hour or local day of an IANA time zone in one query (every bucket of the range, at most
  1 000; `400 VALIDATION_FAILED` on `bucket` beyond); buckets follow daylight saving time (a
  repeated hour is two buckets, a skipped hour none, a day lasts 23 to 25 hours). `tz` takes
  IANA names the database knows (`pg_timezone_names`, any case, echoed in its spelling as
  `timeZone`): UTC offsets such as `+07:00`, which PostgreSQL reads as POSIX specifications with
  the opposite sign, and aliases only ICU still knows (`US/Pacific-New`) are refused with
  `400 VALIDATION_FAILED` on `tz`.
- `GET /surveillance/fishing-violations/years` (year facets) and
  `GET /surveillance/fishing-violations/heatmap?year&bbox&cellKm` (the historical heat layer).
- `GET /surveillance/events` filters `active` (detector lifecycle, `resolvedAt` null or not),
  `zoneId` and `q` (2–100 characters once trimmed, a blank one is refused; part of either
  vessel's name, or the leading digits of an MMSI; LIKE wildcards matched literally).
- `GET /surveillance/transhipments?eventId`: the analyses of one event (every window unless
  `from` / `to` bound it).
- `GET /surveillance/detectors` returns `thresholds: [{ key, value, unit, description }]` per
  detector (`config` is kept).
- Failover through the kit's activation: each detector's `onActivated` drops the state built
  while another instance was active (transhipment restarts its cold-start window and analyses at
  the first tick, anomaly reloads its streaks, fishing rebuilds its runs from `track_points`,
  dark scans at the first tick, geofence ends occurrences of zones deleted or no longer alerting
  while no instance was active); geofence zone changes are handled by the active instance only.
- `DetectorEventsRepository.onRepeated`: `last_seen_at` follows the event time of unchanged
  signals (throttled to 60 s of event time); `loadOpen` returns `domain`, `methodId` and the
  occurrence's event times (`firstOccurredAt`, `lastOccurredAt`), oldest first, so of duplicate
  open rows of a key the newest is kept; `onResolved` ends the other open rows of the key with
  the occurrence (`resolution.duplicateOf`, documented in the API) when it ends its row, and
  nothing else when that row had already ended.
- `AlertKeyLock` (`PostgresAlertKeyLock`): the tick analysers' raises and resolutions run inside
  the key's `AlertEmitter.withKey` turn under a per-`dedupKey` advisory lock after aligning the
  key with `events` (`replaceOpen` / `forget`), so an instance cut off from NATS that still ticks
  never opens an occurrence twice. Position-driven raises that would publish (new occurrences and
  escalations of geofence, anomaly and fishing) run through `AlertKeyLock.raiseFromPosition`: an
  active instance paused past the pinned TTL (`SIGSTOP`, a blocked event loop), which kit 0.3
  lets handle its buffered positions under the old pin without a reload, adopts the occurrence
  the instance that took over opened instead of opening a second one (second row and second
  `alert.raised.v1`, the older row never resolved), and a position not newer than the key's last
  resolution opens nothing. At most `(DATABASE_POOL_MAX - 1) / 2` operations hold a lock per
  instance (each holds a pooled connection and needs a second one).
- `transhipment_results` (migration `0002_review_hardening`, hypertable on the window start,
  2-year retention): every positive analysis is stored with its window, accuracy, average
  priority, distribution, severity and position, linked to the event of its occurrence, in the
  same transaction as the completion of its claim (legacy parity: the child worker stored a result
  per analysis).

### Changed

- Dependencies: `@darmawanweb/ais-its-contracts` `^0.4.0`, `@darmawanweb/ais-its-nest` `^0.3.0`;
  `.pnpmfile.cjs` also keeps the `@nestjs/terminus` gRPC peers out of the production install.
- **OpenAPI (regenerated clients)**: event responses are one schema per alert type discriminated
  by `type` (`TranshipmentEventDto`, `AnomalyEventDto`, `DarkEventDto`, `GeofenceEventDto`,
  `FishingEventDto`, replacing `SurveillanceEventDto`) with typed `data` and `resolution`;
  nullable strings and numbers are typed (`vesselName`, `zoneId`, `lat`, `resolvedAt`, `note`,
  `ship1Name`, …) instead of `object`; path parameters, the page maximum and security schemes as
  documented by kit 0.3.
- English titles and messages round scores, priorities and speeds to 0.1 and durations to whole
  minutes (rendered from the message templates).
- `last_seen_at` stores event time on de-escalations and suppressed re-raises too (was the
  instance clock) and never moves backwards.
- Deployment: two or more replicas with rolling updates; ticks run only on the active instance
  (kit), a graceful stop releases the pin at once.
- `MIGRATIONS_DIR` resolves `migrations/` from the package (service and `pnpm migrate`), `@UuidParam()`
  validates event ids, and the projection consumer switches exhaustively over the exact envelope
  types of contracts 0.4.
- `GET /surveillance/transhipments` lists the stored results (one per positive analysis, newest
  window first) instead of one stale entry per occurrence; `id` is the result id, the new
  `eventId` links the occurrence, `status` (the occurrence's review status) is nullable.
- `PATCH /surveillance/events/:id` changes the note only when the body has `note` (`null` clears
  it); the audit record carries `noteChanged`, and the previous and new note when it changed.
- Event and alert `data` no longer carry organization ids (`orgId`, `relatedOrgId`,
  `zoneOrgId`): ownership is derived at query time from the FLEET projection (spec §8.5).
- The anomaly streak is capped at `ANOMALY_MIN_POSITIONS`, so a persistently anomalous vessel no
  longer rewrites `vessel_state` on every position.

### Removed

- The platform workaround `AlertCoordinator` (`alert-coordinator.ts`,
  `postgres-alert-coordinator.ts`, `__testing__/local-alert-coordinator.ts`): the reload after a
  15 s pause and the 2-minute tick gate (replaced by the kit's activation and, for the positions
  a resumed instance still handles, by the `AlertKeyLock` alignment of position transitions), and
  its `ended by another instance` resolutions (now `forget`, never a second `alert.resolved.v1`).
- `src/db/rows.ts` (the kit's `rowDate` / `rowDateOrNull`).

### Fixed

- A dark resolution reported `lastSeenAt` / `gapMin` as `null` when the position had no
  `previous`; it now falls back to the occurrence's event time (the last sighting).
- A failed transhipment analysis logged and stored in `transhipment_pairs.last_error` the full
  database error, whose drizzle message lists every bound value; it now keeps only the driver's
  message (kit `sanitizeError`), as do the error logs of `pnpm seed`.
- The transhipment expiry compared against the emitter clock when the pair row was gone; it uses
  the occurrence's event time.
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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-surveillance-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-surveillance-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-surveillance-service/releases/tag/v0.1.0
