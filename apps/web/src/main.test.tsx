import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const appProps: unknown[] = [];
  const runtimeOptions: unknown[] = [];
  const repository = {
    reserveEventCoordinates: vi.fn(),
    inspectRestoreStorageState: vi.fn(async () => {
      calls.push("repository:inspect");
      return {
        events: 0,
        contexts: 0,
        clock: 0,
        importReceipts: 0,
        restoreCommit: undefined,
      };
    }),
    close: vi.fn(() => {
      calls.push("repository:close");
    }),
  };
  const gate = {
    supportsRecovery: true,
    isWritable: true,
    start: vi.fn(async () => {
      calls.push("lock:start");
    }),
    assertWritable: vi.fn(() => {
      calls.push("lock:assert");
    }),
    enterReadOnly: vi.fn(() => {
      calls.push("lock:read-only");
      gate.isWritable = false;
    }),
    releaseSharedLock: vi.fn(async () => {
      calls.push("lock:release");
    }),
    requestExclusive: vi.fn(async <T,>(callback: () => Promise<T>) => {
      calls.push("lock:exclusive");
      return callback();
    }),
  };
  return {
    calls,
    appProps,
    runtimeOptions,
    repository,
    gate,
    openLedgerRepository: vi.fn(async () => {
      calls.push("repository:open");
      return repository;
    }),
    bootstrapRestoreActivation: vi.fn(async () => ({
      kind: "pending-empty" as const,
      pendingDeviceId: "pending-device",
    })),
    restoreWithActivation: vi.fn(async () => {
      calls.push("restore:run");
      return {
        kind: "restored" as const,
        pendingDeviceId: "restored-device",
      };
    }),
  };
});

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));
vi.mock("@tenjin/exchange", () => ({
  buildLedgerRestorePlan: vi.fn(),
  readPackage: vi.fn(),
}));
vi.mock("@tenjin/storage-indexeddb", () => ({
  openLedgerRepository: mocks.openLedgerRepository,
}));
vi.mock("./App.js", () => ({
  App: (props: unknown) => {
    mocks.appProps.push(props);
    return <div data-testid="tenjin-app">Tenjin ready</div>;
  },
}));
vi.mock("./app/BootstrapError.js", () => ({
  BootstrapError: ({ error }: { readonly error: unknown }) => (
    <div data-testid="bootstrap-error">{String(error)}</div>
  ),
}));
vi.mock("./app/ledgerBackup.js", () => ({
  buildLedgerBackup: vi.fn(),
  downloadLedgerBackup: vi.fn(),
}));
vi.mock("./app/repositoryLifecycle.js", () => ({
  installRepositoryLifecycle: vi.fn(() => vi.fn()),
}));
vi.mock("./app/restoreActivation.js", () => ({
  bootstrapRestoreActivation: mocks.bootstrapRestoreActivation,
  cancelPendingRestoreActivation: vi.fn(),
  restoreWithActivation: mocks.restoreWithActivation,
}));
vi.mock("./app/RestoreRecoveryView.js", () => ({
  RestoreRecoveryView: () => (
    <div data-testid="restore-recovery">Restore recovery</div>
  ),
}));
vi.mock("./app/runtimeWriteLock.js", () => ({
  createRuntimeWriteLock: vi.fn(() => mocks.gate),
}));
vi.mock("./app/storagePersistence.js", () => ({
  requestStoragePersistence: vi.fn(async () => "persisted"),
}));
vi.mock("./features/ledger/ledgerRuntime.js", () => ({
  createLedgerRuntime: vi.fn((options: unknown) => {
    mocks.runtimeOptions.push(options);
    return { runtime: true };
  }),
}));

describe("production bootstrap wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.clear();
    sessionStorage.clear();
    mocks.calls.length = 0;
    mocks.appProps.length = 0;
    mocks.runtimeOptions.length = 0;
    mocks.gate.isWritable = true;
    mocks.openLedgerRepository.mockClear();
    mocks.bootstrapRestoreActivation.mockClear();
    mocks.restoreWithActivation.mockClear();
    mocks.repository.close.mockClear();
    mocks.repository.inspectRestoreStorageState.mockClear();
  });

  it("acquires the shared lifetime lock before identity and exposes the real backup/restore actions", async () => {
    localStorage.setItem("tenjin.deviceId", "device-live");

    await import("./main.js");

    expect(await screen.findByTestId("tenjin-app")).toHaveTextContent(
      "Tenjin ready",
    );
    expect(mocks.calls.slice(0, 6)).toEqual([
      "lock:start",
      "lock:assert",
      "repository:open",
      "lock:assert",
      "repository:inspect",
      "lock:assert",
    ]);
    expect(mocks.calls).toContain("repository:open");
    expect(mocks.runtimeOptions).toHaveLength(1);
    expect(mocks.appProps).not.toHaveLength(0);
    expect(mocks.appProps.at(-1)).toMatchObject({
      repository: mocks.repository,
      writeGate: mocks.gate,
      storagePersistence: "persisted",
      backupRestoreActions: {
        restoreSupported: true,
        restoreEligible: true,
        onExportBackup: expect.any(Function),
        onRestoreBackup: expect.any(Function),
      },
    });

    const props = mocks.appProps.at(-1) as {
      readonly backupRestoreActions: {
        readonly onRestoreBackup: (file: File) => Promise<void>;
      };
    };
    mocks.repository.inspectRestoreStorageState.mockImplementationOnce(
      async () => {
        mocks.calls.push("repository:inspect");
        return {
          events: 0,
          contexts: 0,
          clock: 1,
          importReceipts: 0,
          restoreCommit: undefined,
        };
      },
    );
    mocks.calls.length = 0;
    await expect(
      props.backupRestoreActions.onRestoreBackup({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as File),
    ).rejects.toThrow("并非完全空白");
    expect(mocks.calls).toEqual([
      "lock:assert",
      "lock:assert",
      "repository:inspect",
      "lock:assert",
    ]);
    expect(mocks.repository.close).not.toHaveBeenCalled();
    expect(mocks.restoreWithActivation).not.toHaveBeenCalled();

    mocks.calls.length = 0;
    await props.backupRestoreActions.onRestoreBackup({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as File);
    expect(mocks.calls).toEqual([
      "lock:assert",
      "lock:assert",
      "repository:inspect",
      "lock:assert",
      "lock:read-only",
      "repository:close",
      "lock:release",
      "restore:run",
    ]);
  });

  it("handles pending recovery before reading the formal device id or creating a writable runtime", async () => {
    localStorage.setItem("tenjin.pendingRestoreDeviceId", "pending-device");
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    await import("./main.js");

    expect(await screen.findByTestId("restore-recovery")).toHaveTextContent(
      "Restore recovery",
    );
    expect(mocks.calls.slice(0, 3)).toEqual([
      "lock:start",
      "lock:read-only",
      "lock:release",
    ]);
    expect(mocks.bootstrapRestoreActivation).toHaveBeenCalledOnce();
    expect(mocks.runtimeOptions).toHaveLength(0);
    expect(mocks.appProps).toHaveLength(0);
    expect(getItem).not.toHaveBeenCalledWith("tenjin.deviceId");
  });
});
