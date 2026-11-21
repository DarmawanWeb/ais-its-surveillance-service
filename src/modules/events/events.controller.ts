import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import {
  ListEventsQueryDto,
  ReviewEventDto,
  SurveillanceEventDto,
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
  })
  @ApiCursorResponse(SurveillanceEventDto)
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListEventsQueryDto,
  ): Promise<CursorPage<SurveillanceEventView>> {
    return this.events.list(principal, query);
  }

  @Get(':id')
  @RequirePermissions('surveillance:read')
  @ApiOperation({ summary: 'One surveillance event' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SurveillanceEventDto })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SurveillanceEventView> {
    return this.events.get(principal, id);
  }

  @Patch(':id')
  @RequirePermissions('surveillance:review')
  @ApiOperation({
    summary: 'Review an event: confirm, dismiss or reopen it, with a note',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SurveillanceEventDto })
  review(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewEventDto,
    @Req() request: FastifyRequest,
  ): Promise<SurveillanceEventView> {
    return this.events.review(principal, id, body, request);
  }
}
