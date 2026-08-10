import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeWriteLock,
  RuntimeRecoveryLockTimeoutError,
  RuntimeRecoveryUnsupportedError,
  RuntimeWriteBlockedError,
} from "./runtimeWriteLock.js";

type Mode = "shared" | "exclusive";

class FakeLockManager {
  readonly requests: { readonly mode: Mode; readonly signal?: AbortSignal }[] = [];
  private sharedCount = 0;
  private readonly waitingExclusive: (() => void)[] = [];

  async request<T>(
    _name: string,
    options: { readonly mode: Mode; readonly signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.requests.push(options);
    if (options.mode === "shared") {
      this.sharedCount += 1;
      try {
        return await callback();
      } finally {
        this.sharedCount -= 1;
        this.waitingExclusive.splice(0).forEach((wake) => wake());
      }
    }
    while (this.sharedCount > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (options.signal?.aborted === true) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        this.waitingExclusive.push(resolve);
      });
    }
    return callback();
  }
}

class FakeChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: unknown[] = [];
  closed = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  close(): void {
    this.closed = true;
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

class DelayedSharedLockManager {
  private grantShared: (() => void) | undefined;

  async request<T>(
    _name: string,
    options: { readonly mode: Mode; readonly signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    if (options.mode !== "shared") return callback();
    await new Promise<void>((resolve) => {
      this.grantShared = resolve;
    });
    return callback();
  }

  grant(): void {
    this.grantShared?.();
  }
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RuntimeWriteLock", () => {
  it("holds a shared lock for its writable lifetime and blocks writes after read-only", async () => {
    const locks = new FakeLockManager();
    const gate = createRuntimeWriteLock({ lockManager: locks });

    await gate.start();
    gate.assertWritable();
    expect(locks.requests).toHaveLength(1);
    expect(locks.requests[0]).toMatchObject({ mode: "shared" });

    gate.enterReadOnly();
    expect(() => gate.assertWritable()).toThrow(RuntimeWriteBlockedError);
    await gate.releaseSharedLock();
  });

  it("never becomes writable when recovery asks it to yield before shared acquisition", async () => {
    const locks = new DelayedSharedLockManager();
    const onReadOnly = vi.fn();
    const gate = createRuntimeWriteLock({
      lockManager: locks,
      onReadOnly,
    });

    const starting = gate.start();
    await drain();
    const yielding = gate.yieldToRecovery();
    locks.grant();

    await expect(starting).rejects.toBeInstanceOf(RuntimeWriteBlockedError);
    await yielding;
    expect(onReadOnly).toHaveBeenCalledOnce();
    expect(gate.isWritable).toBe(false);
    expect(() => gate.assertWritable()).toThrow(RuntimeWriteBlockedError);
  });

  it("requires the initiator to release its own shared lock before recovery", async () => {
    const locks = new FakeLockManager();
    const channel = new FakeChannel();
    const gate = createRuntimeWriteLock({ lockManager: locks, broadcastChannel: channel });
    await gate.start();
    gate.enterReadOnly();

    await expect(gate.requestExclusive(() => "restore")).rejects.toThrow(
      "release this runtime's shared lock",
    );
    await gate.releaseSharedLock();

    await expect(gate.requestExclusive(() => "restore")).resolves.toBe("restore");
    expect(channel.messages).toContainEqual({ type: "tenjin-runtime-yield" });
    expect(locks.requests.map((request) => request.mode)).toEqual([
      "shared",
      "exclusive",
    ]);
  });

  it("makes a yielding peer read-only, close its repository, then release shared", async () => {
    const locks = new FakeLockManager();
    const channel = new FakeChannel();
    const calls: string[] = [];
    const gate = createRuntimeWriteLock({
      lockManager: locks,
      broadcastChannel: channel,
      onReadOnly: () => {
        calls.push("close");
      },
    });
    await gate.start();

    channel.receive({ type: "tenjin-runtime-yield" });
    await drain();

    expect(gate.isWritable).toBe(false);
    expect(calls).toEqual(["close"]);
    expect(() => gate.assertWritable()).toThrow(RuntimeWriteBlockedError);
  });

  it("releases the shared lock even when the yielding peer cannot close cleanly", async () => {
    const locks = new FakeLockManager();
    const peer = createRuntimeWriteLock({
      lockManager: locks,
      onReadOnly: () => {
        throw new Error("close failed");
      },
    });
    const restorer = createRuntimeWriteLock({ lockManager: locks });
    await peer.start();
    await restorer.start();
    restorer.enterReadOnly();
    await restorer.releaseSharedLock();

    await expect(peer.yieldToRecovery()).rejects.toThrow("close failed");
    await expect(restorer.requestExclusive(() => "restored")).resolves.toBe(
      "restored",
    );
    expect(peer.isWritable).toBe(false);
  });

  it("fails recovery closed when Web Locks are unavailable but permits normal single-tab use", async () => {
    const gate = createRuntimeWriteLock({ lockManager: undefined });
    await gate.start();
    gate.assertWritable();
    gate.enterReadOnly();

    await expect(gate.requestExclusive(() => undefined)).rejects.toBeInstanceOf(
      RuntimeRecoveryUnsupportedError,
    );
  });

  it("bounds an exclusive wait and never runs an action after timeout", async () => {
    vi.useFakeTimers();
    const locks = new FakeLockManager();
    const holder = createRuntimeWriteLock({ lockManager: locks });
    const gate = createRuntimeWriteLock({ lockManager: locks });
    await holder.start();
    await gate.start();
    gate.enterReadOnly();
    await gate.releaseSharedLock();
    const action = vi.fn();

    const result = gate.requestExclusive(action, 10);
    const expectation = expect(result).rejects.toBeInstanceOf(
      RuntimeRecoveryLockTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    holder.enterReadOnly();
    await holder.releaseSharedLock();
    await drain();
    expect(action).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("stops the timeout once exclusive ownership begins, even when restore is slow", async () => {
    vi.useFakeTimers();
    const locks = new FakeLockManager();
    const gate = createRuntimeWriteLock({ lockManager: locks });
    await gate.start();
    gate.enterReadOnly();
    await gate.releaseSharedLock();
    let finish!: (value: string) => void;
    const action = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const result = gate.requestExclusive(action, 10);
    await drain();
    expect(action).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    finish("restored");

    await expect(result).resolves.toBe("restored");
    vi.useRealTimers();
  });
});
