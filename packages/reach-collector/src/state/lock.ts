import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type ExclusiveLockErrorCode =
  | "REACH_LOCK_BUSY"
  | "REACH_LOCK_OWNERSHIP_LOST";

export class ExclusiveLockError extends Error {
  readonly code: ExclusiveLockErrorCode;
  readonly lockPath: string;

  constructor(
    code: ExclusiveLockErrorCode,
    lockPath: string,
    message: string,
  ) {
    super(message);
    this.name = "ExclusiveLockError";
    this.code = code;
    this.lockPath = lockPath;
  }
}

export interface ExclusiveLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

export interface AcquireExclusiveLockOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly processIsAlive?: (pid: number) => boolean;
}

interface LockOwner {
  readonly schema: "tenjin.reach-lock/v1";
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

const LOCK_SCHEMA = "tenjin.reach-lock/v1" as const;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    // EPERM means the process exists but cannot be signalled.
    return true;
  }
}

function parseOwner(value: string): LockOwner | undefined {
  try {
    const candidate = JSON.parse(value) as unknown;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    if (
      record.schema !== LOCK_SCHEMA ||
      typeof record.token !== "string" ||
      record.token.length === 0 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      typeof record.hostname !== "string" ||
      record.hostname.length === 0 ||
      typeof record.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return {
      schema: LOCK_SCHEMA,
      token: record.token,
      pid: record.pid as number,
      hostname: record.hostname,
      acquiredAt: record.acquiredAt,
    };
  } catch {
    return undefined;
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // A failed close does not justify deleting another process's lock.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function tryReclaimStaleLock(
  lockPath: string,
  staleAfterMs: number,
  now: () => number,
  createToken: () => string,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  if (now() - lockStat.mtimeMs < staleAfterMs) {
    return false;
  }

  let owner: LockOwner | undefined;
  try {
    owner = parseOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
  }
  if (owner?.hostname !== undefined && owner.hostname !== hostname()) {
    return false;
  }
  if (owner !== undefined && processIsAlive(owner.pid)) {
    return false;
  }

  const stalePath = `${lockPath}.stale-${createToken()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  await unlinkQuietly(stalePath);
  return true;
}

function validateDuration(value: number, field: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be an integer of at least ${minimum}`);
  }
}

export async function acquireExclusiveLock(
  lockPath: string,
  options: AcquireExclusiveLockOptions = {},
): Promise<ExclusiveLock> {
  const timeoutMs = options.timeoutMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;
  const createToken = options.createToken ?? randomUUID;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  validateDuration(timeoutMs, "timeoutMs", 0);
  validateDuration(pollIntervalMs, "pollIntervalMs", 1);
  validateDuration(staleAfterMs, "staleAfterMs", 0);

  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;
  while (true) {
    const token = createToken();
    const owner: LockOwner = {
      schema: LOCK_SCHEMA,
      token,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date(now()).toISOString(),
    };
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      let released = false;
      return {
        path: lockPath,
        token,
        async release(): Promise<void> {
          if (released) {
            return;
          }
          let current: LockOwner | undefined;
          try {
            current = parseOwner(await readFile(lockPath, "utf8"));
          } catch (error) {
            if (errorCode(error) === "ENOENT") {
              released = true;
              return;
            }
            throw error;
          }
          if (current?.token !== token) {
            throw new ExclusiveLockError(
              "REACH_LOCK_OWNERSHIP_LOST",
              lockPath,
              "The collector lock is no longer owned by this process.",
            );
          }
          await unlinkQuietly(lockPath);
          released = true;
        },
      };
    } catch (error) {
      await closeQuietly(handle);
      const code = errorCode(error);
      if (code !== "EEXIST") {
        throw error;
      }
      const reclaimed = await tryReclaimStaleLock(
        lockPath,
        staleAfterMs,
        now,
        createToken,
        processIsAlive,
      );
      if (reclaimed) {
        continue;
      }
      if (now() >= deadline) {
        throw new ExclusiveLockError(
          "REACH_LOCK_BUSY",
          lockPath,
          "Another reach collection run holds the exclusive lock.",
        );
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
  }
}

export async function withExclusiveLock<T>(
  lockPath: string,
  action: () => T | Promise<T>,
  options: AcquireExclusiveLockOptions = {},
): Promise<T> {
  const lock = await acquireExclusiveLock(lockPath, options);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
