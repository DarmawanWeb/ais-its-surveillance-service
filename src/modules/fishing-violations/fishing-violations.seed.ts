import { readFile } from 'node:fs/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { type Database, pointGeography } from '@darmawanweb/ais-its-nest/db';
import { sql } from 'drizzle-orm';
import * as z from 'zod';

import * as schema from '../../db/schema.js';

/** Dataset id of the legacy apprehension records (the seed's idempotency key with the record number). */
export const LEGACY_FISHING_DATASET = 'legacy-ilegal-json-2015-2017';

/** Methodology id of the dataset (spec §17). */
export const LEGACY_FISHING_METHOD_ID = 'fishing.apprehensions_2015_2017';

/** File of the dataset, next to `src/` and `dist/`. */
export const LEGACY_FISHING_FILE = new URL(
  '../../../seeds/fishing-violations-2015-2017.json',
  import.meta.url,
);

/** Provenance stored with every record. */
export const LEGACY_FISHING_SOURCE =
  'Legacy MVP web app, apps/web/src/data/ilegal.json (ais-its-web, mvp-final)';

/** Provenance note stored with every record (methodology §14.2). */
export const LEGACY_FISHING_SOURCE_NOTE =
  'Apprehension points of illegal-fishing vessels 2015-2017 (2015: 108, 2016: 163, 2017: 132) bundled ' +
  'with the legacy web app. Exact provenance, licence and redistribution permission are unverified ' +
  '(candidate origin: KKP Ditjen PSDKP performance report 2017, Table 3.4) — needs citation from the ' +
  'thesis. Positions are apprehension points, not fishing locations.';

/** One record of `ilegal.json`. */
export const LegacyViolationSchema = z.object({
  name: z.string().min(1),
  country: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  violation: z.string(),
  action: z.string(),
  year: z.string().regex(/^\d{4}$/),
});

/** A validated legacy record. */
export type LegacyViolation = z.output<typeof LegacyViolationSchema>;

/** Reads and validates the legacy dataset (every problem is reported). */
export async function readLegacyViolations(
  file: URL = LEGACY_FISHING_FILE,
): Promise<LegacyViolation[]> {
  const json: unknown = JSON.parse(await readFile(file, 'utf8'));
  return z.array(LegacyViolationSchema).parse(json);
}

/** Outcome of {@link seedFishingViolations}. */
export interface SeedReport {
  readonly inserted: number;
  readonly updated: number;
  readonly total: number;
}

const BATCH_SIZE = 100;

/**
 * Upserts the legacy records into `fishing_violations`, keyed by dataset and
 * record number (position in the file): running it again updates the rows
 * in place and keeps their ids, so the seed is idempotent.
 *
 * @method fishing.apprehensions_2015_2017
 * @see ../../../../../docs/METHODOLOGY.md#fishing.apprehensions_2015_2017
 * @see https://ppid.kkp.go.id/media/uploads/document_information_public/Laporan_Kinerja_DJPSDKP_2017.pdf (candidate origin)
 */
export async function seedFishingViolations(
  db: Database<typeof schema>,
  records: readonly LegacyViolation[],
): Promise<SeedReport> {
  // SOURCE: thesis — needs citation (dataset provenance unverified).
  let inserted = 0;
  let updated = 0;
  for (let start = 0; start < records.length; start += BATCH_SIZE) {
    const rows = records
      .slice(start, start + BATCH_SIZE)
      .map((record, offset) => ({
        id: newId(),
        dataset: LEGACY_FISHING_DATASET,
        recordNo: start + offset,
        vesselName: record.name.trim(),
        flagCountry: record.country.trim(),
        year: Number(record.year),
        violation: record.violation.trim(),
        action: record.action.trim(),
        geom: pointGeography(record.lng, record.lat),
        source: LEGACY_FISHING_SOURCE,
        sourceNote: LEGACY_FISHING_SOURCE_NOTE,
        methodId: LEGACY_FISHING_METHOD_ID,
      }));
    const result = await db
      .insert(schema.fishingViolations)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          schema.fishingViolations.dataset,
          schema.fishingViolations.recordNo,
        ],
        set: {
          vesselName: sql`excluded.vessel_name`,
          flagCountry: sql`excluded.flag_country`,
          year: sql`excluded.year`,
          violation: sql`excluded.violation`,
          action: sql`excluded.action`,
          geom: sql`excluded.geom`,
          source: sql`excluded.source`,
          sourceNote: sql`excluded.source_note`,
          methodId: sql`excluded.method_id`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const row of result) {
      if (row.inserted) inserted += 1;
      else updated += 1;
    }
  }
  return { inserted, updated, total: records.length };
}
