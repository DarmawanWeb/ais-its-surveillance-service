import { Module } from '@nestjs/common';

import { EventsModule } from '../events/events.module.js';
import { TranshipmentsController } from './transhipments.controller.js';
import { TranshipmentsService } from './transhipments.service.js';

/** `GET /surveillance/transhipments` — transhipment events, legacy result shape. */
@Module({
  imports: [EventsModule],
  controllers: [TranshipmentsController],
  providers: [TranshipmentsService],
})
export class TranshipmentsModule {}
