import { DETECTOR_ENV } from '@darmawanweb/ais-its-nest/analytics';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
  type TestTokenClaims,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';

/** The real application on the shared containers, with a test token issuer. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  /** `Authorization` header with a freshly signed access token. */
  authorization(claims?: TestTokenClaims): Promise<{ authorization: string }>;
}

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams and consumers start) without listening; use
 * `app.inject()` and close it with `app.close()`.
 */
export async function startTestService(
  env: Readonly<Record<string, string>> = {},
  /** `DETECTORS` and `<ID>_*` (never `process.env` in tests). */
  detectorEnv: Readonly<Record<string, string>> = {},
): Promise<TestService> {
  const infra = inject('infra');
  const jwt = await createTestJwtIssuer();
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: infra.natsUrl,
    // `TEST_LOG_LEVEL=debug pnpm test:int` shows the service logs (silent by default).
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    ...env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
      { provide: DETECTOR_ENV, useValue: detectorEnv },
    ],
  });
  return {
    app,
    config,
    jwt,
    authorization: async (claims) => ({
      authorization: `Bearer ${await jwt.sign(claims)}`,
    }),
  };
}
