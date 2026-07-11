import { afterAll, describe, expect, it, vi } from "vitest";

import { requestStoragePersistence } from "./storagePersistence.js";

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "storage",
);

function installStorage(
  storage: Pick<StorageManager, "persist"> | undefined,
): void {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storage,
  });
}

afterAll(() => {
  if (originalStorageDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "storage");
    return;
  }

  Object.defineProperty(navigator, "storage", originalStorageDescriptor);
});

describe("requestStoragePersistence", () => {
  it("reports persisted when the browser grants persistence", async () => {
    installStorage({ persist: vi.fn().mockResolvedValue(true) });

    await expect(requestStoragePersistence()).resolves.toBe("persisted");
  });

  it("reports best-effort when the browser declines persistence", async () => {
    installStorage({ persist: vi.fn().mockResolvedValue(false) });

    await expect(requestStoragePersistence()).resolves.toBe("best-effort");
  });

  it("falls back to best-effort when the persistence request fails", async () => {
    installStorage({ persist: vi.fn().mockRejectedValue(new Error("denied")) });

    await expect(requestStoragePersistence()).resolves.toBe("best-effort");
  });

  it("reports unsupported when the persistence API is unavailable", async () => {
    installStorage(undefined);

    await expect(requestStoragePersistence()).resolves.toBe("unsupported");
  });
});
