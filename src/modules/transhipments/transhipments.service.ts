import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import {
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import { eventVisibility } from '../../tenancy/event-visibility.js';
import {
  EVENTS_DEFAULT_RANGE_MS,
  EVENTS_MAX_RANGE_MS,
  EventCursorSchema,
} from '../events/events.service.js';
import {
  type StoredTranshipmentResult,
  TranshipmentResultsRepository,
} from './transhipment-results.repository.js';
import type {
  ListTranshipmentsQueryDto,
  TranshipmentResultView,
} from './transhipments.dto.js';

/** A stored positive analysis in the legacy result shape (plus the v2 fields). */
export function toTranshipmentResult(
  record: StoredTranshipmentResult,
): TranshipmentResultView {
  return {
    id: record.id,
    eventId: record.eventId,
    ship1MMSI: record.mmsiA,
    ship2MMSI: record.mmsiB,
    ship1Name: record.nameA,
    ship2Name: record.nameB,
    isIllegal: true,
    startTimestamp: record.startAt.toISOString(),
    endTimestamp: record.endAt.toISOString(),
    accuracy: record.accuracy,
    averagePriority: record.averagePriority,
    priorityDistribution: { ...record.priorityDistribution },
    detectedAt: record.detectedAt.toISOString(),
    severity: record.severity,
    status: record.status,
    lat: record.lat,
    lon: record.lon,
    methodId: record.methodId,
  };
}

/**
 * `GET /surveillance/transhipments`: every positive analysis (legacy
 * `GET /results`, which listed each stored `isIllegal` result), newest
 * window first; tenancy per spec §8.5 through either vessel of the pair.
 */
@Injectable()
export class TranshipmentsService {
  constructor(private readonly results: TranshipmentResultsRepository) {}

  async list(
    principal: Principal,
    query: ListTranshipmentsQueryDto,
  ): Promise<CursorPage<TranshipmentResultView>> {
    // One event's analyses: every window unless the query bounds it.
    const range =
      query.eventId !== undefined &&
      query.from === undefined &&
      query.to === undefined
        ? undefined
        : resolveQueryTimeRange(query, {
            defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
            maxDurationMs: EVENTS_MAX_RANGE_MS,
          });
    const rows = await this.results.list(
      {
        visibility: eventVisibility(principal),
        from: range?.from,
        to: range?.to,
        mmsi: query.mmsi,
        eventId: query.eventId,
      },
      decodeQueryCursor(query, EventCursorSchema),
      query.limit + 1,
    );
    return cursorPage(rows.map(toTranshipmentResult), query.limit, (row) => ({
      time: row.startTimestamp,
      id: row.id,
    }));
  }
}
