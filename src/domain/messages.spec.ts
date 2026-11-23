import { describe, expect, it } from 'vitest';

import {
  anomalyText,
  darkText,
  EVENT_MESSAGES,
  fishingText,
  geofenceText,
  isMessageType,
  renderMessage,
  RESOLUTION_CODES,
  RESOLUTION_REASONS,
  resolution,
  resolutionCodeOf,
  transhipmentText,
} from './messages.js';

const KEY = /^surveillance\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

describe('event messages', () => {
  it('uses stable dotted keys and placeholders that every builder fills', () => {
    const texts = [
      transhipmentText({
        mmsi: 525000001,
        relatedMmsi: 525000002,
        vesselName: 'KM Alpha',
        startTime: new Date('2026-05-01T00:00:00Z'),
        endTime: new Date('2026-05-01T00:45:00Z'),
        accuracy: 86.666_666,
        averagePriority: 19.84,
      }),
      anomalyText({
        mmsi: 525000003,
        navstatus: 1,
        navstatusLabel: 'at anchor',
        predictedNavstatus: 0,
        streak: 3,
        sogKn: 6.04,
      }),
      darkText({
        mmsi: 525000004,
        lastSeenAt: new Date('2026-05-01T00:00:00Z'),
        lastSogKn: 6,
        gapMin: 31.4,
      }),
      geofenceText({
        mmsi: 525000005,
        zoneName: 'Zona A',
        zoneKind: 'restricted',
        zoneCode: null,
        sogKn: 5,
      }),
      fishingText({
        mmsi: 525000006,
        zoneName: 'WPP 712',
        zoneKind: 'fishing_ground',
        zoneCode: 'WPP-712',
        durationMin: 33.2,
        meanSogKn: 2.46,
        courseChangeRateDegPerMin: 3.33,
        positions: 12,
      }),
    ];
    for (const text of texts) {
      expect(text.messageKey).toMatch(KEY);
      expect(`${text.title} ${text.message}`).not.toMatch(/\{[A-Za-z]+\}/);
      for (const value of Object.values(text.messageParams))
        expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    expect(texts[0]).toMatchObject({
      title: 'Suspected transhipment between 525000001 and 525000002',
      message:
        'Vessels 525000001 and 525000002 stayed together from 2026-05-01T00:00:00.000Z to ' +
        '2026-05-01T00:45:00.000Z (score 86.7 %, average priority 19.8)',
      messageParams: {
        vesselName: 'KM Alpha',
        // An unregistered vessel is named by its MMSI.
        relatedVesselName: '525000002',
        durationMin: 45,
      },
    });
    expect(texts[2]?.message).toBe(
      'Vessel 525000004 stopped reporting at 2026-05-01T00:00:00.000Z while under way at 6 kn (silent for 31 min)',
    );
    // A zone without a code has no `zoneCode` parameter (never null).
    expect(texts[3]?.messageParams).not.toHaveProperty('zoneCode');
    expect(texts[4]?.messageParams).toMatchObject({
      zoneCode: 'WPP-712',
      durationMin: 33,
      meanSogKn: 2.5,
    });
  });

  it('knows the five alert types of the service', () => {
    expect(Object.keys(EVENT_MESSAGES).sort()).toEqual([
      'anomaly',
      'dark',
      'fishing',
      'geofence',
      'transhipment',
    ]);
    expect(isMessageType('dark')).toBe(true);
    expect(isMessageType('collision')).toBe(false);
    expect(isMessageType('toString')).toBe(false);
  });

  it('keeps unknown placeholders and omits missing facts', () => {
    expect(renderMessage('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(darkText({ mmsi: 525000004 }).messageParams).toEqual({
      mmsi: 525000004,
      vesselName: '525000004',
    });
  });
});

describe('resolution codes', () => {
  it('resolves with the unchanged English reason and the code in the data', () => {
    expect(resolution('ais_resumed', { gapMin: 50 })).toEqual({
      reason: 'AIS reports resumed',
      data: { gapMin: 50, code: 'ais_resumed' },
    });
  });

  it('derives the code of rows written before codes existed', () => {
    for (const [code, reason] of Object.entries(RESOLUTION_REASONS))
      expect(resolutionCodeOf({ reason })).toBe(code);
    expect(resolutionCodeOf({ reason: 'legacy_import' })).toBe('legacy_import');
    expect(resolutionCodeOf({ reason: 'something else' })).toBe('other');
    expect(resolutionCodeOf({})).toBe('other');
    // A stored code wins over the reason.
    expect(
      resolutionCodeOf({ code: 'zone_deleted', reason: 'left the zone' }),
    ).toBe('zone_deleted');
    expect(resolutionCodeOf({ code: 'bogus', reason: 'left the zone' })).toBe(
      'left_zone',
    );
  });

  it('lists every code once, detector codes with a reason', () => {
    expect(new Set(RESOLUTION_CODES).size).toBe(RESOLUTION_CODES.length);
    expect(Object.keys(RESOLUTION_REASONS).sort()).toEqual(
      RESOLUTION_CODES.filter(
        (code) => code !== 'legacy_import' && code !== 'other',
      ).sort(),
    );
  });
});
