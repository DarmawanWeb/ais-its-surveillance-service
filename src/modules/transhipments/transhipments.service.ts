import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import {
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import { TRANSHIPMENT_ALERT } from '../../detectors/transhipment/transhipment.detector.js';
import { eventVisibility } from '../../tenancy/event-visibility.js';
import {
  type EventRecord,
  EventsRepository,
} from '../events/events.repository.js';
import {
  EVENTS_DEFAULT_RANGE_MS,
  EVENTS_MAX_RANGE_MS,
  EventCursorSchema,
} from '../events/events.service.js';
import type {
  ListTranshipmentsQueryDto,
  TranshipmentResultView,
} from './transhipments.dto.js';

/** The detection data stored with a transhipment event. */
const TranshipmentDataSchema = z.object({
  startTimestamp: z.iso.datetime(),
  endTimestamp: z.iso.datetime(),
  accuracy: z.number(),
  averagePriority: z.number(),
  priorityDistribution: z.object({
    low: z.number(),
    medium: z.number(),
    high: z.number(),
  }),
});

/**
 * Maps a transhipment event to the legacy result shape; `undefined` for a
 * row whose data does not carry a detection (never written by this service).
 */
export function toTranshipmentResult(
  record: EventRecord,
  detectedAt: Date,
): TranshipmentResultView | undefined {
  const parsed = TranshipmentDataSchema.safeParse(record.data);
  if (!parsed.success || record.relatedMmsi === null) return undefined;
  const detection = parsed.data;
  return {
    id: record.id,
    ship1MMSI: record.mmsi,
    ship2MMSI: record.relatedMmsi,
    ship1Name: record.vesselName,
    ship2Name: record.relatedVesselName,
    isIllegal: true,
    startTimestamp: detection.startTimestamp,
    endTimestamp: detection.endTimestamp,
    accuracy: detection.accuracy,
    averagePriority: detection.averagePriority,
    priorityDistribution: detection.priorityDistribution,
    detectedAt: detectedAt.toISOString(),
    severity: record.severity,
    status: record.status,
    lat: record.lat,
    lon: record.lon,
    methodId: record.methodId,
  };
}

/** `GET /surveillance/transhipments`: transhipment events in the legacy result shape. */
@Injectable()
export class TranshipmentsService {
  constructor(private readonly events: EventsRepository) {}

  async list(
    principal: Principal,
    query: ListTranshipmentsQueryDto,
  ): Promise<CursorPage<TranshipmentResultView>> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
      maxDurationMs: EVENTS_MAX_RANGE_MS,
    });
    const rows = await this.events.list(
      {
        visibility: eventVisibility(principal),
        from,
        to,
        types: [TRANSHIPMENT_ALERT],
        mmsi: query.mmsi,
      },
      decodeQueryCursor(query, EventCursorSchema),
      query.limit + 1,
    );
    const page = cursorPage(rows, query.limit, (row) => ({
      time: row.time.toISOString(),
      id: row.id,
    }));
    return {
      data: page.data.flatMap((row) => {
        const result = toTranshipmentResult(row, row.createdAt);
        return result === undefined ? [] : [result];
      }),
      page: page.page,
    };
  }
}
