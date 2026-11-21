import { Module } from '@nestjs/common';

import { StatisticsController } from './statistics.controller.js';
import { StatisticsRepository } from './statistics.repository.js';
import { StatisticsService } from './statistics.service.js';

/** `GET /surveillance/heatmap` and `GET /surveillance/stats`. */
@Module({
  controllers: [StatisticsController],
  providers: [StatisticsService, StatisticsRepository],
})
export class StatisticsModule {}
