import { describe, expect, it } from 'vitest';

import { eventDataOf, eventResolutionOf } from './event-text.js';
import type { EventRecord } from './events.repository.js';

function record(overrides: Partial<EventRecord>): EventRecord {
  const time = new Date('2026-05-01T00:00:00Z');
  return {
    id: '0190d6b4-0000-7000-8000-000000000001',
    time,
    detector: 'transhipment',
    type: 'transhipment',
    domain: 'surveillance',
    severity: 'warning',
    currentSeverity: 'warning',
    mmsi: 525000001,
    relatedMmsi: 525000002,
    vesselName: 'KM Alpha',
    relatedVesselName: null,
    zoneId: null,
    zoneName: null,
    lat: null,
    lon: null,
    title: 'title',
    message: 'message',
    methodId: 'transhipment.accuracy',
    dedupKey: 'transhipment:525000001:525000002',
    data: {},
    status: 'resolved',
    openedAt: time,
    lastSeenAt: time,
    resolvedAt: time,
    resolution: null,
    reviewedBy: null,
    reviewedAt: null,
    note: null,
    createdAt: time,
    ...overrides,
  };
}

describe('event text on read', () => {
  it('derives the message of a legacy transhipment import from its row', () => {
    const data = eventDataOf(
      record({
        data: {
          isIllegal: true,
          accuracy: 87.36,
          averagePriority: 19.8,
          startTimestamp: '2026-05-01T00:00:00.000Z',
          endTimestamp: '2026-05-01T00:30:00.000Z',
          legacy: true,
        },
        resolution: { reason: 'legacy_import' },
      }),
    );
    expect(data).toMatchObject({
      legacy: true,
      messageKey: 'surveillance.transhipment.suspected',
      messageParams: {
        mmsi: 525000001,
        relatedMmsi: 525000002,
        vesselName: 'KM Alpha',
        relatedVesselName: '525000002',
        accuracy: 87.4,
        durationMin: 30,
      },
    });
  });

  it('keeps a stored message and leaves unknown types alone', () => {
    const stored = {
      messageKey: 'surveillance.dark.ais_gap',
      messageParams: { mmsi: 1 },
    };
    expect(eventDataOf(record({ type: 'dark', data: stored }))).toBe(stored);
    expect(eventDataOf(record({ type: 'spoofing', data: { a: 1 } }))).toEqual({
      a: 1,
    });
  });

  it('adds the resolution code of rows without one', () => {
    expect(
      eventResolutionOf(record({ resolution: { reason: 'legacy_import' } })),
    ).toEqual({ reason: 'legacy_import', code: 'legacy_import' });
    expect(
      eventResolutionOf(
        record({ resolution: { reason: 'escalated', supersededBy: 'x' } }),
      ),
    ).toEqual({ reason: 'escalated', supersededBy: 'x', code: 'escalated' });
    expect(eventResolutionOf(record({ resolution: null }))).toBeNull();
  });
});
