import { describe, expect, it } from "vitest";

import {
  bootstrapRestoreActivation,
  cancelPendingRestoreActivation,
  restoreWithActivation,
  type RestoreActivationDependencies,
  type RestoreCommitMarker,
  type RestoreOnlyRepository,
  type RestoreStorageState,
} from "./restoreActivation.js";

type RestoreStorageCounts = Omit<RestoreStorageState, "restoreCommit">;

const EMPTY: RestoreStorageCounts = {
  events: 0,
  contexts: 0,
  clock: 0,
  importReceipts: 0,
};

const COMMITTED_MARKER: RestoreCommitMarker = {
  key: "restore-commit",
  type: "restore-commit",
  newDeviceId: "restore-device",
  committedAt: "2026-08-11T00:00:00.000Z",
};

interface Harness {
  readonly calls: string[];
  dependencies: RestoreActivationDependencies<string, string>;
  pending: string | null;
  formalDeviceId: string | null;
  storageState: RestoreStorageCounts;
  marker: unknown | undefined;
  restoreError: Error | undefined;
  inspectError: Error | undefined;
}

function harness(overrides: Partial<Pick<Harness, "pending" | "storageState" | "marker" | "restoreError" | "inspectError">> = {}): Harness {
  const calls: string[] = [];
  const state: Harness = {
    calls,
    pending: overrides.pending ?? null,
    formalDeviceId: null,
    storageState: overrides.storageState ?? EMPTY,
    marker: overrides.marker,
    restoreError: overrides.restoreError,
    inspectError: overrides.inspectError,
    dependencies: undefined as unknown as RestoreActivationDependencies<string, string>,
  };
  const repository = (): RestoreOnlyRepository<string> => ({
    async inspectRestoreStorageState() {
      calls.push("inspect");
      if (state.inspectError !== undefined) throw state.inspectError;
      return { ...state.storageState, restoreCommit: state.marker };
    },
    async restoreLedger(_plan, newDeviceId) {
      calls.push(`restore:${newDeviceId}`);
      if (state.restoreError !== undefined) throw state.restoreError;
      state.storageState = { events: 1, contexts: 1, clock: 2, importReceipts: 1 };
      state.marker = { ...COMMITTED_MARKER, newDeviceId };
    },
    close() {
      calls.push("close");
    },
  });
  const dependencies: RestoreActivationDependencies<string, string> = {
    pendingStorage: {
      read() {
        calls.push("pending.read");
        return state.pending;
      },
      write(value) {
        calls.push(`pending.write:${value}`);
        state.pending = value;
      },
      remove() {
        calls.push("pending.remove");
        state.pending = null;
      },
    },
    deviceIdStorage: {
      write(value) {
        calls.push(`device.write:${value}`);
        state.formalDeviceId = value;
      },
    },
    generateDeviceId() {
      calls.push("generate");
      return "restore-device";
    },
    async openRestoreRepository() {
      calls.push("open");
      return repository();
    },
    async readPackage() {
      calls.push("readPackage");
      return "package";
    },
    async buildPlan(source, digest) {
      calls.push(`buildPlan:${source}`);
      await digest(new TextEncoder().encode("plan"));
      return "plan";
    },
    async digest(bytes) {
      calls.push(`digest:${new TextDecoder().decode(bytes)}`);
      return "digest";
    },
    reload() {
      calls.push("reload");
    },
    lock: {
      async withExclusive<T>(callback: () => Promise<T>): Promise<T> {
        calls.push("lock");
        return callback();
      },
    },
  };
  state.dependencies = dependencies;
  return state;
}

describe("restore activation", () => {
  it("treats no pending identity as normal without opening storage or generating identity", async () => {
    const subject = harness();

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toEqual({ kind: "normal" });
    expect(subject.calls).toEqual(["lock", "pending.read"]);
  });

  it("U1a promotes a matching committed marker without attempting another restore", async () => {
    const subject = harness({
      pending: "restore-device",
      storageState: { events: 1, contexts: 1, clock: 2, importReceipts: 1 },
      marker: COMMITTED_MARKER,
    });

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toEqual({
      kind: "pending-committed",
      pendingDeviceId: "restore-device",
    });
    expect(subject.formalDeviceId).toBe("restore-device");
    expect(subject.pending).toBeNull();
    expect(subject.calls).toContain("device.write:restore-device");
    expect(subject.calls).not.toContain("generate");
    expect(subject.calls.some((call) => call.startsWith("restore:"))).toBe(false);
  });

  it.each([
    ["U1b rejects a marker for another identity", { ...COMMITTED_MARKER, newDeviceId: "other-device" }],
    ["U1c rejects a malformed marker", { ...COMMITTED_MARKER, unexpected: true }],
  ])("%s", async (_name, marker) => {
    const subject = harness({ pending: "restore-device", marker });

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toMatchObject({ kind: "corrupt" });
    expect(subject.formalDeviceId).toBeNull();
    expect(subject.pending).toBe("restore-device");
    expect(subject.calls).not.toContain("generate");
  });

  it("U1d treats data without a marker as corrupt and keeps the pending identity", async () => {
    const subject = harness({
      pending: "restore-device",
      storageState: { events: 1, contexts: 0, clock: 0, importReceipts: 0 },
    });

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toEqual({
      kind: "corrupt",
      reason: "restore-data-without-marker",
    });
    expect(subject.pending).toBe("restore-device");
    expect(subject.formalDeviceId).toBeNull();
  });

  it("U1e rejects a lone marker without the restored global clock", async () => {
    const subject = harness({
      pending: "restore-device",
      storageState: { events: 0, contexts: 0, clock: 1, importReceipts: 0 },
      marker: COMMITTED_MARKER,
    });

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toEqual({
      kind: "corrupt",
      reason: "restore-commit-incomplete",
    });
    expect(subject.pending).toBe("restore-device");
    expect(subject.formalDeviceId).toBeNull();
    expect(subject.calls).not.toContain("device.write:restore-device");
  });

  it("maps production marker validation failures to a fail-closed recovery state", async () => {
    const subject = harness({
      pending: "restore-device",
      inspectError: new Error("invalid restore commit marker"),
    });

    await expect(bootstrapRestoreActivation(subject.dependencies)).resolves.toEqual({
      kind: "corrupt",
      reason: "restore-storage-state-invalid",
    });
    expect(subject.formalDeviceId).toBeNull();
    expect(subject.pending).toBe("restore-device");
  });

  it.each([
    ["events", { events: 1, contexts: 0, clock: 0, importReceipts: 0 }],
    ["contexts", { events: 0, contexts: 1, clock: 0, importReceipts: 0 }],
    ["clock", { events: 0, contexts: 0, clock: 1, importReceipts: 0 }],
    ["importReceipts", { events: 0, contexts: 0, clock: 0, importReceipts: 1 }],
  ] satisfies readonly [string, RestoreStorageCounts][])("U3 refuses a non-empty %s store before writing pending", async (_store, storageState) => {
    const subject = harness({ storageState });

    await expect(restoreWithActivation(subject.dependencies, new Uint8Array())).resolves.toEqual({
      kind: "restore-target-not-empty",
    });
    expect(subject.pending).toBeNull();
    expect(subject.formalDeviceId).toBeNull();
    expect(subject.calls).not.toContain("generate");
    expect(subject.calls.some((call) => call.startsWith("pending.write:"))).toBe(false);
    expect(subject.calls).not.toContain("readPackage");
    expect(subject.calls.some((call) => call.startsWith("restore:"))).toBe(false);
  });

  it("allows explicit cancellation only for a still-empty pending recovery", async () => {
    const subject = harness({ pending: "restore-device" });

    await expect(cancelPendingRestoreActivation(subject.dependencies)).resolves.toEqual({
      kind: "cancelled",
      pendingDeviceId: "restore-device",
    });
    expect(subject.pending).toBeNull();
    expect(subject.formalDeviceId).toBeNull();
  });

  it("keeps pending and never promotes after restore fails", async () => {
    const subject = harness({ restoreError: new Error("restore failed") });

    await expect(restoreWithActivation(subject.dependencies, new Uint8Array())).rejects.toThrow("restore failed");
    expect(subject.pending).toBe("restore-device");
    expect(subject.formalDeviceId).toBeNull();
    expect(subject.calls).not.toContain("pending.remove");
    expect(subject.calls).not.toContain("reload");
  });

  it("restores in the durable order: empty check, pending, restore, reopen marker, promotion, reload", async () => {
    const subject = harness();

    await expect(restoreWithActivation(subject.dependencies, new Uint8Array([1]))).resolves.toEqual({
      kind: "restored",
      pendingDeviceId: "restore-device",
    });
    expect(subject.calls).toEqual([
      "lock",
      "pending.read",
      "open",
      "inspect",
      "close",
      "generate",
      "pending.write:restore-device",
      "pending.read",
      "readPackage",
      "buildPlan:package",
      "digest:plan",
      "open",
      "restore:restore-device",
      "close",
      "pending.read",
      "open",
      "inspect",
      "close",
      "device.write:restore-device",
      "pending.remove",
      "reload",
    ]);
  });
});
