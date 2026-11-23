import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { ConsumersModule } from './consumers/consumers.module.js';
import * as schema from './db/schema.js';
import { DetectorsModule } from './detectors/detectors.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { FishingViolationsModule } from './modules/fishing-violations/fishing-violations.module.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { StatisticsModule } from './modules/statistics/statistics.module.js';
import { TranshipmentsModule } from './modules/transhipments/transhipments.module.js';
import { MIGRATIONS_DIR } from './service.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot
    // from this package's migrations/ (not the working directory).
    DatabaseModule.forRoot({ schema, migrationsDir: MIGRATIONS_DIR }),
    // Streams this service PRODUCES to (created / widened at boot): alerts and
    // audit records. Consumers only create a missing stream they read.
    NatsModule.forRoot({ streams: ['ALERTS', 'AUDIT'] }),
    // Global default-deny guard: every route needs a principal unless @Public().
    AuthModule.forRoot(),
    AuditModule,
    MethodologyModule,
    DetectorsModule,
    ConsumersModule,
    EventsModule,
    TranshipmentsModule,
    StatisticsModule,
    FishingViolationsModule,
  ],
})
export class AppModule {}
