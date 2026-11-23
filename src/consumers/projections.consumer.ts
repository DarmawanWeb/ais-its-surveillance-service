import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselsRepository } from './vessels.repository.js';
import { ZonesRepository } from './zones.repository.js';

/**
 * Durable projections of the `GEO` (`surveillance-zones`) and `FLEET`
 * (`surveillance-fleet`) streams into `zones` and `vessels` (spec §7.3,
 * §13.8). The detectors read the same streams through the SDK's in-memory
 * `ZoneIndex` / `FleetDirectory`; these tables serve SQL (tenancy filters,
 * zone names, the cold-start candidate search). Idempotent: snapshots apply
 * only when newer, deletions are tombstones.
 */
@Injectable()
export class ProjectionsConsumer {
  private readonly logger = new Logger(ProjectionsConsumer.name);

  constructor(
    private readonly zones: ZonesRepository,
    private readonly vessels: VesselsRepository,
  ) {}

  @EventHandler({ consumer: 'surveillance-zones' })
  async onZone(event: ConsumerEnvelope<'surveillance-zones'>): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.GEO_ZONE_UPSERTED: {
        const applied = await this.zones.upsert(event.data);
        if (!applied)
          this.logger.debug(`Zone ${event.data.id}: older snapshot ignored`);
        return;
      }
      case EVENT_TYPES.GEO_ZONE_DELETED:
        await this.zones.markDeleted(event.data, new Date(event.time));
        return;
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }

  @EventHandler({ consumer: 'surveillance-fleet' })
  async onVessel(event: ConsumerEnvelope<'surveillance-fleet'>): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED: {
        const outcome = await this.vessels.upsert(event.data);
        if (outcome === 'stale')
          this.logger.debug(
            `Vessel ${event.data.id} (${event.data.mmsi}): older snapshot ignored`,
          );
        return;
      }
      case EVENT_TYPES.FLEET_VESSEL_DELETED:
        await this.vessels.markDeleted(event.data, new Date(event.time));
        return;
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }
}
