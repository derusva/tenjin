export const RUNTIME_WRITE_LOCK_NAME = "tenjin-runtime-write";
export const RUNTIME_WRITE_CHANNEL_NAME = "tenjin-runtime-write";

type LockMode = "shared" | "exclusive";

interface RuntimeLockManager {
  request<T>(
    name: string,
    options: { readonly mode: LockMode; readonly signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

interface RuntimeBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

interface RuntimeTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface RuntimeWriteLockOptions {
  readonly lockManager?: RuntimeLockManager | undefined;
  readonly broadcastChannel?: RuntimeBroadcastChannel | undefined;
  readonly lockName?: string;
  readonly recoveryTimeoutMs?: number;
  readonly timer?: RuntimeTimer;
  /** Closes the local repository after a remote runtime asks this tab to yield. */
  readonly onReadOnly?: () => void | Promise<void>;
}

export class RuntimeWriteBlockedError extends Error {
  constructor() {
    super("This runtime is read-only.");
    this.name = "RuntimeWriteBlockedError";
  }
}

export class RuntimeRecoveryUnsupportedError extends Error {
  constructor() {
    super("Ledger recovery requires the Web Locks API.");
    this.name = "RuntimeRecoveryUnsupportedError";
  }
}

export class RuntimeRecoveryLockTimeoutError extends Error {
  constructor() {
    super("Ledger recovery could not obtain the exclusive runtime lock in time.");
    this.name = "RuntimeRecoveryLockTimeoutError";
  }
}

type WriteState = "writable" | "read-only";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function defaultLockManager(): RuntimeLockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

function defaultBroadcastChannel(): RuntimeBroadcastChannel | undefined {
  return typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel(RUNTIME_WRITE_CHANNEL_NAME);
}

function defaultTimer(): RuntimeTimer {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function isYieldRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { readonly type?: unknown }).type === "tenjin-runtime-yield"
  );
}

/**
 * A runtime-wide write gate. Supported browsers hold a shared Web Lock for the
 * complete writable lifetime; browsers without Web Locks remain usable for a
 * single tab but are deliberately unable to enter recovery.
 */
export class RuntimeWriteLock {
  private readonly lockManager: RuntimeLockManager | undefined;
  private readonly channel: RuntimeBroadcastChannel | undefined;
  private readonly lockName: string;
  private readonly recoveryTimeoutMs: number;
  private readonly timer: RuntimeTimer;
  private readonly onReadOnly: (() => void | Promise<void>) | undefined;
  private state: WriteState = "read-only";
  private sharedRelease: Deferred | undefined;
  private sharedRequest: Promise<void> | undefined;
  private sharedHeld = false;
  private sharedGeneration = 0;
  private closed = false;
  private yielding: Promise<void> | undefined;

  constructor(options: RuntimeWriteLockOptions = {}) {
    this.lockManager =
      "lockManager" in options ? options.lockManager : defaultLockManager();
    this.channel =
      "broadcastChannel" in options
        ? options.broadcastChannel
        : defaultBroadcastChannel();
    this.lockName = options.lockName ?? RUNTIME_WRITE_LOCK_NAME;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 3_000;
    this.timer = options.timer ?? defaultTimer();
    this.onReadOnly = options.onReadOnly;

    if (this.channel !== undefined) {
      this.channel.onmessage = (event) => {
        if (isYieldRequest(event.data)) {
          void this.yieldToRecovery().catch(() => undefined);
        }
      };
    }
  }

  get isWritable(): boolean {
    return this.state === "writable";
  }

  get supportsRecovery(): boolean {
    return this.lockManager !== undefined;
  }

  /** Acquires the lifetime shared lock before allowing any write. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new RuntimeWriteBlockedError();
    }
    if (this.state === "writable") {
      return;
    }
    if (this.lockManager === undefined) {
      this.state = "writable";
      return;
    }

    const generation = ++this.sharedGeneration;
    const ready = deferred();
    const release = deferred();
    this.sharedRelease = release;
    this.sharedHeld = false;
    const request = this.lockManager.request(
      this.lockName,
      { mode: "shared" },
      async () => {
        this.sharedHeld = true;
        ready.resolve();
        await release.promise;
        this.sharedHeld = false;
      },
    );
    this.sharedRequest = request;
    try {
      await Promise.race([ready.promise, request]);
      if (this.sharedGeneration !== generation || this.closed) {
        throw new RuntimeWriteBlockedError();
      }
      this.state = "writable";
    } catch (error) {
      this.sharedRelease = undefined;
      this.sharedRequest = undefined;
      throw error;
    }
  }

  assertWritable(): void {
    if (this.state !== "writable") {
      throw new RuntimeWriteBlockedError();
    }
  }

  /** Stops all local writes. Releasing the shared lock remains explicit. */
  enterReadOnly(): void {
    this.state = "read-only";
  }

  /**
   * Releases the lifetime shared lock only after writes have been gated. This
   * separate step lets the caller close IndexedDB between the gate and release.
   */
  async releaseSharedLock(): Promise<void> {
    if (this.state !== "read-only") {
      throw new Error("Enter read-only mode before releasing the shared lock.");
    }
    const release = this.sharedRelease;
    const request = this.sharedRequest;
    if (release !== undefined || request !== undefined) {
      this.sharedGeneration += 1;
    }
    this.sharedRelease = undefined;
    this.sharedRequest = undefined;
    release?.resolve();
    if (request !== undefined) {
      await request;
    }
  }

  /** Sends a best-effort yield request; exclusive acquisition is still authority. */
  requestOtherTabsReadOnly(): void {
    this.channel?.postMessage({ type: "tenjin-runtime-yield" });
  }

  /**
   * Obtains an exclusive recovery window. Callers must first gate writes, close
   * their repository, and release their own shared lock.
   */
  async requestExclusive<T>(
    action: () => Promise<T> | T,
    timeoutMs = this.recoveryTimeoutMs,
  ): Promise<T> {
    if (this.lockManager === undefined) {
      throw new RuntimeRecoveryUnsupportedError();
    }
    if (this.state !== "read-only" || this.sharedHeld || this.sharedRequest !== undefined) {
      throw new Error(
        "Enter read-only mode and release this runtime's shared lock before recovery.",
      );
    }

    this.requestOtherTabsReadOnly();
    const controller = new AbortController();
    let acquired = false;
    let timeoutFired = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = this.timer.setTimeout(() => {
        if (acquired) {
          return;
        }
        timeoutFired = true;
        controller.abort();
        reject(new RuntimeRecoveryLockTimeoutError());
      }, timeoutMs);
    });
    const request = this.lockManager.request(
      this.lockName,
      { mode: "exclusive", signal: controller.signal },
      async () => {
        if (timeoutFired) {
          return undefined as T;
        }
        acquired = true;
        if (timeoutHandle !== undefined) {
          this.timer.clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        return action();
      },
    );

    try {
      return await Promise.race([request, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
      if (timeoutFired) {
        void request.catch(() => undefined);
      }
    }
  }

  /** Handles another tab's recovery request in the required gate-close-release order. */
  async yieldToRecovery(): Promise<void> {
    if (this.yielding === undefined) {
      this.yielding = (async () => {
        this.enterReadOnly();
        try {
          await this.onReadOnly?.();
        } finally {
          await this.releaseSharedLock();
        }
      })();
    }
    await this.yielding;
  }

  async close(): Promise<void> {
    await this.yieldToRecovery();
    this.closed = true;
    this.channel?.close();
  }
}

export function createRuntimeWriteLock(
  options: RuntimeWriteLockOptions = {},
): RuntimeWriteLock {
  return new RuntimeWriteLock(options);
}
