import {
  createLogger,
  loadConfig,
  loggerSettingsFromConfig,
} from '@darmawanweb/ais-its-nest';
import {
  createDatabasePool,
  databasePoolSettings,
} from '@darmawanweb/ais-its-nest/db';
import { drizzle } from 'drizzle-orm/node-postgres';

import { configSchema } from './config.js';
import * as schema from './db/schema.js';
import {
  readLegacyViolations,
  seedFishingViolations,
} from './modules/fishing-violations/fishing-violations.seed.js';

// `pnpm seed`: idempotent reference data — the historical fishing violations
// of the legacy web app (seeds/fishing-violations-2015-2017.json). Run
// `pnpm migrate` (or start the service) first.
const config = loadConfig(configSchema);
const logger = createLogger({
  ...loggerSettingsFromConfig(config),
  service: `${config.SERVICE_NAME}-seed`,
});
const pool = createDatabasePool(databasePoolSettings(config), (error) => {
  logger.error({ err: error }, 'Idle database connection failed');
});
try {
  const records = await readLegacyViolations();
  const report = await seedFishingViolations(
    drizzle(pool, { schema }),
    records,
  );
  logger.info(report, 'Seeded fishing_violations');
} catch (error) {
  logger.error({ err: error }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
