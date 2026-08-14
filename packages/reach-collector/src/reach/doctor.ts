import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  FixedCommandError,
  runCommand,
  type FixedCommandResult,
  type FixedCommandSpec,
} from "../process/runCommand.js";

export interface AgentReachChannelStatus {
  readonly status: string;
  readonly available: boolean;
  readonly message?: string;
  readonly activeBackend?: string;
}

export interface AgentReachDoctorResult {
  readonly installed: boolean;
  readonly executable: string;
  readonly available: boolean;
  readonly channels: Readonly<Record<string, AgentReachChannelStatus>>;
  readonly errorKind?: string;
}

export interface AgentReachDoctorOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly run?: (spec: FixedCommandSpec) => Promise<FixedCommandResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultAgentReachExecutable(): string {
  if (process.platform === "win32") {
    return join(
      homedir(),
      ".agent-reach-venv",
      "Scripts",
      "agent-reach.exe",
    );
  }
  return "agent-reach";
}

function defaultAgentReachToolPaths(): readonly string[] {
  return [
    join(homedir(), ".agent-reach", "tools", "opencli", "node_modules", ".bin"),
  ];
}

function parseDoctorChannels(
  value: unknown,
): Readonly<Record<string, AgentReachChannelStatus>> {
  if (!isRecord(value)) {
    throw new Error("Agent Reach doctor returned a non-object JSON document");
  }
  const channels: Record<string, AgentReachChannelStatus> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.status !== "string") continue;
    const status = raw.status;
    channels[name] = {
      status,
      // Deliberately ignore active_backend as an availability signal. The
      // channel check's status is the only Agent Reach health assertion used.
      available: status === "ok",
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      ...(typeof raw.active_backend === "string"
        ? { activeBackend: raw.active_backend }
        : {}),
    };
  }
  return channels;
}

export async function doctorAgentReach(
  options: AgentReachDoctorOptions = {},
): Promise<AgentReachDoctorResult> {
  const executable = options.executable ?? defaultAgentReachExecutable();
  if (executable.includes("\\") || executable.includes("/")) {
    try {
      await access(executable);
    } catch {
      return {
        installed: false,
        executable,
        available: false,
        channels: {},
        errorKind: "not-found",
      };
    }
  }

  try {
    const result = await (options.run ?? runCommand)({
      executable,
      args: ["doctor", "--json"],
      ...(executable.includes("\\") || executable.includes("/")
        ? { prependPath: [dirname(executable), ...defaultAgentReachToolPaths()] }
        : {}),
      timeoutMs: options.timeoutMs ?? 45_000,
      maxStdoutBytes: 2 * 1024 * 1024,
    });
    const channels = parseDoctorChannels(JSON.parse(result.stdout) as unknown);
    return {
      installed: true,
      executable,
      available: Object.values(channels).some((channel) => channel.available),
      channels,
    };
  } catch (error) {
    return {
      installed:
        !(error instanceof FixedCommandError) || error.kind !== "not-found",
      executable,
      available: false,
      channels: {},
      errorKind:
        error instanceof FixedCommandError ? error.kind : "invalid-output",
    };
  }
}
