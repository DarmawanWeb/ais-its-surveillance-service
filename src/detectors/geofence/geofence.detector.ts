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
import { AlertCoordinator } from '../shared/alert-coordinator.js';
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
 * deleted, deactivated or stops alerting. Global zones apply to every vessel,
 * an organization's zones only to its own vessels. Severity: `critical` for
 * `GEOFENCE_CRITICAL_KINDS` (restricted), else `warning`. Dedup key
 * `geofence:<mmsi>:<zoneId>`.
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
    private readonly coordinator: AlertCoordinator,
  ) {}

  async onPosition(
    context: DetectorContext<GeofenceConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const { config } = context;
    await this.coordinator.positionSeen(context.now());
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
      await context.alerts.raise({
        type: GEOFENCE_ALERT,
        dedupKey: key,
        severity: geofenceSeverity(zone.kind, config.CRITICAL_KINDS),
        mmsi: position.mmsi,
        title: `Entered ${zone.name}`,
        message: `Vessel ${position.mmsi} entered ${zone.name} (${zone.kind})`,
        position,
        occurredAt: position.time,
        zoneId: zone.id,
        data: {
          zoneKind: zone.kind,
          zoneCode: zone.code,
          zoneName: zone.name,
          sogKn: position.sog,
        },
      });
    }

    const insideIds = new Set(inside.map((zone) => zone.id));
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      const wasInside = open.zoneId !== null;
      const isInside = open.zoneId !== null && insideIds.has(open.zoneId);
      if (geofenceTransition(wasInside, isInside) === 'left') {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          reason: 'left the zone',
        });
      }
    }
  }

  async onZoneChanged(
    context: DetectorContext<GeofenceConfig>,
    change: DetectorZoneChange,
  ): Promise<void> {
    const watched =
      change.kind === 'upserted' &&
      isWatchedZone(change.zone, context.config.KINDS);
    if (watched) return;
    for (const open of context.alerts.open()) {
      if (open.zoneId !== change.zone.id) continue;
      await context.alerts.resolve(open.dedupKey, {
        at: context.now(),
        reason:
          change.kind === 'deleted'
            ? 'zone deleted'
            : 'zone no longer alerts on entry',
      });
    }
  }
}
