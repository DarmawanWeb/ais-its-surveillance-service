import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  HeatmapDto,
  type HeatmapView,
  HeatmapQueryDto,
  StatsQueryDto,
  SurveillanceStatsDto,
  type SurveillanceStatsView,
} from './statistics.dto.js';
import { StatisticsService } from './statistics.service.js';

@ApiTags('statistics')
@Controller('surveillance')
export class StatisticsController {
  constructor(private readonly statistics: StatisticsService) {}

  @Get('heatmap')
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary: 'Event counts per grid cell (ST_SnapToGrid, cell size in km)',
  })
  @ApiOkResponse({ type: HeatmapDto })
  heatmap(
    @CurrentPrincipal() principal: Principal,
    @Query() query: HeatmapQueryDto,
  ): Promise<HeatmapView> {
    return this.statistics.heatmap(principal, query);
  }

  @Get('stats')
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary: 'Event counts by type, severity and status in a time range',
  })
  @ApiOkResponse({ type: SurveillanceStatsDto })
  stats(
    @CurrentPrincipal() principal: Principal,
    @Query() query: StatsQueryDto,
  ): Promise<SurveillanceStatsView> {
    return this.statistics.stats(principal, query);
  }
}
