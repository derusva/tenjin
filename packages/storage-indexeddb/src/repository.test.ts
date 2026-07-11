import "fake-indexeddb/auto";

import type {
  CaptureCreatedEvent,
  CaptureDiscardedEvent,
  Event,
  ItemCreatedEvent,
} from "@tenjin/core";
import { deleteDB } from "idb";
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

afterEach(async () => {
  for (const repository of openRepositories) {
    repository.close();
  }
  openRepositories.clear();
  await Promise.all([...openDatabaseNames].map((dbName) => deleteDB(dbName)));
  openDatabaseNames.clear();
});

describe("openLedgerRepository", () => {
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

  it("rolls back earlier writes when structured cloning fails mid-transaction", async () => {
    const repository = await openTestRepository("append-capture-rollback");
    const uncloneableEvent = {
      ...itemCreatedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        uncloneable: () => "functions cannot be cloned",
      },
    } as unknown as Event;

    await expect(
      repository.appendCapture(
        [captureCreatedEvent, uncloneableEvent],
        context,
      ),
    ).rejects.toThrow();

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

  it("rejects a repeated eventId when cloneable non-record content differs", async () => {
    const repository = await openTestRepository("event-date-conflict");
    const storedEvent = {
      ...itemCreatedEvent,
      eventId: "event-with-date",
      payload: {
        ...itemCreatedEvent.payload,
        observedDate: new Date("2026-07-11T00:20:00.000Z"),
      },
    } as unknown as Event;
    const conflictingEvent = {
      ...storedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        observedDate: new Date("2026-07-11T00:21:00.000Z"),
      },
    } as unknown as Event;
    const equalReplay = {
      ...storedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        observedDate: new Date("2026-07-11T00:20:00.000Z"),
      },
    } as unknown as Event;

    await repository.appendEvents([storedEvent]);
    await repository.appendEvents([equalReplay]);
    await expect(repository.appendEvents([conflictingEvent])).rejects.toThrow(
      /eventId/i,
    );
    expect(await repository.readSnapshot()).toEqual({
      events: [storedEvent],
      contexts: [],
    });
  });

  it("accepts an equivalent RegExp replay for the same eventId", async () => {
    const repository = await openTestRepository("event-regexp-replay");
    const storedEvent = {
      ...itemCreatedEvent,
      eventId: "event-with-regexp",
      payload: {
        ...itemCreatedEvent.payload,
        matcher: new RegExp("tenjin", "giu"),
      },
    } as unknown as Event;
    const equalReplay = {
      ...storedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        matcher: new RegExp("tenjin", "giu"),
      },
    } as unknown as Event;

    await repository.appendEvents([storedEvent]);

    await expect(
      repository.appendEvents([equalReplay]),
    ).resolves.toBeUndefined();
    expect(await repository.readSnapshot()).toEqual({
      events: [storedEvent],
      contexts: [],
    });
  });

  it.each([
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
  ])("accepts an equivalent $name structured-clone value replay", async ({
    name,
    createValue,
  }) => {
    const repository = await openTestRepository(`event-clone-${name}`);
    const storedEvent = {
      ...itemCreatedEvent,
      eventId: `event-with-${name}`,
      payload: {
        ...itemCreatedEvent.payload,
        cloneValue: createValue(),
      },
    } as unknown as Event;
    const equalReplay = {
      ...storedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        cloneValue: createValue(),
      },
    } as unknown as Event;

    await repository.appendEvents([storedEvent]);

    await expect(
      repository.appendEvents([equalReplay]),
    ).resolves.toBeUndefined();
  });

  it("accepts an equivalent cyclic event replay", async () => {
    const repository = await openTestRepository("event-cyclic-replay");
    const createCyclicPayload = (): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        ...itemCreatedEvent.payload,
      };
      payload.self = payload;
      return payload;
    };
    const storedEvent = {
      ...itemCreatedEvent,
      eventId: "event-with-cycle",
      payload: createCyclicPayload(),
    } as unknown as Event;
    const equalReplay = {
      ...storedEvent,
      payload: createCyclicPayload(),
    } as unknown as Event;

    await repository.appendEvents([storedEvent]);

    await expect(repository.appendEvents([equalReplay])).resolves.toBeUndefined();
  });

  it("distinguishes a sparse array hole from an explicit undefined value", async () => {
    const repository = await openTestRepository("event-sparse-array");
    const sparseValues = new Array<string | undefined>(2);
    sparseValues[1] = "tenjin";
    const storedEvent = {
      ...itemCreatedEvent,
      eventId: "event-with-sparse-array",
      payload: {
        ...itemCreatedEvent.payload,
        values: sparseValues,
      },
    } as unknown as Event;
    const conflictingReplay = {
      ...storedEvent,
      payload: {
        ...itemCreatedEvent.payload,
        values: [undefined, "tenjin"],
      },
    } as unknown as Event;

    await repository.appendEvents([storedEvent]);

    await expect(repository.appendEvents([conflictingReplay])).rejects.toThrow(
      /eventId/i,
    );
    expect(await repository.readSnapshot()).toEqual({
      events: [storedEvent],
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

  it("accepts an equal Blob replay for the same eventId", async () => {
    const repository = await openTestRepository("event-blob-replay");
    const createEvent = (contents: string): Event =>
      ({
        ...itemCreatedEvent,
        eventId: "event-with-blob",
        payload: {
          ...itemCreatedEvent.payload,
          attachment: new Blob([contents], { type: "text/plain" }),
        },
      }) as unknown as Event;

    await repository.appendEvents([createEvent("tenjin")]);

    await expect(
      repository.appendEvents([createEvent("tenjin")]),
    ).resolves.toBeUndefined();
  });

  it("rejects a same-ID Blob replay with different bytes", async () => {
    const repository = await openTestRepository("event-blob-conflict");
    const createEvent = (contents: string): Event =>
      ({
        ...itemCreatedEvent,
        eventId: "event-with-blob-conflict",
        payload: {
          ...itemCreatedEvent.payload,
          attachment: new Blob([contents], { type: "text/plain" }),
        },
      }) as unknown as Event;
    const storedEvent = createEvent("tenjin");

    await repository.appendEvents([storedEvent]);

    await expect(
      repository.appendEvents([createEvent("TENJIN")]),
    ).rejects.toThrow(/eventId/i);
    const snapshot = await repository.readSnapshot();
    const storedPayload = snapshot.events[0]?.payload as Record<string, unknown>;
    expect(await (storedPayload.attachment as Blob).text()).toBe("tenjin");
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
