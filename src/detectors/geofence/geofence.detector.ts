import {
  type Detector,
  type DetectorContext,
  type DetectorZoneChange,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import {
  geofenceSeverity,
  geofenceTransition,
  isWatchedZone,
} from '../../domain/geofence.js';
import {
  type DetectorResolutionCode,
  geofenceText,
  resolution,
} from '../../domain/messages.js';
import { AlertKeyLock } from '../shared/alert-key-lock.js';
import {
  optionalZoneKindList,
  zoneKindList,
} from '../shared/config-schemas.js';
import { VesselStateRecorder } from '../shared/vessel-state.recorder.js';

/** Alert type of the detector (contracts `ALERT_TYPES.geofence`). */
export const GEOFENCE_ALERT = 'geofence';

/** `GEOFENCE_*` variables without the prefix. */
export const geofenceConfigSchema = z.object({
  /** Watched zone kinds (spec §13.8: restricted, mpa, custom with alertOnEnter). */
  KINDS: zoneKindList('restricted,mpa,custom'),
  /** Kinds whose entry is critical (others: warning). */
  CRITICAL_KINDS: optionalZoneKindList('restricted'),
  /** Count the zone's bufferM as inside (z ⊕ b of the method). */
  USE_BUFFER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

/** Parsed `GEOFENCE_*` configuration. */
export type GeofenceConfig = z.output<typeof geofenceConfigSchema>;

/** Deduplication key of one vessel inside one zone. */
export function geofenceKey(mmsi: number, zoneId: string): string {
  return `${GEOFENCE_ALERT}:${mmsi}:${zoneId}`;
}

/**
 * Zone entry (geofence): an event when a vessel is inside an active zone of
 * kind `restricted` / `mpa` / `custom` (`GEOFENCE_KINDS`) with `alertOnEnter`
 * and no occurrence is open; resolved when it leaves, or when the zone is
 * deleted, deactivated or stops alerting (zone changes are handled by the
 * active instance; a takeover also ends the occurrences of zones that
 * changed while no instance was active). Global zones apply to every vessel,
 * an organization's zones only to its own vessels. Severity: `critical` for
 * `GEOFENCE_CRITICAL_KINDS` (restricted), else `warning`. Dedup key
 * `geofence:<mmsi>:<zoneId>`. An entry opens its occurrence through the
 * `AlertKeyLock` (aligned with `events`, stale positions open nothing), so an
 * instance that resumes after a pause never opens one twice.
 *
 * @method geo.geofence_enter
 * @see ../../../../../docs/METHODOLOGY.md#geo.geofence_enter
 */
@RegisterDetector()
@Injectable()
export class GeofenceDetector implements Detector<GeofenceConfig> {
  readonly id = 'geofence';
  readonly domain = 'surveillance';
  readonly methodIds = ['geo.geofence_enter'];
  readonly alertTypes = [GEOFENCE_ALERT] as const;
  readonly configSchema = geofenceConfigSchema;

  constructor(
    private readonly recorder: VesselStateRecorder,
    private readonly lock: AlertKeyLock,
  ) {}

  async onPosition(
    context: DetectorContext<GeofenceConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const { config } = context;
    await this.recorder.observe(context, position);
    const inside = context.zones
      .zonesAt(position, {
        kinds: config.KINDS,
        useBuffer: config.USE_BUFFER,
        // Global zones and the vessel's own organization's zones (spec §8.5).
        orgId: context.fleet.orgOf(position.mmsi) ?? null,
      })
      .filter((zone) => isWatchedZone(zone, config.KINDS));

    for (const zone of inside) {
      const key = geofenceKey(position.mmsi, zone.id);
      if (geofenceTransition(context.alerts.isOpen(key), true) !== 'entered')
        continue;
      const { title, message, messageKey, messageParams } = geofenceText({
        mmsi: position.mmsi,
        vesselName: context.fleet.byMmsi(position.mmsi)?.name,
        zoneName: zone.name,
        zoneKind: zone.kind,
        zoneCode: zone.code,
        sogKn: position.sog,
      });
      await this.lock.raiseFromPosition(
        context.alerts,
        {
          type: GEOFENCE_ALERT,
          dedupKey: key,
          severity: geofenceSeverity(zone.kind, config.CRITICAL_KINDS),
          mmsi: position.mmsi,
          title,
          message,
          position,
          occurredAt: position.time,
          zoneId: zone.id,
          data: {
            zoneKind: zone.kind,
            zoneCode: zone.code,
            zoneName: zone.name,
            sogKn: position.sog,
            messageKey,
            messageParams,
          },
        },
        position.time,
      );
    }

    const insideIds = new Set(inside.map((zone) => zone.id));
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      const wasInside = open.zoneId !== null;
      const isInside = open.zoneId !== null && insideIds.has(open.zoneId);
      if (geofenceTransition(wasInside, isInside) === 'left') {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          ...resolution('left_zone'),
        });
      }
    }
  }

  /**
   * Zone changes reach every instance; only the active one ends occurrences
   * (a standby's state is replaced from `events` when it takes over).
   */
  async onZoneChanged(
    context: DetectorContext<GeofenceConfig>,
    change: DetectorZoneChange,
  ): Promise<void> {
    if (!context.isActive()) return;
    const watched =
      change.kind === 'upserted' &&
      isWatchedZone(change.zone, context.config.KINDS);
    if (watched) return;
    const code: DetectorResolutionCode =
      change.kind === 'deleted' ? 'zone_deleted' : 'zone_no_longer_alerts';
    for (const open of context.alerts.open()) {
      if (open.zoneId !== change.zone.id) continue;
      await context.alerts.resolve(open.dedupKey, {
        at: context.now(),
        ...resolution(code),
      });
    }
  }

  /**
   * A takeover: the open occurrences were just reloaded from `events`; end
   * those whose zone was deleted or stopped alerting while no instance was
   * active (their zone change was skipped by every standby).
   */
  async onActivated(context: DetectorContext<GeofenceConfig>): Promise<void> {
    for (const open of context.alerts.open()) {
      if (open.zoneId === null) continue;
      const zone = context.zones.get(open.zoneId);
      if (zone !== undefined && isWatchedZone(zone, context.config.KINDS))
        continue;
      await context.alerts.resolve(open.dedupKey, {
        at: context.now(),
        ...resolution(
          zone === undefined ? 'zone_deleted' : 'zone_no_longer_alerts',
        ),
      });
    }
  }
}
