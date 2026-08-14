import { spawn } from "node:child_process";
import { delimiter } from "node:path";

const TERMINATION_GRACE_MS = 250;

export type CommandFailureKind =
  | "no-input"
  | "unavailable"
  | "temporary-failure"
  | "permission-denied"
  | "failed"
  | "not-found"
  | "timed-out"
  | "stdout-limit";

export interface FixedCommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly prependPath?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface FixedCommandResult {
  readonly exitCode: 0;
  readonly stdout: string;
}

export class FixedCommandError extends Error {
  readonly code = "REACH_COMMAND_FAILED";
  readonly kind: CommandFailureKind;
  readonly exitCode?: number;

  constructor(kind: CommandFailureKind, message: string, exitCode?: number) {
    super(message);
    this.name = "FixedCommandError";
    this.kind = kind;
    if (exitCode !== undefined) {
      this.exitCode = exitCode;
    }
  }
}

export function classifyExitCode(exitCode: number): CommandFailureKind {
  switch (exitCode) {
    case 66:
      return "no-input";
    case 69:
      return "unavailable";
    case 75:
      return "temporary-failure";
    case 77:
      return "permission-denied";
    default:
      return "failed";
  }
}

/** Executes a fixed argv vector. It never invokes a shell or returns stderr. */
export async function runCommand(
  spec: FixedCommandSpec,
): Promise<FixedCommandResult> {
  if (spec.executable.trim().length === 0) {
    throw new FixedCommandError("not-found", "Command executable is empty");
  }
  const timeoutMs = spec.timeoutMs ?? 30_000;
  const maxStdoutBytes = spec.maxStdoutBytes ?? 4 * 1024 * 1024;
  const environment =
    spec.environment === undefined &&
    (spec.prependPath === undefined || spec.prependPath.length === 0)
      ? undefined
      : {
          ...process.env,
          ...spec.environment,
          ...(spec.prependPath === undefined || spec.prependPath.length === 0
            ? {}
            : {
                PATH: [...spec.prependPath, process.env.PATH ?? ""].join(
                  delimiter,
                ),
              }),
        };

  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      ...(environment === undefined ? {} : { env: environment }),
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let pendingFailure: FixedCommandError | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTerminationTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (forceTerminationTimer !== undefined) {
        clearTimeout(forceTerminationTimer);
        forceTerminationTimer = undefined;
      }
      child.stdout.off("data", onStdoutData);
      child.off("error", onChildError);
      child.off("close", onChildClose);
    };

    const finishWithError = (error: FixedCommandError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const beginTermination = (error: FixedCommandError): void => {
      if (settled || pendingFailure !== undefined) return;
      pendingFailure = error;

      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      child.stdout.off("data", onStdoutData);
      child.stdout.destroy();

      try {
        child.kill();
      } catch {
        // The force deadline below is also the bounded completion fallback.
      }

      forceTerminationTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The command failure remains the stable externally visible error.
        }
        child.unref();
        finishWithError(error);
      }, TERMINATION_GRACE_MS);
    };

    function onStdoutData(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        beginTermination(
          new FixedCommandError(
            "stdout-limit",
            `Command stdout exceeded ${maxStdoutBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    }

    function onChildError(error: NodeJS.ErrnoException): void {
      if (pendingFailure !== undefined) {
        finishWithError(pendingFailure);
        return;
      }
      const kind = error.code === "ENOENT" ? "not-found" : "failed";
      finishWithError(
        new FixedCommandError(kind, `Unable to start command (${kind})`),
      );
    }

    function onChildClose(exitCode: number | null): void {
      if (settled) return;
      if (pendingFailure !== undefined) {
        finishWithError(pendingFailure);
        return;
      }
      if (exitCode !== 0) {
        const normalizedExitCode = exitCode ?? 1;
        const kind = classifyExitCode(normalizedExitCode);
        finishWithError(
          new FixedCommandError(
            kind,
            `Command exited with status ${normalizedExitCode} (${kind})`,
            normalizedExitCode,
          ),
        );
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode: 0,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    }

    child.stdout.on("data", onStdoutData);
    child.once("error", onChildError);
    child.once("close", onChildClose);

    timeoutTimer = setTimeout(() => {
      beginTermination(
        new FixedCommandError("timed-out", "Command timed out"),
      );
    }, timeoutMs);
  });
}
