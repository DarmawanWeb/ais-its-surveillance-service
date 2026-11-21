import { Module } from '@nestjs/common';

import { ProjectionsConsumer } from './projections.consumer.js';
import { VesselsRepository } from './vessels.repository.js';
import { ZonesRepository } from './zones.repository.js';

/** NATS consumers of the service besides the detector feed (projections). */
@Module({
  providers: [ProjectionsConsumer, ZonesRepository, VesselsRepository],
})
export class ConsumersModule {}
