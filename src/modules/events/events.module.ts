import { Module } from '@nestjs/common';

import { EventsController } from './events.controller.js';
import { EventsRepository } from './events.repository.js';
import { EventsService } from './events.service.js';

/** `GET/PATCH /surveillance/events` — the detector events and their review. */
@Module({
  controllers: [EventsController],
  providers: [EventsService, EventsRepository],
  exports: [EventsRepository],
})
export class EventsModule {}
