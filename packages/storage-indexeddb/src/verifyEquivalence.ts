import {
  deriveLedger,
  type Event,
  type HybridLogicalClock,
  type LedgerView,
} from "@tenjin/core";

import {
  openLedgerRepository,
  structurallyEqual,
  type ContextRecord,
  type LedgerSnapshot,
} from "./repository.js";
import {
  assertRestoreCommitRecord,
  isCanonicalDeviceId,
} from "./restoreCommit.js";

export type EquivalenceFailureCode =
  | "L1_STORE_UNCLASSIFIED"
  | "L1_STORE_KEYSET"
  | "L1_EVENTS_MISMATCH"
  | "L1_CONTEXTS_MISMATCH"
  | "L2_ITEM_VIEW"
  | "L2_REVIEW_QUEUE"
  | "L3_IDENTITY"
  | "L3_CLOCK"
  | "L3_RESTORE_COMMIT";

export interface EquivalenceFailure {
  readonly code: EquivalenceFailureCode;
  readonly detail: string;
}

export interface EquivalenceReport {
  readonly ok: boolean;
  readonly failures: readonly EquivalenceFailure[];
}

export interface ReviewQueueItem {
  readonly itemId: string;
  readonly channel: string;
  readonly prompt: string;
  readonly reveal: unknown;
}

export type ReviewQueueProbe = (
  view: LedgerView,
  snapshot: LedgerSnapshot,
  budget: number,
) => readonly ReviewQueueItem[];

export interface VerifyLedgerEquivalenceInput {
  readonly sourceDatabaseName: string;
  readonly restoredDatabaseName: string;
  readonly packageMaxHlc: HybridLogicalClock;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly expectedNewDeviceId: string;
  readonly reviewBudget: number;
  readonly reviewQueueProbe: ReviewQueueProbe;
}

interface StoreContents {
  readonly keys: readonly IDBValidKey[];
  readonly values: readonly unknown[];
}

const LEDGER_STORES = ["events", "contexts", "clock"] as const;
const L1_VALUE_STORES = ["events", "contexts"] as const;

function openExistingDatabase(name: string): Promise<IDBDatabase> {
  if (name.trim().length === 0 || name !== name.trim()) {
    return Promise.reject(
      new TypeError("database name must be a non-empty canonical string"),
    );
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`database ${name} does not exist`));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readStoreContents(
  database: IDBDatabase,
  storeName: string,
): Promise<StoreContents> {
  const transaction = database.transaction(storeName, "readonly");
  const completion = transactionCompletion(transaction);
  try {
    const store = transaction.objectStore(storeName);
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult(store.getAll()),
    ]);
    await completion;
    return { keys, values };
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted because a request failed.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

async function readSnapshot(database: IDBDatabase): Promise<LedgerSnapshot> {
  const [events, contexts] = await Promise.all([
    readStoreContents(database, "events"),
    readStoreContents(database, "contexts"),
  ]);
  return {
    events: events.values as readonly Event[],
    contexts: contexts.values as readonly ContextRecord[],
  };
}

function storeNames(database: IDBDatabase): readonly string[] {
  return Array.from(database.objectStoreNames);
}

function addFailure(
  failures: EquivalenceFailure[],
  code: EquivalenceFailureCode,
  detail: string,
): void {
  failures.push({ code, detail });
}

async function verifyL1(
  source: IDBDatabase,
  restored: IDBDatabase,
  failures: EquivalenceFailure[],
): Promise<void> {
  const sourceStores = storeNames(source);
  const restoredStores = storeNames(restored);
  const allStores = [...new Set([...sourceStores, ...restoredStores])].sort();

  for (const store of allStores) {
    if (!(LEDGER_STORES as readonly string[]).includes(store)) {
      addFailure(
        failures,
        "L1_STORE_UNCLASSIFIED",
        `unclassified object store: ${store}`,
      );
    }
  }

  for (const store of LEDGER_STORES) {
    if (!sourceStores.includes(store) || !restoredStores.includes(store)) {
      addFailure(
        failures,
        "L1_STORE_KEYSET",
        `${store} is missing from at least one ledger`,
      );
    }
  }

  for (const store of L1_VALUE_STORES) {
    if (!sourceStores.includes(store) || !restoredStores.includes(store)) {
      continue;
    }
    const [sourceContents, restoredContents] = await Promise.all([
      readStoreContents(source, store),
      readStoreContents(restored, store),
    ]);
    if (!(await structurallyEqual(sourceContents.keys, restoredContents.keys))) {
      addFailure(
        failures,
        "L1_STORE_KEYSET",
        `${store} key sets differ`,
      );
    }
    if (!(await structurallyEqual(sourceContents.values, restoredContents.values))) {
      addFailure(
        failures,
        store === "events" ? "L1_EVENTS_MISMATCH" : "L1_CONTEXTS_MISMATCH",
        `${store} values differ`,
      );
    }
  }
}

async function verifyL2(
  source: IDBDatabase,
  restored: IDBDatabase,
  input: VerifyLedgerEquivalenceInput,
  failures: EquivalenceFailure[],
): Promise<void> {
  let sourceSnapshot: LedgerSnapshot;
  let restoredSnapshot: LedgerSnapshot;
  try {
    [sourceSnapshot, restoredSnapshot] = await Promise.all([
      readSnapshot(source),
      readSnapshot(restored),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addFailure(failures, "L2_ITEM_VIEW", `cannot read ledger snapshots: ${detail}`);
    addFailure(
      failures,
      "L2_REVIEW_QUEUE",
      `cannot read ledger snapshots: ${detail}`,
    );
    return;
  }

  const sourceView = deriveLedger(sourceSnapshot.events);
  const restoredView = deriveLedger(restoredSnapshot.events);
  if (!(await structurallyEqual(sourceView.items, restoredView.items))) {
    addFailure(failures, "L2_ITEM_VIEW", "derived ItemView arrays differ");
  }

  let sourceQueue: readonly ReviewQueueItem[] | undefined;
  let restoredQueue: readonly ReviewQueueItem[] | undefined;
  let sourceError: unknown;
  let restoredError: unknown;
  try {
    sourceQueue = input.reviewQueueProbe(
      sourceView,
      sourceSnapshot,
      input.reviewBudget,
    );
  } catch (error) {
    sourceError = error;
  }
  try {
    restoredQueue = input.reviewQueueProbe(
      restoredView,
      restoredSnapshot,
      input.reviewBudget,
    );
  } catch (error) {
    restoredError = error;
  }
  if (
    sourceError !== undefined ||
    restoredError !== undefined ||
    sourceQueue === undefined ||
    restoredQueue === undefined ||
    !(await structurallyEqual(sourceQueue, restoredQueue))
  ) {
    addFailure(failures, "L2_REVIEW_QUEUE", "review queue sequences differ");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Reflect.ownKeys(value).map(String).sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === [...expected].sort()[index])
  );
}

function isValidHlc(value: unknown): value is HybridLogicalClock {
  return (
    isRecord(value) &&
    hasExactFields(value, ["wallTime", "counter"]) &&
    Number.isSafeInteger(value.wallTime) &&
    Number(value.wallTime) >= 0 &&
    Number.isSafeInteger(value.counter) &&
    Number(value.counter) >= 0
  );
}

function compareHlc(left: HybridLogicalClock, right: HybridLogicalClock): number {
  return left.wallTime - right.wallTime || left.counter - right.counter;
}

function clockRecordMap(values: readonly unknown[]): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const value of values) {
    if (isRecord(value) && typeof value.key === "string") {
      result.set(value.key, value);
    }
  }
  return result;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

async function verifyL3(
  restored: IDBDatabase,
  input: VerifyLedgerEquivalenceInput,
  failures: EquivalenceFailure[],
): Promise<void> {
  const packageMaxHlcIsValid = isValidHlc(input.packageMaxHlc);
  if (!packageMaxHlcIsValid) {
    addFailure(failures, "L3_CLOCK", "package maximum HLC is invalid");
  }
  if (!isCanonicalDeviceId(input.expectedNewDeviceId)) {
    addFailure(failures, "L3_IDENTITY", "expected new device id is not canonical");
  }
  if (Object.hasOwn(input.maxSeqByDevice, input.expectedNewDeviceId)) {
    addFailure(
      failures,
      "L3_IDENTITY",
      "expected new device id reuses a historical device",
    );
  }
  if (!storeNames(restored).includes("clock")) {
    addFailure(failures, "L3_CLOCK", "clock store is missing");
    addFailure(failures, "L3_RESTORE_COMMIT", "restore commit marker is missing");
    return;
  }

  let clockContents: StoreContents;
  try {
    clockContents = await readStoreContents(restored, "clock");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addFailure(failures, "L3_CLOCK", `cannot read clock store: ${detail}`);
    addFailure(
      failures,
      "L3_RESTORE_COMMIT",
      `cannot read restore commit marker: ${detail}`,
    );
    return;
  }
  const records = clockRecordMap(clockContents.values);
  const actualClockKeys: string[] = [];
  for (const key of clockContents.keys) {
    if (typeof key !== "string") {
      addFailure(failures, "L3_CLOCK", "clock store contains a non-string key");
    } else {
      actualClockKeys.push(key);
    }
  }
  const expectedSequenceEntries = Object.entries(input.maxSeqByDevice).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  for (const [deviceId, sequence] of expectedSequenceEntries) {
    if (!isCanonicalDeviceId(deviceId)) {
      addFailure(
        failures,
        "L3_IDENTITY",
        `historical device id is not canonical: ${deviceId}`,
      );
    }
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      addFailure(
        failures,
        "L3_CLOCK",
        `historical sequence watermark is invalid for ${deviceId}`,
      );
    }
  }
  const expectedNonMarkerKeys = [
    "global-hlc",
    ...expectedSequenceEntries.map(([deviceId]) => `device-sequence:${deviceId}`),
  ];
  const actualNonMarkerKeys = actualClockKeys.filter(
    (key) => key !== "restore-commit",
  );
  if (!sameStringSet(actualNonMarkerKeys, expectedNonMarkerKeys)) {
    addFailure(failures, "L3_CLOCK", "clock key set does not match restore plan");
  }

  const globalClock = records.get("global-hlc");
  if (
    !isRecord(globalClock) ||
    !hasExactFields(globalClock, ["key", "type", "hlc"]) ||
    globalClock.key !== "global-hlc" ||
    globalClock.type !== "global-hlc" ||
    !isValidHlc(globalClock.hlc) ||
    !packageMaxHlcIsValid ||
    compareHlc(globalClock.hlc, input.packageMaxHlc) <= 0
  ) {
    addFailure(
      failures,
      "L3_CLOCK",
      "persisted global HLC is missing, malformed, or not above package maximum",
    );
  }

  for (const [deviceId, expectedSeq] of expectedSequenceEntries) {
    const key = `device-sequence:${deviceId}`;
    const record = records.get(key);
    if (
      !isRecord(record) ||
      !hasExactFields(record, ["key", "type", "deviceId", "seq"]) ||
      record.key !== key ||
      record.type !== "device-sequence" ||
      record.deviceId !== deviceId ||
      record.seq !== expectedSeq
    ) {
      addFailure(
        failures,
        "L3_CLOCK",
        `historical sequence watermark is invalid for ${deviceId}`,
      );
    }
  }
  if (records.has(`device-sequence:${input.expectedNewDeviceId}`)) {
    addFailure(
      failures,
      "L3_IDENTITY",
      "new device sequence must not exist before its first local write",
    );
  }

  const marker = records.get("restore-commit");
  if (marker === undefined) {
    addFailure(failures, "L3_RESTORE_COMMIT", "restore commit marker is missing");
  } else {
    try {
      assertRestoreCommitRecord(marker);
      if (marker.newDeviceId !== input.expectedNewDeviceId) {
        addFailure(
          failures,
          "L3_RESTORE_COMMIT",
          "restore commit marker is bound to a different device id",
        );
      }
    } catch (error) {
      addFailure(
        failures,
        "L3_RESTORE_COMMIT",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export async function verifyLedgerEquivalence(
  input: VerifyLedgerEquivalenceInput,
): Promise<EquivalenceReport> {
  if (input.sourceDatabaseName === input.restoredDatabaseName) {
    throw new TypeError("source and restored database names must differ");
  }
  const failures: EquivalenceFailure[] = [];
  const source = await openExistingDatabase(input.sourceDatabaseName);
  let restored: IDBDatabase | undefined;
  try {
    restored = await openExistingDatabase(input.restoredDatabaseName);
    try {
      await verifyL1(source, restored, failures);
    } catch (error) {
      addFailure(
        failures,
        "L1_STORE_KEYSET",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await verifyL2(source, restored, input, failures);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      addFailure(failures, "L2_ITEM_VIEW", detail);
      addFailure(failures, "L2_REVIEW_QUEUE", detail);
    }
    try {
      await verifyL3(restored, input, failures);
    } catch (error) {
      addFailure(
        failures,
        "L3_CLOCK",
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    source.close();
    restored?.close();
  }
  return { ok: failures.length === 0, failures };
}

/** Copies a ledger into a disposable database for mutating allocator probes. */
export async function cloneLedgerDatabase(
  sourceDatabaseName: string,
  targetDatabaseName: string,
): Promise<void> {
  if (sourceDatabaseName === targetDatabaseName) {
    throw new TypeError("clone target must differ from source database");
  }
  const source = await openExistingDatabase(sourceDatabaseName);
  let sourceContents: Readonly<Record<(typeof LEDGER_STORES)[number], StoreContents>>;
  try {
    const names = storeNames(source);
    if (!sameStringSet(names, LEDGER_STORES)) {
      throw new TypeError("source database is not a three-store Tenjin ledger");
    }
    const events = await readStoreContents(source, "events");
    const contexts = await readStoreContents(source, "contexts");
    const clock = await readStoreContents(source, "clock");
    sourceContents = { events, contexts, clock };
  } finally {
    source.close();
  }

  const targetRepository = await openLedgerRepository({ dbName: targetDatabaseName });
  targetRepository.close();
  const target = await openExistingDatabase(targetDatabaseName);
  try {
    if (!sameStringSet(storeNames(target), LEDGER_STORES)) {
      throw new TypeError("clone target is not a three-store Tenjin ledger");
    }
    const transaction = target.transaction([...LEDGER_STORES], "readwrite");
    const completion = transactionCompletion(transaction);
    try {
      const counts = await Promise.all(
        LEDGER_STORES.map((store) =>
          requestResult(transaction.objectStore(store).count()),
        ),
      );
      if (counts.some((count) => count !== 0)) {
        throw new Error("clone target ledger is not empty");
      }
      for (const storeName of LEDGER_STORES) {
        const store = transaction.objectStore(storeName);
        for (const value of sourceContents[storeName].values) {
          await requestResult(store.put(value));
        }
      }
      await completion;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because a request failed.
      }
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    target.close();
  }
}
