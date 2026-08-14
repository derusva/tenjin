import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireExclusiveLock,
  ExclusiveLockError,
  withExclusiveLock,
} from "./lock.js";

const temporaryDirectories: string[] = [];

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tenjin-reach-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "collector.lock");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
describe("exclusive file lock", () => {
  it("fails with a stable busy code while another owner holds the lock", async () => {
    const lockPath = await temporaryLockPath();
    const first = await acquireExclusiveLock(lockPath);
    await expect(acquireExclusiveLock(lockPath)).rejects.toMatchObject({
      code: "REACH_LOCK_BUSY",
      lockPath,
    });
    await first.release();
  });

  it("releases even when the protected action throws", async () => {
    const lockPath = await temporaryLockPath();
    await expect(
      withExclusiveLock(lockPath, () => {
        throw new Error("probe");
      }),
    ).rejects.toThrow("probe");
    const second = await acquireExclusiveLock(lockPath);
    await second.release();
  });

  it("reclaims a stale malformed lock without deleting a new owner's file", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, "partial", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const lock = await acquireExclusiveLock(lockPath, { staleAfterMs: 1 });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      token: lock.token,
    });
    await lock.release();
  });

  it("preserves a replacement lock when ownership is lost", async () => {
    const lockPath = await temporaryLockPath();
    const lock = await acquireExclusiveLock(lockPath);
    const replacement = {
      schema: "tenjin.reach-lock/v1",
      token: "replacement",
      pid: process.pid,
      hostname: "test",
      acquiredAt: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(replacement), "utf8");
    await expect(lock.release()).rejects.toBeInstanceOf(ExclusiveLockError);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });
});
