// @vitest-environment node

import "fake-indexeddb/auto";

import { deriveLedger } from "@tenjin/core";
import {
  buildLedgerRestorePlan,
  exportLedgerPackage,
  readPackage,
  type ExportContext,
  type LedgerRestorePlan,
} from "@tenjin/exchange";
import {
  assertRestoreCommitRecord,
  openLedgerRepository,
  verifyLedgerEquivalence,
  type ContextImageRecord,
  type ContextRecord,
  type LedgerRepository,
  type LedgerRestorer,
  type RestoreLedgerInput,
  type ReviewQueueProbe,
} from "@tenjin/storage-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureTransaction } from "../capture/createCapture.js";
import { buildReviewQueue } from "../review/reviewQueue.js";
import { createLedgerRuntime, type LedgerRuntime } from "./ledgerRuntime.js";

const SOURCE_DEVICE_ID = "device-source";
const RESTORED_DEVICE_ID = "device-restored";
const CAPTURED_AT = "2026-08-11T01:00:00.000Z";
const DISCARDED_AT = "2026-08-11T01:01:00.000Z";
const EXPORTED_AT = "2026-08-11T02:00:00.000Z";
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type TestRepository = LedgerRepository & LedgerRestorer;

interface SourceHarness {
  readonly databaseName: string;
  readonly repository: TestRepository;
  readonly runtime: LedgerRuntime;
}

interface RoundTripHarness {
  readonly sourceDatabaseName: string;
  readonly restoredDatabaseName: string;
  readonly source: TestRepository;
  readonly restored: TestRepository;
  readonly plan: LedgerRestorePlan;
}

const databaseNames = new Set<string>();
const repositories = new Set<TestRepository>();
let databaseCounter = 0;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("database delete failed"));
    request.onblocked = () => reject(new Error(`database delete blocked: ${name}`));
  });
}

afterEach(async () => {
  for (const repository of repositories) repository.close();
  repositories.clear();
  for (const name of databaseNames) await deleteDatabase(name);
  databaseNames.clear();
  vi.restoreAllMocks();
});

function nextDatabaseName(label: string): string {
  databaseCounter += 1;
  const name = `tenjin-restore-integration-${label}-${databaseCounter}`;
  databaseNames.add(name);
  return name;
}

async function trackedRepository(name: string): Promise<TestRepository> {
  const repository = await openLedgerRepository({ dbName: name });
  repositories.add(repository);
  return repository;
}

function closeTrackedRepository(repository: TestRepository): void {
  repository.close();
  repositories.delete(repository);
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("WebCrypto subtle.digest is unavailable");
  }
  const stable = input.slice();
  const digest = await subtle.digest("SHA-256", stable);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createSourceHarness(label: string): Promise<SourceHarness> {
  const databaseName = nextDatabaseName(`${label}-source`);
  const repository = await trackedRepository(databaseName);
  const timestamps = [CAPTURED_AT, DISCARDED_AT];
  let uuidSequence = 0;
  const runtime = createLedgerRuntime({
    deviceId: SOURCE_DEVICE_ID,
    reserveEventCoordinates: (...args) =>
      repository.reserveEventCoordinates(...args),
    now: () => new Date(timestamps.shift() ?? DISCARDED_AT),
    randomUUID: () => `${label}-${++uuidSequence}`,
    digest: (text) => sha256Hex(new TextEncoder().encode(text)),
  });
  return { databaseName, repository, runtime };
}

async function fixtureImage(): Promise<ContextImageRecord> {
  const bytes = IMAGE_BYTES.slice();
  return {
    blob: new Blob([bytes.buffer], { type: "image/png" }),
    mediaType: "image/png",
    name: "p5r.png",
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

async function appendLookupCapture(
  source: SourceHarness,
  options: { readonly withImage?: boolean } = {},
): Promise<CaptureTransaction> {
  const transaction = await source.runtime.createCapture({
    type: "lookup",
    original: "大丈夫、手は打ったから。",
    answer: "没关系，已经采取措施了。",
    ...(options.withImage === true ? { image: await fixtureImage() } : {}),
  });
  await source.repository.appendCapture(transaction.events, transaction.context);
  return transaction;
}

async function toExportContext(context: ContextRecord): Promise<ExportContext> {
  const image = context.image;
  return {
    hash: context.hash,
    original: context.original,
    ...(context.corrected === undefined ? {} : { corrected: context.corrected }),
    ...(context.answer === undefined ? {} : { answer: context.answer }),
    ...(image === undefined
      ? {}
      : {
          image: {
            mediaType: image.mediaType,
            name: image.name,
            byteLength: image.byteLength,
            sha256: image.sha256,
            bytes: new Uint8Array(await image.blob.arrayBuffer()),
          },
        }),
    createdAt: context.createdAt,
  };
}

async function restoreRoundTrip(
  label: string,
  source: SourceHarness,
): Promise<RoundTripHarness> {
  const snapshot = await source.repository.readSnapshot();
  const contexts = await Promise.all(snapshot.contexts.map(toExportContext));
  const packageBytes = exportLedgerPackage({
    events: snapshot.events,
    contexts,
    mode: "full-backup",
    exportedByDeviceId: SOURCE_DEVICE_ID,
    exportedAt: EXPORTED_AT,
  });

  // Exchange tests deliberately use a fake digest. This apps/web bridge is the
  // one place that wires the production package reader and real WebCrypto SHA-256
  // to the independent exchange and storage packages.
  const read = await readPackage(packageBytes);
  const plan = await buildLedgerRestorePlan(read, sha256Hex);

  // A compile-time bridge, not a runtime assertion: neither package may import
  // the other, so this is the only place that can prove their shapes line up.
  // If it stops compiling, one side drifted.
  const restoreInputIsStructurallyCompatible: RestoreLedgerInput = plan;
  const restoredDatabaseName = nextDatabaseName(`${label}-restored`);
  const restored = await trackedRepository(restoredDatabaseName);
  await restored.restoreLedger(
    restoreInputIsStructurallyCompatible,
    RESTORED_DEVICE_ID,
  );

  return {
    sourceDatabaseName: source.databaseName,
    restoredDatabaseName,
    source: source.repository,
    restored,
    plan,
  };
}

const realReviewQueueProbe: ReviewQueueProbe = (view, snapshot, budget) =>
  buildReviewQueue(view, snapshot, budget).map(
    ({ itemId, channel, prompt, reveal }) => ({
      itemId,
      channel,
      prompt,
      reveal,
    }),
  );

function verifyRoundTrip(
  harness: RoundTripHarness,
  reviewQueueProbe: ReviewQueueProbe,
) {
  return verifyLedgerEquivalence({
    sourceDatabaseName: harness.sourceDatabaseName,
    restoredDatabaseName: harness.restoredDatabaseName,
    packageMaxHlc: harness.plan.globalHlc,
    maxSeqByDevice: harness.plan.maxSeqByDevice,
    expectedNewDeviceId: RESTORED_DEVICE_ID,
    reviewBudget: 5,
    reviewQueueProbe,
  });
}

async function putStoreRecord(
  databaseName: string,
  storeName: "clock" | "contexts",
  value: unknown,
): Promise<void> {
  const database = await requestResult(indexedDB.open(databaseName));
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    try {
      await requestResult(transaction.objectStore(storeName).put(value));
      await done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The request may already have aborted the transaction.
      }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

function putClockRecord(databaseName: string, value: unknown): Promise<void> {
  return putStoreRecord(databaseName, "clock", value);
}

describe("A1 ledger backup restore integration", () => {
  it("has a usable WebCrypto digest before any of this means anything", async () => {
    // Guard the guard. If crypto.subtle were missing or wired wrong, a round-trip
    // test could still pass by comparing two equally-wrong digests. These two
    // assertions are what make the real-digest claim below worth anything.
    expect(globalThis.crypto?.subtle).toBeDefined();

    // NIST FIPS 180-2 vector for "abc".
    const digest = await sha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("round-trips a real image capture and invokes the real review queue exactly twice", async () => {
    const source = await createSourceHarness("image");
    await appendLookupCapture(source, { withImage: true });
    const harness = await restoreRoundTrip("image", source);
    const probe = vi.fn(realReviewQueueProbe);

    const report = await verifyRoundTrip(harness, probe);

    expect(report).toEqual({ ok: true, failures: [] });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.results[0]?.value).toEqual(probe.mock.results[1]?.value);
    const snapshot = await harness.restored.readSnapshot();
    const restoredImage = snapshot.contexts[0]?.image;
    expect(restoredImage).toBeDefined();
    expect(restoredImage?.mediaType).toBe("image/png");
    expect(restoredImage?.blob.type).toBe("image/png");
    expect(
      restoredImage === undefined
        ? undefined
        : new Uint8Array(await restoredImage.blob.arrayBuffer()),
    ).toEqual(IMAGE_BYTES);
  });

  it("round-trips a real undo after appendDiscard garbage-collects its context", async () => {
    const source = await createSourceHarness("undo");
    const capture = await appendLookupCapture(source);
    const captureCreated = capture.events.find(
      (event) => event.kind === "capture_created",
    );
    if (captureCreated?.kind !== "capture_created") {
      throw new Error("fixture did not create a capture_created event");
    }
    const discard = await source.runtime.createDiscard(captureCreated.captureId);
    await source.repository.appendDiscard(discard, capture.context.hash);
    expect((await source.repository.readSnapshot()).contexts).toEqual([]);

    const harness = await restoreRoundTrip("undo", source);
    const probe: ReviewQueueProbe = vi.fn(realReviewQueueProbe);
    const report = await verifyRoundTrip(harness, probe);

    expect(report).toEqual({ ok: true, failures: [] });
    expect(probe).toHaveBeenCalledTimes(2);
    expect((await harness.restored.readSnapshot()).contexts).toEqual([]);
  });

  it("reports a dedicated L2_REVIEW_QUEUE failure when the real queue projection differs", async () => {
    const source = await createSourceHarness("review-mismatch");
    await appendLookupCapture(source);
    const sourceSnapshot = await source.repository.readSnapshot();
    expect(
      realReviewQueueProbe(
        deriveLedger(sourceSnapshot.events),
        sourceSnapshot,
        5,
      ),
    ).toHaveLength(1);
    const harness = await restoreRoundTrip("review-mismatch", source);
    const restoredContext = (await harness.restored.readSnapshot()).contexts[0];
    if (restoredContext === undefined || restoredContext.answer === undefined) {
      throw new Error("fixture did not restore a reviewable lookup context");
    }
    await putStoreRecord(harness.restoredDatabaseName, "contexts", {
      ...restoredContext,
      answer: `${restoredContext.answer}（已篡改）`,
    });
    const probe = vi.fn(realReviewQueueProbe);

    const report = await verifyRoundTrip(harness, probe);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(report.ok).toBe(false);
    expect(report.failures.map(({ code }) => code)).toEqual([
      "L1_CONTEXTS_MISMATCH",
      "L2_REVIEW_QUEUE",
    ]);
  });

  it("persists a closed restore marker and isolates mismatch and malformed failures", async () => {
    const source = await createSourceHarness("marker");
    await appendLookupCapture(source);
    const harness = await restoreRoundTrip("marker", source);

    closeTrackedRepository(harness.restored);
    const reopened = await trackedRepository(harness.restoredDatabaseName);
    const marker = await reopened.readRestoreCommit();
    expect(marker).toBeDefined();
    assertRestoreCommitRecord(marker);
    expect(Reflect.ownKeys(marker).map(String).sort()).toEqual([
      "committedAt",
      "key",
      "newDeviceId",
      "type",
    ]);
    expect(marker.newDeviceId).toBe(RESTORED_DEVICE_ID);
    expect(new Date(marker.committedAt).toISOString()).toBe(marker.committedAt);
    closeTrackedRepository(reopened);

    await putClockRecord(harness.restoredDatabaseName, {
      ...marker,
      newDeviceId: "device-mismatch",
    });
    const mismatch = await verifyRoundTrip(harness, realReviewQueueProbe);
    expect(mismatch.failures.map(({ code }) => code)).toEqual([
      "L3_RESTORE_COMMIT",
    ]);

    await putClockRecord(harness.restoredDatabaseName, {
      ...marker,
      unexpected: true,
    });
    const malformed = await verifyRoundTrip(harness, realReviewQueueProbe);
    expect(malformed.failures.map(({ code }) => code)).toEqual([
      "L3_RESTORE_COMMIT",
    ]);
  });
});
