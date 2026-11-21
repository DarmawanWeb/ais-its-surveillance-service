import {
  type AppConfig,
  defineConfig,
  envInteger,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import { SERVICE } from './service.js';

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables. Add a variable here and to
 * `.env.example`; `loadConfig()` refuses to start on invalid values and prints
 * every problem. The detectors' variables (`DETECTORS`, `TRANSHIPMENT_*`,
 * `ANOMALY_*`, `DARK_*`, `GEOFENCE_*`, `FISHING_*`) are validated by the
 * Detector SDK with each detector's `configSchema`.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),
  /** Positions handled in parallel by the detector runner (one vessel stays ordered). */
  DETECTOR_CONCURRENCY: envInteger(1, 64).default(8),
  /** Minimum time between two publications of one alert key (SDK cooldown), minutes. */
  ALERT_COOLDOWN_MIN: envInteger(0, 1_440).default(10),
  /**
   * Minimum event-time interval between two `vessel_state` writes of a vessel,
   * seconds (transhipment candidates are written on every position).
   */
  VESSEL_STATE_WRITE_INTERVAL_S: envInteger(0, 3_600).default(60),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;
