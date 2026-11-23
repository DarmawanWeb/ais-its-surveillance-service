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
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
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

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Detector lifecycle, apart from the review `status`: `true` = the occurrence is still open ' +
      '(`resolvedAt` null, e.g. still dark), `false` = the detector ended it (e.g. reappeared)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  readonly active?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only events of this zone (geofence, fishing)',
  })
  @IsOptional()
  @IsUUID()
  readonly zoneId?: string;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Vessel search: part of the name of the vessel or the related vessel (case-insensitive), ' +
      'or the leading digits of an MMSI; 2–100 characters once surrounding spaces are trimmed',
    example: 'mandiri',
  })
  @IsOptional()
  // Trimmed before validation: a blank value is refused, never ignored.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  readonly q?: string;
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

/**
 * The fields every surveillance event has (`events` row with the names
 * joined from the projections). The API returns one of the per-type
 * schemas (`event-variants.dto.ts`), discriminated by `type`.
 */
export abstract class SurveillanceEventBaseDto {
  @ApiProperty({ format: 'uuid', description: 'Event id = alert id' })
  readonly id!: string;

  @ApiProperty({ format: 'date-time', description: 'When it happened' })
  readonly time!: string;

  @ApiProperty({ example: 'transhipment' })
  readonly detector!: string;

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
    type: String,
    nullable: true,
    description: 'Vessel name from the fleet projection',
  })
  readonly vesselName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly relatedVesselName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly zoneId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Zone name from the GEO projection',
  })
  readonly zoneName!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lat!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lon!: number | null;

  @ApiProperty({
    description:
      'English headline (`data.messageKey` / `messageParams` localize it)',
  })
  readonly title!: string;

  @ApiProperty({ description: 'English sentence (see `title`)' })
  readonly message!: string;

  @ApiProperty({
    example: 'transhipment.accuracy',
    description: 'Methodology catalog id (spec §17)',
  })
  readonly methodId!: string;

  @ApiProperty({ example: 'transhipment:525000001:525000002' })
  readonly dedupKey!: string;

  @ApiProperty({
    enum: SURVEILLANCE_EVENT_STATUSES,
    description: 'Review status (the detector lifecycle is `resolvedAt`)',
  })
  readonly status!: SurveillanceEventStatus;

  @ApiProperty({ format: 'date-time' })
  readonly openedAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: "Event time of the occurrence's latest signal",
  })
  readonly lastSeenAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the detector ended the occurrence',
  })
  readonly resolvedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly reviewedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly reviewedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly note!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the event was recorded',
  })
  readonly createdAt!: string;
}

/**
 * Plain response shape of a surveillance event: the common fields plus the
 * per-type `type`, `data` and `resolution` (`event-variants.dto.ts`).
 */
export type SurveillanceEventView = Plain<SurveillanceEventBaseDto> & {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly resolution: Record<string, unknown> | null;
};
