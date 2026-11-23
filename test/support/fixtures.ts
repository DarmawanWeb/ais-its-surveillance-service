import {
  type AlertRaisedV1,
  type AlertResolvedV1,
  type AnyEventEnvelope,
  encodeEnvelope,
  EVENT_TYPES,
  parseEnvelope,
  streamForSubject,
  subjectForEvent,
  subjects,
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
import {
  EventPublisher,
  NatsClient,
  StreamManager,
} from '@darmawanweb/ais-its-nest/nats';
import { createTestConfig, waitFor } from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

import { configSchema } from '../../src/config.js';

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
      await this.publisher.publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionPayload(input, last.get(input.mmsi)),
      );
      last.set(input.mmsi, input);
    }
  }

  /**
   * The `ALERTS` messages of a type and vessel, oldest first: raises and
   * resolutions share the subject `alert.v1.<type>.<mmsi>`.
   */
  async alertMessages(
    type: string,
    mmsi: number,
  ): Promise<
    (
      | { readonly kind: 'raised'; readonly data: AlertRaisedV1 }
      | { readonly kind: 'resolved'; readonly data: AlertResolvedV1 }
    )[]
  > {
    const { jetstream } = this.app.get(NatsClient);
    const subject = subjects.alert(type, mmsi);
    const messages: Awaited<ReturnType<Fixtures['alertMessages']>> = [];
    // An ordered (ephemeral) consumer of the vessel's subject, read to its end.
    const consumer = await jetstream.consumers.get('ALERTS', {
      filter_subjects: [subject],
    });
    try {
      for (;;) {
        const batch = await consumer.fetch({
          max_messages: 100,
          expires: 1_000,
        });
        let received = 0;
        let pending = 0;
        for await (const message of batch) {
          received += 1;
          pending = message.info.pending;
          const parsed = parseEnvelope(message.data);
          if (!parsed.success) continue;
          const { envelope } = parsed;
          if (envelope.type === EVENT_TYPES.ALERT_RAISED)
            messages.push({ kind: 'raised', data: envelope.data });
          else if (envelope.type === EVENT_TYPES.ALERT_RESOLVED)
            messages.push({ kind: 'resolved', data: envelope.data });
        }
        if (received === 0 || pending === 0) break;
      }
    } finally {
      await consumer.delete().catch(() => undefined);
    }
    return messages;
  }

  /** Number of `alert.raised.v1` messages stored for a type and vessel. */
  async alertCount(type: string, mmsi: number): Promise<number> {
    const messages = await this.alertMessages(type, mmsi);
    return messages.filter((message) => message.kind === 'raised').length;
  }

  /** The `alert.resolved.v1` payloads stored for a type and vessel. */
  async resolvedEvents(type: string, mmsi: number): Promise<AlertResolvedV1[]> {
    const messages = await this.alertMessages(type, mmsi);
    return messages.flatMap((message) =>
      message.kind === 'resolved' ? [message.data] : [],
    );
  }

  /** Waits for the latest `alert.raised.v1` of a type and vessel in `ALERTS`. */
  async waitForAlert(
    type: string,
    mmsi: number,
    timeoutMs = 20_000,
  ): Promise<AlertRaisedV1> {
    return waitFor(
      async () => {
        const messages = await this.alertMessages(type, mmsi);
        return messages.findLast((message) => message.kind === 'raised')?.data;
      },
      { timeoutMs },
    );
  }

  /** Waits for the latest `alert.resolved.v1` of a type and vessel in `ALERTS`. */
  async waitForResolution(
    type: string,
    mmsi: number,
    timeoutMs = 20_000,
  ): Promise<AlertResolvedV1> {
    return waitFor(
      async () => {
        const messages = await this.alertMessages(type, mmsi);
        const found = messages.findLast(
          (message) => message.kind === 'resolved',
        );
        return found?.kind === 'resolved' ? found.data : undefined;
      },
      { timeoutMs },
    );
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

/** The `ais.position.recorded.v1` payload of a position (`previous`: the vessel's last one). */
export function positionPayload(
  input: PositionInput,
  previous?: PositionInput,
): ReturnType<typeof toPositionPayload> {
  return toPositionPayload({
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
  });
}

/**
 * Publishes envelopes through a NATS connection of its own, e.g. before any
 * application of a test runs.
 */
export async function publishWithoutApp(
  natsUrl: string,
  envelopes: readonly AnyEventEnvelope[],
): Promise<void> {
  const nats = new NatsClient(
    createTestConfig(configSchema, { NATS_URL: natsUrl }),
    {},
  );
  const { jetstream } = await nats.ready();
  try {
    // The streams exist once a service started; create them otherwise.
    await new StreamManager(nats).ensure(
      [
        ...new Set(
          envelopes.flatMap((envelope) => {
            const stream = streamForSubject(subjectForEvent(envelope));
            return stream === undefined ? [] : [stream.name];
          }),
        ),
      ],
      'producer',
    );
    for (const envelope of envelopes)
      await jetstream.publish(
        subjectForEvent(envelope),
        encodeEnvelope(envelope),
        { msgID: envelope.id },
      );
  } finally {
    await nats.onApplicationShutdown();
  }
}

/** Minutes before now. */
export function minutesAgo(minutes: number, now = Date.now()): Date {
  return new Date(now - minutes * 60_000);
}
