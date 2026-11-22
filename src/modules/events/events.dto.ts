import {
  ALERT_SEVERITIES,
  type AlertSeverity,
  SURVEILLANCE_EVENT_STATUSES,
  type SurveillanceEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  BBoxQueryDto,
  CursorQueryDto,
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
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { Plain } from '../../common/plain.js';

/** Review verdicts a reviewer may set (`resolved` is set by the detectors). */
export const REVIEW_STATUSES = ['open', 'confirmed', 'dismissed'] as const;

/** A review verdict. */
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Query of `GET /surveillance/events`. */
export class ListEventsQueryDto extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
  BBoxQueryDto,
) {
  @ApiPropertyOptional({
    description:
      'Alert type, e.g. transhipment, anomaly, dark, geofence, fishing',
    example: 'transhipment',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  readonly type?: string;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  readonly severity?: AlertSeverity;

  @ApiPropertyOptional({ enum: SURVEILLANCE_EVENT_STATUSES })
  @IsOptional()
  @IsIn(SURVEILLANCE_EVENT_STATUSES)
  readonly status?: SurveillanceEventStatus;

  @ApiPropertyOptional({
    type: 'integer',
    description: 'Vessel (matches mmsi or relatedMmsi)',
    example: 525005223,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;
}

/** Body of `PATCH /surveillance/events/:id`. */
export class ReviewEventDto {
  @ApiProperty({
    enum: REVIEW_STATUSES,
    description:
      'Review verdict; `open` withdraws a verdict (`resolved` when the detector already ended the occurrence)',
  })
  @IsIn(REVIEW_STATUSES)
  readonly status!: ReviewStatus;

  @ApiPropertyOptional({
    type: 'string',
    maxLength: 2_000,
    nullable: true,
    description:
      'Reviewer note: omitted keeps the stored note, `null` clears it, a string replaces it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  readonly note?: string | null;
}

/** A surveillance event (`events` row) as returned by the API. */
export class SurveillanceEventDto {
  @ApiProperty({ format: 'uuid', description: 'Event id = alert id' })
  readonly id!: string;

  @ApiProperty({ format: 'date-time', description: 'When it happened' })
  readonly time!: string;

  @ApiProperty({ example: 'transhipment' })
  readonly detector!: string;

  @ApiProperty({ example: 'transhipment' })
  readonly type!: string;

  @ApiProperty({ enum: ['safety', 'surveillance'] })
  readonly domain!: 'safety' | 'surveillance';

  @ApiProperty({ enum: ALERT_SEVERITIES, description: 'Published severity' })
  readonly severity!: AlertSeverity;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description: 'Current severity of the occurrence',
  })
  readonly currentSeverity!: AlertSeverity;

  @ApiProperty({ type: 'integer', example: 525005223 })
  readonly mmsi!: number;

  @ApiProperty({ type: 'integer', nullable: true })
  readonly relatedMmsi!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Vessel name from the fleet projection',
  })
  readonly vesselName!: string | null;

  @ApiProperty({ nullable: true })
  readonly relatedVesselName!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly zoneId!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Zone name from the GEO projection',
  })
  readonly zoneName!: string | null;

  @ApiProperty({ nullable: true })
  readonly lat!: number | null;

  @ApiProperty({ nullable: true })
  readonly lon!: number | null;

  @ApiProperty()
  readonly title!: string;

  @ApiProperty()
  readonly message!: string;

  @ApiProperty({
    example: 'transhipment.accuracy',
    description: 'Methodology catalog id (spec §17)',
  })
  readonly methodId!: string;

  @ApiProperty({ example: 'transhipment:525000001:525000002' })
  readonly dedupKey!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  readonly data!: Record<string, unknown>;

  @ApiProperty({ enum: SURVEILLANCE_EVENT_STATUSES })
  readonly status!: SurveillanceEventStatus;

  @ApiProperty({ format: 'date-time' })
  readonly openedAt!: string;

  @ApiProperty({ format: 'date-time' })
  readonly lastSeenAt!: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'When the detector ended the occurrence',
  })
  readonly resolvedAt!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  readonly resolution!: Record<string, unknown> | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly reviewedBy!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  readonly reviewedAt!: string | null;

  @ApiProperty({ nullable: true })
  readonly note!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the event was recorded',
  })
  readonly createdAt!: string;
}

/** Plain response shape of {@link SurveillanceEventDto}. */
export type SurveillanceEventView = Plain<SurveillanceEventDto>;
