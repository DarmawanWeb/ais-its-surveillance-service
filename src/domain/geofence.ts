import type {
  AlertSeverity,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';

/** The zone fields the geofence rule reads. */
export interface GeofenceZone {
  readonly kind: ZoneKind;
  readonly active: boolean;
  readonly alertOnEnter: boolean;
}

/**
 * `true` when entering the zone raises a geofence event: an active zone of a
 * watched kind (`GEOFENCE_KINDS`, default `restricted, mpa, custom`) with
 * `alertOnEnter`.
 *
 * @method geo.geofence_enter
 * @see ../../../../docs/METHODOLOGY.md#geo.geofence_enter
 */
export function isWatchedZone(
  zone: GeofenceZone,
  kinds: readonly ZoneKind[],
): boolean {
  return zone.active && zone.alertOnEnter && kinds.includes(zone.kind);
}

/**
 * Zone entry: `enter(z) ⇔ p_{t−1} ∉ z^{⊕b} ∧ p_t ∈ z^{⊕b}` — evaluated by the
 * detector as "inside the (buffered) zone and no occurrence open", so a
 * vessel already inside a newly created zone is reported too and the open
 * occurrence (restored after restarts) carries the "inside" state.
 *
 * @method geo.geofence_enter
 * @see ../../../../docs/METHODOLOGY.md#geo.geofence_enter
 * @param wasInside - the occurrence for this vessel and zone is open
 * @param isInside - the current position is inside the zone (or its buffer)
 */
export function geofenceTransition(
  wasInside: boolean,
  isInside: boolean,
): 'entered' | 'left' | 'unchanged' {
  if (isInside && !wasInside) return 'entered';
  if (!isInside && wasInside) return 'left';
  return 'unchanged';
}

/**
 * Severity of a geofence event (v2 mapping): `critical` for the zone kinds in
 * `criticalKinds` (`GEOFENCE_CRITICAL_KINDS`, default `restricted`), else
 * `warning` (registry default).
 *
 * @method geo.geofence_enter
 */
export function geofenceSeverity(
  kind: ZoneKind,
  criticalKinds: readonly ZoneKind[],
): Extract<AlertSeverity, 'warning' | 'critical'> {
  return criticalKinds.includes(kind) ? 'critical' : 'warning';
}
