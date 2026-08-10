import {
  serializeContextHashInput,
  validateEvent,
  type CaptureCreatedEvent,
  type CaptureDiscardedEvent,
  type Event,
  type HybridLogicalClock,
} from "@tenjin/core";
import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
} from "idb";

import {
  assertRestoreCommitRecord,
  RESTORE_COMMIT_KEY,
  type RestoreCommitRecord,
} from "./restoreCommit.js";
import {
  prepareRestoreLedger,
  type LedgerRestorer,
  type RestoreLedgerInput,
} from "./restore.js";
import {
  assertCoachImportDigest,
  assertCoachImportReceipt,
  type CoachImportReceipt,
} from "./importReceipt.js";

export const CONTEXT_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
] as const;
export const MAX_CONTEXT_IMAGE_BYTES = 20 * 1024 * 1024;

export type ContextImageMediaType =
  (typeof CONTEXT_IMAGE_MEDIA_TYPES)[number];

export interface ContextImageRecord {
  readonly blob: Blob;
  readonly mediaType: ContextImageMediaType;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ContextRecord {
  readonly hash: string;
  readonly original: string;
  readonly focus?: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly image?: ContextImageRecord;
  readonly createdAt: string;
}

export interface LedgerSnapshot {
  readonly events: readonly Event[];
  readonly contexts: readonly ContextRecord[];
}

export interface LedgerBackupSnapshot extends LedgerSnapshot {
  readonly importReceipts: readonly CoachImportReceipt[];
}

export interface CaptureWrite {
  readonly events: readonly Event[];
  readonly context: ContextRecord;
}

export interface DiscardWrite {
  readonly event: CaptureDiscardedEvent;
  readonly contextHash: string;
}

export interface EventCoordinate {
  readonly seq: number;
  readonly hlc: HybridLogicalClock;
}

export interface LedgerRepository {
  reserveEventCoordinates(
    deviceId: string,
    physicalTime: number,
    count: number,
  ): Promise<readonly EventCoordinate[]>;
  appendCapture(
    events: readonly Event[],
    context: ContextRecord,
  ): Promise<void>;
  appendEvents(events: readonly Event[]): Promise<void>;
  appendDiscard(
    event: CaptureDiscardedEvent,
    contextHash: string,
  ): Promise<void>;
  readSnapshot(): Promise<LedgerSnapshot>;
  close(): void;
}

/** Optional capability kept separate so existing LedgerRepository mocks stay valid. */
export interface CoachImportRepository {
  hasImportReceipt(digest: string): Promise<boolean>;
  appendImportedCaptureBatch(
    writes: readonly CaptureWrite[],
    receipt: CoachImportReceipt,
  ): Promise<"imported" | "already-imported">;
  appendDiscardBatch(writes: readonly DiscardWrite[]): Promise<void>;
}

/** Backup reads include fold-external state without widening LedgerRepository. */
export interface LedgerBackupReader {
  readBackupSnapshot(): Promise<LedgerBackupSnapshot>;
}

export type OpenedLedgerRepository = LedgerRepository &
  LedgerRestorer &
  CoachImportRepository &
  LedgerBackupReader;

export interface OpenLedgerRepositoryOptions {
  readonly dbName?: string;
}

interface LedgerDatabase extends DBSchema {
  events: {
    key: string;
    value: Event;
  };
  contexts: {
    key: string;
    value: ContextRecord;
  };
  clock: {
    key: string;
    value: AllocatorRecord;
  };
  importReceipts: {
    key: string;
    value: CoachImportReceipt;
  };
}

interface GlobalClockRecord {
  readonly key: "global-hlc";
  readonly type: "global-hlc";
  readonly hlc: HybridLogicalClock;
}

interface DeviceSequenceRecord {
  readonly key: string;
  readonly type: "device-sequence";
  readonly deviceId: string;
  readonly seq: number;
}

type AllocatorRecord =
  | GlobalClockRecord
  | DeviceSequenceRecord
  | RestoreCommitRecord;

const GLOBAL_CLOCK_KEY = "global-hlc";
const CONTEXT_IMAGE_MEDIA_TYPE_SET = new Set<string>(
  CONTEXT_IMAGE_MEDIA_TYPES,
);
const SHA256_HEXADECIMAL = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256_HEXADECIMAL = /^sha256:[a-f0-9]{64}$/;
const CONTEXT_FIELD_SET = new Set([
  "hash",
  "original",
  "focus",
  "corrected",
  "answer",
  "image",
  "createdAt",
]);
const CONTEXT_IMAGE_FIELD_SET = new Set([
  "blob",
  "mediaType",
  "name",
  "byteLength",
  "sha256",
]);

function deviceSequenceKey(deviceId: string): string {
  return `device-sequence:${deviceId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isBlob(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Blob]" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "slice") === "function" &&
    typeof Reflect.get(value, "arrayBuffer") === "function"
  );
}

function assertValidEvent(event: Event): void {
  const result = validateEvent(event);
  if (!result.valid) {
    const issues = result.errors
      .map(({ field, message }) => `${field}: ${message}`)
      .join("; ");
    throw new TypeError(`Invalid event: ${issues}`);
  }
}

function assertValidContext(context: ContextRecord): void {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("Context must be an object");
  }
  const unknownContextFields = Object.keys(context).filter(
    (field) => !CONTEXT_FIELD_SET.has(field),
  );
  if (unknownContextFields.length > 0) {
    throw new TypeError(
      `Context carries unknown field(s): ${unknownContextFields.sort().join(", ")}`,
    );
  }
  if (!isNonEmptyString(context.hash)) {
    throw new TypeError("Context hash must be a non-empty string");
  }
  if (!isNonEmptyString(context.original)) {
    throw new TypeError("Context original must be a non-empty string");
  }
  if (Object.hasOwn(context, "focus") && !isNonEmptyString(context.focus)) {
    throw new TypeError("Context focus must be a non-empty string");
  }
  if (
    Object.hasOwn(context, "corrected") &&
    !isNonEmptyString(context.corrected)
  ) {
    throw new TypeError("Context corrected must be a non-empty string");
  }
  if (Object.hasOwn(context, "answer") && !isNonEmptyString(context.answer)) {
    throw new TypeError("Context answer must be a non-empty string");
  }
  if (Object.hasOwn(context, "image")) {
    const image = context.image;
    if (typeof image !== "object" || image === null) {
      throw new TypeError("Context image must be an object");
    }
    const unknownImageFields = Object.keys(image).filter(
      (field) => !CONTEXT_IMAGE_FIELD_SET.has(field),
    );
    if (unknownImageFields.length > 0) {
      throw new TypeError(
        `Context image carries unknown field(s): ${unknownImageFields.sort().join(", ")}`,
      );
    }
    if (!isBlob(image.blob)) {
      throw new TypeError("Context image blob must be a Blob");
    }
    if (!CONTEXT_IMAGE_MEDIA_TYPE_SET.has(image.mediaType)) {
      throw new TypeError("Context image mediaType must be supported");
    }
    if (!isNonEmptyString(image.name)) {
      throw new TypeError("Context image name must be a non-empty string");
    }
    if (
      !Number.isSafeInteger(image.byteLength) ||
      image.byteLength <= 0 ||
      image.byteLength > MAX_CONTEXT_IMAGE_BYTES
    ) {
      throw new TypeError(
        "Context image byteLength must be between 1 byte and 20 MB",
      );
    }
    if (image.blob.size !== image.byteLength) {
      throw new TypeError(
        "Context image blob size must match image byteLength",
      );
    }
    if (image.blob.type.toLowerCase() !== image.mediaType) {
      throw new TypeError(
        "Context image blob type must match image mediaType",
      );
    }
    if (!SHA256_HEXADECIMAL.test(image.sha256)) {
      throw new TypeError(
        "Context image sha256 must be a lowercase SHA-256 digest",
      );
    }
  }
  if (!isCanonicalUtcTimestamp(context.createdAt)) {
    throw new TypeError("Context createdAt must be a canonical UTC timestamp");
  }
}

async function assertValidContextImageDigest(
  context: ContextRecord,
): Promise<void> {
  if (context.image === undefined) {
    return;
  }

  const bytes = await context.image.blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hexadecimal !== context.image.sha256) {
    throw new TypeError("Context image sha256 must match the Blob content");
  }
}

async function assertValidContextHash(context: ContextRecord): Promise<void> {
  if (!PREFIXED_SHA256_HEXADECIMAL.test(context.hash)) {
    throw new TypeError(
      "Context hash must be sha256: followed by 64 lowercase hexadecimal characters",
    );
  }
  const serialized = serializeContextHashInput({
    original: context.original,
    ...(context.focus === undefined ? {} : { focus: context.focus }),
    ...(context.corrected === undefined
      ? {}
      : { corrected: context.corrected }),
    ...(context.answer === undefined ? {} : { answer: context.answer }),
    ...(context.image === undefined
      ? {}
      : { imageSha256: context.image.sha256 }),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (context.hash !== `sha256:${hexadecimal}`) {
    throw new TypeError(
      "Context hash must match its canonical serialized content",
    );
  }
}

function contextsHaveSameIdentity(
  left: ContextRecord,
  right: ContextRecord,
): boolean {
  const leftImage = left.image;
  const rightImage = right.image;
  const sameImage =
    leftImage === undefined && rightImage === undefined
      ? true
      : leftImage !== undefined && rightImage !== undefined
        ? leftImage.sha256 === rightImage.sha256 &&
          leftImage.mediaType === rightImage.mediaType &&
          leftImage.byteLength === rightImage.byteLength
        : false;

  return (
    left.hash === right.hash &&
    left.original === right.original &&
    left.focus === right.focus &&
    left.corrected === right.corrected &&
    left.answer === right.answer &&
    sameImage
  );
}

function assertValidCapture(
  events: readonly Event[],
  context: ContextRecord,
): void {
  if (events.length === 0) {
    throw new TypeError("appendCapture requires at least one event");
  }

  assertValidContext(context);
  for (const event of events) {
    assertValidEvent(event);
  }

  const captureCreatedEvents = events.filter(
    (event): event is CaptureCreatedEvent => event.kind === "capture_created",
  );
  if (captureCreatedEvents.length !== 1) {
    throw new TypeError(
      "appendCapture requires exactly one capture_created event",
    );
  }
  if (captureCreatedEvents[0]?.contextHash !== context.hash) {
    throw new TypeError(
      "capture_created contextHash must match the context hash",
    );
  }
}

function compareHlc(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  return left.wallTime - right.wallTime || left.counter - right.counter;
}

function maximumHlc(
  left: HybridLogicalClock | undefined,
  right: HybridLogicalClock,
): HybridLogicalClock {
  return left === undefined || compareHlc(right, left) > 0 ? right : left;
}

function highWaterFromEvents(
  events: readonly Event[],
  deviceId: string,
): {
  readonly seq: number;
  readonly hlc: HybridLogicalClock | undefined;
} {
  let seq = 0;
  let hlc: HybridLogicalClock | undefined;
  for (const event of events) {
    if (event.deviceId === deviceId) {
      seq = Math.max(seq, event.seq);
    }
    hlc = maximumHlc(hlc, event.hlc);
  }
  return { seq, hlc };
}

type ReadwriteStore<Name extends "events" | "clock"> = IDBPObjectStore<
  LedgerDatabase,
  ArrayLike<"events" | "contexts" | "clock" | "importReceipts">,
  Name,
  "readwrite"
>;

async function promoteAllocatorHighWater(
  eventStore: ReadwriteStore<"events">,
  clockStore: ReadwriteStore<"clock">,
  incomingEvents: readonly Event[],
): Promise<void> {
  const deviceIds = [...new Set(incomingEvents.map((event) => event.deviceId))];
  const [storedGlobal, ...storedSequences] = await Promise.all([
    clockStore.get(GLOBAL_CLOCK_KEY),
    ...deviceIds.map((deviceId) =>
      clockStore.get(deviceSequenceKey(deviceId)),
    ),
  ]);
  const validGlobal =
    storedGlobal?.type === "global-hlc" ? storedGlobal : undefined;
  const sequences = new Map<string, number>();
  let needsEventScan = validGlobal === undefined;
  for (const [index, deviceId] of deviceIds.entries()) {
    const stored = storedSequences[index];
    if (
      stored?.type === "device-sequence" &&
      stored.deviceId === deviceId
    ) {
      sequences.set(deviceId, stored.seq);
    } else {
      needsEventScan = true;
    }
  }

  let hlc = validGlobal?.hlc;
  if (needsEventScan) {
    const persistedEvents = await eventStore.getAll();
    for (const event of persistedEvents) {
      hlc = maximumHlc(hlc, event.hlc);
      if (deviceIds.includes(event.deviceId)) {
        sequences.set(
          event.deviceId,
          Math.max(sequences.get(event.deviceId) ?? 0, event.seq),
        );
      }
    }
  }

  for (const event of incomingEvents) {
    hlc = maximumHlc(hlc, event.hlc);
    sequences.set(
      event.deviceId,
      Math.max(sequences.get(event.deviceId) ?? 0, event.seq),
    );
  }

  if (hlc !== undefined) {
    await clockStore.put({
      key: GLOBAL_CLOCK_KEY,
      type: "global-hlc",
      hlc,
    });
  }
  await Promise.all(
    deviceIds.map((deviceId) =>
      clockStore.put({
        key: deviceSequenceKey(deviceId),
        type: "device-sequence",
        deviceId,
        seq: sequences.get(deviceId) ?? 0,
      }),
    ),
  );
}

async function equalEnumerableProperties(
  left: object,
  right: object,
  leftToRight: WeakMap<object, object>,
  rightToLeft: WeakMap<object, object>,
): Promise<boolean> {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const [index, key] of leftKeys.entries()) {
    if (
      key !== rightKeys[index] ||
      !(await structurallyEqualValue(
        leftRecord[key],
        rightRecord[key],
        leftToRight,
        rightToLeft,
      ))
    ) {
      return false;
    }
  }
  return true;
}

function equalBufferBytes(
  left: ArrayBufferLike,
  right: ArrayBufferLike,
): boolean {
  const leftMetadata = left as ArrayBufferLike & {
    readonly resizable?: boolean;
    readonly maxByteLength?: number;
  };
  const rightMetadata = right as ArrayBufferLike & {
    readonly resizable?: boolean;
    readonly maxByteLength?: number;
  };
  if (
    left.byteLength !== right.byteLength ||
    leftMetadata.resizable !== rightMetadata.resizable ||
    leftMetadata.maxByteLength !== rightMetadata.maxByteLength
  ) {
    return false;
  }

  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

async function structurallyEqualValue(
  left: unknown,
  right: unknown,
  leftToRight: WeakMap<object, object>,
  rightToLeft: WeakMap<object, object>,
): Promise<boolean> {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  const mappedRight = leftToRight.get(left);
  if (mappedRight !== undefined) {
    return mappedRight === right;
  }
  if (rightToLeft.has(right)) {
    return false;
  }

  const leftTag = Object.prototype.toString.call(left);
  const rightTag = Object.prototype.toString.call(right);
  if (leftTag !== rightTag) {
    return false;
  }

  leftToRight.set(left, right);
  rightToLeft.set(right, left);

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      (await equalEnumerableProperties(left, right, leftToRight, rightToLeft))
    );
  }

  if (leftTag === "[object Date]") {
    return Object.is(
      (left as Date).getTime(),
      (right as Date).getTime(),
    );
  }
  if (leftTag === "[object RegExp]") {
    const leftRegExp = left as RegExp;
    const rightRegExp = right as RegExp;
    return (
      leftRegExp.source === rightRegExp.source &&
      leftRegExp.flags === rightRegExp.flags
    );
  }
  if (leftTag === "[object ArrayBuffer]") {
    return equalBufferBytes(
      left as ArrayBufferLike,
      right as ArrayBufferLike,
    );
  }
  if (leftTag === "[object SharedArrayBuffer]") {
    return false;
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) {
      return false;
    }
    return (
      left.byteOffset === right.byteOffset &&
      left.byteLength === right.byteLength &&
      (await structurallyEqualValue(
        left.buffer,
        right.buffer,
        leftToRight,
        rightToLeft,
      ))
    );
  }
  if (leftTag === "[object Map]") {
    const leftEntries = [...(left as Map<unknown, unknown>).entries()];
    const rightEntries = [...(right as Map<unknown, unknown>).entries()];
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }
    for (const [index, entry] of leftEntries.entries()) {
      const rightEntry = rightEntries[index];
      if (
        rightEntry === undefined ||
        !(await structurallyEqualValue(
          entry[0],
          rightEntry[0],
          leftToRight,
          rightToLeft,
        )) ||
        !(await structurallyEqualValue(
          entry[1],
          rightEntry[1],
          leftToRight,
          rightToLeft,
        ))
      ) {
        return false;
      }
    }
    return true;
  }
  if (leftTag === "[object Set]") {
    const leftValues = [...(left as Set<unknown>).values()];
    const rightValues = [...(right as Set<unknown>).values()];
    if (leftValues.length !== rightValues.length) {
      return false;
    }
    for (const [index, value] of leftValues.entries()) {
      if (
        !(await structurallyEqualValue(
          value,
          rightValues[index],
          leftToRight,
          rightToLeft,
        ))
      ) {
        return false;
      }
    }
    return true;
  }
  if (
    leftTag === "[object Boolean]" ||
    leftTag === "[object Number]" ||
    leftTag === "[object String]" ||
    leftTag === "[object BigInt]"
  ) {
    return Object.is(
      (left as { valueOf(): unknown }).valueOf(),
      (right as { valueOf(): unknown }).valueOf(),
    );
  }
  if (left instanceof Error && right instanceof Error) {
    const leftHasCause = Object.hasOwn(left, "cause");
    const rightHasCause = Object.hasOwn(right, "cause");
    return (
      left.name === right.name &&
      left.message === right.message &&
      leftHasCause === rightHasCause &&
      (!leftHasCause ||
        (await structurallyEqualValue(
          left.cause,
          right.cause,
          leftToRight,
          rightToLeft,
        )))
    );
  }

  if (leftTag === "[object Blob]" || leftTag === "[object File]") {
    const leftBlob = left as Blob;
    const rightBlob = right as Blob;
    if (leftBlob.size !== rightBlob.size || leftBlob.type !== rightBlob.type) {
      return false;
    }
    if (leftTag === "[object File]") {
      const leftFile = left as Blob & {
        readonly name: string;
        readonly lastModified: number;
      };
      const rightFile = right as Blob & {
        readonly name: string;
        readonly lastModified: number;
      };
      if (
        leftFile.name !== rightFile.name ||
        leftFile.lastModified !== rightFile.lastModified
      ) {
        return false;
      }
    }
    const [leftBuffer, rightBuffer] = await Promise.all([
      leftBlob.arrayBuffer(),
      rightBlob.arrayBuffer(),
    ]);
    return equalBufferBytes(leftBuffer, rightBuffer);
  }

  if (leftTag !== "[object Object]") {
    return false;
  }

  return equalEnumerableProperties(
    left,
    right,
    leftToRight,
    rightToLeft,
  );
}

/**
 * Package-internal support for ledger restore equivalence checks.
 * This is not a general-purpose comparator and is intentionally absent from
 * the package root public API.
 */
export function structurallyEqual(
  left: unknown,
  right: unknown,
): Promise<boolean> {
  return structurallyEqualValue(
    left,
    right,
    new WeakMap<object, object>(),
    new WeakMap<object, object>(),
  );
}

interface PreparedCaptureWrite {
  readonly events: readonly Event[];
  readonly context: ContextRecord;
}

async function prepareImportedCaptureBatch(
  writes: readonly CaptureWrite[],
  receipt: CoachImportReceipt,
): Promise<{
  readonly writes: readonly PreparedCaptureWrite[];
  readonly receipt: CoachImportReceipt;
}> {
  if (!Array.isArray(writes) || writes.length === 0) {
    throw new TypeError(
      "appendImportedCaptureBatch requires at least one capture write",
    );
  }
  assertCoachImportReceipt(receipt);

  const storageReceipt = structuredClone(receipt);
  assertCoachImportReceipt(storageReceipt);
  const preparedWrites: PreparedCaptureWrite[] = [];
  const captureIds = new Set<string>();
  for (const write of writes) {
    if (typeof write !== "object" || write === null) {
      throw new TypeError("Capture write must be an object");
    }
    if (!Array.isArray(write.events)) {
      throw new TypeError("Capture write events must be an array");
    }
    assertValidCapture(write.events, write.context);

    const storageEvents: Event[] = structuredClone(write.events);
    const storageContext: ContextRecord = structuredClone(write.context);
    assertValidCapture(storageEvents, storageContext);
    await assertValidContextImageDigest(storageContext);
    await assertValidContextHash(storageContext);

    const captureCreated = storageEvents.find(
      (event): event is CaptureCreatedEvent => event.kind === "capture_created",
    )!;
    if (captureIds.has(captureCreated.captureId)) {
      throw new TypeError(
        `Coach import batch repeats captureId ${captureCreated.captureId}`,
      );
    }
    captureIds.add(captureCreated.captureId);
    preparedWrites.push({ events: storageEvents, context: storageContext });
  }

  const receiptCaptureIds = new Set(storageReceipt.captureIds);
  if (
    receiptCaptureIds.size !== captureIds.size ||
    [...captureIds].some((captureId) => !receiptCaptureIds.has(captureId))
  ) {
    throw new TypeError(
      "Coach import receipt captureIds must exactly reference the imported captures",
    );
  }

  return { writes: preparedWrites, receipt: storageReceipt };
}

function prepareDiscardBatch(
  writes: readonly DiscardWrite[],
): readonly DiscardWrite[] {
  if (!Array.isArray(writes)) {
    throw new TypeError("appendDiscardBatch writes must be an array");
  }
  return writes.map((write) => {
    if (typeof write !== "object" || write === null) {
      throw new TypeError("Discard write must be an object");
    }
    if (!isNonEmptyString(write.contextHash)) {
      throw new TypeError("appendDiscard contextHash must be non-empty");
    }
    if (write.event.kind !== "capture_discarded") {
      throw new TypeError("appendDiscard requires a capture_discarded event");
    }
    assertValidEvent(write.event);
    const storageEvent = structuredClone(write.event);
    if (storageEvent.kind !== "capture_discarded") {
      throw new TypeError("appendDiscard requires a capture_discarded event");
    }
    assertValidEvent(storageEvent);
    return { event: storageEvent, contextHash: write.contextHash };
  });
}

async function structurallyEqualWithTransactionKeepAlive(
  left: unknown,
  right: unknown,
  requestKeepAlive: () => Promise<unknown>,
): Promise<boolean> {
  let keepAlive = true;
  const keepAliveTask = (async () => {
    while (keepAlive) {
      await requestKeepAlive();
    }
  })();

  let result = false;
  let failed = false;
  let failure: unknown;
  try {
    result = await structurallyEqual(left, right);
  } catch (error) {
    failed = true;
    failure = error;
  }

  keepAlive = false;
  try {
    await keepAliveTask;
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }

  if (failed) {
    throw failure;
  }
  return result;
}

class IndexedDBLedgerRepository
  implements
    LedgerRepository,
    LedgerRestorer,
    CoachImportRepository,
    LedgerBackupReader
{
  readonly #database: IDBPDatabase<LedgerDatabase>;

  constructor(database: IDBPDatabase<LedgerDatabase>) {
    this.#database = database;
  }

  async reserveEventCoordinates(
    deviceId: string,
    physicalTime: number,
    count: number,
  ): Promise<readonly EventCoordinate[]> {
    const normalizedDeviceId = deviceId.trim();
    if (normalizedDeviceId.length === 0) {
      throw new TypeError("deviceId must be a non-empty string");
    }
    if (!Number.isSafeInteger(physicalTime) || physicalTime < 0) {
      throw new TypeError("physicalTime must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError("count must be a positive safe integer");
    }

    const transaction = this.#database.transaction(
      ["events", "clock"],
      "readwrite",
    );
    try {
      const eventStore = transaction.objectStore("events");
      const clockStore = transaction.objectStore("clock");
      const sequenceKey = deviceSequenceKey(normalizedDeviceId);
      const [storedGlobal, storedSequence] = await Promise.all([
        clockStore.get(GLOBAL_CLOCK_KEY),
        clockStore.get(sequenceKey),
      ]);
      let hlc =
        storedGlobal?.type === "global-hlc" ? storedGlobal.hlc : undefined;
      let sequence =
        storedSequence?.type === "device-sequence" &&
        storedSequence.deviceId === normalizedDeviceId
          ? storedSequence.seq
          : undefined;

      if (hlc === undefined || sequence === undefined) {
        const persisted = highWaterFromEvents(
          await eventStore.getAll(),
          normalizedDeviceId,
        );
        hlc = hlc ?? persisted.hlc;
        sequence = sequence ?? persisted.seq;
      }

      if (sequence > Number.MAX_SAFE_INTEGER - count) {
        throw new RangeError("event sequence is exhausted");
      }
      const coordinates: EventCoordinate[] = [];
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        if (hlc === undefined || physicalTime > hlc.wallTime) {
          hlc = { wallTime: physicalTime, counter: 0 };
        } else {
          if (hlc.counter === Number.MAX_SAFE_INTEGER) {
            throw new RangeError("hybrid logical clock counter is exhausted");
          }
          hlc = { wallTime: hlc.wallTime, counter: hlc.counter + 1 };
        }
        coordinates.push({ seq: sequence, hlc });
      }

      await clockStore.put({
        key: sequenceKey,
        type: "device-sequence",
        deviceId: normalizedDeviceId,
        seq: sequence,
      });
      await clockStore.put({
        key: GLOBAL_CLOCK_KEY,
        type: "global-hlc",
        hlc: coordinates.at(-1)!.hlc,
      });
      await transaction.done;
      return coordinates;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async appendCapture(
    events: readonly Event[],
    context: ContextRecord,
  ): Promise<void> {
    assertValidCapture(events, context);
    await assertValidContextImageDigest(context);

    const transaction = this.#database.transaction(
      ["events", "contexts", "clock"],
      "readwrite",
    );

    try {
      const storageEvents: Event[] = [];
      const eventStore = transaction.objectStore("events");
      for (const event of events) {
        const storageEvent = structuredClone(event);
        assertValidEvent(storageEvent);
        storageEvents.push(storageEvent);

        const existing = await eventStore.get(storageEvent.eventId);
        if (existing !== undefined) {
          if (
            await structurallyEqualWithTransactionKeepAlive(
              existing,
              storageEvent,
              () => eventStore.get(storageEvent.eventId),
            )
          ) {
            continue;
          }
          throw new Error(
            `eventId ${storageEvent.eventId} already exists with different content`,
          );
        }
        await eventStore.put(storageEvent);
      }
      const storageContext = structuredClone(context);
      assertValidCapture(storageEvents, storageContext);
      const contextStore = transaction.objectStore("contexts");
      const existingContext = await contextStore.get(storageContext.hash);
      if (existingContext === undefined) {
        await contextStore.put(storageContext);
      } else {
        assertValidContext(existingContext);
        if (!contextsHaveSameIdentity(existingContext, storageContext)) {
          throw new Error(
            `context hash ${storageContext.hash} already exists with different content`,
          );
        }
      }
      await promoteAllocatorHighWater(
        eventStore,
        transaction.objectStore("clock"),
        storageEvents,
      );
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async appendImportedCaptureBatch(
    writes: readonly CaptureWrite[],
    receipt: CoachImportReceipt,
  ): Promise<"imported" | "already-imported"> {
    const prepared = await prepareImportedCaptureBatch(writes, receipt);
    const transaction = this.#database.transaction(
      ["events", "contexts", "clock", "importReceipts"],
      "readwrite",
    );

    try {
      const eventStore = transaction.objectStore("events");
      const contextStore = transaction.objectStore("contexts");
      const receiptStore = transaction.objectStore("importReceipts");
      const existingReceipt = await receiptStore.get(prepared.receipt.digest);
      if (existingReceipt !== undefined) {
        assertCoachImportReceipt(existingReceipt);
        await transaction.done;
        return "already-imported";
      }

      const allEvents: Event[] = [];
      for (const write of prepared.writes) {
        allEvents.push(...write.events);
        for (const storageEvent of write.events) {
          const existingEvent = await eventStore.get(storageEvent.eventId);
          if (existingEvent === undefined) {
            await eventStore.put(storageEvent);
          } else if (
            !(await structurallyEqualWithTransactionKeepAlive(
              existingEvent,
              storageEvent,
              () => eventStore.get(storageEvent.eventId),
            ))
          ) {
            throw new Error(
              `eventId ${storageEvent.eventId} already exists with different content`,
            );
          }
        }

        const existingContext = await contextStore.get(write.context.hash);
        if (existingContext === undefined) {
          await contextStore.put(write.context);
        } else {
          assertValidContext(existingContext);
          if (!contextsHaveSameIdentity(existingContext, write.context)) {
            throw new Error(
              `context hash ${write.context.hash} already exists with different content`,
            );
          }
        }
      }

      await promoteAllocatorHighWater(
        eventStore,
        transaction.objectStore("clock"),
        allEvents,
      );
      await receiptStore.put(prepared.receipt);
      await transaction.done;
      return "imported";
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async hasImportReceipt(digest: string): Promise<boolean> {
    assertCoachImportDigest(digest);
    const transaction = this.#database.transaction(
      "importReceipts",
      "readonly",
    );
    try {
      const receipt = await transaction.objectStore("importReceipts").get(digest);
      await transaction.done;
      if (receipt === undefined) {
        return false;
      }
      assertCoachImportReceipt(receipt);
      return true;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A readonly transaction may already have completed or failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the read or validation error.
      }
      throw error;
    }
  }

  async appendEvents(events: readonly Event[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    for (const event of events) {
      assertValidEvent(event);
    }

    const transaction = this.#database.transaction(
      ["events", "clock"],
      "readwrite",
    );
    try {
      const storageEvents: Event[] = [];
      const eventStore = transaction.objectStore("events");
      for (const event of events) {
        const storageEvent = structuredClone(event);
        assertValidEvent(storageEvent);
        storageEvents.push(storageEvent);

        const existing = await eventStore.get(storageEvent.eventId);
        if (existing !== undefined) {
          if (
            await structurallyEqualWithTransactionKeepAlive(
              existing,
              storageEvent,
              () => eventStore.get(storageEvent.eventId),
            )
          ) {
            continue;
          }
          throw new Error(
            `eventId ${storageEvent.eventId} already exists with different content`,
          );
        }
        await eventStore.put(storageEvent);
      }
      await promoteAllocatorHighWater(
        eventStore,
        transaction.objectStore("clock"),
        storageEvents,
      );
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async appendDiscard(
    event: CaptureDiscardedEvent,
    contextHash: string,
  ): Promise<void> {
    await this.appendDiscardBatch([{ event, contextHash }]);
  }

  async appendDiscardBatch(writes: readonly DiscardWrite[]): Promise<void> {
    const prepared = prepareDiscardBatch(writes);
    if (prepared.length === 0) return;

    const transaction = this.#database.transaction(
      ["events", "contexts", "clock"],
      "readwrite",
    );

    try {
      const eventStore = transaction.objectStore("events");
      for (const write of prepared) {
        const existing = await eventStore.get(write.event.eventId);
        if (existing === undefined) {
          await eventStore.put(write.event);
        } else if (
          !(await structurallyEqualWithTransactionKeepAlive(
            existing,
            write.event,
            () => eventStore.get(write.event.eventId),
          ))
        ) {
          throw new Error(
            `eventId ${write.event.eventId} already exists with different content`,
          );
        }
      }

      const storedEvents = await eventStore.getAll();
      const captureContextById = new Map<string, string>();
      for (const stored of storedEvents) {
        if (stored.kind === "capture_created") {
          captureContextById.set(stored.captureId, stored.contextHash);
        }
      }
      for (const write of prepared) {
        const storedContextHash = captureContextById.get(write.event.captureId);
        if (storedContextHash === undefined) {
          throw new Error(
            `captureId ${write.event.captureId} does not reference a stored capture`,
          );
        }
        if (storedContextHash !== write.contextHash) {
          throw new Error(
            `captureId ${write.event.captureId} belongs to context ${storedContextHash}, not ${write.contextHash}`,
          );
        }
      }
      const discardedCaptureIds = new Set(
        storedEvents
          .filter((stored) => stored.kind === "capture_discarded")
          .map((discard) => discard.captureId),
      );
      const activeContextHashes = new Set(
        storedEvents
          .filter(
            (stored): stored is CaptureCreatedEvent =>
              stored.kind === "capture_created" &&
              !discardedCaptureIds.has(stored.captureId),
          )
          .map((capture) => capture.contextHash),
      );
      const contextStore = transaction.objectStore("contexts");
      for (const contextHash of new Set(
        prepared.map((write) => write.contextHash),
      )) {
        if (!activeContextHashes.has(contextHash)) {
          await contextStore.delete(contextHash);
        }
      }
      await promoteAllocatorHighWater(
        eventStore,
        transaction.objectStore("clock"),
        prepared.map((write) => write.event),
      );
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async restoreLedger(
    input: RestoreLedgerInput,
    newDeviceId: string,
  ): Promise<void> {
    const prepared = await prepareRestoreLedger(input, newDeviceId);
    for (const event of prepared.events) assertValidEvent(event);
    for (const context of prepared.contexts) {
      assertValidContext(context);
      await assertValidContextImageDigest(context);
    }

    const transaction = this.#database.transaction(
      ["events", "contexts", "clock", "importReceipts"],
      "readwrite",
    );
    try {
      const eventStore = transaction.objectStore("events");
      const contextStore = transaction.objectStore("contexts");
      const clockStore = transaction.objectStore("clock");
      const receiptStore = transaction.objectStore("importReceipts");
      const counts = await Promise.all([
        eventStore.count(),
        contextStore.count(),
        clockStore.count(),
        receiptStore.count(),
      ]);
      if (counts.some((count) => count !== 0)) {
        throw new Error("目标库非空，无法执行完整账本恢复");
      }

      for (const event of prepared.events) {
        await eventStore.put(event);
      }
      for (const context of prepared.contexts) {
        await contextStore.put(context);
      }
      for (const receipt of prepared.importReceipts) {
        await receiptStore.put(receipt);
      }
      await clockStore.put({
        key: GLOBAL_CLOCK_KEY,
        type: "global-hlc",
        hlc: prepared.globalHlc,
      });
      for (const [deviceId, seq] of prepared.maxSeqByDevice) {
        await clockStore.put({
          key: deviceSequenceKey(deviceId),
          type: "device-sequence",
          deviceId,
          seq,
        });
      }
      await clockStore.put(prepared.marker);
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the operation error rather than the follow-up abort error.
      }
      throw error;
    }
  }

  async readRestoreCommit(): Promise<RestoreCommitRecord | undefined> {
    const transaction = this.#database.transaction("clock", "readonly");
    const marker = await transaction.objectStore("clock").get(RESTORE_COMMIT_KEY);
    await transaction.done;
    if (marker === undefined) return undefined;
    assertRestoreCommitRecord(marker);
    return marker;
  }

  async readSnapshot(): Promise<LedgerSnapshot> {
    const transaction = this.#database.transaction(
      ["events", "contexts"],
      "readonly",
    );
    const [events, contexts] = await Promise.all([
      transaction.objectStore("events").getAll(),
      transaction.objectStore("contexts").getAll(),
    ]);
    await transaction.done;

    events.sort((left, right) =>
      left.eventId < right.eventId
        ? -1
        : left.eventId > right.eventId
          ? 1
          : 0,
    );
    contexts.sort((left, right) =>
      left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
    );

    return { events, contexts };
  }

  async readBackupSnapshot(): Promise<LedgerBackupSnapshot> {
    const transaction = this.#database.transaction(
      ["events", "contexts", "importReceipts"],
      "readonly",
    );
    const [events, contexts, importReceipts] = await Promise.all([
      transaction.objectStore("events").getAll(),
      transaction.objectStore("contexts").getAll(),
      transaction.objectStore("importReceipts").getAll(),
    ]);
    await transaction.done;

    for (const receipt of importReceipts) {
      assertCoachImportReceipt(receipt);
    }
    events.sort((left, right) =>
      left.eventId < right.eventId
        ? -1
        : left.eventId > right.eventId
          ? 1
          : 0,
    );
    contexts.sort((left, right) =>
      left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
    );
    importReceipts.sort((left, right) =>
      left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
    );

    return { events, contexts, importReceipts };
  }

  close(): void {
    this.#database.close();
  }
}

export async function openLedgerRepository(
  options: OpenLedgerRepositoryOptions = {},
): Promise<OpenedLedgerRepository> {
  const databaseName = options.dbName ?? "tenjin-ledger";
  let upgradeWasBlocked = false;
  let openedDatabase: IDBPDatabase<LedgerDatabase> | undefined;
  let rejectBlocked: (reason: Error) => void = () => undefined;
  const blockedOpening = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });
  const opening = openDB<LedgerDatabase>(
    databaseName,
    3,
    {
      blocked() {
        upgradeWasBlocked = true;
        rejectBlocked(
          new Error(
            "本地账本升级被其他 Tenjin 标签页占用。请关闭其他 Tenjin 标签页后重试。",
          ),
        );
      },
      blocking() {
        openedDatabase?.close();
      },
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore("events", { keyPath: "eventId" });
          database.createObjectStore("contexts", { keyPath: "hash" });
        }
        if (oldVersion < 2) {
          database.createObjectStore("clock", { keyPath: "key" });
        }
        if (
          oldVersion < 3 &&
          !database.objectStoreNames.contains("importReceipts")
        ) {
          database.createObjectStore("importReceipts", { keyPath: "digest" });
        }
      },
    },
  );
  void opening.then(
    (database) => {
      if (upgradeWasBlocked) {
        database.close();
      } else {
        openedDatabase = database;
      }
    },
    () => undefined,
  );

  const database = await Promise.race([opening, blockedOpening]);
  openedDatabase = database;

  return new IndexedDBLedgerRepository(database);
}
