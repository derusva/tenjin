import { describe, expect, it } from "vitest";

import { FixedCommandError, runCommand } from "./runCommand.js";

describe("runCommand", () => {
  it("captures bounded stdout without a shell", async () => {
    await expect(
      runCommand({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"] }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok" });
  });

  it.each([
    [66, "no-input"],
    [69, "unavailable"],
    [75, "temporary-failure"],
    [77, "permission-denied"],
  ] as const)("classifies exit %s", async (exitCode, kind) => {
    const failure = await runCommand({
      executable: process.execPath,
      args: ["-e", `process.exit(${exitCode})`],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FixedCommandError);
    expect((failure as FixedCommandError).kind).toBe(kind);
    expect((failure as FixedCommandError).exitCode).toBe(exitCode);
  });

  it("fails closed when stdout exceeds the configured bound", async () => {
    const failure = await runCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('12345')"],
      maxStdoutBytes: 4,
    }).catch((error: unknown) => error);
    expect((failure as FixedCommandError).kind).toBe("stdout-limit");
  });

  it.each([
    {
      name: "timeout",
      expectedKind: "timed-out",
      timeoutMs: 25,
      maxStdoutBytes: undefined,
      script: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    },
    {
      name: "stdout limit",
      expectedKind: "stdout-limit",
      timeoutMs: 5_000,
      maxStdoutBytes: 4,
      script:
        "process.on('SIGTERM', () => {}); process.stdout.write('12345'); setInterval(() => {}, 1000)",
    },
  ] as const)(
    "completes within a hard bound after $name termination",
    async ({ expectedKind, timeoutMs, maxStdoutBytes, script }) => {
      const hardTestDeadlineMs = 1_500;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const startedAt = Date.now();

      const failure = await Promise.race([
        runCommand({
          executable: process.execPath,
          args: ["-e", script],
          timeoutMs,
          ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
        }).catch((error: unknown) => error),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error("runCommand exceeded the hard test deadline")),
            hardTestDeadlineMs,
          );
        }),
      ]).finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      });

      expect(failure).toBeInstanceOf(FixedCommandError);
      expect((failure as FixedCommandError).kind).toBe(expectedKind);
      expect(Date.now() - startedAt).toBeLessThan(hardTestDeadlineMs);
    },
  );
});
