export const EVENT_KINDS = [
  "capture_created",
  "capture_discarded",
  "item_created",
  "lookup_observed",
  "listening_miss_observed",
  "production_correction_observed",
  "verification_observed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface HybridLogicalClock {
  readonly wallTime: number;
  readonly counter: number;
}

export type EventActor = "user" | "deterministic_rule" | "llm_proposal";

export type EventPayload = Readonly<Record<string, unknown>>;
export type LearningChannel = "R" | "L" | "P";

export interface EventEnvelope<
  Kind extends EventKind,
  Payload extends object = EventPayload,
> {
  readonly schemaVersion?: number;
  readonly eventId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly hlc: HybridLogicalClock;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor?: EventActor;
  readonly kind: Kind;
  readonly ruleVersion?: string;
  readonly itemId?: string;
  readonly captureId?: string;
  readonly contextHash?: string;
  readonly refs?: readonly string[];
  readonly payload: Payload;
}

export interface CaptureCreatedPayload {
  readonly captureType: "lookup" | "listening_miss" | "production_correction";
  readonly captureDurationMs?: number;
}

export interface CaptureDiscardedPayload {
  readonly reason?: "undo" | "discarded";
}

export interface ItemCreatedPayload {
  readonly display: string;
  readonly identityKey: string;
  readonly targetChannels: readonly LearningChannel[];
}

export interface LookupObservedPayload {
  readonly channel: "R";
  readonly result: "lookup";
}

export interface ListeningMissObservedPayload {
  readonly channel: "L";
  readonly result: "miss";
}

export interface ProductionCorrectionObservedPayload {
  readonly channel: "P";
  readonly result: "correction";
}

export interface VerificationObservedPayload {
  readonly channel: LearningChannel;
  readonly result: "pass" | "hesitant" | "fail";
  readonly probeSource: string;
  readonly immediateRetest: boolean;
}

export type CaptureCreatedEvent = EventEnvelope<
  "capture_created",
  CaptureCreatedPayload
> & {
  readonly captureId: string;
  readonly contextHash: string;
};

export type CaptureDiscardedEvent = EventEnvelope<
  "capture_discarded",
  CaptureDiscardedPayload
> & {
  readonly captureId: string;
};
export type ItemCreatedEvent = EventEnvelope<
  "item_created",
  ItemCreatedPayload
> & {
  readonly itemId: string;
  readonly captureId: string;
};
export type LookupObservedEvent = EventEnvelope<
  "lookup_observed",
  LookupObservedPayload
> & {
  readonly itemId: string;
  readonly captureId: string;
};
export type ListeningMissObservedEvent = EventEnvelope<
  "listening_miss_observed",
  ListeningMissObservedPayload
> & {
  readonly itemId: string;
  readonly captureId: string;
};
export type ProductionCorrectionObservedEvent = EventEnvelope<
  "production_correction_observed",
  ProductionCorrectionObservedPayload
> & {
  readonly itemId: string;
  readonly captureId: string;
};
export type VerificationObservedEvent = EventEnvelope<
  "verification_observed",
  VerificationObservedPayload
> & {
  readonly itemId: string;
};

export type Event =
  | CaptureCreatedEvent
  | CaptureDiscardedEvent
  | ItemCreatedEvent
  | LookupObservedEvent
  | ListeningMissObservedEvent
  | ProductionCorrectionObservedEvent
  | VerificationObservedEvent;

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export type ValidationResult =
  | {
      readonly valid: true;
      readonly value: Event;
    }
  | {
      readonly valid: false;
      readonly errors: readonly ValidationIssue[];
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addNonEmptyStringIssue(
  record: Record<string, unknown>,
  field: string,
  errors: ValidationIssue[],
  issueField = field,
): void {
  if (!isNonEmptyString(record[field])) {
    errors.push({
      field: issueField,
      message: `${issueField} must be a non-empty string`,
    });
  }
}

function getPayload(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(candidate.payload)) {
    errors.push({ field: "payload", message: "payload must be an object" });
    return undefined;
  }

  return candidate.payload;
}

function parseTimestamp(value: unknown): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString() === value ? timestamp : undefined;
}

const CAPTURE_CREATED_PAYLOAD_FIELDS = new Set([
  "captureType",
  "captureDurationMs",
]);
const CAPTURE_DISCARDED_PAYLOAD_FIELDS = new Set(["reason"]);
const ITEM_CREATED_PAYLOAD_FIELDS = new Set([
  "display",
  "identityKey",
  "targetChannels",
]);
const CHANNEL_OBSERVATION_PAYLOAD_FIELDS = new Set(["channel", "result"]);
const VERIFICATION_OBSERVED_PAYLOAD_FIELDS = new Set([
  "channel",
  "result",
  "probeSource",
  "immediateRetest",
]);
const HLC_FIELDS = new Set(["wallTime", "counter"]);
const COMMON_EVENT_ENVELOPE_FIELDS = [
  "schemaVersion",
  "eventId",
  "deviceId",
  "seq",
  "hlc",
  "occurredAt",
  "recordedAt",
  "actor",
  "kind",
  "ruleVersion",
  "refs",
  "payload",
] as const;
const EVENT_ENVELOPE_FIELDS: Readonly<Record<EventKind, ReadonlySet<string>>> = {
  capture_created: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "captureId",
    "contextHash",
  ]),
  capture_discarded: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "captureId",
  ]),
  item_created: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "itemId",
    "captureId",
  ]),
  lookup_observed: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "itemId",
    "captureId",
  ]),
  listening_miss_observed: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "itemId",
    "captureId",
  ]),
  production_correction_observed: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "itemId",
    "captureId",
  ]),
  verification_observed: new Set([
    ...COMMON_EVENT_ENVELOPE_FIELDS,
    "itemId",
  ]),
};
const EVENT_KIND_SET = new Set<EventKind>(EVENT_KINDS);
const EVENT_ACTORS = new Set<unknown>([
  "user",
  "deterministic_rule",
  "llm_proposal",
]);
const CAPTURE_TYPES = new Set([
  "lookup",
  "listening_miss",
  "production_correction",
]);
const LEARNING_CHANNELS = new Set<unknown>(["R", "L", "P"]);
const VERIFICATION_RESULTS = new Set<unknown>([
  "pass",
  "hesitant",
  "fail",
]);

function validateAllowedFields(
  record: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  errors: ValidationIssue[],
  fieldPrefix = "",
  eventKind?: EventKind,
): void {
  for (const field of Object.keys(record)) {
    if (allowedFields.has(field)) {
      continue;
    }

    const issueField = fieldPrefix.length > 0 ? `${fieldPrefix}.${field}` : field;
    errors.push({
      field: issueField,
      message:
        eventKind === undefined
          ? `${issueField} is not allowed`
          : `${issueField} is not allowed for ${eventKind}`,
    });
  }
}

function validateEnvelopeFields(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): void {
  if (candidate.schemaVersion !== 1) {
    errors.push({
      field: "schemaVersion",
      message: "schemaVersion must be 1",
    });
  }

  if (Object.hasOwn(candidate, "actor") && !EVENT_ACTORS.has(candidate.actor)) {
    errors.push({
      field: "actor",
      message: "actor must be user, deterministic_rule, or llm_proposal",
    });
  }

  if (
    Object.hasOwn(candidate, "ruleVersion") &&
    !isNonEmptyString(candidate.ruleVersion)
  ) {
    errors.push({
      field: "ruleVersion",
      message: "ruleVersion must be a non-empty string",
    });
  }

  if (
    Object.hasOwn(candidate, "refs") &&
    (!Array.isArray(candidate.refs) ||
      !candidate.refs.every((ref) => isNonEmptyString(ref)))
  ) {
    errors.push({
      field: "refs",
      message: "refs must be an array of non-empty event IDs",
    });
  }
}

function validateCaptureCreated(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): void {
  addNonEmptyStringIssue(candidate, "captureId", errors);
  addNonEmptyStringIssue(candidate, "contextHash", errors);

  const payload = getPayload(candidate, errors);
  if (payload === undefined) {
    return;
  }

  validateAllowedFields(
    payload,
    CAPTURE_CREATED_PAYLOAD_FIELDS,
    errors,
    "payload",
    "capture_created",
  );

  if (!CAPTURE_TYPES.has(payload.captureType as string)) {
    errors.push({
      field: "payload.captureType",
      message: "payload.captureType must be a supported capture type",
    });
  }

  if (
    Object.hasOwn(payload, "captureDurationMs") &&
    (!Number.isSafeInteger(payload.captureDurationMs) ||
      (payload.captureDurationMs as number) < 0)
  ) {
    errors.push({
      field: "payload.captureDurationMs",
      message: "payload.captureDurationMs must be a non-negative safe integer",
    });
  }

}

function validateCaptureDiscarded(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): void {
  addNonEmptyStringIssue(candidate, "captureId", errors);
  const payload = getPayload(candidate, errors);

  if (payload !== undefined) {
    validateAllowedFields(
      payload,
      CAPTURE_DISCARDED_PAYLOAD_FIELDS,
      errors,
      "payload",
      "capture_discarded",
    );
  }

  if (
    payload !== undefined &&
    Object.hasOwn(payload, "reason") &&
    payload.reason !== "undo" &&
    payload.reason !== "discarded"
  ) {
    errors.push({
      field: "payload.reason",
      message: "payload.reason must be undo or discarded",
    });
  }
}

function validateItemCreated(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): void {
  addNonEmptyStringIssue(candidate, "itemId", errors);
  addNonEmptyStringIssue(candidate, "captureId", errors);
  const payload = getPayload(candidate, errors);
  if (payload === undefined) {
    return;
  }

  validateAllowedFields(
    payload,
    ITEM_CREATED_PAYLOAD_FIELDS,
    errors,
    "payload",
    "item_created",
  );

  addNonEmptyStringIssue(payload, "display", errors, "payload.display");
  addNonEmptyStringIssue(payload, "identityKey", errors, "payload.identityKey");
  if (
    !Array.isArray(payload.targetChannels) ||
    payload.targetChannels.length === 0 ||
    !payload.targetChannels.every((channel) => LEARNING_CHANNELS.has(channel))
  ) {
    errors.push({
      field: "payload.targetChannels",
      message: "payload.targetChannels must contain supported channels",
    });
  }
}

function validateChannelObservation(
  candidate: Record<string, unknown>,
  channel: LearningChannel,
  result: "lookup" | "miss" | "correction",
  errors: ValidationIssue[],
): void {
  addNonEmptyStringIssue(candidate, "itemId", errors);
  addNonEmptyStringIssue(candidate, "captureId", errors);
  const payload = getPayload(candidate, errors);
  if (payload === undefined) {
    return;
  }

  validateAllowedFields(
    payload,
    CHANNEL_OBSERVATION_PAYLOAD_FIELDS,
    errors,
    "payload",
    candidate.kind as EventKind,
  );

  if (payload.channel !== channel) {
    errors.push({
      field: "payload.channel",
      message: `payload.channel must be ${channel}`,
    });
  }
  if (payload.result !== result) {
    errors.push({
      field: "payload.result",
      message: `payload.result must be ${result}`,
    });
  }
}

function validateVerificationObserved(
  candidate: Record<string, unknown>,
  errors: ValidationIssue[],
): void {
  addNonEmptyStringIssue(candidate, "itemId", errors);
  const payload = getPayload(candidate, errors);
  if (payload === undefined) {
    return;
  }

  validateAllowedFields(
    payload,
    VERIFICATION_OBSERVED_PAYLOAD_FIELDS,
    errors,
    "payload",
    "verification_observed",
  );

  if (!LEARNING_CHANNELS.has(payload.channel)) {
    errors.push({
      field: "payload.channel",
      message: "payload.channel must be R, L, or P",
    });
  }
  if (!VERIFICATION_RESULTS.has(payload.result)) {
    errors.push({
      field: "payload.result",
      message: "payload.result must be pass, hesitant, or fail",
    });
  }
  addNonEmptyStringIssue(
    payload,
    "probeSource",
    errors,
    "payload.probeSource",
  );
  if (typeof payload.immediateRetest !== "boolean") {
    errors.push({
      field: "payload.immediateRetest",
      message: "payload.immediateRetest must be a boolean",
    });
  }
}

export function validateEvent(event: unknown): ValidationResult {
  if (typeof event !== "object" || event === null) {
    return {
      valid: false,
      errors: [
        {
          field: "$",
          message: "event must be an object",
        },
      ],
    };
  }

  const candidate = event as Record<string, unknown>;
  const errors: ValidationIssue[] = [];
  const occurredAt = parseTimestamp(candidate.occurredAt);
  const recordedAt = parseTimestamp(candidate.recordedAt);

  if (!isNonEmptyString(candidate.eventId)) {
    errors.push({
      field: "eventId",
      message: "eventId must be a non-empty string",
    });
  }

  if (!isNonEmptyString(candidate.deviceId)) {
    errors.push({
      field: "deviceId",
      message: "deviceId must be a non-empty string",
    });
  }

  validateEnvelopeFields(candidate, errors);

  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) <= 0) {
    errors.push({
      field: "seq",
      message: "seq must be a positive safe integer",
    });
  }

  if (
    typeof candidate.hlc !== "object" ||
    candidate.hlc === null ||
    Array.isArray(candidate.hlc)
  ) {
    errors.push({
      field: "hlc",
      message: "hlc must be an object",
    });
  } else {
    const hlc = candidate.hlc as Record<string, unknown>;

    if (
      !Number.isSafeInteger(hlc.wallTime) ||
      (hlc.wallTime as number) < 0
    ) {
      errors.push({
        field: "hlc.wallTime",
        message: "hlc.wallTime must be a non-negative safe integer",
      });
    }

    if (!Number.isSafeInteger(hlc.counter) || (hlc.counter as number) < 0) {
      errors.push({
        field: "hlc.counter",
        message: "hlc.counter must be a non-negative safe integer",
      });
    }

    validateAllowedFields(hlc, HLC_FIELDS, errors, "hlc");
  }

  if (occurredAt === undefined) {
    errors.push({
      field: "occurredAt",
      message: "occurredAt must be a canonical UTC ISO-8601 string",
    });
  }

  if (recordedAt === undefined) {
    errors.push({
      field: "recordedAt",
      message: "recordedAt must be a canonical UTC ISO-8601 string",
    });
  }

  if (
    occurredAt !== undefined &&
    recordedAt !== undefined &&
    occurredAt > recordedAt
  ) {
    errors.push({
      field: "occurredAt",
      message: "occurredAt must not be later than recordedAt",
    });
  }

  if (
    typeof candidate.kind !== "string" ||
    !EVENT_KIND_SET.has(candidate.kind as EventKind)
  ) {
    errors.push({
      field: "kind",
      message: "kind must be a supported event kind",
    });
  } else {
    validateAllowedFields(
      candidate,
      EVENT_ENVELOPE_FIELDS[candidate.kind as EventKind],
      errors,
      "",
      candidate.kind as EventKind,
    );
  }

  switch (candidate.kind) {
    case "capture_created":
      validateCaptureCreated(candidate, errors);
      break;
    case "capture_discarded":
      validateCaptureDiscarded(candidate, errors);
      break;
    case "item_created":
      validateItemCreated(candidate, errors);
      break;
    case "lookup_observed":
      validateChannelObservation(candidate, "R", "lookup", errors);
      break;
    case "listening_miss_observed":
      validateChannelObservation(candidate, "L", "miss", errors);
      break;
    case "production_correction_observed":
      validateChannelObservation(candidate, "P", "correction", errors);
      break;
    case "verification_observed":
      validateVerificationObserved(candidate, errors);
      break;
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  return {
    valid: true,
    value: event as Event,
  };
}
