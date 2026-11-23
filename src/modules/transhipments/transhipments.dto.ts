import {
  ALERT_SEVERITIES,
  type AlertSeverity,
  SURVEILLANCE_EVENT_STATUSES,
  type SurveillanceEventStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import type { Plain } from '../../common/plain.js';

/** Query of `GET /surveillance/transhipments`. */
export class ListTranshipmentsQueryDto extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
) {
  @ApiPropertyOptional({
    type: 'integer',
    description:
      'Only pairs with this vessel (legacy GET /results/:mmsi); `from` / `to` select by window start',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Only the analyses of this event (`TranshipmentResultDto.eventId`); without `from` / `to` ' +
      'every analysis of the event, whatever its window',
  })
  @IsOptional()
  @IsUUID()
  readonly eventId?: string;
}

/** Share of the positive checks per priority category, percent. */
export class PriorityDistributionDto {
  @ApiProperty({ description: 'P < 6, percent' })
  readonly low!: number;

  @ApiProperty({ description: '6 ≤ P < 18, percent' })
  readonly medium!: number;

  @ApiProperty({ description: 'P ≥ 18, percent' })
  readonly high!: number;
}

/**
 * One positive analysis in the legacy result shape
 * (`IllegalTranshipmentResult`: ship1MMSI/ship2MMSI sorted, isIllegal,
 * startTimestamp, endTimestamp, accuracy, averagePriority,
 * priorityDistribution, detectedAt) plus the v2 fields of its occurrence.
 */
export class TranshipmentResultDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Result id (one per positive analysis)',
  })
  readonly id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Event of the occurrence (`GET /surveillance/events/:id`)',
  })
  readonly eventId!: string;

  @ApiProperty({ type: 'integer', description: 'Smaller MMSI of the pair' })
  readonly ship1MMSI!: number;

  @ApiProperty({ type: 'integer', description: 'Larger MMSI of the pair' })
  readonly ship2MMSI!: number;

  @ApiProperty({ type: String, nullable: true })
  readonly ship1Name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly ship2Name!: string | null;

  @ApiProperty({
    description: 'Always true: only positive analyses are stored',
  })
  readonly isIllegal!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly startTimestamp!: string;

  @ApiProperty({ format: 'date-time' })
  readonly endTimestamp!: string;

  @ApiProperty({ description: 'Score 0–100 (transhipment.accuracy)' })
  readonly accuracy!: number;

  @ApiProperty({ description: 'Mean product priority of the positive checks' })
  readonly averagePriority!: number;

  @ApiProperty({ type: PriorityDistributionDto })
  readonly priorityDistribution!: PriorityDistributionDto;

  @ApiProperty({
    format: 'date-time',
    description: 'When the analysis detected it',
  })
  readonly detectedAt!: string;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description:
      'Severity of this analysis (critical from TRANSHIPMENT_CRITICAL_ACCURACY)',
  })
  readonly severity!: AlertSeverity;

  @ApiProperty({
    enum: SURVEILLANCE_EVENT_STATUSES,
    nullable: true,
    description:
      'Review status of the occurrence (`null` once its event expired)',
  })
  readonly status!: SurveillanceEventStatus | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Midpoint of the two vessels in the middle of the window',
  })
  readonly lat!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lon!: number | null;

  @ApiProperty({ example: 'transhipment.accuracy' })
  readonly methodId!: string;
}

/** Plain response shape of {@link TranshipmentResultDto}. */
export type TranshipmentResultView = Plain<TranshipmentResultDto>;
