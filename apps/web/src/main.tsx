import { openLedgerRepository } from "@tenjin/storage-indexeddb";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { createLedgerRuntime } from "./features/ledger/ledgerRuntime.js";

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

  const repository = await openLedgerRepository();
  const snapshot = await repository.readSnapshot();
  const runtime = createLedgerRuntime({
    deviceId: loadDeviceId(),
    existingEvents: snapshot.events,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    digest: digestSha256,
  });

  window.addEventListener(
    "pagehide",
    () => {
      repository.close();
    },
    { once: true },
  );

  createRoot(rootElement).render(
    <App repository={repository} runtime={runtime} />,
  );
}

void main();
