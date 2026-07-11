import "fake-indexeddb/auto";

import type {
  CaptureCreatedEvent,
  CaptureDiscardedEvent,
  Event,
  ItemCreatedEvent,
} from "@tenjin/core";
import { deleteDB, openDB, type DBSchema } from "idb";
import { afterEach, describe, expect, it } from "vitest";

import {
  openLedgerRepository,
  type ContextRecord,
  type LedgerRepository,
} from "./repository.js";

const openDatabaseNames = new Set<string>();
const openRepositories = new Set<LedgerRepository>();

function createDatabaseName(testName: string): string {
  const dbName = `tenjin-storage-${testName}-${crypto.randomUUID()}`;
  openDatabaseNames.add(dbName);
  return dbName;
}

async function openTestRepository(testName: string): Promise<LedgerRepository> {
  const repository = await openLedgerRepository({
    dbName: createDatabaseName(testName),
  });
  openRepositories.add(repository);
  return repository;
}

const captureCreatedEvent = {
  schemaVersion: 1,
  eventId: "event-capture-1",
  deviceId: "device-1",
  seq: 1,
  hlc: {
    wallTime: 1_783_702_800_000,
    counter: 0,
  },
  occurredAt: "2026-07-11T00:20:00.000Z",
  recordedAt: "2026-07-11T00:20:01.000Z",
  kind: "capture_created",
  captureId: "capture-1",
  contextHash: "sha256:context-1",
  payload: {
    captureType: "lookup",
  },
} as const satisfies CaptureCreatedEvent;

const context = {
  hash: "sha256:context-1",
  original: "tenjin",
  corrected: "Tenjin",
  createdAt: "2026-07-11T00:20:00.000Z",
} as const;

const itemCreatedEvent = {
  schemaVersion: 1,
  eventId: "event-item-1",
  deviceId: "device-1",
  seq: 2,
  hlc: {
    wallTime: 1_783_702_800_000,
    counter: 1,
  },
  occurredAt: "2026-07-11T00:20:00.000Z",
  recordedAt: "2026-07-11T00:20:01.000Z",
  kind: "item_created",
  captureId: "capture-1",
  itemId: "item-1",
  payload: {
    display: "天神",
    identityKey: "天神",
    targetChannels: ["R"],
  },
} as const satisfies ItemCreatedEvent;

const captureDiscardedEvent = {
  schemaVersion: 1,
  eventId: "event-discard-1",
  deviceId: "device-1",
  seq: 3,
  hlc: {
    wallTime: 1_783_702_800_000,
    counter: 2,
  },
  occurredAt: "2026-07-11T00:20:02.000Z",
  recordedAt: "2026-07-11T00:20:03.000Z",
  kind: "capture_discarded",
  captureId: "capture-1",
  payload: {
    reason: "undo",
  },
} as const satisfies CaptureDiscardedEvent;

interface LegacyLedgerDatabase extends DBSchema {
  events: {
    key: string;
    value: Event;
  };
  contexts: {
    key: string;
    value: ContextRecord;
  };
}

afterEach(async () => {
  for (const repository of openRepositories) {
    repository.close();
  }
  openRepositories.clear();
  await Promise.all([...openDatabaseNames].map((dbName) => deleteDB(dbName)));
  openDatabaseNames.clear();
});

describe("openLedgerRepository", () => {
  it("rejects instead of hanging when a legacy connection blocks the upgrade", async () => {
    const dbName = createDatabaseName("blocked-legacy-upgrade");
    const legacyDatabase = await openDB<LegacyLedgerDatabase>(dbName, 1, {
      upgrade(database) {
        database.createObjectStore("events", { keyPath: "eventId" });
        database.createObjectStore("contexts", { keyPath: "hash" });
      },
    });
    const opening = openLedgerRepository({ dbName });
    const outcome = await Promise.race([
      opening.then(
        () => ({ status: "opened" }) as const,
        (error: unknown) => ({
          status: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 50);
      }),
    ]);

    legacyDatabase.close();
    if (outcome === "still-pending") {
      const lateRepository = await opening;
      lateRepository.close();
    }

    expect(outcome).toEqual({
      status: "rejected",
      message: expect.stringContaining("关闭其他 Tenjin 标签页"),
    });
  });

  it("releases its connection when a future schema upgrade starts", async () => {
    const dbName = createDatabaseName("future-upgrade");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    let futureDatabase: Awaited<ReturnType<typeof openDB>> | undefined;
    const futureOpening = openDB(dbName, 3).then((database) => {
      futureDatabase = database;
      return "opened" as const;
    });
    const outcome = await Promise.race([
      futureOpening,
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 50);
      }),
    ]);

    if (outcome === "still-pending") {
      repository.close();
      openRepositories.delete(repository);
      await futureOpening;
    }
    futureDatabase?.close();

    expect(outcome).toBe("opened");
  });

  it("does not expose its IndexedDB database through own properties", async () => {
    const repository = await openTestRepository("database-privacy");

    const ownKeys = Reflect.ownKeys(repository);
    const ownValues = ownKeys.map((key) => Reflect.get(repository, key));

    expect(ownKeys).not.toContain("database");
    expect(Reflect.get(repository, "database")).toBeUndefined();
    expect(ownValues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transaction: expect.any(Function),
        }),
      ]),
    );
  });

  it("atomically reserves unique coordinates across repository instances", async () => {
    const dbName = createDatabaseName("coordinate-concurrency");
    const firstRepository = await openLedgerRepository({ dbName });
    const secondRepository = await openLedgerRepository({ dbName });
    openRepositories.add(firstRepository);
    openRepositories.add(secondRepository);
    const physicalTime = Date.parse("2026-07-11T03:00:00.000Z");

    const [first, second] = await Promise.all([
      firstRepository.reserveEventCoordinates(
        "device-shared",
        physicalTime,
        2,
      ),
      secondRepository.reserveEventCoordinates(
        "device-shared",
        physicalTime,
        2,
      ),
    ]);

    const coordinates = [...first, ...second];
    expect(coordinates.map(({ seq }) => seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      coordinates
        .map(({ hlc }) => `${hlc.wallTime}:${hlc.counter}`)
        .sort(),
    ).toEqual([
      `${physicalTime}:0`,
      `${physicalTime}:1`,
      `${physicalTime}:2`,
      `${physicalTime}:3`,
    ]);
  });

  it("initializes allocator high-water marks from legacy events on upgrade", async () => {
    const dbName = createDatabaseName("coordinate-legacy-upgrade");
    const persistedWallTime = Date.parse("2026-07-11T04:00:00.000Z");
    const legacyEvent = {
      ...captureCreatedEvent,
      eventId: "legacy-event",
      deviceId: "device-legacy",
      seq: 41,
      hlc: { wallTime: persistedWallTime, counter: 7 },
    } as const satisfies CaptureCreatedEvent;
    const legacyDatabase = await openDB<LegacyLedgerDatabase>(dbName, 1, {
      upgrade(database) {
        database.createObjectStore("events", { keyPath: "eventId" });
        database.createObjectStore("contexts", { keyPath: "hash" });
      },
    });
    await legacyDatabase.put("events", legacyEvent);
    legacyDatabase.close();

    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);

    await expect(
      repository.reserveEventCoordinates(
        "device-legacy",
        Date.parse("2026-07-11T02:00:00.000Z"),
        1,
      ),
    ).resolves.toEqual([
      {
        seq: 42,
        hlc: { wallTime: persistedWallTime, counter: 8 },
      },
    ]);
  });

  it("raises allocator high-water marks after imported events and reopening", async () => {
    const dbName = createDatabaseName("coordinate-import");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    const physicalTime = Date.parse("2026-07-11T03:00:00.000Z");

    await expect(
      repository.reserveEventCoordinates("device-import", physicalTime, 1),
    ).resolves.toEqual([
      { seq: 1, hlc: { wallTime: physicalTime, counter: 0 } },
    ]);

    const importedWallTime = Date.parse("2026-07-11T05:00:00.000Z");
    const importedEvent = {
      ...captureCreatedEvent,
      eventId: "imported-event",
      deviceId: "device-import",
      seq: 70,
      hlc: { wallTime: importedWallTime, counter: 11 },
    } as const satisfies CaptureCreatedEvent;
    await repository.appendEvents([importedEvent]);
    repository.close();
    openRepositories.delete(repository);

    const reopened = await openLedgerRepository({ dbName });
    openRepositories.add(reopened);

    await expect(
      reopened.reserveEventCoordinates("device-import", physicalTime, 2),
    ).resolves.toEqual([
      { seq: 71, hlc: { wallTime: importedWallTime, counter: 12 } },
      { seq: 72, hlc: { wallTime: importedWallTime, counter: 13 } },
    ]);
  });

  it("raises high-water marks from the stored clone when caller data mutates", async () => {
    const repository = await openTestRepository("coordinate-import-mutation");
    const physicalTime = Date.parse("2026-07-11T03:00:00.000Z");
    await repository.reserveEventCoordinates("device-import", physicalTime, 1);
    const importedWallTime = Date.parse("2026-07-11T05:00:00.000Z");
    const importedEvent = {
      ...captureCreatedEvent,
      eventId: "mutable-imported-event",
      deviceId: "device-import",
      seq: 50,
      hlc: { wallTime: importedWallTime, counter: 9 },
    } as CaptureCreatedEvent;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (
        typeof value === "object" &&
        value !== null &&
        "eventId" in value &&
        value.eventId === importedEvent.eventId
      ) {
        (importedEvent as { seq: number }).seq = 0;
        (importedEvent as { hlc: { wallTime: number; counter: number } }).hlc = {
          wallTime: physicalTime,
          counter: 0,
        };
      }
      return Reflect.apply(
        originalPut,
        this,
        key === undefined ? [value] : [value, key],
      ) as IDBRequest<IDBValidKey>;
    };

    try {
      await repository.appendEvents([importedEvent]);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    await expect(
      repository.reserveEventCoordinates("device-import", physicalTime, 1),
    ).resolves.toEqual([
      { seq: 51, hlc: { wallTime: importedWallTime, counter: 10 } },
    ]);
  });

  it("commits capture events and context together", async () => {
    const repository = await openTestRepository("append-capture");

    await repository.appendCapture([captureCreatedEvent], context);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [context],
    });
  });

  it("sorts multiple contexts by hash regardless of insertion order", async () => {
    const repository = await openTestRepository("context-sorting");
    const earlierContext = {
      hash: "sha256:context-0",
      original: "earlier",
      createdAt: "2026-07-11T00:19:00.000Z",
    } as const satisfies ContextRecord;
    const earlierCapture = {
      ...captureCreatedEvent,
      eventId: "event-capture-0",
      seq: 4,
      captureId: "capture-0",
      contextHash: earlierContext.hash,
      occurredAt: "2026-07-11T00:19:00.000Z",
      recordedAt: "2026-07-11T00:19:01.000Z",
    } as const satisfies CaptureCreatedEvent;

    await repository.appendCapture([captureCreatedEvent], context);
    await repository.appendCapture([earlierCapture], earlierContext);

    expect(await repository.readSnapshot()).toEqual({
      events: [earlierCapture, captureCreatedEvent],
      contexts: [earlierContext, context],
    });
  });

  it("rejects an unknown uncloneable field before issuing event writes", async () => {
    const repository = await openTestRepository("append-capture-rollback");
    const issuedEventIds: string[] = [];
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (
        typeof value === "object" &&
        value !== null &&
        "eventId" in value &&
        typeof value.eventId === "string"
      ) {
        issuedEventIds.push(value.eventId);
      }
      return Reflect.apply(
        originalPut,
        this,
        key === undefined ? [value] : [value, key],
      ) as IDBRequest<IDBValidKey>;
    };
    const uncloneableEvent = {
      ...itemCreatedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        uncloneable: () => "functions cannot be cloned",
      },
    } as unknown as Event;

    try {
      await expect(
        repository.appendCapture(
          [captureCreatedEvent, uncloneableEvent],
          context,
        ),
      ).rejects.toThrow();
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    expect(issuedEventIds).toEqual([]);
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it.each([
    {
      name: "an empty event batch",
      events: [],
      context,
    },
    {
      name: "an invalid event later in the batch",
      events: [
        captureCreatedEvent,
        { ...itemCreatedEvent, occurredAt: "not-a-timestamp" } as Event,
      ],
      context,
    },
    {
      name: "no capture_created event",
      events: [itemCreatedEvent],
      context,
    },
    {
      name: "more than one capture_created event",
      events: [
        captureCreatedEvent,
        { ...captureCreatedEvent, eventId: "event-capture-2" },
      ],
      context,
    },
    {
      name: "a capture_created contextHash mismatch",
      events: [captureCreatedEvent],
      context: { ...context, hash: "sha256:different-context" },
    },
    {
      name: "an empty context hash",
      events: [captureCreatedEvent],
      context: { ...context, hash: "" },
    },
    {
      name: "an empty original context",
      events: [captureCreatedEvent],
      context: { ...context, original: " " },
    },
    {
      name: "an empty corrected context",
      events: [captureCreatedEvent],
      context: { ...context, corrected: "" },
    },
    {
      name: "a non-canonical context timestamp",
      events: [captureCreatedEvent],
      context: { ...context, createdAt: "2026-07-11T00:20:00Z" },
    },
  ] satisfies readonly {
    readonly name: string;
    readonly events: readonly Event[];
    readonly context: ContextRecord;
  }[])("rejects $name before persisting any capture data", async ({
    name,
    events,
    context: invalidContext,
  }) => {
    const repository = await openTestRepository(`invalid-${name}`);

    await expect(
      repository.appendCapture(events, invalidContext),
    ).rejects.toThrow();
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it("treats an equal eventId replay as a no-op and rejects conflicting content", async () => {
    const repository = await openTestRepository("event-idempotency");
    const structurallyEqualReplay = {
      schemaVersion: 1,
      payload: { captureType: "lookup" },
      contextHash: "sha256:context-1",
      captureId: "capture-1",
      kind: "capture_created",
      recordedAt: "2026-07-11T00:20:01.000Z",
      occurredAt: "2026-07-11T00:20:00.000Z",
      hlc: { counter: 0, wallTime: 1_783_702_800_000 },
      seq: 1,
      deviceId: "device-1",
      eventId: "event-capture-1",
    } as const satisfies CaptureCreatedEvent;
    const conflictingReplay = {
      ...captureCreatedEvent,
      payload: { captureType: "listening_miss" },
    } as const satisfies CaptureCreatedEvent;

    await repository.appendCapture([captureCreatedEvent], context);
    await repository.appendCapture([structurallyEqualReplay], context);
    await expect(
      repository.appendCapture([conflictingReplay], context),
    ).rejects.toThrow(/eventId/i);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [context],
    });
  });

  it.each([
    {
      name: "Date",
      createValue: () => new Date("2026-07-11T00:20:00.000Z"),
    },
    {
      name: "RegExp",
      createValue: () => new RegExp("tenjin", "giu"),
    },
    {
      name: "Map",
      createValue: () => new Map([["tenjin", { count: 1 }]]),
    },
    {
      name: "Set",
      createValue: () => new Set(["tenjin", "天神"]),
    },
    {
      name: "ArrayBuffer",
      createValue: () => Uint8Array.from([1, 2, 3]).buffer,
    },
    {
      name: "typed array",
      createValue: () => Uint16Array.from([1, 65_535]),
    },
    {
      name: "DataView",
      createValue: () =>
        new DataView(Uint8Array.from([0, 1, 2, 3]).buffer, 1, 2),
    },
    {
      name: "Blob",
      createValue: () => new Blob(["tenjin"], { type: "text/plain" }),
    },
    {
      name: "cyclic object",
      createValue: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    },
    {
      name: "sparse array",
      createValue: () => {
        const value = new Array<string | undefined>(2);
        value[1] = "tenjin";
        return value;
      },
    },
  ])("rejects an unknown $name payload extension before writing", async ({
    name,
    createValue,
  }) => {
    const repository = await openTestRepository(`event-clone-${name}`);
    const eventWithPrivateExtension = {
      ...itemCreatedEvent,
      eventId: `event-with-${name}`,
      payload: {
        ...itemCreatedEvent.payload,
        privateExtension: createValue(),
      },
    } as unknown as Event;

    await expect(
      repository.appendEvents([eventWithPrivateExtension]),
    ).rejects.toThrow(/payload\.privateExtension.*not allowed/i);
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it("rejects an uncloneable replay even when its visible content is equal", async () => {
    const repository = await openTestRepository("event-uncloneable-replay");
    const uncloneableReplay = new Proxy(itemCreatedEvent, {});

    await repository.appendEvents([itemCreatedEvent]);

    await expect(
      repository.appendEvents([uncloneableReplay]),
    ).rejects.toThrow();
    expect(await repository.readSnapshot()).toEqual({
      events: [itemCreatedEvent],
      contexts: [],
    });
  });

  it("appends event-only batches, accepts empty batches, and returns sorted events", async () => {
    const repository = await openTestRepository("append-events");

    await repository.appendEvents([]);
    await repository.appendEvents([itemCreatedEvent, captureCreatedEvent]);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent, itemCreatedEvent],
      contexts: [],
    });
  });

  it("validates every appendEvents event before persisting the batch", async () => {
    const repository = await openTestRepository("append-events-validation");
    const invalidLaterEvent = {
      ...itemCreatedEvent,
      eventId: "event-invalid",
      recordedAt: "not-a-timestamp",
    } as Event;

    await expect(
      repository.appendEvents([captureCreatedEvent, invalidLaterEvent]),
    ).rejects.toThrow(/invalid event/i);
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it("validates the storage-normalized event after non-enumerable fields disappear", async () => {
    const repository = await openTestRepository("normalized-event-validation");
    const event = { ...itemCreatedEvent };
    Object.defineProperty(event, "kind", {
      value: itemCreatedEvent.kind,
      enumerable: false,
    });

    await expect(repository.appendEvents([event])).rejects.toThrow(
      /invalid event/i,
    );
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it("validates storage-normalized capture context fields", async () => {
    const repository = await openTestRepository("normalized-context-validation");
    const nonEnumerableOriginal = { ...context };
    Object.defineProperty(nonEnumerableOriginal, "original", {
      value: context.original,
      enumerable: false,
    });

    await expect(
      repository.appendCapture([captureCreatedEvent], nonEnumerableOriginal),
    ).rejects.toThrow(/context original/i);
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it("appends a discard event and removes its context together", async () => {
    const repository = await openTestRepository("append-discard");
    await repository.appendCapture([captureCreatedEvent], context);

    await repository.appendDiscard(captureDiscardedEvent, context.hash);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent, captureDiscardedEvent],
      contexts: [],
    });
  });

  it("retains shared context until its last active capture is discarded", async () => {
    const repository = await openTestRepository("append-discard-shared-context");
    const newerCapture = {
      ...captureCreatedEvent,
      eventId: "event-capture-2",
      seq: 4,
      hlc: {
        wallTime: 1_783_702_860_000,
        counter: 0,
      },
      occurredAt: "2026-07-11T00:21:00.000Z",
      recordedAt: "2026-07-11T00:21:01.000Z",
      captureId: "capture-2",
    } as const satisfies CaptureCreatedEvent;
    const newerDiscard = {
      ...captureDiscardedEvent,
      eventId: "event-discard-2",
      seq: 5,
      hlc: {
        wallTime: 1_783_702_920_000,
        counter: 0,
      },
      occurredAt: "2026-07-11T00:22:00.000Z",
      recordedAt: "2026-07-11T00:22:01.000Z",
      captureId: "capture-2",
    } as const satisfies CaptureDiscardedEvent;

    await repository.appendCapture([captureCreatedEvent], context);
    await repository.appendCapture([newerCapture], context);

    await repository.appendDiscard(newerDiscard, context.hash);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent, newerCapture, newerDiscard],
      contexts: [context],
    });

    await repository.appendDiscard(captureDiscardedEvent, context.hash);

    expect(await repository.readSnapshot()).toEqual({
      events: [
        captureCreatedEvent,
        newerCapture,
        captureDiscardedEvent,
        newerDiscard,
      ],
      contexts: [],
    });
  });

  it("preserves the context when a discard event write fails", async () => {
    const repository = await openTestRepository("append-discard-rollback");
    const uncloneableDiscard = {
      ...captureDiscardedEvent,
      eventId: "event-discard-uncloneable",
      payload: {
        ...captureDiscardedEvent.payload,
        uncloneable: () => "functions cannot be cloned",
      },
    } as unknown as CaptureDiscardedEvent;
    await repository.appendCapture([captureCreatedEvent], context);

    await expect(
      repository.appendDiscard(uncloneableDiscard, context.hash),
    ).rejects.toThrow();

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [context],
    });
  });

  it("validates a storage-normalized discard event", async () => {
    const repository = await openTestRepository("normalized-discard-validation");
    const event = { ...captureDiscardedEvent };
    Object.defineProperty(event, "kind", {
      value: captureDiscardedEvent.kind,
      enumerable: false,
    });

    await expect(
      repository.appendDiscard(event, context.hash),
    ).rejects.toThrow(/capture_discarded|invalid event/i);
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });

  it.each([
    {
      name: "an empty contextHash",
      event: captureDiscardedEvent,
      contextHash: " ",
    },
    {
      name: "a non-discard event",
      event: captureCreatedEvent as unknown as CaptureDiscardedEvent,
      contextHash: context.hash,
    },
    {
      name: "an invalid discard event",
      event: {
        ...captureDiscardedEvent,
        occurredAt: "not-a-timestamp",
      } as CaptureDiscardedEvent,
      contextHash: context.hash,
    },
  ])("rejects appendDiscard with $name before writing", async ({
    name,
    event,
    contextHash,
  }) => {
    const repository = await openTestRepository(`invalid-discard-${name}`);

    await expect(repository.appendDiscard(event, contextHash)).rejects.toThrow();
    expect(await repository.readSnapshot()).toEqual({
      events: [],
      contexts: [],
    });
  });
});
