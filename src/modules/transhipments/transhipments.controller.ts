import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ListTranshipmentsQueryDto,
  TranshipmentResultDto,
  type TranshipmentResultView,
} from './transhipments.dto.js';
import { TranshipmentsService } from './transhipments.service.js';

@ApiTags('transhipments')
@Controller('surveillance/transhipments')
export class TranshipmentsController {
  constructor(private readonly transhipments: TranshipmentsService) {}

  @Get()
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary:
      'Detected transhipments in the legacy result shape (accuracy, window, priority distribution)',
  })
  @ApiCursorResponse(TranshipmentResultDto)
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListTranshipmentsQueryDto,
  ): Promise<CursorPage<TranshipmentResultView>> {
    return this.transhipments.list(principal, query);
  }
}
