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
  StatsSeriesQueryDto,
  SurveillanceStatsDto,
  SurveillanceStatsSeriesDto,
  type SurveillanceStatsSeriesView,
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

  @Get('stats/series')
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary:
      'Event counts by type and severity per hour or day of a time zone (one query for a chart)',
    description:
      'Every bucket of the range in order (empty ones with zero counts); the first bucket starts ' +
      'at `from`, the last ends at `to`. Buckets follow daylight saving time of `tz`: a repeated ' +
      'hour is two buckets, a skipped hour none, a day lasts 23 to 25 hours. Tenancy as ' +
      '`GET /surveillance/stats`.',
  })
  @ApiOkResponse({ type: SurveillanceStatsSeriesDto })
  series(
    @CurrentPrincipal() principal: Principal,
    @Query() query: StatsSeriesQueryDto,
  ): Promise<SurveillanceStatsSeriesView> {
    return this.statistics.series(principal, query);
  }
}
