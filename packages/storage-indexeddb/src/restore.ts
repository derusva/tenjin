import {
  serializeContextHashInput,
  validateEvent,
  type Event,
  type HybridLogicalClock,
} from "@tenjin/core";

import type { ContextImageMediaType, ContextRecord } from "./repository.js";
import {
  assertCoachImportReceipt,
  type CoachImportReceipt,
} from "./importReceipt.js";
import {
  assertRestoreCommitRecord,
  isCanonicalDeviceId,
  isCanonicalUtcTimestamp,
  type RestoreCommitRecord,
} from "./restoreCommit.js";

export interface RestoreContextInput {
  readonly hash: string;
  readonly original: string;
  readonly focus?: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly image?: {
    readonly mediaType: ContextImageMediaType;
    readonly name: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly bytes: Uint8Array;
  };
  readonly createdAt: string;
}

export interface RestoreLedgerInput {
  readonly events: readonly Event[];
  readonly contexts: readonly RestoreContextInput[];
  readonly importReceipts?: readonly CoachImportReceipt[];
  readonly globalHlc: HybridLogicalClock;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly forbiddenDeviceIds: readonly string[];
}

export interface LedgerRestorer {
  restoreLedger(input: RestoreLedgerInput, newDeviceId: string): Promise<void>;
  readRestoreCommit(): Promise<RestoreCommitRecord | undefined>;
}

export interface PreparedRestoreLedger {
  readonly events: readonly Event[];
  readonly contexts: readonly ContextRecord[];
  readonly importReceipts: readonly CoachImportReceipt[];
  readonly globalHlc: HybridLogicalClock;
  readonly maxSeqByDevice: readonly (readonly [string, number])[];
  readonly marker: RestoreCommitRecord;
}

const CONTEXT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BARE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTEXT_FIELDS: readonly string[] = [
  "hash",
  "original",
  "focus",
  "corrected",
  "answer",
  "image",
  "createdAt",
];
const IMAGE_FIELDS: readonly string[] = [
  "mediaType",
  "name",
  "byteLength",
  "sha256",
  "bytes",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unknown = Reflect.ownKeys(value)
    .filter((field) => typeof field !== "string" || !allowed.includes(field))
    .map(String)
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`${subject} carries unknown field(s): ${unknown.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertValidHlc(
  value: unknown,
  field: string,
): asserts value is HybridLogicalClock {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  assertNoUnknownFields(value, ["wallTime", "counter"], field);
  for (const component of ["wallTime", "counter"] as const) {
    if (
      typeof value[component] !== "number" ||
      !Number.isSafeInteger(value[component]) ||
      value[component] < 0
    ) {
      throw new TypeError(
        `${field}.${component} must be a non-negative safe integer`,
      );
    }
  }
}

function compareHlc(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  return left.wallTime - right.wallTime || left.counter - right.counter;
}

function successorHlc(input: HybridLogicalClock): HybridLogicalClock {
  if (input.counter < Number.MAX_SAFE_INTEGER) {
    return { wallTime: input.wallTime, counter: input.counter + 1 };
  }
  if (input.wallTime < Number.MAX_SAFE_INTEGER) {
    return { wallTime: input.wallTime + 1, counter: 0 };
  }
  throw new RangeError("hybrid logical clock successor is exhausted");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function prepareContext(
  candidate: RestoreContextInput,
): Promise<ContextRecord> {
  if (!isRecord(candidate)) {
    throw new TypeError("restore context must be an object");
  }
  assertNoUnknownFields(candidate, CONTEXT_FIELDS, "restore context");
  if (!CONTEXT_HASH_PATTERN.test(candidate.hash)) {
    throw new TypeError(
      "restore context hash must be sha256: followed by 64 lowercase hexadecimal characters",
    );
  }
  const original = requireNonEmptyString(
    candidate.original,
    "restore context original",
  );
  const focus = Object.hasOwn(candidate, "focus")
    ? requireNonEmptyString(candidate.focus, "restore context focus")
    : undefined;
  const corrected = Object.hasOwn(candidate, "corrected")
    ? requireNonEmptyString(candidate.corrected, "restore context corrected")
    : undefined;
  const answer = Object.hasOwn(candidate, "answer")
    ? requireNonEmptyString(candidate.answer, "restore context answer")
    : undefined;
  if (!isCanonicalUtcTimestamp(candidate.createdAt)) {
    throw new TypeError(
      "restore context createdAt must be a canonical UTC ISO-8601 timestamp",
    );
  }

  let image: ContextRecord["image"];
  let imageSha256: string | undefined;
  if (Object.hasOwn(candidate, "image")) {
    if (!isRecord(candidate.image)) {
      throw new TypeError("restore context image must be an object");
    }
    assertNoUnknownFields(candidate.image, IMAGE_FIELDS, "restore context image");
    const imageInput = candidate.image;
    const name = requireNonEmptyString(imageInput.name, "restore context image name");
    if (!(imageInput.bytes instanceof Uint8Array)) {
      throw new TypeError("restore context image bytes must be a Uint8Array");
    }
    if (
      typeof imageInput.byteLength !== "number" ||
      !Number.isSafeInteger(imageInput.byteLength) ||
      imageInput.byteLength < 1
    ) {
      throw new TypeError(
        "restore context image byteLength must be a positive safe integer",
      );
    }
    if (imageInput.byteLength !== imageInput.bytes.byteLength) {
      throw new TypeError(
        "restore context image byteLength must equal the carried bytes",
      );
    }
    if (!BARE_DIGEST_PATTERN.test(imageInput.sha256)) {
      throw new TypeError(
        "restore context image sha256 must be 64 lowercase hexadecimal characters",
      );
    }
    const bytes = imageInput.bytes.slice();
    const blob = new Blob([bytes], { type: imageInput.mediaType });
    imageSha256 = imageInput.sha256;
    image = {
      blob,
      mediaType: imageInput.mediaType,
      name,
      byteLength: imageInput.byteLength,
      sha256: imageInput.sha256,
    };
  }

  const actualContextDigest = await sha256Hex(
    new TextEncoder().encode(
      serializeContextHashInput({
        original,
        ...(focus === undefined ? {} : { focus }),
        ...(corrected === undefined ? {} : { corrected }),
        ...(answer === undefined ? {} : { answer }),
        ...(imageSha256 === undefined ? {} : { imageSha256 }),
      }),
    ),
  );
  if (candidate.hash !== `sha256:${actualContextDigest}`) {
    throw new TypeError(
      "restore context sha256 must match its serialized content",
    );
  }

  return {
    hash: candidate.hash,
    original,
    ...(focus === undefined ? {} : { focus }),
    ...(corrected === undefined ? {} : { corrected }),
    ...(answer === undefined ? {} : { answer }),
    ...(image === undefined ? {} : { image }),
    createdAt: candidate.createdAt,
  };
}

function validateWatermarks(
  events: readonly Event[],
  declaredHlc: HybridLogicalClock,
  declaredSequences: Readonly<Record<string, number>>,
): readonly (readonly [string, number])[] {
  assertValidHlc(declaredHlc, "restore globalHlc");
  if (!isRecord(declaredSequences)) {
    throw new TypeError("restore maxSeqByDevice must be an object");
  }
  const sequenceEntries = Object.entries(declaredSequences).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [deviceId, sequence] of sequenceEntries) {
    if (!isCanonicalDeviceId(deviceId)) {
      throw new TypeError("maxSeqByDevice keys must be canonical device ids");
    }
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new TypeError("maxSeqByDevice values must be positive safe integers");
    }
  }

  const actualSequences = new Map<string, number>();
  let actualHlc: HybridLogicalClock = { wallTime: 0, counter: 0 };
  for (const event of events) {
    actualSequences.set(
      event.deviceId,
      Math.max(actualSequences.get(event.deviceId) ?? 0, event.seq),
    );
    if (compareHlc(event.hlc, actualHlc) > 0) actualHlc = event.hlc;
  }
  const actualEntries = [...actualSequences.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    compareHlc(declaredHlc, actualHlc) !== 0 ||
    JSON.stringify(sequenceEntries) !== JSON.stringify(actualEntries)
  ) {
    throw new TypeError(
      "restore clock watermarks must exactly match the validated event set",
    );
  }
  return sequenceEntries;
}

/** Performs every non-IDB operation before the atomic restore transaction. */
export async function prepareRestoreLedger(
  input: RestoreLedgerInput,
  newDeviceId: string,
): Promise<PreparedRestoreLedger> {
  if (!isRecord(input)) throw new TypeError("restore input must be an object");
  if (!isCanonicalDeviceId(newDeviceId)) {
    throw new TypeError(
      "newDeviceId must be a non-empty canonical string without surrounding whitespace",
    );
  }
  if (!Array.isArray(input.events) || !Array.isArray(input.contexts)) {
    throw new TypeError("restore events and contexts must be arrays");
  }
  if (
    Object.hasOwn(input, "importReceipts") &&
    !Array.isArray(input.importReceipts)
  ) {
    throw new TypeError("restore importReceipts must be an array when present");
  }
  if (!Array.isArray(input.forbiddenDeviceIds)) {
    throw new TypeError("restore forbiddenDeviceIds must be an array");
  }

  const events = input.events.map((event) => structuredClone(event));
  const eventIds = new Set<string>();
  const eventCoordinates = new Set<string>();
  const eventDeviceIds = new Set<string>();
  for (const event of events) {
    const result = validateEvent(event);
    if (!result.valid) {
      throw new TypeError(
        `Invalid restore event: ${result.errors
          .map(({ field, message }) => `${field}: ${message}`)
          .join("; ")}`,
      );
    }
    if (event.eventId !== `${event.deviceId}:${event.seq}`) {
      throw new TypeError("restore eventId must equal deviceId:seq");
    }
    if (eventIds.has(event.eventId)) {
      throw new TypeError(`duplicate restore eventId ${event.eventId}`);
    }
    const coordinate = `${event.deviceId}\u0000${event.seq}`;
    if (eventCoordinates.has(coordinate)) {
      throw new TypeError("duplicate restore deviceId and seq coordinate");
    }
    eventIds.add(event.eventId);
    eventCoordinates.add(coordinate);
    eventDeviceIds.add(event.deviceId);
  }

  const forbiddenDeviceIds = new Set<string>();
  for (const deviceId of input.forbiddenDeviceIds) {
    if (!isCanonicalDeviceId(deviceId)) {
      throw new TypeError("forbiddenDeviceIds must contain canonical device ids");
    }
    forbiddenDeviceIds.add(deviceId);
  }
  if (forbiddenDeviceIds.has(newDeviceId)) {
    throw new TypeError("newDeviceId is forbidden by the restore package");
  }
  if (eventDeviceIds.has(newDeviceId)) {
    throw new TypeError("newDeviceId must not reuse a historical event device");
  }

  const maxSeqByDevice = validateWatermarks(
    events,
    input.globalHlc,
    input.maxSeqByDevice,
  );
  const contexts = await Promise.all(input.contexts.map(prepareContext));
  const contextHashes = new Set<string>();
  for (const context of contexts) {
    if (contextHashes.has(context.hash)) {
      throw new TypeError(`duplicate restore context hash ${context.hash}`);
    }
    contextHashes.add(context.hash);
  }

  const availableCaptureIds = new Set(
    events
      .filter((event) => event.kind === "capture_created")
      .map((event) => event.captureId),
  );
  const receiptDigests = new Set<string>();
  const importReceipts: CoachImportReceipt[] = [];
  for (const candidate of input.importReceipts ?? []) {
    assertCoachImportReceipt(candidate);
    const receipt = structuredClone(candidate);
    assertCoachImportReceipt(receipt);
    if (receiptDigests.has(receipt.digest)) {
      throw new TypeError(`duplicate restore import receipt ${receipt.digest}`);
    }
    for (const captureId of receipt.captureIds) {
      if (!availableCaptureIds.has(captureId)) {
        throw new TypeError(
          `restore import receipt references unknown captureId ${captureId}`,
        );
      }
    }
    receiptDigests.add(receipt.digest);
    importReceipts.push(receipt);
  }

  const marker: RestoreCommitRecord = {
    key: "restore-commit",
    type: "restore-commit",
    newDeviceId,
    committedAt: new Date().toISOString(),
  };
  assertRestoreCommitRecord(marker);

  return {
    events,
    contexts,
    importReceipts,
    globalHlc: successorHlc(input.globalHlc),
    maxSeqByDevice,
    marker,
  };
}
