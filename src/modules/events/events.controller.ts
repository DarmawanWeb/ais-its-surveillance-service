import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { UuidParam } from '@darmawanweb/ais-its-nest/http';
import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import {
  ApiSurveillanceEventPage,
  ApiSurveillanceEventResponse,
} from './event-variants.dto.js';
import {
  ListEventsQueryDto,
  ReviewEventDto,
  type SurveillanceEventView,
} from './events.dto.js';
import { EventsService } from './events.service.js';

@ApiTags('events')
@Controller('surveillance/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary:
      'Surveillance events, newest first (tenancy: own vessels unless authority)',
    description:
      'Filters combine with AND; `active` selects by the detector lifecycle (`resolvedAt`), ' +
      '`status` by the review. Each event has `data.messageKey` / `messageParams` for a ' +
      'localized title and, once ended, `resolution.code`.',
  })
  @ApiSurveillanceEventPage()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListEventsQueryDto,
  ): Promise<CursorPage<SurveillanceEventView>> {
    return this.events.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('surveillance:read')
  @ApiOperation({ summary: 'One surveillance event' })
  @ApiSurveillanceEventResponse()
  get(
    @CurrentPrincipal() principal: Principal,
    @UuidParam() id: string,
  ): Promise<SurveillanceEventView> {
    return this.events.get(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('surveillance:review')
  @ApiOperation({
    summary: 'Review an event: confirm, dismiss or reopen it, with a note',
  })
  @ApiSurveillanceEventResponse('The reviewed event')
  review(
    @CurrentPrincipal() principal: Principal,
    @UuidParam() id: string,
    @Body() body: ReviewEventDto,
    @Req() request: FastifyRequest,
  ): Promise<SurveillanceEventView> {
    return this.events.review(principal, id, body, request);
  }
}
