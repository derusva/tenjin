import {
  validateEvent,
  type CaptureCreatedEvent,
  type CaptureDiscardedEvent,
  type Event,
} from "@tenjin/core";
import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from "idb";

export interface ContextRecord {
  readonly hash: string;
  readonly original: string;
  readonly corrected?: string;
  readonly createdAt: string;
}

export interface LedgerSnapshot {
  readonly events: readonly Event[];
  readonly contexts: readonly ContextRecord[];
}

export interface LedgerRepository {
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
  if (!isNonEmptyString(context.hash)) {
    throw new TypeError("Context hash must be a non-empty string");
  }
  if (!isNonEmptyString(context.original)) {
    throw new TypeError("Context original must be a non-empty string");
  }
  if (
    Object.hasOwn(context, "corrected") &&
    !isNonEmptyString(context.corrected)
  ) {
    throw new TypeError("Context corrected must be a non-empty string");
  }
  if (!isCanonicalUtcTimestamp(context.createdAt)) {
    throw new TypeError("Context createdAt must be a canonical UTC timestamp");
  }
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

function structurallyEqual(left: unknown, right: unknown): Promise<boolean> {
  return structurallyEqualValue(
    left,
    right,
    new WeakMap<object, object>(),
    new WeakMap<object, object>(),
  );
}

class IndexedDBLedgerRepository implements LedgerRepository {
  readonly #database: IDBPDatabase<LedgerDatabase>;

  constructor(database: IDBPDatabase<LedgerDatabase>) {
    this.#database = database;
  }

  async appendCapture(
    events: readonly Event[],
    context: ContextRecord,
  ): Promise<void> {
    assertValidCapture(events, context);

    const transaction = this.#database.transaction(
      ["events", "contexts"],
      "readwrite",
    );

    try {
      const storageEvents = events.map((event) => structuredClone(event));
      const storageContext = structuredClone(context);
      assertValidCapture(storageEvents, storageContext);

      const eventStore = transaction.objectStore("events");
      for (const storageEvent of storageEvents) {
        const existing = await eventStore.get(storageEvent.eventId);
        if (existing !== undefined) {
          if (await structurallyEqual(existing, storageEvent)) {
            continue;
          }
          throw new Error(
            `eventId ${storageEvent.eventId} already exists with different content`,
          );
        }
        await eventStore.put(storageEvent);
      }
      await transaction.objectStore("contexts").put(storageContext);
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

  async appendEvents(events: readonly Event[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    for (const event of events) {
      assertValidEvent(event);
    }

    const transaction = this.#database.transaction("events", "readwrite");
    try {
      const storageEvents = events.map((event) => structuredClone(event));
      for (const storageEvent of storageEvents) {
        assertValidEvent(storageEvent);
      }

      const eventStore = transaction.objectStore("events");
      for (const storageEvent of storageEvents) {
        const existing = await eventStore.get(storageEvent.eventId);
        if (existing !== undefined) {
          if (await structurallyEqual(existing, storageEvent)) {
            continue;
          }
          throw new Error(
            `eventId ${storageEvent.eventId} already exists with different content`,
          );
        }
        await eventStore.put(storageEvent);
      }
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
    if (!isNonEmptyString(contextHash)) {
      throw new TypeError("appendDiscard contextHash must be non-empty");
    }
    if (event.kind !== "capture_discarded") {
      throw new TypeError("appendDiscard requires a capture_discarded event");
    }
    assertValidEvent(event);

    const transaction = this.#database.transaction(
      ["events", "contexts"],
      "readwrite",
    );

    try {
      const storageEvent = structuredClone(event);
      if (storageEvent.kind !== "capture_discarded") {
        throw new TypeError(
          "appendDiscard requires a capture_discarded event",
        );
      }
      assertValidEvent(storageEvent);

      const eventStore = transaction.objectStore("events");
      const existing = await eventStore.get(storageEvent.eventId);
      if (existing === undefined) {
        await eventStore.put(storageEvent);
      } else if (!(await structurallyEqual(existing, storageEvent))) {
        throw new Error(
          `eventId ${storageEvent.eventId} already exists with different content`,
        );
      }
      await transaction.objectStore("contexts").delete(contextHash);
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

  close(): void {
    this.#database.close();
  }
}

export async function openLedgerRepository(
  options: OpenLedgerRepositoryOptions = {},
): Promise<LedgerRepository> {
  const database = await openDB<LedgerDatabase>(
    options.dbName ?? "tenjin-ledger",
    1,
    {
      upgrade(database) {
        database.createObjectStore("events", { keyPath: "eventId" });
        database.createObjectStore("contexts", { keyPath: "hash" });
      },
    },
  );

  return new IndexedDBLedgerRepository(database);
}
