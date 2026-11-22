import { Module } from '@nestjs/common';

import { TranshipmentResultsRepository } from './transhipment-results.repository.js';
import { TranshipmentsController } from './transhipments.controller.js';
import { TranshipmentsService } from './transhipments.service.js';

/** `GET /surveillance/transhipments` — every positive analysis, legacy result shape. */
@Module({
  controllers: [TranshipmentsController],
  providers: [TranshipmentsService, TranshipmentResultsRepository],
})
export class TranshipmentsModule {}
