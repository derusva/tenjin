import { describe, expect, it, vi } from "vitest";

import { installRepositoryLifecycle } from "./repositoryLifecycle.js";

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
});
