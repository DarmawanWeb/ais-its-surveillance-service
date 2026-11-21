import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
  type AlertRaisedV1,
  type VesselSnapshotV1,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import type { AisSource } from '@darmawanweb/ais-its-contracts/domain';
import {
  makeTestVesselSnapshot,
  makeTestZone,
  toPositionPayload,
} from '@darmawanweb/ais-its-nest/analytics';
import { PG_POOL } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

/** A unique, valid 9-digit MMSI per call (tests share the containers). */
let nextMmsi = 200_000_000 + Math.floor(Math.random() * 500_000_000);
export function uniqueMmsi(): number {
  nextMmsi += 1;
  return nextMmsi;
}

/** A square polygon of `sizeDeg` degrees at (lon, lat). */
export function square(
  lon: number,
  lat: number,
  sizeDeg = 0.1,
): ZoneSnapshotV1['geometry'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + sizeDeg, lat],
        [lon + sizeDeg, lat + sizeDeg],
        [lon, lat + sizeDeg],
        [lon, lat],
      ],
    ],
  };
}

/** A position to publish; times are `Date`s. */
export interface PositionInput {
  readonly mmsi: number;
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly sog?: number;
  readonly cog?: number;
  readonly hdg?: number;
  readonly navstatus?: number;
  readonly predictedNavstatus?: 0 | 1;
  readonly source?: AisSource;
}

/** Publishing and inspection helpers bound to a test application. */
export class Fixtures {
  readonly publisher: EventPublisher;
  readonly pool: Pool;

  constructor(readonly app: NestFastifyApplication) {
    this.publisher = app.get(EventPublisher);
    this.pool = app.get<unknown, Pool>(PG_POOL);
  }

  async zone(
    input: Parameters<typeof makeTestZone>[0],
  ): Promise<ZoneSnapshotV1> {
    const zone = makeTestZone(input);
    await this.publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);
    return zone;
  }

  async vessel(
    input: Partial<VesselSnapshotV1> & Pick<VesselSnapshotV1, 'mmsi'>,
  ): Promise<VesselSnapshotV1> {
    const vessel = makeTestVesselSnapshot(input);
    await this.publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      vessel,
    );
    return vessel;
  }

  /** Publishes positions in order (each vessel's `previous` = its last one published). */
  async positions(inputs: readonly PositionInput[]): Promise<void> {
    const last = new Map<number, PositionInput>();
    for (const input of inputs) {
      const previous = last.get(input.mmsi);
      await this.publisher.publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload({
          mmsi: input.mmsi,
          time: input.time,
          source: input.source ?? 'primary',
          lat: input.lat,
          lon: input.lon,
          sog: input.sog ?? 0,
          cog: input.cog ?? 0,
          hdg: input.hdg ?? 511,
          navstatus: input.navstatus ?? 0,
          predictedNavstatus: input.predictedNavstatus ?? 0,
          coastDistanceM: null,
          previous:
            previous === undefined
              ? null
              : {
                  time: previous.time,
                  lat: previous.lat,
                  lon: previous.lon,
                  sog: previous.sog ?? 0,
                  cog: previous.cog ?? 0,
                  hdg: previous.hdg ?? 511,
                  navstatus: previous.navstatus ?? 0,
                  predictedNavstatus: previous.predictedNavstatus ?? 0,
                },
        }),
      );
      last.set(input.mmsi, input);
    }
  }

  /** Number of `alert.raised.v1` messages stored for a type and vessel. */
  async alertCount(type: string, mmsi: number): Promise<number> {
    const { manager } = this.app.get(NatsClient);
    const subject = subjects.alert(type, mmsi);
    const info = await manager.streams.info('ALERTS', {
      subjects_filter: subject,
    });
    return info.state.subjects?.[subject] ?? 0;
  }

  /** Waits for the latest alert of a type and vessel in the `ALERTS` stream. */
  async waitForAlert(
    type: string,
    mmsi: number,
    timeoutMs = 20_000,
  ): Promise<AlertRaisedV1> {
    const { manager } = this.app.get(NatsClient);
    const stored = await waitFor(
      () =>
        manager.streams.getMessage('ALERTS', {
          last_by_subj: subjects.alert(type, mmsi),
        }),
      { timeoutMs },
    );
    const parsed = parseEnvelope(stored.data);
    if (!parsed.success || parsed.envelope.type !== EVENT_TYPES.ALERT_RAISED)
      throw new Error(`Not an alert: ${stored.subject}`);
    return parsed.envelope.data;
  }

  /** Rows of a query (`search_path` is the service schema). */
  async rows<Row extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, values);
    return result.rows;
  }
}

/** Minutes before now. */
export function minutesAgo(minutes: number, now = Date.now()): Date {
  return new Date(now - minutes * 60_000);
}
