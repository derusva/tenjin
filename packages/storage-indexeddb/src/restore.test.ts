import "fake-indexeddb/auto";

import { serializeContextHashInput, type Event } from "@tenjin/core";
import { deleteDB, openDB, type DBSchema } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openLedgerRepository,
  type ContextRecord,
  type LedgerRepository,
} from "./repository.js";
import {
  RestoreCommitRecordError,
  type RestoreCommitRecord,
} from "./restoreCommit.js";
import type {
  LedgerRestorer,
  RestoreContextInput,
  RestoreLedgerInput,
} from "./restore.js";

interface InspectionDatabase extends DBSchema {
  events: { key: string; value: Event };
  contexts: { key: string; value: ContextRecord };
  clock: { key: string; value: unknown };
}

const databases = new Set<string>();
const repositories = new Set<LedgerRepository>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const repository of repositories) repository.close();
  repositories.clear();
  await Promise.all([...databases].map((name) => deleteDB(name)));
  databases.clear();
});

function databaseName(label: string): string {
  const name = `tenjin-restore-${label}-${crypto.randomUUID()}`;
  databases.add(name);
  return name;
}

async function openRestoreRepository(
  name: string,
): Promise<LedgerRepository & LedgerRestorer> {
  const repository = await openLedgerRepository({ dbName: name });
  repositories.add(repository);
  return repository;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createContext(
  imageBytes?: Uint8Array,
): Promise<RestoreContextInput> {
  const original = "手を打つ";
  const answer = "采取措施";
  const imageSha256 =
    imageBytes === undefined ? undefined : await sha256Hex(imageBytes);
  const hash = await sha256Hex(
    new TextEncoder().encode(
      serializeContextHashInput({
        original,
        answer,
        ...(imageSha256 === undefined ? {} : { imageSha256 }),
      }),
    ),
  );
  return {
    hash: `sha256:${hash}`,
    original,
    answer,
    ...(imageBytes === undefined
      ? {}
      : {
          image: {
            mediaType: "image/png" as const,
            name: "p5r.png",
            byteLength: imageBytes.byteLength,
            sha256: imageSha256!,
            bytes: imageBytes,
          },
        }),
    createdAt: "2026-08-10T10:00:00.000Z",
  };
}

function captureEvent(
  deviceId: string,
  seq: number,
  wallTime: number,
  contextHash: string,
  captureId = `capture-${deviceId}-${seq}`,
): Event {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-10T10:00:00.000Z",
    recordedAt: "2026-08-10T10:00:00.000Z",
    actor: "user",
    ruleVersion: "vertical-slice-v1",
    kind: "capture_created",
    captureId,
    contextHash,
    payload: { captureType: "lookup" },
  };
}

async function validInput(options: {
  readonly imageBytes?: Uint8Array;
  readonly eventDeviceId?: string;
  readonly eventWallTime?: number;
  readonly forbiddenDeviceIds?: readonly string[];
} = {}): Promise<RestoreLedgerInput> {
  const storedContext = await createContext(options.imageBytes);
  const eventDeviceId = options.eventDeviceId ?? "device-source";
  const eventWallTime = options.eventWallTime ?? 100;
  return {
    events: [captureEvent(eventDeviceId, 1, eventWallTime, storedContext.hash)],
    contexts: [storedContext],
    globalHlc: { wallTime: eventWallTime, counter: 0 },
    maxSeqByDevice: Object.fromEntries([[eventDeviceId, 1]]),
    forbiddenDeviceIds:
      options.forbiddenDeviceIds ?? [eventDeviceId, "device-exporter"],
  };
}

async function inspect(name: string): Promise<{
  readonly events: readonly Event[];
  readonly contexts: readonly ContextRecord[];
  readonly clock: readonly unknown[];
}> {
  const database = await openDB<InspectionDatabase>(name, 2);
  try {
    const transaction = database.transaction(
      ["events", "contexts", "clock"],
      "readonly",
    );
    const result = await Promise.all([
      transaction.objectStore("events").getAll(),
      transaction.objectStore("contexts").getAll(),
      transaction.objectStore("clock").getAll(),
    ]);
    await transaction.done;
    return { events: result[0], contexts: result[1], clock: result[2] };
  } finally {
    database.close();
  }
}

async function seed(
  name: string,
  store: "events" | "contexts" | "clock",
  value: unknown,
): Promise<void> {
  const database = await openDB<InspectionDatabase>(name, 2);
  try {
    const transaction = database.transaction(store, "readwrite");
    await transaction.objectStore(store).put(value as never);
    await transaction.done;
  } finally {
    database.close();
  }
}

describe("restoreLedger", () => {
  it.each(["", "   ", " device-new "])(
    "rejects non-canonical new device id %j before writing",
    async (newDeviceId) => {
      const name = databaseName("bad-new-id");
      const repository = await openRestoreRepository(name);
      await expect(
        repository.restoreLedger(await validInput(), newDeviceId),
      ).rejects.toThrow(/newDeviceId.*canonical/i);
      expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
    },
  );

  it("rejects a device id from the explicit forbidden set", async () => {
    const name = databaseName("forbidden");
    const repository = await openRestoreRepository(name);
    await expect(
      repository.restoreLedger(await validInput(), "device-exporter"),
    ).rejects.toThrow(/forbidden/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it("rejects an event device even if a malformed caller omits it from forbiddenDeviceIds", async () => {
    const name = databaseName("event-device");
    const repository = await openRestoreRepository(name);
    const input = await validInput({ forbiddenDeviceIds: ["device-exporter"] });
    await expect(
      repository.restoreLedger(input, "device-source"),
    ).rejects.toThrow(/event device/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it("rejects a context hash mismatch before writing", async () => {
    const name = databaseName("context-hash");
    const repository = await openRestoreRepository(name);
    const input = await validInput();
    const tampered: RestoreLedgerInput = {
      ...input,
      contexts: [{ ...input.contexts[0]!, original: "tampered" }],
    };
    await expect(
      repository.restoreLedger(tampered, "device-new"),
    ).rejects.toThrow(/context sha256.*serialized content/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it("rejects image bytes whose digest does not match before writing", async () => {
    const name = databaseName("image-digest");
    const repository = await openRestoreRepository(name);
    const input = await validInput({ imageBytes: new Uint8Array([1, 2, 3]) });
    const storedContext = input.contexts[0]!;
    const tampered: RestoreLedgerInput = {
      ...input,
      contexts: [
        {
          ...storedContext,
          image: {
            ...storedContext.image!,
            bytes: new Uint8Array([1, 2, 4]),
          },
        },
      ],
    };
    await expect(
      repository.restoreLedger(tampered, "device-new"),
    ).rejects.toThrow(/image sha256.*Blob content/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it("rejects an invalid core event before writing", async () => {
    const name = databaseName("invalid-event");
    const repository = await openRestoreRepository(name);
    const input = await validInput();
    const invalidEvent = {
      ...input.events[0]!,
      seq: 0,
    } as Event;
    await expect(
      repository.restoreLedger(
        { ...input, events: [invalidEvent] },
        "device-new",
      ),
    ).rejects.toThrow(/Invalid restore event/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it.each(["events", "contexts", "clock"] as const)(
    "rejects when only the %s store is non-empty and changes nothing",
    async (store) => {
      const name = databaseName(`nonempty-${store}`);
      const repository = await openRestoreRepository(name);
      const input = await validInput();
      const seedValue =
        store === "events"
          ? input.events[0]!
          : store === "contexts"
            ? {
                hash: "seed-context",
                original: "seed",
                createdAt: "2026-08-10T00:00:00.000Z",
              }
            : {
                key: "global-hlc",
                type: "global-hlc",
                hlc: { wallTime: 1, counter: 0 },
              };
      await seed(name, store, seedValue);
      const before = await inspect(name);
      await expect(
        repository.restoreLedger(input, "device-new"),
      ).rejects.toThrow(/目标库非空/);
      expect(await inspect(name)).toEqual(before);
    },
  );

  it("atomically restores image bytes, exact clock watermarks, and the durable marker", async () => {
    const name = databaseName("success");
    const repository = await openRestoreRepository(name);
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const input = await validInput({ imageBytes });

    await repository.restoreLedger(input, "device-new");

    const state = await inspect(name);
    expect(state.events).toEqual(input.events);
    expect(state.contexts).toHaveLength(1);
    const image = state.contexts[0]!.image!;
    expect(new Uint8Array(await image.blob.arrayBuffer())).toEqual(imageBytes);
    expect(image.blob.type).toBe("image/png");
    const clock = state.clock as readonly Record<string, unknown>[];
    expect(clock.map((record) => record.key).sort()).toEqual([
      "device-sequence:device-source",
      "global-hlc",
      "restore-commit",
    ]);
    expect(clock).toContainEqual({
      key: "device-sequence:device-source",
      type: "device-sequence",
      deviceId: "device-source",
      seq: 1,
    });
    expect(clock).not.toContainEqual(
      expect.objectContaining({ key: "device-sequence:device-new" }),
    );
    expect(clock).toContainEqual({
      key: "global-hlc",
      type: "global-hlc",
      hlc: { wallTime: 100, counter: 1 },
    });

    const marker = await repository.readRestoreCommit();
    expect(marker).toMatchObject({
      key: "restore-commit",
      type: "restore-commit",
      newDeviceId: "device-new",
    });
    expect(new Date(marker!.committedAt).toISOString()).toBe(marker!.committedAt);

    repository.close();
    repositories.delete(repository);
    const reopened = await openRestoreRepository(name);
    expect(await reopened.readRestoreCommit()).toEqual(marker);
  });

  it("rolls back all stores and the marker when a put fails mid-transaction", async () => {
    const name = databaseName("put-failure");
    const repository = await openRestoreRepository(name);
    const nativePut = IDBObjectStore.prototype.put;
    let markerWasScheduled = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = key === undefined
        ? nativePut.call(this, value)
        : nativePut.call(this, value, key);
      if (
        typeof value === "object" &&
        value !== null &&
        "key" in value &&
        value.key === "restore-commit"
      ) {
        markerWasScheduled = true;
        throw new Error("injected restore put failure after marker scheduling");
      }
      return request;
    });

    await expect(
      repository.restoreLedger(await validInput(), "device-new"),
    ).rejects.toThrow("injected restore put failure after marker scheduling");
    expect(markerWasScheduled).toBe(true);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
    expect(await repository.readRestoreCommit()).toBeUndefined();
  });

  it("rejects a second restore as non-empty and preserves all three stores", async () => {
    const name = databaseName("second-restore");
    const repository = await openRestoreRepository(name);
    const input = await validInput();
    await repository.restoreLedger(input, "device-new");
    const before = await inspect(name);

    await expect(
      repository.restoreLedger(input, "device-another"),
    ).rejects.toThrow(/目标库非空/);
    expect(await inspect(name)).toEqual(before);
  });

  it("serializes concurrent restores so exactly one succeeds", async () => {
    const name = databaseName("concurrent");
    const first = await openRestoreRepository(name);
    const second = await openRestoreRepository(name);
    const firstImage = new Uint8Array([1, 1]);
    const secondImage = new Uint8Array([2, 2, 2]);
    const firstInput = await validInput({
      imageBytes: firstImage,
      eventDeviceId: "device-source-a",
      eventWallTime: 100,
    });
    const secondInput = await validInput({
      imageBytes: secondImage,
      eventDeviceId: "device-source-b",
      eventWallTime: 200,
    });
    const results = await Promise.allSettled([
      first.restoreLedger(firstInput, "device-new-a"),
      second.restoreLedger(secondInput, "device-new-b"),
    ]);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/目标库非空/);
    const marker = await first.readRestoreCommit();
    const expectedInput = winnerIndex === 0 ? firstInput : secondInput;
    const expectedNewDeviceId = winnerIndex === 0 ? "device-new-a" : "device-new-b";
    const expectedImage = winnerIndex === 0 ? firstImage : secondImage;
    expect(marker!.newDeviceId).toBe(expectedNewDeviceId);

    const state = await inspect(name);
    expect(state.events).toEqual(expectedInput.events);
    expect(state.contexts).toHaveLength(1);
    expect(state.contexts[0]).toMatchObject({
      hash: expectedInput.contexts[0]!.hash,
      original: expectedInput.contexts[0]!.original,
      answer: expectedInput.contexts[0]!.answer,
      image: {
        mediaType: "image/png",
        byteLength: expectedImage.byteLength,
        sha256: expectedInput.contexts[0]!.image!.sha256,
      },
    });
    expect(
      new Uint8Array(await state.contexts[0]!.image!.blob.arrayBuffer()),
    ).toEqual(expectedImage);
    expect(state.clock).toEqual(
      expect.arrayContaining([
        {
          key: `device-sequence:${expectedInput.events[0]!.deviceId}`,
          type: "device-sequence",
          deviceId: expectedInput.events[0]!.deviceId,
          seq: 1,
        },
        {
          key: "global-hlc",
          type: "global-hlc",
          hlc: {
            wallTime: expectedInput.globalHlc.wallTime,
            counter: expectedInput.globalHlc.counter + 1,
          },
        },
        expect.objectContaining({
          key: "restore-commit",
          newDeviceId: expectedNewDeviceId,
        }),
      ]),
    );
    expect(state.clock).toHaveLength(3);
  });

  it("preserves prototype-named historical device watermarks as exact clock keys", async () => {
    const name = databaseName("prototype-ids");
    const repository = await openRestoreRepository(name);
    const storedContext = await createContext();
    const devices = ["__proto__", "constructor", "toString"] as const;
    const events = devices.map((deviceId, index) =>
      captureEvent(deviceId, index + 1, index + 1, storedContext.hash),
    );
    const input: RestoreLedgerInput = {
      events,
      contexts: [storedContext],
      globalHlc: { wallTime: 3, counter: 0 },
      maxSeqByDevice: Object.fromEntries(
        devices.map((deviceId, index) => [deviceId, index + 1]),
      ),
      forbiddenDeviceIds: devices,
    };

    await repository.restoreLedger(input, "device-new");
    const clock = (await inspect(name)).clock as readonly Record<string, unknown>[];
    const keys = clock
      .map((record) => (record as { readonly key: string }).key)
      .sort();
    expect(keys).toEqual([
      "device-sequence:__proto__",
      "device-sequence:constructor",
      "device-sequence:toString",
      "global-hlc",
      "restore-commit",
    ]);
    for (const [index, deviceId] of devices.entries()) {
      expect(clock).toContainEqual({
        key: `device-sequence:${deviceId}`,
        type: "device-sequence",
        deviceId,
        seq: index + 1,
      });
    }
  });

  it("rejects an exhausted HLC successor before opening a write transaction", async () => {
    const name = databaseName("hlc-overflow");
    const repository = await openRestoreRepository(name);
    const storedContext = await createContext();
    const event = {
      ...captureEvent("device-source", 1, Number.MAX_SAFE_INTEGER, storedContext.hash),
      hlc: {
        wallTime: Number.MAX_SAFE_INTEGER,
        counter: Number.MAX_SAFE_INTEGER,
      },
    } satisfies Event;
    const input: RestoreLedgerInput = {
      events: [event],
      contexts: [storedContext],
      globalHlc: {
        wallTime: Number.MAX_SAFE_INTEGER,
        counter: Number.MAX_SAFE_INTEGER,
      },
      maxSeqByDevice: { "device-source": 1 },
      forbiddenDeviceIds: ["device-source", "device-exporter"],
    };
    await expect(
      repository.restoreLedger(input, "device-new"),
    ).rejects.toThrow(/clock.*exhausted/i);
    expect(await inspect(name)).toEqual({ events: [], contexts: [], clock: [] });
  });

  it("rolls an exhausted counter into the next safe wall time", async () => {
    const name = databaseName("hlc-counter-rollover");
    const repository = await openRestoreRepository(name);
    const storedContext = await createContext();
    const event = {
      ...captureEvent("device-source", 1, 100, storedContext.hash),
      hlc: { wallTime: 100, counter: Number.MAX_SAFE_INTEGER },
    } satisfies Event;
    await repository.restoreLedger(
      {
        events: [event],
        contexts: [storedContext],
        globalHlc: event.hlc,
        maxSeqByDevice: { "device-source": 1 },
        forbiddenDeviceIds: ["device-source", "device-exporter"],
      },
      "device-new",
    );
    expect((await inspect(name)).clock).toContainEqual({
      key: "global-hlc",
      type: "global-hlc",
      hlc: { wallTime: 101, counter: 0 },
    });
  });
});

describe("readRestoreCommit", () => {
  it("returns undefined when the marker is absent", async () => {
    const repository = await openRestoreRepository(databaseName("marker-absent"));
    await expect(repository.readRestoreCommit()).resolves.toBeUndefined();
  });

  it("rejects malformed stored markers with a dedicated error", async () => {
    const name = databaseName("marker-malformed");
    const repository = await openRestoreRepository(name);
    await seed(name, "clock", {
      key: "restore-commit",
      type: "restore-commit",
      newDeviceId: " device ",
      committedAt: "2026-08-10T10:00:00.000Z",
    });
    await expect(repository.readRestoreCommit()).rejects.toThrow(
      RestoreCommitRecordError,
    );
  });
});

// Compile-time guard: restore stays a separate capability, so existing mocks
// and consumers may continue to implement only LedgerRepository.
const _ledgerOnlyConsumer: LedgerRepository | undefined = undefined;
void _ledgerOnlyConsumer;
const _markerShape: RestoreCommitRecord | undefined = undefined;
void _markerShape;
