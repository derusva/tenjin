import {
  buildLedgerRestorePlan,
  readPackage,
  type LedgerRestorePlan,
  type ReadLedgerPackage,
} from "@tenjin/exchange";
import {
  openLedgerRepository,
  type OpenedLedgerRepository,
} from "@tenjin/storage-indexeddb";
import { createRoot, type Root } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App.js";
import { BootstrapError } from "./app/BootstrapError.js";
import {
  buildLedgerBackup,
  downloadLedgerBackup,
} from "./app/ledgerBackup.js";
import { installRepositoryLifecycle } from "./app/repositoryLifecycle.js";
import {
  bootstrapRestoreActivation,
  cancelPendingRestoreActivation,
  restoreWithActivation,
  type RestoreActivationDependencies,
  type RestoreActivationState,
} from "./app/restoreActivation.js";
import { RestoreRecoveryView } from "./app/RestoreRecoveryView.js";
import {
  createRuntimeWriteLock,
  type RuntimeWriteLock,
} from "./app/runtimeWriteLock.js";
import { requestStoragePersistence } from "./app/storagePersistence.js";
import { createLedgerRuntime } from "./features/ledger/ledgerRuntime.js";
import "./styles/tokens.css";
import "./styles/app.css";

registerSW({ immediate: true });

const DEVICE_ID_KEY = "tenjin.deviceId";
const PENDING_RESTORE_DEVICE_ID_KEY = "tenjin.pendingRestoreDeviceId";
const RESTORE_ERROR_KEY = "tenjin.restoreError";

type BrowserRestoreDependencies = RestoreActivationDependencies<
  ReadLedgerPackage,
  LedgerRestorePlan
>;

function loadDeviceId(): string {
  const stored = localStorage.getItem(DEVICE_ID_KEY);
  if (stored !== null && stored.length > 0 && stored === stored.trim()) {
    return stored;
  }

  const deviceId = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

async function digestSha256Bytes(bytes: Uint8Array): Promise<string> {
  const stableBytes = bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestSha256Text(text: string): Promise<string> {
  return digestSha256Bytes(new TextEncoder().encode(text));
}

function renderLoading(root: Root, message: string): void {
  root.render(
    <div className="app-shell">
      <main className="app-main">
        <section className="utility-view state-view">
          <p role="status">{message}</p>
        </section>
      </main>
    </div>,
  );
}

function storeRestoreError(error: unknown): void {
  try {
    sessionStorage.setItem(
      RESTORE_ERROR_KEY,
      error instanceof Error ? error.message : String(error),
    );
  } catch {
    // The recovery screen remains reachable even when sessionStorage is blocked.
  }
}

function takeRestoreError(): string | undefined {
  try {
    const value = sessionStorage.getItem(RESTORE_ERROR_KEY) ?? undefined;
    sessionStorage.removeItem(RESTORE_ERROR_KEY);
    return value;
  } catch {
    return undefined;
  }
}

function restoreStateMessage(state: RestoreActivationState): string {
  switch (state.kind) {
    case "normal":
      return "恢复状态已变化，请重新打开 Tenjin。";
    case "pending-empty":
      return "备份尚未成功写入，请重新选择同一份文件。";
    case "pending-committed":
      return "恢复已经完成，正在重新打开 Tenjin。";
    case "corrupt":
      return `恢复状态无法安全继续：${state.reason}`;
  }
}

function createRestoreDependencies(
  runtimeLock: RuntimeWriteLock,
): BrowserRestoreDependencies {
  return {
    pendingStorage: {
      read: () => localStorage.getItem(PENDING_RESTORE_DEVICE_ID_KEY),
      write: (deviceId) =>
        localStorage.setItem(PENDING_RESTORE_DEVICE_ID_KEY, deviceId),
      remove: () => localStorage.removeItem(PENDING_RESTORE_DEVICE_ID_KEY),
    },
    deviceIdStorage: {
      write: (deviceId) => localStorage.setItem(DEVICE_ID_KEY, deviceId),
    },
    generateDeviceId: () => crypto.randomUUID(),
    openRestoreRepository: () => openLedgerRepository(),
    readPackage,
    buildPlan: buildLedgerRestorePlan,
    digest: digestSha256Bytes,
    reload: () => window.location.reload(),
    lock: {
      withExclusive: (callback) => runtimeLock.requestExclusive(callback),
    },
  };
}

function storageIsEmpty(
  state: Awaited<ReturnType<OpenedLedgerRepository["inspectRestoreStorageState"]>>,
): boolean {
  return (
    state.events === 0 &&
    state.contexts === 0 &&
    state.clock === 0 &&
    state.importReceipts === 0
  );
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function renderRecovery(
  root: Root,
  runtimeLock: RuntimeWriteLock,
  state: Extract<
    RestoreActivationState,
    { readonly kind: "pending-empty" | "corrupt" }
  >,
): void {
  const dependencies = createRestoreDependencies(runtimeLock);
  const initialError = takeRestoreError();
  root.render(
    <RestoreRecoveryView
      state={state}
      {...(initialError === undefined ? {} : { initialError })}
      onRetry={async (file) => {
        const result = await restoreWithActivation(
          dependencies,
          await fileBytes(file),
        );
        if (
          result.kind !== "restored" &&
          result.kind !== "pending-committed"
        ) {
          throw new Error(
            result.kind === "restore-target-not-empty"
              ? "恢复目标不再为空。"
              : restoreStateMessage(result),
          );
        }
      }}
      onCancel={async () => {
        const result = await cancelPendingRestoreActivation(dependencies);
        if (result.kind === "cancelled" || result.kind === "normal") {
          window.location.reload();
          return;
        }
        throw new Error(restoreStateMessage(result));
      }}
      onReload={() => window.location.reload()}
    />,
  );
}

async function main(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error("Tenjin root element is missing");
  }
  const root = createRoot(rootElement);
  renderLoading(root, "正在打开本地账本…");

  let repository: OpenedLedgerRepository | undefined;
  let cleanupRepositoryLifecycle: (() => void) | undefined;
  let reloadScheduled = false;
  const closeRepository = () => {
    cleanupRepositoryLifecycle?.();
    cleanupRepositoryLifecycle = undefined;
    repository?.close();
    repository = undefined;
  };
  const scheduleReload = () => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    window.setTimeout(() => window.location.reload(), 0);
  };
  const runtimeLock = createRuntimeWriteLock({
    onReadOnly: async () => {
      renderLoading(root, "另一标签页正在恢复，Tenjin 即将重新打开…");
      closeRepository();
      scheduleReload();
    },
  });

  try {
    // The shared lock is acquired before any formal identity is read or minted.
    await runtimeLock.start();
    const pendingDeviceId = localStorage.getItem(
      PENDING_RESTORE_DEVICE_ID_KEY,
    );
    if (pendingDeviceId !== null) {
      runtimeLock.enterReadOnly();
      await runtimeLock.releaseSharedLock();
      const state = await bootstrapRestoreActivation(
        createRestoreDependencies(runtimeLock),
      );
      if (state.kind === "normal" || state.kind === "pending-committed") {
        scheduleReload();
        return;
      }
      renderRecovery(root, runtimeLock, state);
      return;
    }

    runtimeLock.assertWritable();
    const deviceId = loadDeviceId();
    const openedRepository = await openLedgerRepository();
    repository = openedRepository;
    // A remote recovery may have won while IndexedDB was opening.
    runtimeLock.assertWritable();
    const initialRestoreState =
      await openedRepository.inspectRestoreStorageState();
    runtimeLock.assertWritable();
    const restoreEligible = storageIsEmpty(initialRestoreState);
    const runtime = createLedgerRuntime({
      deviceId,
      reserveEventCoordinates: (eventDeviceId, physicalTime, count) =>
        openedRepository.reserveEventCoordinates(
          eventDeviceId,
          physicalTime,
          count,
        ),
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      digest: digestSha256Text,
    });

    cleanupRepositoryLifecycle = installRepositoryLifecycle(window, {
      enterReadOnly: () => runtimeLock.enterReadOnly(),
      close: closeRepository,
      releaseSharedLock: () => runtimeLock.releaseSharedLock(),
    });

    const backupRestoreActions = {
      restoreSupported: runtimeLock.supportsRecovery,
      restoreEligible,
      onExportBackup: async () => {
        runtimeLock.assertWritable();
        const backup = await buildLedgerBackup({
          reader: openedRepository,
          deviceId,
          exportedAt: new Date().toISOString(),
        });
        runtimeLock.assertWritable();
        downloadLedgerBackup(backup);
      },
      onRestoreBackup: async (file: File) => {
        runtimeLock.assertWritable();
        const bytes = await fileBytes(file);
        runtimeLock.assertWritable();
        const state = await openedRepository.inspectRestoreStorageState();
        runtimeLock.assertWritable();
        if (!storageIsEmpty(state)) {
          throw new Error("当前本地账本并非完全空白，不能执行恢复。");
        }

        runtimeLock.enterReadOnly();
        renderLoading(root, "正在验证并恢复备份…");
        closeRepository();
        await runtimeLock.releaseSharedLock();
        try {
          const result = await restoreWithActivation(
            createRestoreDependencies(runtimeLock),
            bytes,
          );
          if (
            result.kind !== "restored" &&
            result.kind !== "pending-committed"
          ) {
            throw new Error(
              result.kind === "restore-target-not-empty"
                ? "恢复目标不再为空。"
                : restoreStateMessage(result),
            );
          }
        } catch (error) {
          storeRestoreError(error);
          scheduleReload();
          throw error;
        }
      },
    };
    const renderApplication = (
      storagePersistence: Awaited<ReturnType<typeof requestStoragePersistence>>,
    ) => {
      root.render(
        <App
          repository={openedRepository}
          runtime={runtime}
          writeGate={runtimeLock}
          storagePersistence={storagePersistence}
          backupRestoreActions={backupRestoreActions}
        />,
      );
    };

    // Persistence status is informative; it must never block the usable ledger.
    renderApplication("unsupported");
    void requestStoragePersistence().then((storagePersistence) => {
      if (
        repository === openedRepository &&
        runtimeLock.isWritable &&
        !reloadScheduled
      ) {
        renderApplication(storagePersistence);
      }
    });
  } catch (error) {
    closeRepository();
    runtimeLock.enterReadOnly();
    await runtimeLock.releaseSharedLock().catch(() => undefined);
    root.render(
      <BootstrapError
        error={error}
        onRetry={() => window.location.reload()}
      />,
    );
  }
}

void main();
