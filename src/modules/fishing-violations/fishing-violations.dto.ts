import { BBoxQueryDto, PageQueryDto } from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

import type { Plain } from '../../common/plain.js';
import {
  DEFAULT_CELL_KM,
  HeatmapCellDto,
} from '../statistics/statistics.dto.js';

/** Query of `GET /surveillance/fishing-violations`. */
export class ListFishingViolationsQueryDto extends IntersectionType(
  PageQueryDto,
  BBoxQueryDto,
) {
  @ApiPropertyOptional({ type: 'integer', example: 2016 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  readonly year?: number;
}

/** A historical illegal-fishing record (map layer). */
export class FishingViolationDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: 'KM. Mandiri 777' })
  readonly vesselName!: string;

  @ApiProperty({
    example: 'Indonesia',
    description: 'Flag country as recorded',
  })
  readonly flagCountry!: string;

  @ApiProperty({ type: 'integer', example: 2015 })
  readonly year!: number;

  @ApiProperty()
  readonly violation!: string;

  @ApiProperty({ description: 'Follow-up action' })
  readonly action!: string;

  @ApiProperty({ description: 'Apprehension point latitude, degrees' })
  readonly lat!: number;

  @ApiProperty({ description: 'Apprehension point longitude, degrees' })
  readonly lon!: number;

  @ApiProperty({ description: 'Provenance of the record' })
  readonly source!: string;

  @ApiProperty({ description: 'Provenance note and caveats' })
  readonly sourceNote!: string;

  @ApiProperty({ example: 'fishing.apprehensions_2015_2017' })
  readonly methodId!: string;
}

/** Query of `GET /surveillance/fishing-violations/heatmap`. */
export class FishingViolationHeatmapQueryDto extends BBoxQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    example: 2016,
    description: 'Only this year (default: every year)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  readonly year?: number;

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

/** `GET /surveillance/fishing-violations/heatmap` response (the historical heat layer). */
export class FishingViolationHeatmapDto {
  @ApiProperty({ type: [HeatmapCellDto], description: 'Densest first' })
  readonly cells!: HeatmapCellDto[];

  @ApiProperty({ description: 'Cell size, kilometres' })
  readonly cellKm!: number;

  @ApiProperty({ description: 'Cell size, degrees (ST_SnapToGrid)' })
  readonly cellDeg!: number;

  @ApiProperty({ type: 'integer', nullable: true, example: 2016 })
  readonly year!: number | null;

  @ApiProperty({ type: 'integer', description: 'Records counted' })
  readonly total!: number;
}

/** Records of one year. */
export class FishingViolationYearDto {
  @ApiProperty({ type: 'integer', example: 2016 })
  readonly year!: number;

  @ApiProperty({ type: 'integer', example: 163 })
  readonly count!: number;
}

/** `GET /surveillance/fishing-violations/years` response (year facets). */
export class FishingViolationYearsDto {
  @ApiProperty({ type: [FishingViolationYearDto], description: 'Oldest first' })
  readonly years!: FishingViolationYearDto[];

  @ApiProperty({ type: 'integer', description: 'Records of every year' })
  readonly total!: number;
}

/** Plain response shape of {@link FishingViolationHeatmapDto}. */
export type FishingViolationHeatmapView = Plain<FishingViolationHeatmapDto>;

/** Plain response shape of {@link FishingViolationYearsDto}. */
export type FishingViolationYearsView = Plain<FishingViolationYearsDto>;

/** Plain response shape of {@link FishingViolationDto}. */
export type FishingViolationView = Plain<FishingViolationDto>;
