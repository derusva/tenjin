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

function structurallyEqual(left: unknown, right: unknown): boolean {
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
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      Object.is(left.getTime(), right.getTime())
    );
  }

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (
    (leftPrototype !== Object.prototype && leftPrototype !== null) ||
    (rightPrototype !== Object.prototype && rightPrototype !== null)
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

class IndexedDBLedgerRepository implements LedgerRepository {
  constructor(private readonly database: IDBPDatabase<LedgerDatabase>) {}

  async appendCapture(
    events: readonly Event[],
    context: ContextRecord,
  ): Promise<void> {
    assertValidCapture(events, context);

    const transaction = this.database.transaction(
      ["events", "contexts"],
      "readwrite",
    );

    try {
      const eventStore = transaction.objectStore("events");
      for (const event of events) {
        const existing = await eventStore.get(event.eventId);
        if (existing !== undefined) {
          if (structurallyEqual(existing, event)) {
            continue;
          }
          throw new Error(
            `eventId ${event.eventId} already exists with different content`,
          );
        }
        await eventStore.put(event);
      }
      await transaction.objectStore("contexts").put(context);
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

    const transaction = this.database.transaction("events", "readwrite");
    try {
      const eventStore = transaction.objectStore("events");
      for (const event of events) {
        const existing = await eventStore.get(event.eventId);
        if (existing !== undefined) {
          if (structurallyEqual(existing, event)) {
            continue;
          }
          throw new Error(
            `eventId ${event.eventId} already exists with different content`,
          );
        }
        await eventStore.put(event);
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

    const transaction = this.database.transaction(
      ["events", "contexts"],
      "readwrite",
    );

    try {
      const eventStore = transaction.objectStore("events");
      const existing = await eventStore.get(event.eventId);
      if (existing === undefined) {
        await eventStore.put(event);
      } else if (!structurallyEqual(existing, event)) {
        throw new Error(
          `eventId ${event.eventId} already exists with different content`,
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
    const transaction = this.database.transaction(
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
    this.database.close();
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
