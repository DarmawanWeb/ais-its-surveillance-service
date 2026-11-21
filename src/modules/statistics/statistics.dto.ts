import {
  BBoxQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import type { Plain } from '../../common/plain.js';

/** Default heatmap cell size, kilometres. */
export const DEFAULT_CELL_KM = 10;

/** Query of `GET /surveillance/heatmap`. */
export class HeatmapQueryDto extends IntersectionType(
  TimeRangeQueryDto,
  BBoxQueryDto,
) {
  @ApiPropertyOptional({
    description: 'Alert type (default: every type)',
    example: 'fishing',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  readonly type?: string;

  @ApiPropertyOptional({
    description: 'Cell size, kilometres (converted to degrees at 111.32 km/°)',
    minimum: 0.5,
    maximum: 500,
    default: DEFAULT_CELL_KM,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(500)
  readonly cellKm: number = DEFAULT_CELL_KM;
}

/** One heatmap cell. */
export class HeatmapCellDto {
  @ApiProperty({ description: 'Latitude of the cell centre, degrees' })
  readonly lat!: number;

  @ApiProperty({ description: 'Longitude of the cell centre, degrees' })
  readonly lon!: number;

  @ApiProperty({ type: 'integer' })
  readonly count!: number;
}

/** `GET /surveillance/heatmap` response. */
export class HeatmapDto {
  @ApiProperty({ type: [HeatmapCellDto] })
  readonly cells!: HeatmapCellDto[];

  @ApiProperty({ description: 'Cell size, kilometres' })
  readonly cellKm!: number;

  @ApiProperty({ description: 'Cell size, degrees (ST_SnapToGrid)' })
  readonly cellDeg!: number;

  @ApiProperty({ format: 'date-time' })
  readonly from!: string;

  @ApiProperty({ format: 'date-time' })
  readonly to!: string;

  @ApiProperty({ type: 'integer', description: 'Events counted' })
  readonly total!: number;
}

/** Query of `GET /surveillance/stats`. */
export class StatsQueryDto extends TimeRangeQueryDto {}

/** Pairs of the transhipment queue by status (authority users only). */
export class TranshipmentQueueStatsDto {
  @ApiProperty({ type: 'integer' })
  readonly pending!: number;

  @ApiProperty({ type: 'integer' })
  readonly inProgress!: number;

  @ApiProperty({ type: 'integer' })
  readonly completed!: number;

  @ApiProperty({ type: 'integer' })
  readonly failed!: number;
}

/** `GET /surveillance/stats` response. */
export class SurveillanceStatsDto {
  @ApiProperty({ format: 'date-time' })
  readonly from!: string;

  @ApiProperty({ format: 'date-time' })
  readonly to!: string;

  @ApiProperty({ type: 'integer', description: 'Events in the range' })
  readonly total!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Occurrences the detectors have not ended',
  })
  readonly active!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { transhipment: 2, dark: 5 },
  })
  readonly byType!: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { warning: 4, critical: 1 },
  })
  readonly bySeverity!: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { open: 3, confirmed: 1 },
  })
  readonly byStatus!: Record<string, number>;

  @ApiProperty({
    type: TranshipmentQueueStatsDto,
    nullable: true,
    description: 'Candidate queue (authority users only, else null)',
  })
  readonly transhipmentQueue!: TranshipmentQueueStatsDto | null;

  @ApiProperty({
    type: 'integer',
    description: 'Historical fishing violation records',
  })
  readonly fishingViolations!: number;
}

/** Plain response shape of {@link HeatmapDto}. */
export type HeatmapView = Plain<HeatmapDto>;

/** Plain response shape of {@link SurveillanceStatsDto}. */
export type SurveillanceStatsView = Plain<SurveillanceStatsDto>;
