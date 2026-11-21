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
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import type { Plain } from '../../common/plain.js';

/** Query of `GET /surveillance/transhipments`. */
export class ListTranshipmentsQueryDto extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
) {
  @ApiPropertyOptional({
    type: 'integer',
    description: 'Only pairs with this vessel (legacy GET /results/:mmsi)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;
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
 * A detected transhipment in the legacy result shape
 * (`IllegalTranshipmentResult`: ship1MMSI/ship2MMSI sorted, isIllegal,
 * startTimestamp, endTimestamp, accuracy, averagePriority,
 * priorityDistribution, detectedAt) plus the v2 event fields.
 */
export class TranshipmentResultDto {
  @ApiProperty({ format: 'uuid', description: 'Event id' })
  readonly id!: string;

  @ApiProperty({ type: 'integer', description: 'Smaller MMSI of the pair' })
  readonly ship1MMSI!: number;

  @ApiProperty({ type: 'integer', description: 'Larger MMSI of the pair' })
  readonly ship2MMSI!: number;

  @ApiProperty({ nullable: true })
  readonly ship1Name!: string | null;

  @ApiProperty({ nullable: true })
  readonly ship2Name!: string | null;

  @ApiProperty({
    description: 'Always true: only positive analyses are events',
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

  @ApiProperty({ enum: ALERT_SEVERITIES })
  readonly severity!: AlertSeverity;

  @ApiProperty({ enum: SURVEILLANCE_EVENT_STATUSES })
  readonly status!: SurveillanceEventStatus;

  @ApiProperty({ nullable: true })
  readonly lat!: number | null;

  @ApiProperty({ nullable: true })
  readonly lon!: number | null;

  @ApiProperty({ example: 'transhipment.accuracy' })
  readonly methodId!: string;
}

/** Plain response shape of {@link TranshipmentResultDto}. */
export type TranshipmentResultView = Plain<TranshipmentResultDto>;
