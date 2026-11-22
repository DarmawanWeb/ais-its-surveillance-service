import { describe, expect, it } from 'vitest';

import {
  isAnomalousPosition,
  isSustainedAnomaly,
  nextAnomalyStreak,
} from './anomaly.js';
import { darkReferenceTime, isDarkVessel, minutesBetween } from './dark.js';
import {
  courseChangeDeg,
  evaluateLoitering,
  extendRun,
  fishingSeverity,
  isInFishingBand,
  type LoiteringFix,
  type LoiteringThresholds,
} from './fishing.js';
import {
  geofenceSeverity,
  geofenceTransition,
  isWatchedZone,
} from './geofence.js';
import { transhipmentSeverity } from './transhipment/analysis.js';
import {
  candidateObservations,
  mergeNeighbours,
  midpoint,
  pairOf,
  transhipmentKey,
} from './transhipment/pairs.js';

const T0 = new Date('2026-05-01T00:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe('anomaly.navstatus_mismatch', () => {
  it.each([
    [1, 0, true],
    [0, 0, false],
    [5, 0, false],
    [1, 1, false],
    [0, 1, true],
    [5, 1, true],
    [15, 1, true],
  ] as const)(
    'navstatus %i with prediction %i → %s',
    (navstatus, predicted, expected) => {
      expect(isAnomalousPosition(navstatus, predicted)).toBe(expected);
    },
  );

  it('ignores excluded reported codes', () => {
    expect(isAnomalousPosition(15, 1, [15])).toBe(false);
  });

  it('counts consecutive anomalies and resets on a consistent position', () => {
    let streak = 0;
    for (const anomalous of [true, true, false, true, true, true]) {
      streak = nextAnomalyStreak(streak, anomalous, 3);
    }
    expect(streak).toBe(3);
    expect(isSustainedAnomaly(streak, 3)).toBe(true);
    expect(isSustainedAnomaly(2, 3)).toBe(false);
  });

  it('caps the streak once the anomaly is sustained (no change, no write)', () => {
    let streak = 0;
    const seen: number[] = [];
    for (let position = 0; position < 6; position++) {
      streak = nextAnomalyStreak(streak, true, 3);
      seen.push(streak);
    }
    expect(seen).toEqual([1, 2, 3, 3, 3, 3]);
    expect(nextAnomalyStreak(3, false, 3)).toBe(0);
  });
});

describe('dark.ais_gap', () => {
  const thresholds = {
    gapMs: 30 * 60_000,
    minSogKn: 1,
    harbourDistanceM: 5_000,
  };

  it('uses the event-time watermark, bounded by the wall clock', () => {
    expect(darkReferenceTime(at(10), undefined)).toBeNull();
    expect(darkReferenceTime(at(10), at(5))).toEqual(at(5));
    expect(darkReferenceTime(at(10), at(15))).toEqual(at(10));
  });

  it('flags a moving vessel silent for longer than the gap away from harbours', () => {
    expect(
      isDarkVessel({ time: at(0), sog: 5 }, null, at(31), thresholds),
    ).toBe(true);
    expect(
      isDarkVessel({ time: at(0), sog: 5 }, 8_000, at(31), thresholds),
    ).toBe(true);
  });

  it.each([
    ['not silent long enough', { time: at(0), sog: 5 }, null, at(30)],
    ['too slow', { time: at(0), sog: 1 }, null, at(60)],
    ['near a harbour', { time: at(0), sog: 5 }, 4_999, at(60)],
  ] as const)('ignores a vessel %s', (_label, last, distance, reference) => {
    expect(isDarkVessel(last, distance, reference, thresholds)).toBe(false);
  });

  it('measures gaps in minutes', () => {
    expect(minutesBetween(at(0), at(42.5))).toBeCloseTo(42.5);
  });
});

describe('geo.geofence_enter', () => {
  it('watches active alert-on-enter zones of the configured kinds', () => {
    const zone = {
      kind: 'restricted',
      active: true,
      alertOnEnter: true,
    } as const;
    expect(isWatchedZone(zone, ['restricted', 'mpa'])).toBe(true);
    expect(
      isWatchedZone({ ...zone, alertOnEnter: false }, ['restricted']),
    ).toBe(false);
    expect(isWatchedZone({ ...zone, active: false }, ['restricted'])).toBe(
      false,
    );
    expect(isWatchedZone(zone, ['mpa'])).toBe(false);
  });

  it('derives transitions and severities', () => {
    expect(geofenceTransition(false, true)).toBe('entered');
    expect(geofenceTransition(true, false)).toBe('left');
    expect(geofenceTransition(true, true)).toBe('unchanged');
    expect(geofenceSeverity('restricted', ['restricted'])).toBe('critical');
    expect(geofenceSeverity('mpa', ['restricted'])).toBe('warning');
  });
});

describe('fishing.loitering', () => {
  const thresholds: LoiteringThresholds = {
    minSogKn: 0.5,
    maxSogKn: 4,
    minDurationMs: 30 * 60_000,
    maxGapMs: 10 * 60_000,
    minPositions: 6,
    sampleIntervalMs: 3 * 60_000,
    minCourseChangeDegPerMin: 3,
  };
  const zigzag = (minutes: number, step: number): LoiteringFix[] =>
    Array.from({ length: Math.floor(minutes / step) + 1 }, (_, index) => ({
      time: at(index * step),
      sog: 2.5,
      cog: index % 2 === 0 ? 40 : 160,
    }));

  it('keeps the speed band inclusive', () => {
    expect(isInFishingBand(0.5, thresholds)).toBe(true);
    expect(isInFishingBand(4, thresholds)).toBe(true);
    expect(isInFishingBand(4.1, thresholds)).toBe(false);
    expect(isInFishingBand(0.4, thresholds)).toBe(false);
  });

  it('wraps course changes and ignores unavailable courses', () => {
    expect(courseChangeDeg(350, 10)).toBe(20);
    expect(courseChangeDeg(10, 190)).toBe(180);
    expect(courseChangeDeg(360, 10)).toBeNull();
  });

  it('detects a zigzag of 30 minutes and more', () => {
    const evaluation = evaluateLoitering(zigzag(36, 3), thresholds);
    expect(evaluation).toMatchObject({ loitering: true, positions: 13 });
    expect(evaluation.courseChangeRateDegPerMin).toBeCloseTo(40);
  });

  it('rejects straight tracks and short patterns', () => {
    const straight = zigzag(60, 3).map((fix) => ({ ...fix, cog: 90 }));
    expect(evaluateLoitering(straight, thresholds).loitering).toBe(false);
    expect(evaluateLoitering(zigzag(27, 3), thresholds).loitering).toBe(false);
    expect(evaluateLoitering([], thresholds).loitering).toBe(false);
  });

  it('does not sum course jitter between fixes closer than the sample interval', () => {
    const jitter = Array.from({ length: 181 }, (_, index) => ({
      time: new Date(T0.getTime() + index * 10_000),
      sog: 3,
      cog: index % 2 === 0 ? 88 : 92,
    }));
    expect(evaluateLoitering(jitter, thresholds).loitering).toBe(false);
  });

  it('restarts the run on a gap or a non-qualifying fix', () => {
    const run = extendRun(
      [],
      { time: at(0), sog: 2, cog: 0 },
      true,
      thresholds,
    );
    expect(
      extendRun(run, { time: at(5), sog: 2, cog: 0 }, true, thresholds),
    ).toHaveLength(2);
    expect(
      extendRun(run, { time: at(11), sog: 2, cog: 0 }, true, thresholds),
    ).toHaveLength(1);
    expect(
      extendRun(run, { time: at(5), sog: 9, cog: 0 }, false, thresholds),
    ).toEqual([]);
  });

  it('maps severities by zone kind', () => {
    expect(fishingSeverity('restricted', ['restricted'])).toBe('critical');
    expect(fishingSeverity('fishing_ground', ['restricted'])).toBe('warning');
  });
});

describe('transhipment.candidate_queue', () => {
  const fix = (mmsi: number, lat: number, minutes = 0) => ({
    mmsi,
    time: at(minutes),
    lat,
    lon: 104,
    sog: 0.3,
    hdg: 45,
  });

  it('keys pairs by sorted MMSI', () => {
    expect(pairOf(525000002, 525000001)).toEqual([525000001, 525000002]);
    expect(transhipmentKey(525000002, 525000001)).toBe(
      'transhipment:525000001:525000002',
    );
  });

  it('scores neighbours and keeps positive pairs', () => {
    const current = fix(525000009, 1);
    const observations = candidateObservations(current, [
      { fix: fix(525000001, 1.0001), distanceM: 11 },
      { fix: fix(525000002, 1.01), distanceM: 1_111 },
    ]);
    expect(observations).toEqual([
      {
        mmsiA: 525000001,
        mmsiB: 525000009,
        observer: 525000009,
        priority: 27,
        distanceM: 11,
        seenAt: at(0),
      },
    ]);
  });

  it('merges memory and stored neighbours, newest fix first', () => {
    const merged = mergeNeighbours(
      525000009,
      [{ fix: fix(525000001, 1.0001, 1), distanceM: 11 }],
      [
        { fix: fix(525000001, 1.0002, 0), distanceM: 22 },
        { fix: fix(525000003, 1.0003, 0), distanceM: 33 },
        { fix: fix(525000009, 1, 0), distanceM: 0 },
      ],
    );
    expect(
      merged.map((neighbour) => [neighbour.fix.mmsi, neighbour.distanceM]),
    ).toEqual([
      [525000001, 11],
      [525000003, 33],
    ]);
  });

  it('places events at the midpoint and grades them by score', () => {
    expect(midpoint({ lat: 1, lon: 104 }, { lat: 1.2, lon: 104.2 })).toEqual({
      lat: 1.1,
      lon: 104.1,
    });
    expect(transhipmentSeverity(93, 90)).toBe('critical');
    expect(transhipmentSeverity(76.2, 90)).toBe('warning');
  });
});
