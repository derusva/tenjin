#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  collectFixtureSource,
  collectNoteRssSource,
  collectOpenCliSource,
  doctorAgentReach,
  doctorOpenCli,
  probeInstagramSaved,
} from "./adapters/index.js";
import {
  loadReachConfig,
  type ReachConfig,
  type ReachSourceConfig,
} from "./config.js";
import { canonicalJson } from "./contracts/canonicalJson.js";
import {
  hasSeenRevision,
  recordSeenRevision,
  type CollectorStateV1,
} from "./contracts/collectorState.js";
import {
  parseRawSourceItem,
  type RawSourceItemV1,
} from "./contracts/rawSourceItem.js";
import {
  runCollection,
  type CollectionRunResult,
  type SourceCollectionResult,
} from "./pipeline/collect.js";
import {
  defaultReachDataDir,
  FileStateStore,
  readJsonFile,
  writeJsonAtomic,
} from "./state/fileStore.js";
import {
  buildTeachingRequest,
  compileCoachTransfer,
  loadTeachingRequest,
} from "./teaching.js";

const HELP = `Tenjin Reach Collector

Usage:
  tenjin-reach [--json] doctor --config <path>
  tenjin-reach [--json] collect --config <path> [--source <id>] [--dry-run]
  tenjin-reach [--json] teaching prepare --config <path> [--source <id>] [--limit <1-100>] [--out <path>]
  tenjin-reach [--json] teaching compile --request <path> --result <path> [--out <path>] [--sources-out <path>]
  tenjin-reach [--json] state show --config <path>
  tenjin-reach [--json] --help

Notes:
  --source may be repeated. JSON errors are always written to stderr.
`;

type WriteText = (text: string) => void;

export interface ReachCliRuntime {
  readonly collectSource?: (
    source: ReachSourceConfig,
  ) => Promise<SourceCollectionResult>;
  readonly doctor?: () => Promise<unknown>;
  readonly now?: () => Date;
}

export interface ReachCliOptions {
  readonly cwd?: string;
  readonly stdout?: WriteText;
  readonly stderr?: WriteText;
  readonly runtime?: ReachCliRuntime;
}

type OptionKind = "flag" | "value" | "multi";

interface ParsedOptions {
  readonly help: boolean;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly multi: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

interface CommandContext {
  readonly cwd: string;
  readonly json: boolean;
  readonly writeStdout: WriteText;
  readonly collectSource: (
    source: ReachSourceConfig,
  ) => Promise<SourceCollectionResult>;
  readonly doctor: () => Promise<unknown>;
  readonly now: () => Date;
}

class ReachCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReachCliError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ReachCliError(code, message);
}

function parseOptions(
  args: readonly string[],
  specification: Readonly<Record<string, OptionKind>>,
): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const positionals: string[] = [];
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    const kind = specification[name];
    if (kind === undefined) {
      fail("REACH_CLI_UNKNOWN_OPTION", `Unknown option: ${name}`);
    }
    if (kind === "flag") {
      if (inlineValue !== undefined) {
        fail("REACH_CLI_INVALID_OPTION", `${name} does not take a value`);
      }
      if (flags.has(name)) {
        fail("REACH_CLI_DUPLICATE_OPTION", `Option may appear once: ${name}`);
      }
      flags.add(name);
      continue;
    }

    const value =
      inlineValue ??
      (() => {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
          fail("REACH_CLI_MISSING_VALUE", `Option requires a value: ${name}`);
        }
        index += 1;
        return next;
      })();
    if (value.trim().length === 0) {
      fail("REACH_CLI_MISSING_VALUE", `Option requires a value: ${name}`);
    }
    if (kind === "value") {
      if (values.has(name)) {
        fail("REACH_CLI_DUPLICATE_OPTION", `Option may appear once: ${name}`);
      }
      values.set(name, value);
    } else {
      const existing = multi.get(name) ?? [];
      existing.push(value);
      multi.set(name, existing);
    }
  }

  return { help, flags, values, multi, positionals };
}

function requiredOption(options: ParsedOptions, name: string): string {
  const value = options.values.get(name);
  if (value === undefined) {
    fail("REACH_CLI_MISSING_OPTION", `Required option is missing: ${name}`);
  }
  return value;
}

function resolveFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function outputJson(write: WriteText, value: unknown): void {
  write(`${canonicalJson(value)}\n`);
}

function outputSuccess(
  context: CommandContext,
  value: Readonly<Record<string, unknown>>,
  human: string,
): void {
  if (context.json) {
    outputJson(context.writeStdout, { ok: true, ...value });
  } else {
    context.writeStdout(`${human}\n`);
  }
}

function dataDirFor(config: ReachConfig): string {
  return resolve(config.dataDir ?? defaultReachDataDir());
}

function sourceSelection(
  config: ReachConfig,
  requested: readonly string[],
  options: { readonly requireEnabled: boolean },
): ReadonlySet<string> | undefined {
  if (requested.length === 0) {
    return undefined;
  }
  const selected = new Set<string>();
  for (const sourceId of requested) {
    const source = config.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      fail("REACH_SOURCE_NOT_FOUND", `Configured source was not found: ${sourceId}`);
    }
    if (options.requireEnabled && !source.enabled) {
      fail("REACH_SOURCE_DISABLED", `Configured source is disabled: ${sourceId}`);
    }
    selected.add(sourceId);
  }
  return selected;
}

async function defaultCollectSource(
  source: ReachSourceConfig,
): Promise<SourceCollectionResult> {
  switch (source.kind) {
    case "fixture": {
      const items = await collectFixtureSource(source);
      return { sourceId: source.id, status: "collected", items };
    }
    case "note-rss": {
      const items = await collectNoteRssSource(source);
      return { sourceId: source.id, status: "collected", items };
    }
    case "youtube-history":
    case "youtube-watch-later":
    case "x-bookmarks":
    case "x-likes":
    {
      const items = await collectOpenCliSource(source);
      return { sourceId: source.id, status: "collected", items };
    }
    case "instagram-saved-probe": {
      const probe = await probeInstagramSaved(source);
      return {
        sourceId: source.id,
        status: "probe_only",
        items: [],
        message: probe.reachable
          ? "Instagram Saved is reachable but lacks stable identity fields."
          : "Instagram Saved probe is unavailable.",
      };
    }
  }
}

async function dryRunCollection(
  config: ReachConfig,
  state: CollectorStateV1,
  collectSource: (
    source: ReachSourceConfig,
  ) => Promise<SourceCollectionResult>,
  sourceIds: ReadonlySet<string> | undefined,
  now: Date,
): Promise<CollectionRunResult> {
  const sources: SourceCollectionResult[] = [];
  const newItems: RawSourceItemV1[] = [];
  let previewState = state;
  const seenAt = now.toISOString();

  for (const source of config.sources) {
    if (!source.enabled || (sourceIds !== undefined && !sourceIds.has(source.id))) {
      continue;
    }
    const result = await collectSource(source);
    sources.push(result);
    if (result.status === "probe_only") {
      continue;
    }
    for (const item of result.items) {
      if (!hasSeenRevision(previewState, item)) {
        newItems.push(item);
      }
      previewState = recordSeenRevision(previewState, item, seenAt);
    }
  }
  return { state: previewState, newItems, sources };
}

function collectionSummary(
  result: CollectionRunResult,
): readonly Readonly<Record<string, unknown>>[] {
  return result.sources.map((source) => ({
    sourceId: source.sourceId,
    status: source.status,
    itemCount: source.items.length,
    ...(source.message === undefined ? {} : { message: source.message }),
  }));
}

async function runDoctor(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const options = parseOptions(args, { "--config": "value" });
  if (options.help) {
    outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
    return;
  }
  if (options.positionals.length > 0) {
    fail("REACH_CLI_UNEXPECTED_ARGUMENT", "doctor does not take positional arguments");
  }
  const configPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--config"),
  );
  const config = await loadReachConfig(configPath);
  const dataDir = dataDirFor(config);
  const runtime = await context.doctor();
  outputSuccess(
    context,
    {
      command: "doctor",
      configPath,
      dataDir,
      configuredSources: config.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        enabled: source.enabled,
      })),
      runtime,
    },
    `Reach doctor completed for ${config.sources.length} configured source(s).`,
  );
}

async function runCollect(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const options = parseOptions(args, {
    "--config": "value",
    "--source": "multi",
    "--dry-run": "flag",
  });
  if (options.help) {
    outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
    return;
  }
  if (options.positionals.length > 0) {
    fail("REACH_CLI_UNEXPECTED_ARGUMENT", "collect does not take positional arguments");
  }
  const configPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--config"),
  );
  const config = await loadReachConfig(configPath);
  const dataDir = dataDirFor(config);
  const sourceIds = sourceSelection(config, options.multi.get("--source") ?? [], {
    requireEnabled: true,
  });
  const store = new FileStateStore({ dataDir });
  const dryRun = options.flags.has("--dry-run");
  let result: CollectionRunResult;

  if (dryRun) {
    result = await dryRunCollection(
      config,
      await store.load(),
      context.collectSource,
      sourceIds,
      context.now(),
    );
  } else {
    let completed: CollectionRunResult | undefined;
    await store.update(async (state) => {
      completed = await runCollection(
        config,
        dataDir,
        state,
        { collect: context.collectSource },
        sourceIds,
        context.now(),
      );
      return completed.state;
    });
    if (completed === undefined) {
      fail("REACH_COLLECTION_INCOMPLETE", "Collection did not produce a result");
    }
    result = completed;
  }

  const sources = collectionSummary(result);
  outputSuccess(
    context,
    {
      command: "collect",
      dryRun,
      dataDir,
      newItemCount: result.newItems.length,
      sources,
    },
    `${dryRun ? "Dry run found" : "Collected"} ${result.newItems.length} new item(s) from ${sources.length} source(s).`,
  );
}

function rawItemPath(
  dataDir: string,
  itemKey: string,
  contentHash: string,
): string {
  return join(
    dataDir,
    "raw",
    itemKey.slice("sha256:".length),
    `${contentHash.slice("sha256:".length)}.json`,
  );
}

async function loadCurrentRawItems(
  dataDir: string,
  state: CollectorStateV1,
  sourceIds: ReadonlySet<string> | undefined,
): Promise<readonly RawSourceItemV1[]> {
  const revisions = Object.entries(state.revisions)
    .filter(([, revision]) =>
      sourceIds === undefined
        ? true
        : revision.sourceIds.some((sourceId) => sourceIds.has(sourceId)),
    )
    .sort((left, right) => {
      const recency = right[1].lastSeenAt.localeCompare(left[1].lastSeenAt);
      return recency === 0 ? left[0].localeCompare(right[0]) : recency;
    });
  const items: RawSourceItemV1[] = [];
  for (const [itemKey, revision] of revisions) {
    const item = parseRawSourceItem(
      await readJsonFile(rawItemPath(dataDir, itemKey, revision.contentHash)),
    );
    if (
      item.itemKey !== itemKey ||
      item.revisionKey !== revision.revisionKey ||
      !revision.sourceIds.includes(item.sourceId)
    ) {
      fail(
        "REACH_STATE_RAW_MISMATCH",
        `Collector state does not match raw item: ${itemKey}`,
      );
    }
    items.push(item);
  }
  return items;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 12;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    fail("REACH_CLI_INVALID_LIMIT", "--limit must be an integer between 1 and 100");
  }
  return parsed;
}

async function runTeachingPrepare(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const options = parseOptions(args, {
    "--config": "value",
    "--source": "multi",
    "--limit": "value",
    "--out": "value",
  });
  if (options.help) {
    outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
    return;
  }
  if (options.positionals.length > 0) {
    fail(
      "REACH_CLI_UNEXPECTED_ARGUMENT",
      "teaching prepare does not take positional arguments",
    );
  }
  const configPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--config"),
  );
  const config = await loadReachConfig(configPath);
  const dataDir = dataDirFor(config);
  const sourceIds = sourceSelection(config, options.multi.get("--source") ?? [], {
    requireEnabled: false,
  });
  const store = new FileStateStore({ dataDir });
  const items = await loadCurrentRawItems(dataDir, await store.load(), sourceIds);
  const request = buildTeachingRequest(items, parseLimit(options.values.get("--limit")));
  const requestPath = resolveFrom(
    context.cwd,
    options.values.get("--out") ?? join(dataDir, "teaching-request.json"),
  );
  await writeJsonAtomic(requestPath, request);
  outputSuccess(
    context,
    {
      command: "teaching.prepare",
      requestPath,
      sourceItemCount: items.length,
      excerptCount: request.excerpts.length,
    },
    `Prepared ${request.excerpts.length} teaching excerpt(s) at ${requestPath}.`,
  );
}

async function runTeachingCompile(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const options = parseOptions(args, {
    "--request": "value",
    "--result": "value",
    "--out": "value",
    "--sources-out": "value",
  });
  if (options.help) {
    outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
    return;
  }
  if (options.positionals.length > 0) {
    fail(
      "REACH_CLI_UNEXPECTED_ARGUMENT",
      "teaching compile does not take positional arguments",
    );
  }
  const requestPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--request"),
  );
  const resultPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--result"),
  );
  const outputDirectory = dirname(requestPath);
  const transferPath = resolveFrom(
    context.cwd,
    options.values.get("--out") ?? join(outputDirectory, "coach-transfer.json"),
  );
  const sourcesPath = resolveFrom(
    context.cwd,
    options.values.get("--sources-out") ??
      join(outputDirectory, "coach-transfer.sources.json"),
  );
  if (transferPath === sourcesPath) {
    fail(
      "REACH_CLI_OUTPUT_COLLISION",
      "--out and --sources-out must resolve to different paths",
    );
  }
  const request = await loadTeachingRequest(outputDirectory, requestPath);
  const resultInput = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
  const compiled = compileCoachTransfer(request, resultInput);
  await writeJsonAtomic(transferPath, compiled.transfer);
  await writeJsonAtomic(sourcesPath, compiled.sourceSidecar);
  outputSuccess(
    context,
    {
      command: "teaching.compile",
      transferPath,
      sourcesPath,
      itemCount: compiled.transfer.items.length,
    },
    `Compiled ${compiled.transfer.items.length} Coach item(s) at ${transferPath}.`,
  );
}

async function runStateShow(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const options = parseOptions(args, { "--config": "value" });
  if (options.help) {
    outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
    return;
  }
  if (options.positionals.length > 0) {
    fail("REACH_CLI_UNEXPECTED_ARGUMENT", "state show does not take positional arguments");
  }
  const configPath = resolveFrom(
    context.cwd,
    requiredOption(options, "--config"),
  );
  const config = await loadReachConfig(configPath);
  const dataDir = dataDirFor(config);
  const state = await new FileStateStore({ dataDir }).load();
  outputSuccess(
    context,
    { command: "state.show", dataDir, state },
    `State has ${Object.keys(state.revisions).length} tracked item(s) across ${Object.keys(state.sources).length} source(s).`,
  );
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown; readonly message?: unknown })
      : undefined;
  const code =
    typeof candidate?.code === "string" && /^[A-Z][A-Z0-9_]+$/u.test(candidate.code)
      ? candidate.code
      : "REACH_INTERNAL_ERROR";
  const rawMessage =
    typeof candidate?.message === "string" && candidate.message.length > 0
      ? candidate.message
      : code === "REACH_INTERNAL_ERROR"
        ? "Reach collector failed unexpectedly."
        : "Reach collector failed.";
  const message = redactCredentials(rawMessage);
  return { code, message };
}

function redactCredentials(message: string): string {
  const structuredCredentialField =
    String.raw`(?:authorization|cookie|token|secret|password|api[-_ ]?key)`;
  const keyValueCredentialField =
    String.raw`(?:cookie|token|secret|password|api[-_ ]?key)`;
  const jsonStringValue = String.raw`"(?:\\.|[^"\\])*"`;
  const inspectedStringValue = String.raw`'(?:\\.|[^'\\])*'`;

  return message
    .replace(
      new RegExp(
        String.raw`("${structuredCredentialField}"[ \t]*:[ \t]*)${jsonStringValue}`,
        "giu",
      ),
      '$1"[REDACTED]"',
    )
    .replace(
      new RegExp(
        String.raw`('${structuredCredentialField}'[ \t]*:[ \t]*)${inspectedStringValue}`,
        "giu",
      ),
      "$1'[REDACTED]'",
    )
    .replace(
      /\b(authorization)([ \t]*:[ \t]*)(?:(bearer)([ \t]+))?[^\r\n]*/giu,
      "$1$2$3$4[REDACTED]",
    )
    .replace(
      /\b(cookie)([ \t]*:[ \t]*)[^\r\n]*/giu,
      "$1$2[REDACTED]",
    )
    .replace(
      new RegExp(
        String.raw`\b(${keyValueCredentialField})([ \t]*[:=][ \t]*)(?:${jsonStringValue}|${inspectedStringValue}|[^\s,;\]}]+)`,
        "giu",
      ),
      "$1$2[REDACTED]",
    );
}

export async function runReachCli(
  argv: readonly string[],
  options: ReachCliOptions = {},
): Promise<number> {
  const writeStdout = options.stdout ?? ((text) => process.stdout.write(text));
  const writeStderr = options.stderr ?? ((text) => process.stderr.write(text));
  const jsonCount = argv.filter((arg) => arg === "--json").length;
  const json = jsonCount > 0;
  try {
    if (jsonCount > 1) {
      fail("REACH_CLI_DUPLICATE_OPTION", "Option may appear once: --json");
    }
    const args = argv.filter((arg) => arg !== "--json");
    const context: CommandContext = {
      cwd: resolve(options.cwd ?? process.cwd()),
      json,
      writeStdout,
      collectSource: options.runtime?.collectSource ?? defaultCollectSource,
      doctor:
        options.runtime?.doctor ??
        (async () => ({
          agentReach: await doctorAgentReach(),
          openCli: await doctorOpenCli(),
        })),
      now: options.runtime?.now ?? (() => new Date()),
    };

    if (
      args.length === 0 ||
      args[0] === "help" ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      if (args.length > 1) {
        fail("REACH_CLI_UNEXPECTED_ARGUMENT", "help does not take arguments");
      }
      outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
      return 0;
    }

    const [command, ...commandArgs] = args;
    switch (command) {
      case "doctor":
        await runDoctor(context, commandArgs);
        break;
      case "collect":
        await runCollect(context, commandArgs);
        break;
      case "teaching": {
        const [subcommand, ...subcommandArgs] = commandArgs;
        if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
          outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
          break;
        }
        if (subcommand === "prepare") {
          await runTeachingPrepare(context, subcommandArgs);
          break;
        }
        if (subcommand === "compile") {
          await runTeachingCompile(context, subcommandArgs);
          break;
        }
        fail("REACH_CLI_UNKNOWN_COMMAND", `Unknown teaching command: ${subcommand}`);
        break;
      }
      case "state": {
        const [subcommand, ...subcommandArgs] = commandArgs;
        if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
          outputSuccess(context, { command: "help", text: HELP }, HELP.trimEnd());
          break;
        }
        if (subcommand === "show") {
          await runStateShow(context, subcommandArgs);
          break;
        }
        fail("REACH_CLI_UNKNOWN_COMMAND", `Unknown state command: ${subcommand}`);
        break;
      }
      default:
        fail("REACH_CLI_UNKNOWN_COMMAND", `Unknown command: ${command}`);
    }
    return 0;
  } catch (error) {
    outputJson(writeStderr, { ok: false, error: errorDetails(error) });
    return 1;
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(entryPath)
) {
  process.exitCode = await runReachCli(process.argv.slice(2));
}
