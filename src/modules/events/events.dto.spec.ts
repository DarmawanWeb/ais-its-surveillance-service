import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ListEventsQueryDto } from './events.dto.js';

/** The query as the validation pipe sees it, and the constraints that failed on `q`. */
async function parseQ(
  q: string,
): Promise<{ q: string | undefined; failed: string[] }> {
  const query = plainToInstance(ListEventsQueryDto, { q });
  const errors = await validate(query);
  return {
    q: query.q,
    failed: errors
      .filter((error) => error.property === 'q')
      .flatMap((error) => Object.keys(error.constraints ?? {})),
  };
}

describe('ListEventsQueryDto.q', () => {
  it('validates the trimmed search: a blank one is refused, never ignored', async () => {
    expect((await parseQ('  ')).failed).toContain('minLength');
    expect((await parseQ(' a ')).failed).toContain('minLength');
    expect((await parseQ('x')).failed).toContain('minLength');
  });

  it('searches for the trimmed value', async () => {
    expect(await parseQ('  bravo ')).toEqual({ q: 'bravo', failed: [] });
  });
});
