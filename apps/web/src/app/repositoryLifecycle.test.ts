import { describe, expect, it, vi } from "vitest";

import {
  closeRepositoryLifecycle,
  installRepositoryLifecycle,
} from "./repositoryLifecycle.js";

function pagehide(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

describe("installRepositoryLifecycle", () => {
  it("keeps the repository open when the page enters the back-forward cache", () => {
    const target = new EventTarget();
    const close = vi.fn();

    installRepositoryLifecycle(target, close);
    target.dispatchEvent(pagehide(true));

    expect(close).not.toHaveBeenCalled();
  });

  it("closes the repository when the page is discarded", () => {
    const target = new EventTarget();
    const close = vi.fn();

    installRepositoryLifecycle(target, close);
    target.dispatchEvent(pagehide(false));

    expect(close).toHaveBeenCalledOnce();
  });

  it("removes the pagehide listener during cleanup", () => {
    const target = new EventTarget();
    const close = vi.fn();

    const cleanup = installRepositoryLifecycle(target, close);
    cleanup();
    target.dispatchEvent(pagehide(false));

    expect(close).not.toHaveBeenCalled();
  });

  it("gates writes, closes the repository, then releases the shared lock", async () => {
    const calls: string[] = [];

    await closeRepositoryLifecycle({
      enterReadOnly: () => {
        calls.push("read-only");
      },
      close: () => {
        calls.push("close");
      },
      releaseSharedLock: () => {
        calls.push("release");
      },
    });

    expect(calls).toEqual(["read-only", "close", "release"]);
  });

  it("still releases the shared lock when repository close fails", async () => {
    const release = vi.fn();

    await expect(
      closeRepositoryLifecycle({
        enterReadOnly: vi.fn(),
        close: () => {
          throw new Error("close failed");
        },
        releaseSharedLock: release,
      }),
    ).rejects.toThrow("close failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("applies the same ordered shutdown on non-bfcache pagehide", async () => {
    const target = new EventTarget();
    const calls: string[] = [];
    installRepositoryLifecycle(target, {
      enterReadOnly: () => {
        calls.push("read-only");
      },
      close: () => {
        calls.push("close");
      },
      releaseSharedLock: () => {
        calls.push("release");
      },
    });

    target.dispatchEvent(pagehide(false));
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["read-only", "close", "release"]);
  });
});
