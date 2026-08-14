import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  InstagramProbeSourceConfig,
  OpenCliSourceConfig,
} from "../config.js";
import {
  createRawSourceItem,
  type RawSourceItemV1,
  type VideoTranscriptCueV1,
} from "../contracts/index.js";
import {
  FixedCommandError,
  runCommand,
  type FixedCommandSpec,
  type FixedCommandResult,
} from "../process/runCommand.js";

export interface OpenCliDependencies {
  readonly executable?: string;
  readonly version?: string;
  readonly argsPrefix?: readonly string[];
  readonly run: (spec: FixedCommandSpec) => Promise<FixedCommandResult>;
}

export interface InstagramSavedProbeResult {
  readonly supported: false;
  readonly reachable: boolean;
  readonly reason: "unstable-identity";
}

export interface OpenCliDoctorResult {
  readonly installed: boolean;
  readonly executable: string;
  readonly version?: string;
  readonly browserBridge: "not_checked";
  readonly reason: string;
}

function isolatedOpenCliMain(): string {
  return join(
    homedir(),
    ".agent-reach",
    "tools",
    "opencli",
    "node_modules",
    "@jackwener",
    "opencli",
    "dist",
    "src",
    "main.js",
  );
}

function defaultDependencies(): OpenCliDependencies {
  const isolatedMain = isolatedOpenCliMain();
  return existsSync(isolatedMain)
    ? {
        executable: process.execPath,
        version: "1.8.6",
        argsPrefix: [isolatedMain],
        run: runCommand,
      }
    : {
        executable: "opencli",
        version: "unknown",
        argsPrefix: [],
        run: runCommand,
      };
}

const DEFAULT_DEPENDENCIES = defaultDependencies();

function records(stdout: string): readonly Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("OpenCLI output must be a JSON array");
  return parsed.filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenCLI item is missing ${field}`);
  }
  return value.trim();
}

function youtubeId(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get("v") ?? parsed.pathname.split("/").filter(Boolean).at(-1) ?? url;
}

function seconds(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = /^(\d+(?:\.\d+)?)s$/u.exec(value.trim());
  return match === null ? 0 : Math.round(Number(match[1]) * 1_000);
}

async function transcript(
  url: string,
  language: string,
  dependencies: OpenCliDependencies,
): Promise<readonly VideoTranscriptCueV1[] | undefined> {
  const executable = dependencies.executable ?? DEFAULT_DEPENDENCIES.executable!;
  const argsPrefix = dependencies.argsPrefix ?? DEFAULT_DEPENDENCIES.argsPrefix ?? [];
  try {
    const output = await dependencies.run({
      executable,
      args: [...argsPrefix, "youtube", "transcript", url, "--lang", language, "--mode", "raw", "-f", "json"],
      timeoutMs: 60_000,
      maxStdoutBytes: 8 * 1024 * 1024,
    });
    const cues = records(output.stdout).map((cue) => {
      const startMs = seconds(cue.start);
      const endMs = seconds(cue.end);
      return {
        startMs,
        ...(endMs > startMs ? { endMs } : {}),
        text: required(cue.text, "transcript text"),
      };
    });
    return cues.length === 0 ? undefined : cues;
  } catch (error) {
    if (error instanceof FixedCommandError && error.kind === "no-input") return undefined;
    throw error;
  }
}

export async function collectOpenCliSource(
  config: OpenCliSourceConfig,
  dependencies: OpenCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly RawSourceItemV1[]> {
  const executable = dependencies.executable ?? DEFAULT_DEPENDENCIES.executable!;
  const version = dependencies.version ?? DEFAULT_DEPENDENCIES.version!;
  const argsPrefix = dependencies.argsPrefix ?? DEFAULT_DEPENDENCIES.argsPrefix ?? [];
  const sourceArgs: readonly string[] =
    config.kind === "youtube-history"
      ? ["youtube", "history", "--limit", String(config.limit), "-f", "json"]
      : config.kind === "youtube-watch-later"
        ? ["youtube", "watch-later", "--limit", String(config.limit), "-f", "json"]
        : config.kind === "x-bookmarks"
          ? ["twitter", "bookmarks", "--limit", String(config.limit), "-f", "json"]
          : ["twitter", "likes", "--limit", String(config.limit), "-f", "json"];
  let rows: readonly Record<string, unknown>[];
  try {
    rows = records((await dependencies.run({
      executable,
      args: [...argsPrefix, ...sourceArgs],
      timeoutMs: 60_000,
      maxStdoutBytes: 8 * 1024 * 1024,
    })).stdout);
  } catch (error) {
    if (error instanceof FixedCommandError && error.kind === "no-input") return [];
    throw error;
  }

  const results: RawSourceItemV1[] = [];
  for (const row of rows.slice(0, config.limit)) {
    if (config.kind === "youtube-history" || config.kind === "youtube-watch-later") {
      const url = required(row.url, "url");
      const title = required(row.title, "title");
      const cues = await transcript(url, config.transcriptLanguage ?? "ja", dependencies);
      results.push(createRawSourceItem({
        sourceId: config.id,
        accountScope: config.accountScope,
        platform: "youtube",
        externalId: youtubeId(url),
        canonicalUrl: url,
        interaction: config.kind === "youtube-history" ? "history" : "watch_later",
        content: {
          kind: "video",
          title,
          ...(cues === undefined ? {} : { transcript: cues }),
        },
        backend: { name: "opencli", version },
        ...(typeof row.channel === "string" && row.channel.trim().length > 0
          ? { author: row.channel.trim() }
          : {}),
      }));
    } else {
      const id = required(row.id, "id");
      const url = required(row.url, "url");
      const text = required(row.text, "text");
      results.push(createRawSourceItem({
        sourceId: config.id,
        accountScope: config.accountScope,
        platform: "x",
        externalId: id,
        canonicalUrl: url,
        interaction: config.kind === "x-bookmarks" ? "bookmark" : "like",
        content: { kind: "post", text },
        backend: { name: "opencli", version },
        ...(typeof row.author === "string" && row.author.trim().length > 0
          ? { author: row.author.trim() }
          : {}),
      }));
    }
  }
  return results;
}

export async function probeInstagramSaved(
  config: InstagramProbeSourceConfig,
  dependencies: OpenCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<InstagramSavedProbeResult> {
  const executable = dependencies.executable ?? DEFAULT_DEPENDENCIES.executable!;
  const argsPrefix = dependencies.argsPrefix ?? DEFAULT_DEPENDENCIES.argsPrefix ?? [];
  try {
    records((await dependencies.run({
      executable,
      args: [...argsPrefix, "instagram", "saved", "--limit", String(config.limit), "-f", "json"],
      timeoutMs: 60_000,
      maxStdoutBytes: 2 * 1024 * 1024,
    })).stdout);
    return { supported: false, reachable: true, reason: "unstable-identity" };
  } catch (error) {
    if (error instanceof FixedCommandError && error.kind === "no-input") {
      return { supported: false, reachable: true, reason: "unstable-identity" };
    }
    throw error;
  }
}

export async function doctorOpenCli(
  dependencies: OpenCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<OpenCliDoctorResult> {
  const executable = dependencies.executable ?? DEFAULT_DEPENDENCIES.executable!;
  const argsPrefix = dependencies.argsPrefix ?? DEFAULT_DEPENDENCIES.argsPrefix ?? [];
  try {
    const result = await dependencies.run({
      executable,
      args: [...argsPrefix, "--version"],
      timeoutMs: 15_000,
      maxStdoutBytes: 64 * 1024,
    });
    return {
      installed: true,
      executable,
      version: result.stdout.trim(),
      browserBridge: "not_checked",
      reason:
        "Version check is non-invasive; login and Browser Bridge require a real read probe.",
    };
  } catch (error) {
    return {
      installed: !(error instanceof FixedCommandError && error.kind === "not-found"),
      executable,
      browserBridge: "not_checked",
      reason: error instanceof Error ? error.message : "OpenCLI check failed",
    };
  }
}
