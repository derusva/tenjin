import "fake-indexeddb/auto";

import {
  serializeContextHashInput,
  type Event,
  type HybridLogicalClock,
} from "@tenjin/core";
import { deleteDB, openDB, type DBSchema } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openLedgerRepository,
  structurallyEqual,
  type ContextRecord,
  type LedgerRepository,
} from "./repository.js";
import type { LedgerRestorer, RestoreLedgerInput } from "./restore.js";
import {
  cloneLedgerDatabase,
  verifyLedgerEquivalence,
  type ReviewQueueProbe,
  type VerifyLedgerEquivalenceInput,
} from "./verifyEquivalence.js";

interface TestLedgerDatabase extends DBSchema {
  events: { key: string; value: Event };
  contexts: { key: string; value: ContextRecord };
  clock: { key: string; value: unknown };
}

const databases = new Set<string>();
const repositories = new Set<LedgerRepository>();
const PACKAGE_MAX_HLC: HybridLogicalClock = { wallTime: 100, counter: 3 };
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

afterEach(async () => {
  for (const repository of repositories) repository.close();
  repositories.clear();
  await Promise.all([...databases].map((name) => deleteDB(name)));
  databases.clear();
  vi.restoreAllMocks();
});

function databaseName(label: string): string {
  const name = `tenjin-equivalence-${label}-${crypto.randomUUID()}`;
  databases.add(name);
  return name;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stable = bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", stable);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fixtureContext(): Promise<ContextRecord> {
  const original = "大丈夫、手は打ったから。";
  const answer = "没关系，已经采取措施了。";
  const imageSha256 = await sha256Hex(IMAGE_BYTES);
  const digest = await sha256Hex(
    new TextEncoder().encode(
      serializeContextHashInput({ original, answer, imageSha256 }),
    ),
  );
  return {
    hash: `sha256:${digest}`,
    original,
    answer,
    image: {
      blob: new Blob([IMAGE_BYTES], { type: "image/png" }),
      mediaType: "image/png",
      name: "p5r.png",
      byteLength: IMAGE_BYTES.byteLength,
      sha256: imageSha256,
    },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function fixtureEvents(contextHash: string): readonly Event[] {
  const common = (seq: number) => ({
    schemaVersion: 1,
    eventId: `device-source:${seq}`,
    deviceId: "device-source",
    seq,
    hlc: { wallTime: 100, counter: seq },
    occurredAt: "2026-08-11T00:00:00.000Z",
    recordedAt: "2026-08-11T00:00:00.000Z",
    actor: "user" as const,
    ruleVersion: "vertical-slice-v1",
  });
  return [
    {
      ...common(1),
      kind: "capture_created",
      captureId: "capture-1",
      contextHash,
      payload: { captureType: "lookup" },
    },
    {
      ...common(2),
      kind: "item_created",
      captureId: "capture-1",
      itemId: "item-1",
      payload: {
        display: "手を打つ",
        identityKey: "text:手を打つ",
        targetChannels: ["R"],
      },
    },
    {
      ...common(3),
      kind: "lookup_observed",
      captureId: "capture-1",
      itemId: "item-1",
      payload: { channel: "R", result: "lookup" },
    },
  ];
}

const queueProjection: ReviewQueueProbe = (view, snapshot) => {
  const captureHash = new Map(
    snapshot.events.flatMap((event) =>
      event.kind === "capture_created"
        ? [[event.captureId, event.contextHash] as const]
        : [],
    ),
  );
  const itemCapture = new Map(
    snapshot.events.flatMap((event) =>
      event.kind === "item_created"
        ? [[event.itemId, event.captureId] as const]
        : [],
    ),
  );
  const contexts = new Map(snapshot.contexts.map((context) => [context.hash, context]));
  return view.items.flatMap((item) => {
    const captureId = itemCapture.get(item.itemId);
    const context =
      captureId === undefined
        ? undefined
        : contexts.get(captureHash.get(captureId) ?? "");
    return context?.answer === undefined
      ? []
      : [
          {
            itemId: item.itemId,
            channel: "R",
            prompt: context.original,
            reveal: context.answer,
          },
        ];
  });
};

interface Harness {
  readonly sourceName: string;
  readonly restoredName: string;
  readonly source: LedgerRepository & LedgerRestorer;
  readonly restored: LedgerRepository & LedgerRestorer;
  readonly input: RestoreLedgerInput;
  readonly verifyInput: Omit<VerifyLedgerEquivalenceInput, "reviewQueueProbe">;
}

async function createHarness(label: string): Promise<Harness> {
  const sourceName = databaseName(`${label}-source`);
  const restoredName = databaseName(`${label}-restored`);
  const source = await openLedgerRepository({ dbName: sourceName });
  const restored = await openLedgerRepository({ dbName: restoredName });
  repositories.add(source);
  repositories.add(restored);
  const context = await fixtureContext();
  const events = fixtureEvents(context.hash);
  await source.appendCapture(events, context);
  const input: RestoreLedgerInput = {
    events,
    contexts: [
      {
        hash: context.hash,
        original: context.original,
        answer: context.answer!,
        image: {
          mediaType: context.image!.mediaType,
          name: context.image!.name,
          byteLength: context.image!.byteLength,
          sha256: context.image!.sha256,
          bytes: new Uint8Array(await context.image!.blob.arrayBuffer()),
        },
        createdAt: context.createdAt,
      },
    ],
    globalHlc: PACKAGE_MAX_HLC,
    maxSeqByDevice: { "device-source": 3 },
    forbiddenDeviceIds: ["device-source", "device-exporter"],
  };
  await restored.restoreLedger(input, "device-restored");
  return {
    sourceName,
    restoredName,
    source,
    restored,
    input,
    verifyInput: {
      sourceDatabaseName: sourceName,
      restoredDatabaseName: restoredName,
      packageMaxHlc: PACKAGE_MAX_HLC,
      maxSeqByDevice: input.maxSeqByDevice,
      expectedNewDeviceId: "device-restored",
      reviewBudget: 5,
    },
  };
}

async function putRecord(
  databaseNameValue: string,
  storeName: "events" | "contexts" | "clock",
  value: unknown,
): Promise<void> {
  const database = await openDB<TestLedgerDatabase>(databaseNameValue);
  try {
    const transaction = database.transaction(storeName, "readwrite");
    await transaction.objectStore(storeName).put(value as never);
    await transaction.done;
  } finally {
    database.close();
  }
}

async function clearStore(
  databaseNameValue: string,
  storeName: "events" | "contexts" | "clock",
): Promise<void> {
  const database = await openDB<TestLedgerDatabase>(databaseNameValue);
  try {
    const transaction = database.transaction(storeName, "readwrite");
    await transaction.objectStore(storeName).clear();
    await transaction.done;
  } finally {
    database.close();
  }
}

async function deleteRecord(
  databaseNameValue: string,
  storeName: "events" | "contexts" | "clock",
  key: string,
): Promise<void> {
  const database = await openDB<TestLedgerDatabase>(databaseNameValue);
  try {
    const transaction = database.transaction(storeName, "readwrite");
    await transaction.objectStore(storeName).delete(key);
    await transaction.done;
  } finally {
    database.close();
  }
}

async function dumpDatabase(name: string) {
  const database = await openDB<TestLedgerDatabase>(name);
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
    return result;
  } finally {
    database.close();
  }
}

describe("verifyLedgerEquivalence", () => {
  it("rejects comparing a database with itself", async () => {
    const harness = await createHarness("same-database");
    await expect(
      verifyLedgerEquivalence({
        ...harness.verifyInput,
        restoredDatabaseName: harness.sourceName,
        reviewQueueProbe: queueProjection,
      }),
    ).rejects.toThrow(/source and restored database names must differ/i);
  });

  it("passes all layers and does not mutate either database", async () => {
    const harness = await createHarness("happy");
    const probe = vi.fn(queueProjection);
    const beforeSource = await dumpDatabase(harness.sourceName);
    const beforeRestored = await dumpDatabase(harness.restoredName);

    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: probe,
    });

    expect(report).toEqual({ ok: true, failures: [] });
    expect(probe).toHaveBeenCalledTimes(2);
    await expect(
      structurallyEqual(await dumpDatabase(harness.sourceName), beforeSource),
    ).resolves.toBe(true);
    await expect(
      structurallyEqual(await dumpDatabase(harness.restoredName), beforeRestored),
    ).resolves.toBe(true);
  });

  it("runs L2 after an L1 context difference and reports the review queue failure", async () => {
    const harness = await createHarness("l1-l2");
    await clearStore(harness.restoredName, "contexts");
    await clearStore(harness.restoredName, "clock");
    const probe = vi.fn(queueProjection);

    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: probe,
    });

    expect(report.ok).toBe(false);
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "L1_STORE_KEYSET",
        "L1_CONTEXTS_MISMATCH",
        "L2_REVIEW_QUEUE",
        "L3_CLOCK",
        "L3_RESTORE_COMMIT",
      ]),
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("compares context Blob bytes through the L1 storage layer", async () => {
    const harness = await createHarness("blob-mismatch");
    const [context] = (await harness.restored.readSnapshot()).contexts;
    const changedBytes = IMAGE_BYTES.slice();
    const changedIndex = changedBytes.length - 1;
    changedBytes[changedIndex] = changedBytes[changedIndex]! ^ 0xff;
    await putRecord(harness.restoredName, "contexts", {
      ...context!,
      image: {
        ...context!.image!,
        blob: new Blob([changedBytes], { type: context!.image!.mediaType }),
      },
    });

    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain(
      "L1_CONTEXTS_MISMATCH",
    );
  });

  it("reports a derived ItemView difference independently of L1", async () => {
    const harness = await createHarness("item-view");
    const changed = {
      ...harness.input.events[1]!,
      payload: {
        ...harness.input.events[1]!.payload,
        display: "手を打った",
      },
    } as Event;
    await putRecord(harness.restoredName, "events", changed);

    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["L1_EVENTS_MISMATCH", "L2_ITEM_VIEW"]),
    );
  });

  it("fails closed when a fourth object store is present", async () => {
    const harness = await createHarness("unknown-store");
    harness.restored.close();
    repositories.delete(harness.restored);
    const current = await openDB(harness.restoredName);
    const nextVersion = current.version + 1;
    current.close();
    const upgraded = await openDB(harness.restoredName, nextVersion, {
      upgrade(database) {
        database.createObjectStore("future-state", { keyPath: "key" });
      },
    });
    upgraded.close();

    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures).toContainEqual(
      expect.objectContaining({ code: "L1_STORE_UNCLASSIFIED" }),
    );
  });

  it("reports an empty clock store with the dedicated clock failure", async () => {
    const harness = await createHarness("empty-clock");
    await clearStore(harness.restoredName, "clock");
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain("L3_CLOCK");
    expect(report.failures.map(({ code }) => code)).toContain(
      "L3_RESTORE_COMMIT",
    );
  });

  it("reports a missing marker without a generic clock failure", async () => {
    const harness = await createHarness("marker-missing");
    await deleteRecord(harness.restoredName, "clock", "restore-commit");
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain(
      "L3_RESTORE_COMMIT",
    );
    expect(report.failures.map(({ code }) => code)).not.toContain("L3_CLOCK");
  });

  it("reports marker id mismatch without disguising it as a clock failure", async () => {
    const harness = await createHarness("marker-id");
    const marker = await harness.restored.readRestoreCommit();
    await putRecord(harness.restoredName, "clock", {
      ...marker,
      newDeviceId: "device-other",
    });
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain(
      "L3_RESTORE_COMMIT",
    );
    expect(report.failures.map(({ code }) => code)).not.toContain("L3_CLOCK");
  });

  it("reports a malformed marker with the dedicated failure", async () => {
    const harness = await createHarness("marker-shape");
    const marker = await harness.restored.readRestoreCommit();
    await putRecord(harness.restoredName, "clock", {
      ...marker,
      futureField: true,
    });
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain(
      "L3_RESTORE_COMMIT",
    );
    expect(report.failures.map(({ code }) => code)).not.toContain("L3_CLOCK");
  });

  it("detects a low global clock while preserving the exact key set", async () => {
    const harness = await createHarness("low-clock");
    await putRecord(harness.restoredName, "clock", {
      key: "global-hlc",
      type: "global-hlc",
      hlc: { wallTime: 99, counter: 0 },
    });
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain("L3_CLOCK");
  });

  it("detects a new-device sequence and an incorrect historical watermark", async () => {
    const harness = await createHarness("identity-watermarks");
    await putRecord(harness.restoredName, "clock", {
      key: "device-sequence:device-restored",
      type: "device-sequence",
      deviceId: "device-restored",
      seq: 1,
    });
    await putRecord(harness.restoredName, "clock", {
      key: "device-sequence:device-source",
      type: "device-sequence",
      deviceId: "device-source",
      seq: 2,
    });
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["L3_IDENTITY", "L3_CLOCK"]),
    );
  });

  it("fails closed on a non-string clock key", async () => {
    const harness = await createHarness("non-string-clock-key");
    await putRecord(harness.restoredName, "clock", {
      key: 1,
      type: "future-clock-record",
    });
    const report = await verifyLedgerEquivalence({
      ...harness.verifyInput,
      reviewQueueProbe: queueProjection,
    });
    expect(report.failures.map(({ code }) => code)).toContain("L3_CLOCK");
  });

  it("uses a disposable clone for the first local allocator write", async () => {
    const harness = await createHarness("clone");
    const cloneName = databaseName("clone-target");
    const before = await dumpDatabase(harness.restoredName);
    await cloneLedgerDatabase(harness.restoredName, cloneName);
    const clone = await openLedgerRepository({ dbName: cloneName });
    repositories.add(clone);

    const coordinates = await clone.reserveEventCoordinates(
      "device-restored",
      Date.parse("2026-08-11T00:01:00.000Z"),
      1,
    );
    const coordinate = coordinates[0]!;
    expect(coordinate.seq).toBe(1);
    expect(
      coordinate.hlc.wallTime > PACKAGE_MAX_HLC.wallTime ||
        (coordinate.hlc.wallTime === PACKAGE_MAX_HLC.wallTime &&
          coordinate.hlc.counter > PACKAGE_MAX_HLC.counter),
    ).toBe(true);
    await expect(
      structurallyEqual(await dumpDatabase(harness.restoredName), before),
    ).resolves.toBe(true);
  });

  it("aborts a disposable clone when a put fails after being scheduled", async () => {
    const harness = await createHarness("clone-failure");
    const cloneName = databaseName("clone-failure-target");
    const nativePut = IDBObjectStore.prototype.put;
    let putCalls = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request =
        key === undefined
          ? nativePut.call(this, value)
          : nativePut.call(this, value, key);
      putCalls += 1;
      if (putCalls === 2) {
        throw new Error("injected clone put failure after scheduling");
      }
      return request;
    });

    await expect(
      cloneLedgerDatabase(harness.restoredName, cloneName),
    ).rejects.toThrow("injected clone put failure after scheduling");
    expect(putCalls).toBe(2);
    expect(await dumpDatabase(cloneName)).toEqual([[], [], []]);
  });

  it("rejects and closes a malformed clone target that lacks a ledger store", async () => {
    const harness = await createHarness("clone-malformed-target");
    const cloneName = databaseName("clone-malformed-target-db");
    const malformed = await openDB(cloneName, 2, {
      upgrade(database) {
        database.createObjectStore("events", { keyPath: "eventId" });
        database.createObjectStore("contexts", { keyPath: "hash" });
      },
    });
    malformed.close();

    await expect(
      cloneLedgerDatabase(harness.restoredName, cloneName),
    ).rejects.toThrow(/target.*three-store Tenjin ledger/i);

    let deletionWasBlocked = false;
    await deleteDB(cloneName, {
      blocked() {
        deletionWasBlocked = true;
      },
    });
    databases.delete(cloneName);
    expect(deletionWasBlocked).toBe(false);
  });
});
