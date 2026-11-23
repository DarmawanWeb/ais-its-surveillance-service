import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { StatsSeriesQueryDto } from './statistics.dto.js';
import type {
  SeriesCountRow,
  StatisticsRepository,
} from './statistics.repository.js';
import { assembleSeries, StatisticsService } from './statistics.service.js';

const at = (iso: string): Date => new Date(iso);

function row(
  bucketFrom: string,
  bucketTo: string,
  type: string | null = null,
  severity: string | null = null,
  count = 0,
): SeriesCountRow {
  return {
    bucketFrom: at(bucketFrom),
    bucketTo: at(bucketTo),
    type,
    severity,
    count,
  };
}

describe('assembleSeries', () => {
  it('clips the first and last bucket to the range and keeps empty buckets', () => {
    const buckets = assembleSeries(
      [
        row(
          '2026-05-01T00:00:00Z',
          '2026-05-02T00:00:00Z',
          'dark',
          'warning',
          2,
        ),
        row(
          '2026-05-01T00:00:00Z',
          '2026-05-02T00:00:00Z',
          'transhipment',
          'critical',
          1,
        ),
        row('2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z'),
        row(
          '2026-05-03T00:00:00Z',
          '2026-05-04T00:00:00Z',
          'dark',
          'warning',
          1,
        ),
      ],
      at('2026-05-01T06:00:00Z'),
      at('2026-05-03T12:00:00Z'),
    );
    expect(buckets).toEqual([
      {
        from: at('2026-05-01T06:00:00Z'),
        to: at('2026-05-02T00:00:00Z'),
        total: 3,
        byType: { dark: 2, transhipment: 1 },
        bySeverity: { warning: 2, critical: 1 },
      },
      {
        from: at('2026-05-02T00:00:00Z'),
        to: at('2026-05-03T00:00:00Z'),
        total: 0,
        byType: {},
        bySeverity: {},
      },
      {
        from: at('2026-05-03T00:00:00Z'),
        to: at('2026-05-03T12:00:00Z'),
        total: 1,
        byType: { dark: 1 },
        bySeverity: { warning: 1 },
      },
    ]);
  });

  it('folds a bucket that starts exactly at the range end into the one before (inclusive end)', () => {
    const buckets = assembleSeries(
      [
        row('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'),
        row(
          '2026-05-02T00:00:00Z',
          '2026-05-03T00:00:00Z',
          'dark',
          'warning',
          1,
        ),
      ],
      at('2026-05-01T00:00:00Z'),
      at('2026-05-02T00:00:00Z'),
    );
    expect(buckets).toEqual([
      {
        from: at('2026-05-01T00:00:00Z'),
        to: at('2026-05-02T00:00:00Z'),
        total: 1,
        byType: { dark: 1 },
        bySeverity: { warning: 1 },
      },
    ]);
  });
});

describe('StatisticsService.series time zone', () => {
  /** The service over a repository that knows `Asia/Jakarta` only. */
  function setup() {
    const queried: string[] = [];
    const repository: Pick<
      StatisticsRepository,
      'timeZoneName' | 'eventSeries'
    > = {
      timeZoneName: (name) =>
        Promise.resolve(
          name.toLowerCase() === 'asia/jakarta' ? 'Asia/Jakarta' : undefined,
        ),
      eventSeries: (_filters, _bucket, timeZone) => {
        queried.push(timeZone);
        return Promise.resolve([]);
      },
    };
    const service = new StatisticsService(repository as StatisticsRepository);
    const principal = {
      kind: 'user',
      hasAuthorityAccess: true,
      orgId: null,
    } as unknown as Principal;
    const series = (tz: string) =>
      service.series(principal, plainToInstance(StatsSeriesQueryDto, { tz }));
    return { series, queried };
  }

  it('refuses a zone the database does not know with 400 on tz, before querying', async () => {
    const { series, queried } = setup();
    // ICU still knows this alias; the database's tzdata dropped it.
    const error: unknown = await series('US/Pacific-New').catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).errors).toEqual([
      expect.objectContaining({ field: 'tz', code: 'isTimeZone' }),
    ]);
    expect(queried).toEqual([]);
  });

  it('queries and echoes the database spelling of the zone', async () => {
    const { series, queried } = setup();
    const body = await series('asia/jakarta');
    expect(queried).toEqual(['Asia/Jakarta']);
    expect(body.timeZone).toBe('Asia/Jakarta');
  });
});
