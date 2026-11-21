import pg from 'pg';

/**
 * A `timestamptz` value of a raw `db.execute()` row. Drizzle's node-postgres
 * driver turns pg's date parsing off for every query (it maps its own column
 * types), so raw SQL rows carry PostgreSQL's text form
 * (`2026-11-21 19:30:43.755+00`) instead of a `Date`; rows of the drizzle
 * query builder and of the bare `pg` pool are already `Date`s.
 */
export type RawTimestamp = Date | string;

/** pg's own `timestamptz` text parser (the global type registry is untouched by drizzle). */
const parseTimestamptz = pg.types.getTypeParser(
  pg.types.builtins.TIMESTAMPTZ,
  'text',
) as (value: string) => Date;

/**
 * Converts a raw `timestamptz` value to a `Date` with pg's parser (exact for
 * PostgreSQL's output, microseconds truncated to milliseconds).
 *
 * @throws RangeError when the value is not a valid timestamp
 */
export function rowDate(value: RawTimestamp): Date {
  const date = value instanceof Date ? value : parseTimestamptz(value);
  if (Number.isNaN(date.getTime()))
    throw new RangeError(`Invalid timestamptz value: ${String(value)}`);
  return date;
}

/** {@link rowDate} for nullable columns. */
export function rowDateOrNull(value: RawTimestamp | null): Date | null {
  return value === null ? null : rowDate(value);
}
