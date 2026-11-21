import {
  AisSourceSchema,
  ZoneKindSchema,
} from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

/**
 * Value of an optional list meaning "no entries": the Detector SDK drops
 * blank variables (their default applies), so an empty list is spelled `none`.
 */
export const EMPTY_LIST = 'none';

/** Splits a comma separated variable into trimmed, non-empty entries (`none` = no entries). */
function splitList(value: string): string[] {
  if (value.trim().toLowerCase() === EMPTY_LIST) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** A comma separated list of zone kinds (at least one). */
export function zoneKindList(defaults: string) {
  return z
    .string()
    .default(defaults)
    .transform(splitList)
    .pipe(z.array(ZoneKindSchema).min(1));
}

/** A comma separated list of zone kinds, possibly empty (`none`). */
export function optionalZoneKindList(defaults: string) {
  return z
    .string()
    .default(defaults)
    .transform(splitList)
    .pipe(z.array(ZoneKindSchema));
}

/** A comma separated list of AIS sources, possibly empty (`none`). */
export function aisSourceList(defaults: string) {
  return z
    .string()
    .default(defaults)
    .transform(splitList)
    .pipe(z.array(AisSourceSchema));
}

/** A comma separated list of AIS navigational status codes (0–15), possibly empty (`none`). */
export function navStatusList(defaults: string) {
  return z
    .string()
    .default(defaults)
    .transform((value) => splitList(value).map(Number))
    .pipe(z.array(z.number().int().min(0).max(15)));
}

/** A positive number read from the environment. */
export function positiveNumber(defaults: number) {
  return z.coerce.number().positive().default(defaults);
}

/** A positive integer within bounds read from the environment. */
export function boundedInteger(defaults: number, min: number, max: number) {
  return z.coerce.number().int().min(min).max(max).default(defaults);
}
