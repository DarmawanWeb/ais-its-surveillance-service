import { BBoxQueryDto, PageQueryDto } from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import type { Plain } from '../../common/plain.js';

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

/** Plain response shape of {@link FishingViolationDto}. */
export type FishingViolationView = Plain<FishingViolationDto>;
