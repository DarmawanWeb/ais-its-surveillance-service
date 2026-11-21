import { Module } from '@nestjs/common';

import { FishingViolationsController } from './fishing-violations.controller.js';
import { FishingViolationsRepository } from './fishing-violations.repository.js';
import { FishingViolationsService } from './fishing-violations.service.js';

/** `GET /surveillance/fishing-violations` — historical records (`pnpm seed`). */
@Module({
  controllers: [FishingViolationsController],
  providers: [FishingViolationsService, FishingViolationsRepository],
})
export class FishingViolationsModule {}
