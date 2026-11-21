import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { ApiPageResponse } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  FishingViolationDto,
  type FishingViolationView,
  ListFishingViolationsQueryDto,
} from './fishing-violations.dto.js';
import { FishingViolationsService } from './fishing-violations.service.js';

@ApiTags('fishing-violations')
@Controller('surveillance/fishing-violations')
export class FishingViolationsController {
  constructor(private readonly violations: FishingViolationsService) {}

  @Get()
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary:
      'Historical illegal-fishing apprehensions 2015–2017 (legacy dataset, map layer)',
  })
  @ApiPageResponse(FishingViolationDto)
  list(
    @Query() query: ListFishingViolationsQueryDto,
  ): Promise<Paginated<FishingViolationView>> {
    return this.violations.list(query);
  }
}
