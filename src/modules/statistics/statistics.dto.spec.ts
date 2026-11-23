import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { StatsSeriesQueryDto } from './statistics.dto.js';

/** The constraints that failed on `tz`, or `[]`. */
async function tzErrors(tz: string): Promise<string[]> {
  const errors = await validate(plainToInstance(StatsSeriesQueryDto, { tz }));
  return errors
    .filter((error) => error.property === 'tz')
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('StatsSeriesQueryDto.tz', () => {
  it('accepts IANA zone names in any case', async () => {
    for (const tz of [
      'UTC',
      'Asia/Jakarta',
      'asia/jakarta',
      'Etc/GMT-7',
      'America/Argentina/Buenos_Aires',
      'America/Port-au-Prince',
    ])
      expect(await tzErrors(tz), tz).toEqual([]);
  });

  it('refuses UTC offsets, which PostgreSQL reads with the opposite sign', async () => {
    for (const tz of ['+07:00', '-03:00', '+0700', '07:00'])
      expect(await tzErrors(tz), tz).toContain('matches');
  });

  it('refuses unknown names', async () => {
    expect(await tzErrors('Mars/Base')).toContain('isTimeZone');
  });
});
