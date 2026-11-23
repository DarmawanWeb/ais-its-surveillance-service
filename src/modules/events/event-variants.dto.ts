import {
  ZONE_KINDS,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import { CursorPageInfoDto } from '@darmawanweb/ais-its-nest/http';
import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';

import {
  EVENT_MESSAGES,
  type MessageParams,
  RESOLUTION_CODES,
  type ResolutionCode,
} from '../../domain/messages.js';
import { PriorityDistributionDto } from '../transhipments/transhipments.dto.js';
import { SurveillanceEventBaseDto } from './events.dto.js';

/** Description of `messageKey`. */
const MESSAGE_KEY_DESCRIPTION =
  'Stable message key `surveillance.<detector>.<situation>` of the title and message ' +
  '(README "Messages"); rows written before 0.2.0 get it derived on read';

/** The localizable text of an event (cross-service convention; README "Messages"). */
abstract class EventMessageDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    },
    description:
      'Parameters of the sentence (vessel and zone names, MMSIs, metres, minutes, knots)',
    example: { mmsi: 525005223, vesselName: 'KM Mandiri 777' },
  })
  readonly messageParams!: MessageParams;
}

/** `data` of a `transhipment` event (the analysis behind the occurrence). */
export class TranshipmentEventDataDto extends EventMessageDto {
  @ApiProperty({
    enum: [EVENT_MESSAGES.transhipment.key],
    description: MESSAGE_KEY_DESCRIPTION,
  })
  readonly messageKey!: string;

  @ApiProperty({ description: 'Always true: only positive analyses raise' })
  readonly isIllegal!: boolean;

  @ApiProperty({ description: 'Score 0–100 (transhipment.accuracy)' })
  readonly accuracy!: number;

  @ApiProperty({ format: 'date-time', description: 'Window start' })
  readonly startTimestamp!: string;

  @ApiProperty({ format: 'date-time', description: 'Window end' })
  readonly endTimestamp!: string;

  @ApiProperty({ description: 'Mean product priority of the positive checks' })
  readonly averagePriority!: number;

  @ApiProperty({ type: PriorityDistributionDto })
  readonly priorityDistribution!: PriorityDistributionDto;

  @ApiPropertyOptional({
    description: 'TRANSHIPMENT_ACCURACY_THRESHOLD of the analysis, percent',
  })
  readonly accuracyThreshold?: number;

  @ApiPropertyOptional({
    description: 'Accumulated candidate priority of the pair when analysed',
  })
  readonly accumulatedPriority?: number;

  @ApiPropertyOptional({
    type: 'integer',
    description: 'Candidate observations of the pair',
  })
  readonly observations?: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Distance of the last observation, metres',
  })
  readonly lastDistanceM?: number | null;

  @ApiPropertyOptional({
    type: 'integer',
    description: 'Track fixes of ship 1',
  })
  readonly route1Points?: number;

  @ApiPropertyOptional({
    type: 'integer',
    description: 'Track fixes of ship 2',
  })
  readonly route2Points?: number;

  @ApiProperty({
    type: [String],
    description: 'Methodology ids of the detection chain',
  })
  readonly methodIds!: string[];

  @ApiPropertyOptional({
    description:
      'Imported from the legacy MVP (the fields it did not store are absent)',
  })
  readonly legacy?: boolean;
}

/** `data` of an `anomaly` event. */
export class AnomalyEventDataDto extends EventMessageDto {
  @ApiProperty({
    enum: [EVENT_MESSAGES.anomaly.key],
    description: MESSAGE_KEY_DESCRIPTION,
  })
  readonly messageKey!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 15,
    description: 'Reported AIS navigational status',
  })
  readonly navstatus!: number;

  @ApiProperty({
    enum: [0, 1],
    description: 'Predicted status: 0 under way, 1 at anchor',
  })
  readonly predictedNavstatus!: 0 | 1;

  @ApiProperty({
    type: 'integer',
    description: 'Consecutive anomalous positions',
  })
  readonly streak!: number;

  @ApiProperty({ type: 'integer', description: 'ANOMALY_MIN_POSITIONS' })
  readonly minPositions!: number;

  @ApiProperty({ description: 'Speed over ground, knots' })
  readonly sogKn!: number;
}

/** `data` of a `dark` event (AIS gap). */
export class DarkEventDataDto extends EventMessageDto {
  @ApiProperty({
    enum: [EVENT_MESSAGES.dark.key],
    description: MESSAGE_KEY_DESCRIPTION,
  })
  readonly messageKey!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Last position before the gap',
  })
  readonly lastSeenAt!: string;

  @ApiProperty({ description: 'Last speed over ground, knots' })
  readonly lastSogKn!: number;

  @ApiProperty({ description: 'Last course over ground, degrees' })
  readonly lastCogDeg!: number;

  @ApiProperty({ description: 'Silence when reported, minutes' })
  readonly gapMin!: number;

  @ApiProperty({ type: 'integer', description: 'DARK_GAP_MIN' })
  readonly gapThresholdMin!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Distance to the nearest global port / anchorage within DARK_HARBOUR_DISTANCE_KM, metres (null: none)',
  })
  readonly nearestHarbourM!: number | null;
}

/** The zone fields of `geofence` and `fishing` data. */
abstract class ZoneEventDataDto extends EventMessageDto {
  @ApiProperty({ enum: ZONE_KINDS })
  readonly zoneKind!: ZoneKind;

  @ApiProperty({ type: String, nullable: true })
  readonly zoneCode!: string | null;

  @ApiProperty({ description: 'Zone name when the event was raised' })
  readonly zoneName!: string;
}

/** `data` of a `geofence` event (zone entry). */
export class GeofenceEventDataDto extends ZoneEventDataDto {
  @ApiProperty({
    enum: [EVENT_MESSAGES.geofence.key],
    description: MESSAGE_KEY_DESCRIPTION,
  })
  readonly messageKey!: string;

  @ApiProperty({ description: 'Speed over ground at the entry, knots' })
  readonly sogKn!: number;
}

/** `data` of a `fishing` event (loitering pattern). */
export class FishingEventDataDto extends ZoneEventDataDto {
  @ApiProperty({
    enum: [EVENT_MESSAGES.fishing.key],
    description: MESSAGE_KEY_DESCRIPTION,
  })
  readonly messageKey!: string;

  @ApiProperty({ description: 'Duration of the pattern, minutes' })
  readonly durationMin!: number;

  @ApiProperty({ type: 'integer', description: 'Fixes of the pattern' })
  readonly positions!: number;

  @ApiProperty({ description: 'Mean speed over ground, knots' })
  readonly meanSogKn!: number;

  @ApiProperty({ description: 'Mean course-change rate, degrees per minute' })
  readonly courseChangeRateDegPerMin!: number;

  @ApiProperty({ description: 'Total course change, degrees' })
  readonly totalCourseChangeDeg!: number;
}

/** Codes a type's occurrences end with (`escalated` and `other` for all). */
const CODES_OF = {
  transhipment: [
    'escalated',
    'analysis_negative',
    'pair_separated',
    'legacy_import',
    'other',
  ],
  anomaly: ['escalated', 'navstatus_consistent', 'other'],
  dark: ['escalated', 'ais_resumed', 'other'],
  geofence: [
    'escalated',
    'left_zone',
    'zone_deleted',
    'zone_no_longer_alerts',
    'other',
  ],
  fishing: ['escalated', 'left_zone', 'loitering_ended', 'other'],
} as const satisfies Record<
  keyof typeof EVENT_MESSAGES,
  readonly ResolutionCode[]
>;

/** Description of `resolution.code`. */
const CODE_DESCRIPTION = `Stable code of the reason (README "Resolution codes"; all codes: ${RESOLUTION_CODES.join(', ')})`;

/** How an occurrence ended (`resolution`, set together with `resolvedAt`). */
abstract class EventResolutionDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'English reason (kept for older clients; translate `code`)',
  })
  readonly reason!: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      '`escalated`: the alert of the same occurrence that superseded this one',
  })
  readonly supersededBy?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A duplicate open row of the same `dedupKey` (opened by a second writer during a failover) ' +
      'ended together with this alert of the occurrence',
  })
  readonly duplicateOf?: string;
}

/** `resolution` of a `transhipment` event. */
export class TranshipmentResolutionDto extends EventResolutionDto {
  @ApiProperty({
    enum: [...CODES_OF.transhipment],
    description: CODE_DESCRIPTION,
  })
  readonly code!: ResolutionCode;

  @ApiPropertyOptional({
    format: 'date-time',
    description: '`pair_separated`: when the pair was last observed together',
  })
  readonly lastSeenAt?: string;
}

/** `resolution` of an `anomaly` event. */
export class AnomalyResolutionDto extends EventResolutionDto {
  @ApiProperty({
    enum: [...CODES_OF.anomaly],
    description: CODE_DESCRIPTION,
  })
  readonly code!: ResolutionCode;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 15 })
  readonly navstatus?: number;

  @ApiPropertyOptional({ enum: [0, 1] })
  readonly predictedNavstatus?: 0 | 1;
}

/** `resolution` of a `dark` event. */
export class DarkResolutionDto extends EventResolutionDto {
  @ApiProperty({
    enum: [...CODES_OF.dark],
    description: CODE_DESCRIPTION,
  })
  readonly code!: ResolutionCode;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'First position after the gap',
  })
  readonly reappearedAt?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last position before the gap',
  })
  readonly lastSeenAt?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Length of the gap, minutes',
  })
  readonly gapMin?: number | null;

  @ApiPropertyOptional({ description: 'Latitude where it reappeared' })
  readonly lat?: number;

  @ApiPropertyOptional({ description: 'Longitude where it reappeared' })
  readonly lon?: number;
}

/** `resolution` of a `geofence` event. */
export class GeofenceResolutionDto extends EventResolutionDto {
  @ApiProperty({
    enum: [...CODES_OF.geofence],
    description: CODE_DESCRIPTION,
  })
  readonly code!: ResolutionCode;
}

/** `resolution` of a `fishing` event. */
export class FishingResolutionDto extends EventResolutionDto {
  @ApiProperty({
    enum: [...CODES_OF.fishing],
    description: CODE_DESCRIPTION,
  })
  readonly code!: ResolutionCode;
}

/** A `transhipment` event. */
export class TranshipmentEventDto extends SurveillanceEventBaseDto {
  @ApiProperty({ enum: ['transhipment'] })
  readonly type!: 'transhipment';

  @ApiProperty({ type: TranshipmentEventDataDto })
  readonly data!: TranshipmentEventDataDto;

  @ApiProperty({ type: TranshipmentResolutionDto, nullable: true })
  readonly resolution!: TranshipmentResolutionDto | null;
}

/** An `anomaly` event. */
export class AnomalyEventDto extends SurveillanceEventBaseDto {
  @ApiProperty({ enum: ['anomaly'] })
  readonly type!: 'anomaly';

  @ApiProperty({ type: AnomalyEventDataDto })
  readonly data!: AnomalyEventDataDto;

  @ApiProperty({ type: AnomalyResolutionDto, nullable: true })
  readonly resolution!: AnomalyResolutionDto | null;
}

/** A `dark` event. */
export class DarkEventDto extends SurveillanceEventBaseDto {
  @ApiProperty({ enum: ['dark'] })
  readonly type!: 'dark';

  @ApiProperty({ type: DarkEventDataDto })
  readonly data!: DarkEventDataDto;

  @ApiProperty({ type: DarkResolutionDto, nullable: true })
  readonly resolution!: DarkResolutionDto | null;
}

/** A `geofence` event. */
export class GeofenceEventDto extends SurveillanceEventBaseDto {
  @ApiProperty({ enum: ['geofence'] })
  readonly type!: 'geofence';

  @ApiProperty({ type: GeofenceEventDataDto })
  readonly data!: GeofenceEventDataDto;

  @ApiProperty({ type: GeofenceResolutionDto, nullable: true })
  readonly resolution!: GeofenceResolutionDto | null;
}

/** A `fishing` event. */
export class FishingEventDto extends SurveillanceEventBaseDto {
  @ApiProperty({ enum: ['fishing'] })
  readonly type!: 'fishing';

  @ApiProperty({ type: FishingEventDataDto })
  readonly data!: FishingEventDataDto;

  @ApiProperty({ type: FishingResolutionDto, nullable: true })
  readonly resolution!: FishingResolutionDto | null;
}

/** The event schema of each alert type, the `type` discriminator's mapping. */
export const SURVEILLANCE_EVENT_DTOS = {
  transhipment: TranshipmentEventDto,
  anomaly: AnomalyEventDto,
  dark: DarkEventDto,
  geofence: GeofenceEventDto,
  fishing: FishingEventDto,
} as const satisfies Record<keyof typeof EVENT_MESSAGES, Type>;

/** `oneOf` the event schemas, discriminated by `type`. */
function surveillanceEventSchema() {
  const entries = Object.entries(SURVEILLANCE_EVENT_DTOS);
  return {
    oneOf: entries.map(([, dto]) => ({ $ref: getSchemaPath(dto) })),
    discriminator: {
      propertyName: 'type',
      mapping: Object.fromEntries(
        entries.map(([type, dto]) => [type, getSchemaPath(dto)]),
      ),
    },
  };
}

/** Documents a `200` surveillance event (one of the per-type schemas). */
export function ApiSurveillanceEventResponse(
  description = 'The event: one schema per alert type, discriminated by `type`',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(...Object.values(SURVEILLANCE_EVENT_DTOS)),
    ApiOkResponse({ description, schema: surveillanceEventSchema() }),
  );
}

/** Documents a `200` cursor page of surveillance events (spec §5). */
export function ApiSurveillanceEventPage(
  description = 'One page of events, newest first; each item one schema per alert type, discriminated by `type`',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(
      ...Object.values(SURVEILLANCE_EVENT_DTOS),
      CursorPageInfoDto,
    ),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        required: ['data', 'page'],
        properties: {
          data: { type: 'array', items: surveillanceEventSchema() },
          page: { $ref: getSchemaPath(CursorPageInfoDto) },
        },
      },
    }),
  );
}
