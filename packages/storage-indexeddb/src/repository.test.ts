import "fake-indexeddb/auto";

import {
  serializeContextHashInput,
  type CaptureCreatedEvent,
  type CaptureDiscardedEvent,
  type Event,
  type ItemCreatedEvent,
} from "@tenjin/core";
import { deleteDB, openDB, type DBSchema } from "idb";
import { afterEach, describe, expect, it } from "vitest";

import {
  openLedgerRepository,
  structurallyEqual,
  type CaptureWrite,
  type ContextRecord,
  type DiscardWrite,
  type LedgerRepository,
  type OpenedLedgerRepository,
} from "./repository.js";
import type { CoachImportReceipt } from "./importReceipt.js";
import { RestoreCommitRecordError } from "./restoreCommit.js";
import * as publicApi from "./index.js";

function packageRootMustNotExposeStructurallyEqual() {
  // @ts-expect-error structurallyEqual is intentionally package-internal.
  return publicApi.structurallyEqual;
}
void packageRootMustNotExposeStructurallyEqual;

const openDatabaseNames = new Set<string>();
const openRepositories = new Set<LedgerRepository>();

function createDatabaseName(testName: string): string {
  const dbName = `tenjin-storage-${testName}-${crypto.randomUUID()}`;
  openDatabaseNames.add(dbName);
  return dbName;
}

async function openTestRepository(
  testName: string,
): Promise<OpenedLedgerRepository> {
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

interface VersionTwoLedgerDatabase extends LegacyLedgerDatabase {
  clock: {
    key: string;
    value: unknown;
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function importedCaptureWrite(
  label: string,
  seq: number,
  captureId = `capture-${label}`,
  contextOverride: Partial<ContextRecord> = {},
): Promise<CaptureWrite> {
  const original = `source sentence ${label}`;
  const focus = `focus ${label}`;
  const answer = `answer ${label}`;
  const hash = `sha256:${await sha256Text(
    serializeContextHashInput({ original, focus, answer }),
  )}`;
  const importedContext = {
    hash,
    original,
    focus,
    answer,
    createdAt: "2026-08-11T00:00:00.000Z",
    ...contextOverride,
  } satisfies ContextRecord;
  const event = {
    ...captureCreatedEvent,
    eventId: `event-import-${label}`,
    deviceId: "device-coach",
    seq,
    hlc: {
      wallTime: captureCreatedEvent.hlc.wallTime + seq,
      counter: 0,
    },
    captureId,
    contextHash: importedContext.hash,
  } satisfies CaptureCreatedEvent;
  return { events: [event], context: importedContext };
}

function receiptFor(
  writes: readonly CaptureWrite[],
  hexadecimal = "11".repeat(32),
  importedAt = "2026-08-11T00:00:01.000Z",
): CoachImportReceipt {
  return {
    digest: `sha256:${hexadecimal}`,
    importedAt,
    captureIds: writes.map(
      (write) =>
        write.events.find((event) => event.kind === "capture_created")!
          .captureId,
    ),
  };
}

function discardWrite(
  captureId: string,
  contextHash: string,
  seq: number,
): DiscardWrite {
  return {
    event: {
      ...captureDiscardedEvent,
      eventId: `event-batch-discard-${seq}`,
      deviceId: "device-coach",
      seq,
      hlc: {
        wallTime: captureDiscardedEvent.hlc.wallTime + seq,
        counter: 0,
      },
      captureId,
    },
    contextHash,
  };
}

async function allStoreCounts(name: string): Promise<readonly number[]> {
  const database = await openDB(name);
  try {
    const transaction = database.transaction(
      ["events", "contexts", "clock", "importReceipts"],
      "readonly",
    );
    const counts = await Promise.all(
      ["events", "contexts", "clock", "importReceipts"].map((store) =>
        transaction.objectStore(store).count(),
      ),
    );
    await transaction.done;
    return counts;
  } finally {
    database.close();
  }
}

async function readClockStore(
  name: string,
): Promise<{
  readonly keys: readonly IDBValidKey[];
  readonly values: readonly unknown[];
}> {
  const database = await openDB(name);
  try {
    const transaction = database.transaction("clock", "readonly");
    const store = transaction.objectStore("clock");
    const [keys, values] = await Promise.all([
      store.getAllKeys(),
      store.getAll(),
    ]);
    await transaction.done;
    return { keys, values };
  } finally {
    database.close();
  }
}

async function seedRestoreProbeStore(
  name: string,
  store: "events" | "contexts" | "clock" | "importReceipts",
  value: unknown,
): Promise<void> {
  const database = await openDB(name);
  try {
    const transaction = database.transaction(store, "readwrite");
    await transaction.objectStore(store).put(value as never);
    await transaction.done;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const repository of openRepositories) {
    repository.close();
  }
  openRepositories.clear();
  await Promise.all([...openDatabaseNames].map((dbName) => deleteDB(dbName)));
  openDatabaseNames.clear();
});

describe("structurallyEqual package-internal comparator", () => {
  it("compares independent Blobs byte for byte", async () => {
    const left = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const equal = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const different = new Blob([new Uint8Array([1, 2, 4])], {
      type: "image/png",
    });

    await expect(structurallyEqual(left, equal)).resolves.toBe(true);
    await expect(structurallyEqual(left, different)).resolves.toBe(false);
  });

  it("treats equal Blob bytes with different media types as different", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const png = new Blob([bytes], { type: "image/png" });
    const jpeg = new Blob([bytes], { type: "image/jpeg" });

    await expect(structurallyEqual(png, jpeg)).resolves.toBe(false);
  });

  it("recurses through nested records independent of key insertion order", async () => {
    const left = {
      label: "context",
      nested: {
        values: [1, { image: new Blob([new Uint8Array([7, 8])], { type: "image/png" }) }],
        active: true,
      },
    };
    const equal = {
      nested: {
        active: true,
        values: [1, { image: new Blob([new Uint8Array([7, 8])], { type: "image/png" }) }],
      },
      label: "context",
    };
    const changed = {
      ...equal,
      nested: { ...equal.nested, active: false },
    };

    await expect(structurallyEqual(left, equal)).resolves.toBe(true);
    await expect(structurallyEqual(left, changed)).resolves.toBe(false);
  });

  it("does not expose the comparator from the package root", () => {
    expect(Object.hasOwn(publicApi, "structurallyEqual")).toBe(false);
  });
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
    const futureOpening = openDB(dbName, 4).then((database) => {
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

  it("losslessly upgrades a v2 ledger to v3 and adds an empty receipt store", async () => {
    const dbName = createDatabaseName("v2-v3-lossless");
    const clockRecord = {
      key: "global-hlc",
      type: "global-hlc",
      hlc: captureCreatedEvent.hlc,
    } as const;
    const versionTwo = await openDB<VersionTwoLedgerDatabase>(dbName, 2, {
      upgrade(database) {
        database.createObjectStore("events", { keyPath: "eventId" });
        database.createObjectStore("contexts", { keyPath: "hash" });
        database.createObjectStore("clock", { keyPath: "key" });
      },
    });
    await versionTwo.put("events", captureCreatedEvent);
    await versionTwo.put("contexts", context);
    await versionTwo.put("clock", clockRecord);
    versionTwo.close();

    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [context],
    });
    expect((await repository.readBackupSnapshot()).importReceipts).toEqual([]);

    const upgraded = await openDB<VersionTwoLedgerDatabase>(dbName);
    expect(upgraded.version).toBe(3);
    expect(Array.from(upgraded.objectStoreNames)).toEqual([
      "clock",
      "contexts",
      "events",
      "importReceipts",
    ]);
    expect(await upgraded.get("clock", "global-hlc")).toEqual(clockRecord);
    upgraded.close();
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

  it("round-trips an optional focus without replacing the source excerpt", async () => {
    const repository = await openTestRepository("focus-roundtrip");
    const focusedContext = {
      ...context,
      original: "大丈夫、手は打ったから。",
      focus: "手を打つ",
      answer: "采取措施",
    } as const satisfies ContextRecord;

    await repository.appendCapture([captureCreatedEvent], focusedContext);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [focusedContext],
    });
  });

  it("rejects a reused context hash when focus identity differs", async () => {
    const repository = await openTestRepository("focus-identity-conflict");
    const firstContext = {
      ...context,
      focus: "手を打つ",
    } as const satisfies ContextRecord;
    const conflictingContext = {
      ...context,
      focus: "手は打った",
      createdAt: "2026-07-11T00:21:00.000Z",
    } as const satisfies ContextRecord;
    const secondCapture = {
      ...captureCreatedEvent,
      eventId: "event-capture-2",
      captureId: "capture-2",
      seq: 2,
      hlc: { ...captureCreatedEvent.hlc, counter: 1 },
    } as const satisfies CaptureCreatedEvent;

    await repository.appendCapture([captureCreatedEvent], firstContext);
    await expect(
      repository.appendCapture([secondCapture], conflictingContext),
    ).rejects.toThrow(/context hash/i);

    expect(await repository.readSnapshot()).toEqual({
      events: [captureCreatedEvent],
      contexts: [firstContext],
    });
  });

  it("round-trips an image Blob and removes it with the unreferenced context on undo", async () => {
    const dbName = createDatabaseName("image-roundtrip-undo");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const imageSha256 =
      "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543";
    const imageContext = {
      hash: context.hash,
      original: "lesson.png",
      answer: "课程截图",
      image: {
        blob: new Blob([imageBytes], { type: "image/png" }),
        mediaType: "image/png",
        name: "lesson.png",
        byteLength: imageBytes.byteLength,
        sha256: imageSha256,
      },
      createdAt: context.createdAt,
    } as const satisfies ContextRecord;

    await repository.appendCapture([captureCreatedEvent], imageContext);
    repository.close();
    openRepositories.delete(repository);

    const reopened = await openLedgerRepository({ dbName });
    openRepositories.add(reopened);
    const stored = (await reopened.readSnapshot()).contexts[0];
    expect(stored).toMatchObject({
      original: "lesson.png",
      answer: "课程截图",
      image: {
        mediaType: "image/png",
        name: "lesson.png",
        byteLength: imageBytes.byteLength,
        sha256: imageSha256,
      },
    });
    expect(
      new Uint8Array(await stored!.image!.blob.arrayBuffer()),
    ).toEqual(imageBytes);

    await reopened.appendDiscard(captureDiscardedEvent, imageContext.hash);

    expect(await reopened.readSnapshot()).toEqual({
      events: [captureCreatedEvent, captureDiscardedEvent],
      contexts: [],
    });
  });

  it("reuses the first immutable context for repeated identical image content", async () => {
    const repository = await openTestRepository("image-context-reuse");
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const imageSha256 =
      "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543";
    const firstContext = {
      hash: context.hash,
      original: "图片记录",
      answer: "课程截图",
      image: {
        blob: new Blob([imageBytes], { type: "image/png" }),
        mediaType: "image/png",
        name: "first.png",
        byteLength: imageBytes.byteLength,
        sha256: imageSha256,
      },
      createdAt: context.createdAt,
    } as const satisfies ContextRecord;
    const secondContext = {
      ...firstContext,
      image: {
        ...firstContext.image,
        name: "renamed.png",
      },
      createdAt: "2026-07-11T00:21:00.000Z",
    } as const satisfies ContextRecord;
    const secondCapture = {
      ...captureCreatedEvent,
      eventId: "event-capture-2",
      captureId: "capture-2",
      seq: 2,
      hlc: {
        ...captureCreatedEvent.hlc,
        counter: 1,
      },
    } as const satisfies CaptureCreatedEvent;

    await repository.appendCapture([captureCreatedEvent], firstContext);
    await repository.appendCapture([secondCapture], secondContext);

    const snapshot = await repository.readSnapshot();
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.contexts).toHaveLength(1);
    expect(snapshot.contexts[0]).toMatchObject({
      createdAt: firstContext.createdAt,
      image: {
        name: "first.png",
        sha256: imageSha256,
      },
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
      name: "an empty focus context",
      events: [captureCreatedEvent],
      context: { ...context, focus: " \n " },
    },
    {
      name: "a non-canonical context timestamp",
      events: [captureCreatedEvent],
      context: { ...context, createdAt: "2026-07-11T00:20:00Z" },
    },
    {
      name: "image Blob size that differs from byteLength",
      events: [captureCreatedEvent],
      context: {
        ...context,
        image: {
          blob: new Blob(["png"], { type: "image/png" }),
          mediaType: "image/png",
          name: "lesson.png",
          byteLength: 4,
          sha256: "ab".repeat(32),
        },
      },
    },
    {
      name: "image sha256 that differs from Blob content",
      events: [captureCreatedEvent],
      context: {
        ...context,
        image: {
          blob: new Blob(["png"], { type: "image/png" }),
          mediaType: "image/png",
          name: "lesson.png",
          byteLength: 3,
          sha256: "ab".repeat(32),
        },
      },
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

  it.each([
    {
      name: "context",
      value: {
        ...context,
        futureField: "must not be stored",
      } as unknown as ContextRecord,
    },
    {
      name: "context image",
      value: {
        ...context,
        image: {
          blob: new Blob(["png"], { type: "image/png" }),
          mediaType: "image/png",
          name: "lesson.png",
          byteLength: 3,
          sha256: "ab".repeat(32),
          exifOrientation: 1,
        },
      } as unknown as ContextRecord,
    },
  ])("rejects an unknown $name field through the closed context validator", async ({
    name,
    value,
  }) => {
    const repository = await openTestRepository(`unknown-${name}`);

    await expect(
      repository.appendCapture([captureCreatedEvent], value),
    ).rejects.toThrow(/unknown field/i);
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

describe("inspectRestoreStorageState", () => {
  it.each([
    {
      store: "events" as const,
      value: { eventId: "restore-probe-event" },
      expected: { events: 1, contexts: 0, clock: 0, importReceipts: 0 },
    },
    {
      store: "contexts" as const,
      value: { hash: "restore-probe-context" },
      expected: { events: 0, contexts: 1, clock: 0, importReceipts: 0 },
    },
    {
      store: "clock" as const,
      value: { key: "global-hlc", type: "global-hlc" },
      expected: { events: 0, contexts: 0, clock: 1, importReceipts: 0 },
    },
    {
      store: "importReceipts" as const,
      value: { digest: "restore-probe-receipt" },
      expected: { events: 0, contexts: 0, clock: 0, importReceipts: 1 },
    },
  ])("reports a non-empty $store store without mutating it", async ({
    store,
    value,
    expected,
  }) => {
    const dbName = createDatabaseName(`restore-probe-${store}`);
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    await seedRestoreProbeStore(dbName, store, value);

    await expect(repository.inspectRestoreStorageState()).resolves.toEqual({
      ...expected,
      restoreCommit: undefined,
    });
    expect(await allStoreCounts(dbName)).toEqual([
      expected.events,
      expected.contexts,
      expected.clock,
      expected.importReceipts,
    ]);
  });

  it("returns a validated restore commit marker", async () => {
    const dbName = createDatabaseName("restore-probe-marker");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    const marker = {
      key: "restore-commit",
      type: "restore-commit",
      newDeviceId: "device-restored",
      committedAt: "2026-08-11T00:00:00.000Z",
    } as const;
    await seedRestoreProbeStore(dbName, "clock", marker);

    await expect(repository.inspectRestoreStorageState()).resolves.toEqual({
      events: 0,
      contexts: 0,
      clock: 1,
      importReceipts: 0,
      restoreCommit: marker,
    });
  });

  it("rejects a malformed restore commit marker with its dedicated error", async () => {
    const dbName = createDatabaseName("restore-probe-malformed-marker");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    await seedRestoreProbeStore(dbName, "clock", {
      key: "restore-commit",
      type: "restore-commit",
      newDeviceId: " device-restored ",
      committedAt: "2026-08-11T00:00:00.000Z",
    });

    await expect(repository.inspectRestoreStorageState()).rejects.toThrow(
      RestoreCommitRecordError,
    );
  });

  it("reads every restore store through one readonly transaction", async () => {
    const repository = await openTestRepository("restore-probe-single-tx");
    const nativeTransaction = IDBDatabase.prototype.transaction;
    const observedTransactions: Array<{
      readonly stores: string[];
      readonly mode: IDBTransactionMode | undefined;
    }> = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ): IDBTransaction {
      observedTransactions.push({
        stores: (typeof storeNames === "string" ? [storeNames] : [...storeNames])
          .sort(),
        mode,
      });
      return Reflect.apply(
        nativeTransaction,
        this,
        options === undefined
          ? mode === undefined
            ? [storeNames]
            : [storeNames, mode]
          : [storeNames, mode, options],
      ) as IDBTransaction;
    };

    try {
      await repository.inspectRestoreStorageState();
    } finally {
      IDBDatabase.prototype.transaction = nativeTransaction;
    }

    expect(observedTransactions).toEqual([
      {
        stores: ["clock", "contexts", "events", "importReceipts"],
        mode: "readonly",
      },
    ]);
  });
});

describe("Coach import repository capabilities", () => {
  it("commits every capture and its receipt in one batch", async () => {
    const repository = await openTestRepository("coach-batch-commit");
    const writes = [
      await importedCaptureWrite("one", 1),
      await importedCaptureWrite("two", 2),
    ];
    const receipt = receiptFor(writes);

    await expect(
      repository.appendImportedCaptureBatch(writes, receipt),
    ).resolves.toBe("imported");

    const backup = await repository.readBackupSnapshot();
    expect(backup.events).toHaveLength(2);
    expect(backup.contexts).toHaveLength(2);
    expect(backup.importReceipts).toEqual([receipt]);
  });

  it("validates every capture hash before opening the atomic write", async () => {
    const repository = await openTestRepository("coach-invalid-second");
    const first = await importedCaptureWrite("valid", 1);
    const second = await importedCaptureWrite("invalid", 2);
    const invalidSecond = {
      ...second,
      context: { ...second.context, original: "tampered after hashing" },
    } satisfies CaptureWrite;

    await expect(
      repository.appendImportedCaptureBatch(
        [first, invalidSecond],
        receiptFor([first, invalidSecond]),
      ),
    ).rejects.toThrow(/context hash.*serialized content/i);
    expect(await repository.readBackupSnapshot()).toEqual({
      events: [],
      contexts: [],
      importReceipts: [],
    });
  });

  it("treats the digest as the idempotency key with zero second-call changes", async () => {
    const repository = await openTestRepository("coach-digest-idempotency");
    const first = await importedCaptureWrite("first", 1);
    const second = await importedCaptureWrite("second", 2);
    const digest = "22".repeat(32);
    await repository.appendImportedCaptureBatch(
      [first],
      receiptFor([first], digest),
    );
    const before = await repository.readBackupSnapshot();

    await expect(
      repository.appendImportedCaptureBatch(
        [second],
        receiptFor([second], digest, "2026-08-11T00:00:02.000Z"),
      ),
    ).resolves.toBe("already-imported");

    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
  });

  it("checks a receipt digest without mutating any store", async () => {
    const repository = await openTestRepository("coach-receipt-read");
    const write = await importedCaptureWrite("receipt-read", 1);
    const receipt = receiptFor([write], "23".repeat(32));

    await expect(repository.hasImportReceipt(receipt.digest)).resolves.toBe(false);
    await repository.appendImportedCaptureBatch([write], receipt);
    const before = await repository.readBackupSnapshot();
    await expect(repository.hasImportReceipt(receipt.digest)).resolves.toBe(true);
    await expect(
      repository.hasImportReceipt(`sha256:${"AA".repeat(32)}`),
    ).rejects.toThrow(/lowercase/i);
    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
  });

  it("serializes concurrent imports of the same digest across connections", async () => {
    const dbName = createDatabaseName("coach-digest-concurrency");
    const firstRepository = await openLedgerRepository({ dbName });
    const secondRepository = await openLedgerRepository({ dbName });
    openRepositories.add(firstRepository);
    openRepositories.add(secondRepository);
    const first = await importedCaptureWrite("race-a", 1);
    const second = await importedCaptureWrite("race-b", 2);
    const digest = "33".repeat(32);

    const results = await Promise.all([
      firstRepository.appendImportedCaptureBatch(
        [first],
        receiptFor([first], digest),
      ),
      secondRepository.appendImportedCaptureBatch(
        [second],
        receiptFor([second], digest),
      ),
    ]);
    expect(results.sort()).toEqual(["already-imported", "imported"]);

    const backup = await firstRepository.readBackupSnapshot();
    expect(backup.events).toHaveLength(1);
    expect(backup.contexts).toHaveLength(1);
    expect(backup.importReceipts).toHaveLength(1);
    const storedCapture = backup.events.find(
      (event) => event.kind === "capture_created",
    )!;
    expect(backup.importReceipts[0]!.captureIds).toEqual([
      storedCapture.captureId,
    ]);
  });

  it.each([
    {
      name: "a bare digest",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        digest: "44".repeat(32),
      }),
    },
    {
      name: "an uppercase digest",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        digest: `sha256:${"AA".repeat(32)}`,
      }),
    },
    {
      name: "a non-canonical timestamp",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        importedAt: "2026-08-11T00:00:01Z",
      }),
    },
    {
      name: "blank captureIds",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        captureIds: ["   "],
      }),
    },
    {
      name: "duplicate captureIds",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        captureIds: [receipt.captureIds[0]!, receipt.captureIds[0]!],
      }),
    },
    {
      name: "an unknown field",
      mutate: (receipt: CoachImportReceipt) => ({
        ...receipt,
        futureField: true,
      }),
    },
    {
      name: "a missing field",
      mutate: (receipt: CoachImportReceipt) => ({
        digest: receipt.digest,
        captureIds: receipt.captureIds,
      }),
    },
    {
      name: "a symbol field",
      mutate: (receipt: CoachImportReceipt) => {
        const changed = { ...receipt };
        Object.defineProperty(changed, Symbol("future"), {
          value: true,
          enumerable: true,
        });
        return changed;
      },
    },
  ])("rejects a receipt with $name through the closed validator", async ({
    name,
    mutate,
  }) => {
    const repository = await openTestRepository(`coach-receipt-${name}`);
    const write = await importedCaptureWrite(`receipt-${name}`, 1);
    const invalidReceipt = mutate(receiptFor([write])) as CoachImportReceipt;

    await expect(
      repository.appendImportedCaptureBatch([write], invalidReceipt),
    ).rejects.toThrow(/receipt/i);
    expect(await repository.readBackupSnapshot()).toEqual({
      events: [],
      contexts: [],
      importReceipts: [],
    });
  });

  it("handles prototype-named capture ids without losing receipt references", async () => {
    const repository = await openTestRepository("coach-prototype-capture-ids");
    const writes = [
      await importedCaptureWrite("prototype", 1, "__proto__"),
      await importedCaptureWrite("constructor", 2, "constructor"),
    ];
    const receipt = receiptFor(writes, "55".repeat(32));

    await repository.appendImportedCaptureBatch(writes, receipt);

    expect((await repository.readBackupSnapshot()).importReceipts).toEqual([
      receipt,
    ]);
  });

  it("rolls back events, contexts, clock, and receipt when receipt put throws", async () => {
    const dbName = createDatabaseName("coach-receipt-put-rollback");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    const writes = [
      await importedCaptureWrite("rollback-a", 1),
      await importedCaptureWrite("rollback-b", 2),
    ];
    const receipt = receiptFor(writes, "66".repeat(32));
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (
        typeof value === "object" &&
        value !== null &&
        "digest" in value &&
        value.digest === receipt.digest
      ) {
        throw new Error("injected receipt put failure");
      }
      return Reflect.apply(
        nativePut,
        this,
        key === undefined ? [value] : [value, key],
      ) as IDBRequest<IDBValidKey>;
    };

    try {
      await expect(
        repository.appendImportedCaptureBatch(writes, receipt),
      ).rejects.toThrow("injected receipt put failure");
    } finally {
      IDBObjectStore.prototype.put = nativePut;
    }
    expect(await allStoreCounts(dbName)).toEqual([0, 0, 0, 0]);
  });

  it("batch discard performs final active-reference GC and retains receipts", async () => {
    const repository = await openTestRepository("coach-batch-discard-gc");
    const first = await importedCaptureWrite("shared", 1, "capture-shared-a");
    const firstEvent = first.events[0]! as CaptureCreatedEvent;
    const second = {
      events: [
        {
          ...firstEvent,
          eventId: "event-import-shared-second",
          seq: 2,
          hlc: { wallTime: firstEvent.hlc.wallTime + 1, counter: 0 },
          captureId: "capture-shared-b",
        },
      ],
      context: first.context,
    } satisfies CaptureWrite;
    const writes = [first, second];
    const receipt = receiptFor(writes, "77".repeat(32));
    await repository.appendImportedCaptureBatch(writes, receipt);

    await repository.appendDiscardBatch([
      discardWrite("capture-shared-a", first.context.hash, 10),
      discardWrite("capture-shared-b", first.context.hash, 11),
    ]);

    const backup = await repository.readBackupSnapshot();
    expect(backup.events).toHaveLength(4);
    expect(backup.contexts).toEqual([]);
    expect(backup.importReceipts).toEqual([receipt]);
  });

  it("atomically removes the matching receipt so the same digest can be imported again", async () => {
    const repository = await openTestRepository("coach-batch-undo-reimport");
    const first = await importedCaptureWrite(
      "reimport",
      1,
      "capture-reimport-first",
    );
    const digest = "79".repeat(32);
    const receipt = receiptFor([first], digest);
    await repository.appendImportedCaptureBatch([first], receipt);

    await repository.appendDiscardBatch(
      [discardWrite("capture-reimport-first", first.context.hash, 10)],
      receipt.digest,
    );

    await expect(repository.hasImportReceipt(receipt.digest)).resolves.toBe(
      false,
    );
    const afterUndo = await repository.readBackupSnapshot();
    expect(afterUndo.importReceipts).toEqual([]);
    expect(afterUndo.contexts).toEqual([]);

    const firstEvent = first.events[0]! as CaptureCreatedEvent;
    const second = {
      events: [
        {
          ...firstEvent,
          eventId: "event-import-reimport-second",
          seq: 20,
          hlc: { wallTime: firstEvent.hlc.wallTime + 20, counter: 0 },
          captureId: "capture-reimport-second",
        },
      ],
      context: first.context,
    } satisfies CaptureWrite;
    const secondReceipt = receiptFor(
      [second],
      digest,
      "2026-08-11T00:00:02.000Z",
    );

    await expect(
      repository.appendImportedCaptureBatch([second], secondReceipt),
    ).resolves.toBe("imported");
    const afterReimport = await repository.readBackupSnapshot();
    expect(afterReimport.importReceipts).toEqual([secondReceipt]);
    expect(afterReimport.contexts).toEqual([first.context]);
    expect(
      afterReimport.events.some(
        (event) =>
          event.kind === "capture_created" &&
          event.captureId === "capture-reimport-second",
      ),
    ).toBe(true);
  });

  it("rolls back every discard when receipt captureIds do not exactly match the targets", async () => {
    const repository = await openTestRepository(
      "coach-batch-undo-receipt-mismatch",
    );
    const writes = [
      await importedCaptureWrite("receipt-mismatch-a", 1),
      await importedCaptureWrite("receipt-mismatch-b", 2),
    ];
    const receipt = receiptFor(writes, "7a".repeat(32));
    await repository.appendImportedCaptureBatch(writes, receipt);
    const before = await repository.readBackupSnapshot();
    const firstCapture = writes[0]!.events[0]! as CaptureCreatedEvent;

    await expect(
      repository.appendDiscardBatch(
        [discardWrite(firstCapture.captureId, writes[0]!.context.hash, 10)],
        receipt.digest,
      ),
    ).rejects.toThrow(/exactly match/i);
    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
  });

  it("rolls back discard events and contexts when receipt deletion fails", async () => {
    const dbName = createDatabaseName("coach-batch-undo-delete-rollback");
    const repository = await openLedgerRepository({ dbName });
    openRepositories.add(repository);
    const write = await importedCaptureWrite("receipt-delete-rollback", 1);
    const receipt = receiptFor([write], "7b".repeat(32));
    await repository.appendImportedCaptureBatch([write], receipt);
    const capture = write.events[0]! as CaptureCreatedEvent;
    const before = await repository.readBackupSnapshot();
    const clockBefore = await readClockStore(dbName);
    const nativeDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ): IDBRequest<undefined> {
      if (this.name === "importReceipts" && query === receipt.digest) {
        throw new Error("injected receipt delete failure");
      }
      return Reflect.apply(nativeDelete, this, [query]) as IDBRequest<undefined>;
    };

    try {
      await expect(
        repository.appendDiscardBatch(
          [discardWrite(capture.captureId, write.context.hash, 10)],
          receipt.digest,
        ),
      ).rejects.toThrow("injected receipt delete failure");
    } finally {
      IDBObjectStore.prototype.delete = nativeDelete;
    }
    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
    expect(await readClockStore(dbName)).toEqual(clockBefore);
  });

  it("rejects a discard whose capture and context do not belong together", async () => {
    const repository = await openTestRepository("coach-batch-discard-mismatch");
    const first = await importedCaptureWrite("mismatch-a", 1);
    const second = await importedCaptureWrite("mismatch-b", 2);
    const writes = [first, second];
    await repository.appendImportedCaptureBatch(
      writes,
      receiptFor(writes, "78".repeat(32)),
    );
    const before = await repository.readBackupSnapshot();
    const firstCapture = first.events[0]! as CaptureCreatedEvent;

    await expect(
      repository.appendDiscardBatch([
        discardWrite(firstCapture.captureId, second.context.hash, 10),
      ]),
    ).rejects.toThrow(/belongs to context/i);
    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
  });

  it("rolls back every discard when a later discard put throws", async () => {
    const repository = await openTestRepository("coach-batch-discard-rollback");
    const writes = [
      await importedCaptureWrite("discard-a", 1),
      await importedCaptureWrite("discard-b", 2),
    ];
    const receipt = receiptFor(writes, "88".repeat(32));
    await repository.appendImportedCaptureBatch(writes, receipt);
    const discards = writes.map((write, index) => {
      const capture = write.events[0]! as CaptureCreatedEvent;
      return discardWrite(capture.captureId, write.context.hash, 10 + index);
    });
    const before = await repository.readBackupSnapshot();
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (
        typeof value === "object" &&
        value !== null &&
        "eventId" in value &&
        value.eventId === discards[1]!.event.eventId
      ) {
        throw new Error("injected second discard put failure");
      }
      return Reflect.apply(
        nativePut,
        this,
        key === undefined ? [value] : [value, key],
      ) as IDBRequest<IDBValidKey>;
    };

    try {
      await expect(repository.appendDiscardBatch(discards)).rejects.toThrow(
        "injected second discard put failure",
      );
    } finally {
      IDBObjectStore.prototype.put = nativePut;
    }
    await expect(
      structurallyEqual(await repository.readBackupSnapshot(), before),
    ).resolves.toBe(true);
  });

  it("reads one coherent backup snapshot through a single IndexedDB transaction", async () => {
    const repository = await openTestRepository("coach-backup-single-tx");
    const write = await importedCaptureWrite("backup", 1);
    await repository.appendImportedCaptureBatch(
      [write],
      receiptFor([write], "99".repeat(32)),
    );
    const nativeTransaction = IDBDatabase.prototype.transaction;
    const observedStoreSets: string[][] = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ): IDBTransaction {
      observedStoreSets.push(
        (typeof storeNames === "string" ? [storeNames] : [...storeNames]).sort(),
      );
      return Reflect.apply(
        nativeTransaction,
        this,
        options === undefined
          ? mode === undefined
            ? [storeNames]
            : [storeNames, mode]
          : [storeNames, mode, options],
      ) as IDBTransaction;
    };

    try {
      const backup = await repository.readBackupSnapshot();
      expect(backup.events).toHaveLength(1);
      expect(backup.contexts).toHaveLength(1);
      expect(backup.importReceipts).toHaveLength(1);
    } finally {
      IDBDatabase.prototype.transaction = nativeTransaction;
    }
    expect(observedStoreSets).toEqual([
      ["contexts", "events", "importReceipts"],
    ]);
  });
});
