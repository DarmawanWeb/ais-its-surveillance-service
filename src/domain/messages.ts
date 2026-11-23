/**
 * Localizable texts of the surveillance events (cross-service convention of
 * the platform: the web renders Bahasa Indonesia and English). Every alert
 * keeps its English `title` and `message` (e-mail, webhooks, older clients)
 * and carries in `data` a stable `messageKey`
 * (`surveillance.<detector>.<situation>`) with flat `messageParams`; the web
 * translates from the key. The English texts are rendered from the templates
 * below with the same parameters, so the README table ("Messages") is the
 * single reference of both. Keys never contain user input; parameters may
 * (vessel and zone names).
 */

/** A value of a message parameter. */
export type MessageParamValue = string | number | boolean;

/** Flat parameters of a localizable sentence. */
export type MessageParams = Readonly<Record<string, MessageParamValue>>;

/** English templates (`{param}` placeholders) of one message key. */
export interface MessageTemplate {
  readonly key: string;
  readonly title: string;
  readonly message: string;
}

/** The message of each alert type this service raises. */
export const EVENT_MESSAGES = {
  transhipment: {
    key: 'surveillance.transhipment.suspected',
    title: 'Suspected transhipment between {mmsi} and {relatedMmsi}',
    message:
      'Vessels {mmsi} and {relatedMmsi} stayed together from {startTime} to {endTime} ' +
      '(score {accuracy} %, average priority {averagePriority})',
  },
  anomaly: {
    key: 'surveillance.anomaly.navstatus_mismatch',
    title: 'Navigational status anomaly of {mmsi}',
    message:
      'Vessel {mmsi} reports "{navstatusLabel}" ({navstatus}) while its motion predicts ' +
      '{predictedLabel}, {streak} positions in a row',
  },
  dark: {
    key: 'surveillance.dark.ais_gap',
    title: 'AIS gap of {mmsi}',
    message:
      'Vessel {mmsi} stopped reporting at {lastSeenAt} while under way at {lastSogKn} kn ' +
      '(silent for {gapMin} min)',
  },
  geofence: {
    key: 'surveillance.geofence.entered',
    title: 'Entered {zoneName}',
    message: 'Vessel {mmsi} entered {zoneName} ({zoneKind})',
  },
  fishing: {
    key: 'surveillance.fishing.loitering',
    title: 'Suspected fishing in {zoneName}',
    message:
      'Vessel {mmsi} loitered at {meanSogKn} kn with frequent course changes for ' +
      '{durationMin} min in {zoneName} ({zoneKind})',
  },
} as const satisfies Record<string, MessageTemplate>;

/** An alert type with a message (every type this service raises). */
export type MessageType = keyof typeof EVENT_MESSAGES;

/** The message keys of the events. */
export type EventMessageKey = (typeof EVENT_MESSAGES)[MessageType]['key'];

/** `true` for the alert types of {@link EVENT_MESSAGES}. */
export function isMessageType(type: string): type is MessageType {
  return Object.hasOwn(EVENT_MESSAGES, type);
}

/** The English title and message with their key and parameters (event `data`). */
export interface EventText {
  readonly title: string;
  readonly message: string;
  readonly messageKey: EventMessageKey;
  readonly messageParams: MessageParams;
}

/** `{param}` → value; unknown placeholders stay as they are. */
export function renderMessage(template: string, params: MessageParams): string {
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name) => {
    const value = params[name as string];
    return value === undefined ? match : String(value);
  });
}

/** Rounds to `digits` decimals (display values of the parameters). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Parameters without the `undefined` ones (facts a stored row may lack). */
function compact(
  entries: Record<string, MessageParamValue | null | undefined>,
): MessageParams {
  const params: Record<string, MessageParamValue> = {};
  for (const [name, value] of Object.entries(entries))
    if (value !== undefined && value !== null) params[name] = value;
  return params;
}

/** A vessel's display name: its fleet name, else its MMSI. */
function nameOf(mmsi: number, name: string | null | undefined): string {
  return name !== undefined && name !== null && name.trim() !== ''
    ? name
    : String(mmsi);
}

function iso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function text(type: MessageType, params: MessageParams): EventText {
  const template = EVENT_MESSAGES[type];
  return {
    title: renderMessage(template.title, params),
    message: renderMessage(template.message, params),
    messageKey: template.key,
    messageParams: params,
  };
}

/** Facts of a transhipment occurrence (the pair sorted by MMSI). */
export interface TranshipmentFacts {
  readonly mmsi: number;
  readonly relatedMmsi: number;
  readonly vesselName?: string | null | undefined;
  readonly relatedVesselName?: string | null | undefined;
  readonly startTime?: Date | string | undefined;
  readonly endTime?: Date | string | undefined;
  readonly accuracy?: number | undefined;
  readonly averagePriority?: number | undefined;
}

/** `surveillance.transhipment.suspected`. */
export function transhipmentText(facts: TranshipmentFacts): EventText {
  const start = iso(facts.startTime);
  const end = iso(facts.endTime);
  const durationMin =
    start === undefined || end === undefined
      ? undefined
      : Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return text(
    'transhipment',
    compact({
      mmsi: facts.mmsi,
      relatedMmsi: facts.relatedMmsi,
      vesselName: nameOf(facts.mmsi, facts.vesselName),
      relatedVesselName: nameOf(facts.relatedMmsi, facts.relatedVesselName),
      startTime: start,
      endTime: end,
      durationMin: Number.isFinite(durationMin) ? durationMin : undefined,
      accuracy:
        facts.accuracy === undefined ? undefined : roundTo(facts.accuracy, 1),
      averagePriority:
        facts.averagePriority === undefined
          ? undefined
          : roundTo(facts.averagePriority, 1),
    }),
  );
}

/** Facts of a navigational status anomaly. */
export interface AnomalyFacts {
  readonly mmsi: number;
  readonly vesselName?: string | null | undefined;
  readonly navstatus?: number | undefined;
  /** English label of `navstatus` (contracts `navStatusLabel`). */
  readonly navstatusLabel?: string | undefined;
  readonly predictedNavstatus?: number | undefined;
  readonly streak?: number | undefined;
  readonly sogKn?: number | undefined;
}

/** English label of a predicted status (0 under way, 1 at anchor). */
export function predictedLabel(predicted: number): string {
  return predicted === 1 ? 'at anchor' : 'under way';
}

/** `surveillance.anomaly.navstatus_mismatch`. */
export function anomalyText(facts: AnomalyFacts): EventText {
  return text(
    'anomaly',
    compact({
      mmsi: facts.mmsi,
      vesselName: nameOf(facts.mmsi, facts.vesselName),
      navstatus: facts.navstatus,
      navstatusLabel: facts.navstatusLabel,
      predictedNavstatus: facts.predictedNavstatus,
      predictedLabel:
        facts.predictedNavstatus === undefined
          ? undefined
          : predictedLabel(facts.predictedNavstatus),
      streak: facts.streak,
      sogKn: facts.sogKn === undefined ? undefined : roundTo(facts.sogKn, 1),
    }),
  );
}

/** Facts of an AIS gap. */
export interface DarkFacts {
  readonly mmsi: number;
  readonly vesselName?: string | null | undefined;
  readonly lastSeenAt?: Date | string | undefined;
  readonly lastSogKn?: number | undefined;
  readonly gapMin?: number | undefined;
}

/** `surveillance.dark.ais_gap`. */
export function darkText(facts: DarkFacts): EventText {
  return text(
    'dark',
    compact({
      mmsi: facts.mmsi,
      vesselName: nameOf(facts.mmsi, facts.vesselName),
      lastSeenAt: iso(facts.lastSeenAt),
      lastSogKn:
        facts.lastSogKn === undefined ? undefined : roundTo(facts.lastSogKn, 1),
      gapMin: facts.gapMin === undefined ? undefined : Math.round(facts.gapMin),
    }),
  );
}

/** Facts of a zone event (geofence entry, fishing loitering). */
export interface ZoneFacts {
  readonly mmsi: number;
  readonly vesselName?: string | null | undefined;
  readonly zoneName?: string | null | undefined;
  readonly zoneKind?: string | undefined;
  readonly zoneCode?: string | null | undefined;
}

/** Facts of a geofence entry. */
export interface GeofenceFacts extends ZoneFacts {
  readonly sogKn?: number | undefined;
}

/** `surveillance.geofence.entered`. */
export function geofenceText(facts: GeofenceFacts): EventText {
  return text(
    'geofence',
    compact({
      ...zoneParams(facts),
      sogKn: facts.sogKn === undefined ? undefined : roundTo(facts.sogKn, 1),
    }),
  );
}

/** Facts of a fishing loitering pattern. */
export interface FishingFacts extends ZoneFacts {
  readonly durationMin?: number | undefined;
  readonly meanSogKn?: number | undefined;
  readonly courseChangeRateDegPerMin?: number | undefined;
  readonly positions?: number | undefined;
}

/** `surveillance.fishing.loitering`. */
export function fishingText(facts: FishingFacts): EventText {
  return text(
    'fishing',
    compact({
      ...zoneParams(facts),
      durationMin:
        facts.durationMin === undefined
          ? undefined
          : Math.round(facts.durationMin),
      meanSogKn:
        facts.meanSogKn === undefined ? undefined : roundTo(facts.meanSogKn, 1),
      courseChangeRateDegPerMin:
        facts.courseChangeRateDegPerMin === undefined
          ? undefined
          : roundTo(facts.courseChangeRateDegPerMin, 1),
      positions: facts.positions,
    }),
  );
}

function zoneParams(
  facts: ZoneFacts,
): Record<string, MessageParamValue | undefined> {
  return {
    mmsi: facts.mmsi,
    vesselName: nameOf(facts.mmsi, facts.vesselName),
    zoneName: facts.zoneName ?? undefined,
    zoneKind: facts.zoneKind,
    zoneCode: facts.zoneCode ?? undefined,
  };
}

/**
 * Why an occurrence ended (`resolution.code`, stable). The English
 * `resolution.reason` of each code is {@link RESOLUTION_REASONS}.
 */
export const RESOLUTION_CODES = [
  /** Superseded by a more severe alert of the same occurrence. */
  'escalated',
  /** dark: the vessel reported again. */
  'ais_resumed',
  /** anomaly: a position with a consistent navigational status. */
  'navstatus_consistent',
  /** geofence / fishing: the vessel left the zone. */
  'left_zone',
  /** fishing: no qualifying fix for `FISHING_RESOLVE_AFTER_MIN`. */
  'loitering_ended',
  /** transhipment: a new analysis of the pair is negative. */
  'analysis_negative',
  /** transhipment: the pair was not observed together for `TRANSHIPMENT_PAIR_EXPIRY_MIN`. */
  'pair_separated',
  /** geofence: the zone was deleted. */
  'zone_deleted',
  /** geofence: the zone is inactive, stopped alerting on entry or is no longer watched. */
  'zone_no_longer_alerts',
  /** Imported from the legacy MVP as an ended occurrence (mongo migrator). */
  'legacy_import',
  /** A reason this version does not classify (see `reason`). */
  'other',
] as const;

/** A {@link RESOLUTION_CODES} value. */
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

/** A code the detectors resolve with. */
export type DetectorResolutionCode = Exclude<
  ResolutionCode,
  'legacy_import' | 'other'
>;

/** English `resolution.reason` of each detector code (unchanged since 0.1.0). */
export const RESOLUTION_REASONS: Readonly<
  Record<DetectorResolutionCode, string>
> = {
  escalated: 'escalated',
  ais_resumed: 'AIS reports resumed',
  navstatus_consistent: 'navigational status consistent again',
  left_zone: 'left the zone',
  loitering_ended: 'loitering pattern ended',
  analysis_negative: 'analysis no longer positive',
  pair_separated: 'pair no longer observed together',
  zone_deleted: 'zone deleted',
  zone_no_longer_alerts: 'zone no longer alerts on entry',
};

const CODE_OF_REASON: ReadonlyMap<string, ResolutionCode> = new Map([
  ...Object.entries(RESOLUTION_REASONS).map(
    ([code, reason]) => [reason, code as ResolutionCode] as const,
  ),
  ['legacy_import', 'legacy_import'],
]);

/** `true` for a {@link RESOLUTION_CODES} value. */
export function isResolutionCode(value: unknown): value is ResolutionCode {
  return (
    typeof value === 'string' &&
    (RESOLUTION_CODES as readonly string[]).includes(value)
  );
}

/**
 * The code of a stored resolution: its `code`, else the code of its English
 * `reason` (rows written before 0.2.0 and by the migrator), else `other`.
 */
export function resolutionCodeOf(
  resolution: Readonly<Record<string, unknown>>,
): ResolutionCode {
  if (isResolutionCode(resolution.code)) return resolution.code;
  const reason = resolution.reason;
  return (
    (typeof reason === 'string' ? CODE_OF_REASON.get(reason) : undefined) ??
    'other'
  );
}

/**
 * Options of `context.alerts.resolve()` for a code: the English reason and
 * `data.code` (published in `alert.resolved.v1` and stored in
 * `events.resolution`), plus the detector's extra data.
 */
export function resolution(
  code: DetectorResolutionCode,
  data: Readonly<Record<string, unknown>> = {},
): {
  readonly reason: string;
  readonly data: Readonly<Record<string, unknown>>;
} {
  return { reason: RESOLUTION_REASONS[code], data: { ...data, code } };
}
