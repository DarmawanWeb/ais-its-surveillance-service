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
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  MaxLength,
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

/** Bucket sizes of `GET /surveillance/stats/series`. */
export const SERIES_BUCKETS = ['hour', 'day'] as const;

/** A {@link SERIES_BUCKETS} value. */
export type SeriesBucket = (typeof SERIES_BUCKETS)[number];

/** Most buckets one series request may return. */
export const MAX_SERIES_BUCKETS = 1_000;

/**
 * Shape of a time zone name: IANA names start with a letter (`Asia/Jakarta`,
 * `Etc/GMT-7`, `UTC`). UTC offsets such as `+07:00` are refused: ICU accepts
 * them, but PostgreSQL reads them as POSIX zone specifications, whose sign is
 * reversed (`+07:00` would align buckets to UTC-07:00).
 */
export const TIME_ZONE_NAME_PATTERN =
  '^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$';

/** Query of `GET /surveillance/stats/series`. */
export class StatsSeriesQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    enum: SERIES_BUCKETS,
    default: 'day',
    description: `Bucket size (at most ${MAX_SERIES_BUCKETS} buckets per request)`,
  })
  @IsOptional()
  @IsIn(SERIES_BUCKETS)
  readonly bucket: SeriesBucket = 'day';

  @ApiPropertyOptional({
    default: 'UTC',
    example: 'Asia/Jakarta',
    maxLength: 64,
    pattern: TIME_ZONE_NAME_PATTERN,
    description:
      'IANA time zone name of the bucket boundaries (local hours and days, e.g. WIB), any case; ' +
      'the response echoes the database spelling. UTC offsets such as `+07:00` are refused (use ' +
      '`Etc/GMT-7`), and so are names the database does not know (`400 VALIDATION_FAILED`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(new RegExp(TIME_ZONE_NAME_PATTERN), {
    message:
      'tz must be an IANA time zone name (e.g. Asia/Jakarta, Etc/GMT-7), not a UTC offset',
  })
  @IsTimeZone()
  readonly tz: string = 'UTC';

  @ApiPropertyOptional({
    description: 'Alert type (default: every type)',
    example: 'dark',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  readonly type?: string;
}

/** Event counts of one bucket. */
export class StatsBucketDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Bucket start (the range start for the first bucket)',
  })
  readonly from!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Bucket end, exclusive (the range end, inclusive, for the last bucket)',
  })
  readonly to!: string;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { dark: 3, transhipment: 1 },
  })
  readonly byType!: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { warning: 3, critical: 1 },
  })
  readonly bySeverity!: Record<string, number>;
}

/** `GET /surveillance/stats/series` response. */
export class SurveillanceStatsSeriesDto {
  @ApiProperty({ format: 'date-time' })
  readonly from!: string;

  @ApiProperty({ format: 'date-time' })
  readonly to!: string;

  @ApiProperty({ enum: SERIES_BUCKETS })
  readonly bucket!: SeriesBucket;

  @ApiProperty({ example: 'Asia/Jakarta' })
  readonly timeZone!: string;

  @ApiProperty({
    type: [StatsBucketDto],
    description: 'Every bucket of the range in order, empty ones included',
  })
  readonly buckets!: StatsBucketDto[];
}

/** Plain response shape of {@link SurveillanceStatsSeriesDto}. */
export type SurveillanceStatsSeriesView = Plain<SurveillanceStatsSeriesDto>;

/** Plain response shape of {@link HeatmapDto}. */
export type HeatmapView = Plain<HeatmapDto>;

/** Plain response shape of {@link SurveillanceStatsDto}. */
export type SurveillanceStatsView = Plain<SurveillanceStatsDto>;
