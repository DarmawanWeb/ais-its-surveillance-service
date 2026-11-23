import {
  isNavStatus,
  navStatusLabel,
} from '@darmawanweb/ais-its-contracts/domain';

import {
  anomalyText,
  darkText,
  type EventText,
  fishingText,
  geofenceText,
  isMessageType,
  resolutionCodeOf,
  transhipmentText,
} from '../../domain/messages.js';
import type { EventRecord } from './events.repository.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The message of a stored event rebuilt from its row: events written before
 * 0.2.0 (and the legacy imports of the mongo migrator) carry no
 * `messageKey`. The parameters come from the stored data and the current
 * names of the projections; facts the row lacks are left out.
 */
export function deriveEventText(record: EventRecord): EventText | undefined {
  if (!isMessageType(record.type)) return undefined;
  const { data } = record;
  switch (record.type) {
    case 'transhipment':
      return transhipmentText({
        mmsi: record.mmsi,
        relatedMmsi: record.relatedMmsi ?? record.mmsi,
        vesselName: record.vesselName,
        relatedVesselName: record.relatedVesselName,
        startTime: str(data.startTimestamp),
        endTime: str(data.endTimestamp),
        accuracy: num(data.accuracy),
        averagePriority: num(data.averagePriority),
      });
    case 'anomaly': {
      const navstatus = num(data.navstatus);
      return anomalyText({
        mmsi: record.mmsi,
        vesselName: record.vesselName,
        navstatus,
        navstatusLabel:
          navstatus !== undefined && isNavStatus(navstatus)
            ? navStatusLabel(navstatus)
            : undefined,
        predictedNavstatus: num(data.predictedNavstatus),
        streak: num(data.streak),
        sogKn: num(data.sogKn),
      });
    }
    case 'dark':
      return darkText({
        mmsi: record.mmsi,
        vesselName: record.vesselName,
        lastSeenAt: str(data.lastSeenAt),
        lastSogKn: num(data.lastSogKn),
        gapMin: num(data.gapMin),
      });
    case 'geofence':
      return geofenceText({
        mmsi: record.mmsi,
        vesselName: record.vesselName,
        zoneName: str(data.zoneName) ?? record.zoneName,
        zoneKind: str(data.zoneKind),
        zoneCode: str(data.zoneCode),
        sogKn: num(data.sogKn),
      });
    case 'fishing':
      return fishingText({
        mmsi: record.mmsi,
        vesselName: record.vesselName,
        zoneName: str(data.zoneName) ?? record.zoneName,
        zoneKind: str(data.zoneKind),
        zoneCode: str(data.zoneCode),
        durationMin: num(data.durationMin),
        meanSogKn: num(data.meanSogKn),
        courseChangeRateDegPerMin: num(data.courseChangeRateDegPerMin),
        positions: num(data.positions),
      });
  }
}

/** The event's `data` with `messageKey` / `messageParams` (stored, else derived). */
export function eventDataOf(record: EventRecord): Record<string, unknown> {
  const { data } = record;
  if (
    typeof data.messageKey === 'string' &&
    typeof data.messageParams === 'object' &&
    data.messageParams !== null
  )
    return data;
  const text = deriveEventText(record);
  return text === undefined
    ? data
    : {
        ...data,
        messageKey: text.messageKey,
        messageParams: text.messageParams,
      };
}

/** The event's `resolution` with its stable `code` (stored, else derived). */
export function eventResolutionOf(
  record: EventRecord,
): Record<string, unknown> | null {
  const { resolution } = record;
  if (resolution === null) return null;
  return {
    ...resolution,
    reason: typeof resolution.reason === 'string' ? resolution.reason : null,
    code: resolutionCodeOf(resolution),
  };
}
