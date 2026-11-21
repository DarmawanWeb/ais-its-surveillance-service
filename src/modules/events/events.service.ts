import { NotFoundError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  bboxOf,
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import { eventVisibility } from '../../tenancy/event-visibility.js';
import type {
  ListEventsQueryDto,
  ReviewEventDto,
  SurveillanceEventView,
} from './events.dto.js';
import { type EventRecord, EventsRepository } from './events.repository.js';

/** Default time range of event lists: the last 30 days. */
export const EVENTS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60_000;
/** Longest time range of event queries: one year. */
export const EVENTS_MAX_RANGE_MS = 366 * 24 * 60 * 60_000;

/** Cursor position of the event lists. */
export const EventCursorSchema = z.object({
  time: z.iso.datetime(),
  id: z.uuid(),
});

/** `404 SURVEILLANCE_EVENT_NOT_FOUND`: unknown, or not visible to the principal. */
export class SurveillanceEventNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`No surveillance event ${id}`, {
      code: 'SURVEILLANCE_EVENT_NOT_FOUND',
      title: 'Surveillance event not found',
      extra: { id },
    });
  }
}

/** API form of an event record. */
export function toEventDto(record: EventRecord): SurveillanceEventView {
  return {
    ...record,
    time: record.time.toISOString(),
    openedAt: record.openedAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Listing, reading and reviewing surveillance events (tenancy per spec §8.5). */
@Injectable()
export class EventsService {
  constructor(
    private readonly events: EventsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(
    principal: Principal,
    query: ListEventsQueryDto,
  ): Promise<CursorPage<SurveillanceEventView>> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: EVENTS_DEFAULT_RANGE_MS,
      maxDurationMs: EVENTS_MAX_RANGE_MS,
    });
    const rows = await this.events.list(
      {
        visibility: eventVisibility(principal),
        from,
        to,
        types: query.type === undefined ? undefined : [query.type],
        severity: query.severity,
        status: query.status,
        mmsi: query.mmsi,
        bbox: bboxOf(query),
      },
      decodeQueryCursor(query, EventCursorSchema),
      query.limit + 1,
    );
    return cursorPage(rows.map(toEventDto), query.limit, (row) => ({
      time: row.time,
      id: row.id,
    }));
  }

  async get(principal: Principal, id: string): Promise<SurveillanceEventView> {
    const record = await this.events.findById(id, eventVisibility(principal));
    if (record === undefined) throw new SurveillanceEventNotFoundError(id);
    return toEventDto(record);
  }

  /** Stores a reviewer's verdict and records `surveillance_event.review` in the audit log. */
  async review(
    principal: Principal,
    id: string,
    body: ReviewEventDto,
    request?: AuditRequest,
  ): Promise<SurveillanceEventView> {
    const visibility = eventVisibility(principal);
    const before = await this.events.findById(id, visibility);
    if (before === undefined) throw new SurveillanceEventNotFoundError(id);
    await this.events.review(id, {
      status: body.status,
      note: body.note ?? null,
      reviewedBy: principal.id,
      reviewedAt: new Date(),
    });
    const after = await this.events.findById(id, visibility);
    if (after === undefined) throw new SurveillanceEventNotFoundError(id);
    await this.audit.record(
      {
        action: 'surveillance_event.review',
        targetType: 'surveillance_event',
        targetId: id,
        meta: {
          type: after.type,
          mmsi: after.mmsi,
          from: before.status,
          to: after.status,
        },
      },
      principal,
      request,
    );
    return toEventDto(after);
  }
}
