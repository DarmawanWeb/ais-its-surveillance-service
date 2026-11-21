import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  detectTranshipment,
  priorityCategory,
  weightedScore,
} from './analysis.js';
import {
  candidatePriorities,
  headingPriority,
  locationPriority,
  speedPriority,
} from './priority.js';
import { fixAtTime, sampleRoute, type TrackFix } from './track.js';

/**
 * Golden values computed once by running the legacy functions
 * (be-legacy/src/utils/illegal-transhipment.ts) on deterministic synthetic
 * inputs — see the fixture's `description` and README "Legacy parity".
 */
const Packed = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
const Distribution = z.object({
  low: z.number(),
  medium: z.number(),
  high: z.number(),
});
const Fixture = z.object({
  baseTime: z.iso.datetime(),
  speed: z.array(
    z.object({
      a: z.object({ sog: z.number() }),
      b: z.object({ sog: z.number() }),
      expected: z.number(),
    }),
  ),
  location: z.array(
    z.object({
      a: z.object({ lat: z.number(), lon: z.number() }),
      b: z.object({ lat: z.number(), lon: z.number() }),
      expected: z.number(),
      distanceInMeters: z.number(),
    }),
  ),
  heading: z.array(
    z.object({
      a: z.object({ hdg: z.number() }),
      b: z.object({ hdg: z.number() }),
      expected: z.number(),
    }),
  ),
  weights: z.array(
    z.object({
      priority: z.number(),
      weight: z.number(),
      category: z.enum(['low', 'medium', 'high']),
    }),
  ),
  possibility: z.object({
    current: z.object({
      lat: z.number(),
      lon: z.number(),
      sog: z.number(),
      hdg: z.number(),
    }),
    ships: z.array(
      z.object({
        mmsi: z.string(),
        fix: z
          .object({
            lat: z.number(),
            lon: z.number(),
            sog: z.number(),
            hdg: z.number(),
          })
          .nullable(),
      }),
    ),
    expected: z.array(z.object({ mmsi: z.string(), priority: z.number() })),
  }),
  interpolation: z.object({
    route: z.array(Packed),
    cases: z.array(
      z.object({
        targetOffsetMs: z.number(),
        expected: z
          .object({
            lat: z.number(),
            lon: z.number(),
            sog: z.number(),
            hdg: z.number(),
            cog: z.number(),
            time: z.iso.datetime(),
          })
          .nullable(),
      }),
    ),
  }),
  sampling: z.array(
    z.object({ route: z.array(Packed), expected: z.array(Packed) }),
  ),
  detection: z.array(
    z.object({
      name: z.string(),
      route1: z.array(Packed),
      route2: z.array(Packed),
      expected: z.object({
        isIllegal: z.boolean(),
        startTimestamp: z.iso.datetime().nullable(),
        endTimestamp: z.iso.datetime().nullable(),
        accuracy: z.number().nullable(),
        averagePriority: z.number().nullable(),
        priorityDistribution: Distribution.nullable(),
      }),
    }),
  ),
});

const fixture = Fixture.parse(
  JSON.parse(
    readFileSync(
      new URL('__fixtures__/legacy-golden.json', import.meta.url),
      'utf8',
    ),
  ),
);
const base = Date.parse(fixture.baseTime);

/** Unpacks `[offsetMs, lat, lon, sog, hdg]` (the harness set cog = hdg, 0 for 511). */
function unpack([offset, lat, lon, sog, hdg]: z.output<
  typeof Packed
>): TrackFix {
  return {
    time: new Date(base + offset),
    lat,
    lon,
    sog,
    hdg,
    cog: hdg === 511 ? 0 : hdg,
  };
}

describe('transhipment rules — golden parity with the legacy backend', () => {
  it.each(fixture.speed)(
    'speed priority $a.sog / $b.sog kn → $expected',
    ({ a, b, expected }) => {
      expect(speedPriority(a, b)).toBe(expected);
    },
  );

  it.each(fixture.location)(
    'location priority at $distanceInMeters m → $expected',
    ({ a, b, expected }) => {
      expect(locationPriority(a, b)).toBe(expected);
    },
  );

  it.each(fixture.heading)(
    'heading priority $a.hdg / $b.hdg → $expected',
    ({ a, b, expected }) => {
      expect(headingPriority(a, b)).toBe(expected);
    },
  );

  it.each(fixture.weights)(
    'weight and category of P = $priority',
    ({ priority, weight, category }) => {
      expect(weightedScore(priority)).toBe(weight);
      expect(priorityCategory(priority)).toBe(category);
    },
  );

  it('scores candidate vessels like checkIlegalTranshipmentPossibility', () => {
    const { current, ships, expected } = fixture.possibility;
    const result = candidatePriorities(
      current,
      ships.map((ship) => ({ mmsi: Number(ship.mmsi), fix: ship.fix })),
    );
    expect(result).toEqual(
      expected.map((entry) => ({
        mmsi: Number(entry.mmsi),
        priority: entry.priority,
      })),
    );
  });

  it.each(fixture.interpolation.cases)(
    'position at offset $targetOffsetMs ms',
    ({ targetOffsetMs, expected }) => {
      const route = fixture.interpolation.route.map(unpack);
      const fix = fixAtTime(route, new Date(base + targetOffsetMs));
      if (expected === null) {
        expect(fix).toBeNull();
        return;
      }
      expect(fix).toEqual({
        lat: expected.lat,
        lon: expected.lon,
        sog: expected.sog,
        hdg: expected.hdg,
        cog: expected.cog,
        time: new Date(expected.time),
      });
    },
  );

  it.each(fixture.sampling.map((entry, index) => ({ ...entry, index })))(
    'resamples route #$index',
    ({ route, expected }) => {
      const sampled = sampleRoute(route.map(unpack), 30, 3 * 60_000);
      expect(
        sampled.map((fix) => [
          fix.time.getTime() - base,
          fix.lat,
          fix.lon,
          fix.sog,
          fix.hdg,
        ]),
      ).toEqual(expected);
    },
  );

  it.each(fixture.detection)(
    'detection: $name',
    ({ route1, route2, expected }) => {
      const result = detectTranshipment(route1.map(unpack), route2.map(unpack));
      if (!expected.isIllegal) {
        expect(result).toEqual({ isIllegal: false });
        return;
      }
      expect(result).toEqual({
        isIllegal: true,
        startTimestamp: new Date(expected.startTimestamp ?? ''),
        endTimestamp: new Date(expected.endTimestamp ?? ''),
        accuracy: expected.accuracy,
        averagePriority: expected.averagePriority,
        priorityDistribution: expected.priorityDistribution,
      });
    },
  );

  it('covers both outcomes of the detection', () => {
    const illegal = fixture.detection.filter(
      (entry) => entry.expected.isIllegal,
    );
    expect(illegal.length).toBeGreaterThanOrEqual(10);
    expect(fixture.detection.length - illegal.length).toBeGreaterThanOrEqual(
      10,
    );
  });
});
