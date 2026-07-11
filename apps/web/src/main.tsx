import {
  openLedgerRepository,
  type LedgerRepository,
} from "@tenjin/storage-indexeddb";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App.js";
import { BootstrapError } from "./app/BootstrapError.js";
import { installRepositoryLifecycle } from "./app/repositoryLifecycle.js";
import { requestStoragePersistence } from "./app/storagePersistence.js";
import { createLedgerRuntime } from "./features/ledger/ledgerRuntime.js";
import "./styles/tokens.css";
import "./styles/app.css";

registerSW({ immediate: true });

const DEVICE_ID_KEY = "tenjin.deviceId";

function loadDeviceId(): string {
  const stored = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (stored !== undefined && stored.length > 0) {
    return stored;
  }

  const deviceId = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

async function digestSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function main(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error("Tenjin root element is missing");
  }
  const root = createRoot(rootElement);
  let repository: LedgerRepository | undefined;

  root.render(
    <div className="app-shell">
      <main className="app-main">
        <section className="utility-view state-view">
          <p role="status">正在打开本地账本…</p>
        </section>
      </main>
    </div>,
  );

  try {
    const storagePersistence = await requestStoragePersistence();
    const openedRepository = await openLedgerRepository();
    repository = openedRepository;
    const runtime = createLedgerRuntime({
      deviceId: loadDeviceId(),
      reserveEventCoordinates: (deviceId, physicalTime, count) =>
        openedRepository.reserveEventCoordinates(deviceId, physicalTime, count),
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      digest: digestSha256,
    });

    const cleanupRepositoryLifecycle = installRepositoryLifecycle(
      window,
      () => {
        cleanupRepositoryLifecycle();
        openedRepository.close();
      },
    );

    root.render(
      <App
        repository={openedRepository}
        runtime={runtime}
        storagePersistence={storagePersistence}
      />,
    );
  } catch (error) {
    repository?.close();
    root.render(
      <BootstrapError
        error={error}
        onRetry={() => window.location.reload()}
      />,
    );
  }
}

void main();
