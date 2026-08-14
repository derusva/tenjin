import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const REACH_CONFIG_SCHEMA = "tenjin.reach-config/v1" as const;

interface SourceBase {
  readonly id: string;
  readonly accountScope: string;
  readonly enabled: boolean;
  readonly limit: number;
}

export interface FixtureSourceConfig extends SourceBase {
  readonly kind: "fixture";
  readonly path: string;
}

export interface NoteRssSourceConfig extends SourceBase {
  readonly kind: "note-rss";
  readonly feedUrl: string;
  readonly fetchFullText: boolean;
}

export interface OpenCliSourceConfig extends SourceBase {
  readonly kind:
    | "youtube-history"
    | "youtube-watch-later"
    | "x-bookmarks"
    | "x-likes";
  readonly transcriptLanguage?: string;
}

export interface InstagramProbeSourceConfig extends SourceBase {
  readonly kind: "instagram-saved-probe";
}

export type ReachSourceConfig =
  | FixtureSourceConfig
  | NoteRssSourceConfig
  | OpenCliSourceConfig
  | InstagramProbeSourceConfig;

export interface ReachConfig {
  readonly schema: typeof REACH_CONFIG_SCHEMA;
  readonly dataDir?: string;
  readonly sources: readonly ReachSourceConfig[];
}

export class ReachConfigError extends Error {
  readonly code:
    | "CONFIG_NOT_OBJECT"
    | "CONFIG_UNKNOWN_KEY"
    | "CONFIG_MISSING_KEY"
    | "CONFIG_UNSUPPORTED_SCHEMA"
    | "CONFIG_INVALID_SOURCES"
    | "CONFIG_INVALID_SOURCE"
    | "CONFIG_DUPLICATE_SOURCE";

  constructor(code: ReachConfigError["code"], message: string) {
    super(message);
    this.name = "ReachConfigError";
    this.code = code;
  }
}

const TOP_LEVEL_KEYS = new Set(["schema", "dataDir", "sources"]);
const SOURCE_BASE_KEYS = new Set([
  "id",
  "kind",
  "accountScope",
  "enabled",
  "limit",
]);
const SOURCE_KEYS: Readonly<Record<ReachSourceConfig["kind"], ReadonlySet<string>>> = {
  fixture: new Set([...SOURCE_BASE_KEYS, "path"]),
  "note-rss": new Set([...SOURCE_BASE_KEYS, "feedUrl", "fetchFullText"]),
  "youtube-history": new Set([...SOURCE_BASE_KEYS, "transcriptLanguage"]),
  "youtube-watch-later": new Set([...SOURCE_BASE_KEYS, "transcriptLanguage"]),
  "x-bookmarks": SOURCE_BASE_KEYS,
  "x-likes": SOURCE_BASE_KEYS,
  "instagram-saved-probe": SOURCE_BASE_KEYS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context}.${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
  fallback: boolean,
  context: string,
): boolean {
  const value = record[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context}.${field} must be boolean`,
    );
  }
  return value;
}

function optionalLimit(
  record: Record<string, unknown>,
  context: string,
): number {
  const value = record.limit;
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context}.limit must be an integer between 1 and 200`,
    );
  }
  return value as number;
}

function assertHttpsUrl(value: string, context: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context} must be a valid URL`,
    );
  }
  if (url.protocol !== "https:") {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context} must use https`,
    );
  }
  return url.toString();
}

function parseSource(
  value: unknown,
  index: number,
  configDir: string,
): ReachSourceConfig {
  const context = `sources[${index}]`;
  if (!isRecord(value)) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context} must be an object`,
    );
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(kind in SOURCE_KEYS)) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context}.kind is unsupported`,
    );
  }
  const typedKind = kind as ReachSourceConfig["kind"];
  const unknownKey = Object.keys(value).find(
    (key) => !SOURCE_KEYS[typedKind].has(key),
  );
  if (unknownKey !== undefined) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCE",
      `${context} contains unknown key: ${unknownKey}`,
    );
  }

  const common = {
    id: requiredString(value, "id", context),
    accountScope: requiredString(value, "accountScope", context),
    enabled: optionalBoolean(value, "enabled", true, context),
    limit: optionalLimit(value, context),
  };

  switch (typedKind) {
    case "fixture": {
      const path = requiredString(value, "path", context);
      return {
        ...common,
        kind: typedKind,
        path: isAbsolute(path) ? path : resolve(configDir, path),
      };
    }
    case "note-rss":
      return {
        ...common,
        kind: typedKind,
        feedUrl: assertHttpsUrl(
          requiredString(value, "feedUrl", context),
          `${context}.feedUrl`,
        ),
        fetchFullText: optionalBoolean(
          value,
          "fetchFullText",
          true,
          context,
        ),
      };
    case "youtube-history":
    case "youtube-watch-later": {
      const transcriptLanguage = value.transcriptLanguage;
      if (
        transcriptLanguage !== undefined &&
        (typeof transcriptLanguage !== "string" ||
          transcriptLanguage.trim().length === 0)
      ) {
        throw new ReachConfigError(
          "CONFIG_INVALID_SOURCE",
          `${context}.transcriptLanguage must be a non-empty string`,
        );
      }
      return {
        ...common,
        kind: typedKind,
        ...(typeof transcriptLanguage === "string"
          ? { transcriptLanguage: transcriptLanguage.trim() }
          : {}),
      };
    }
    case "x-bookmarks":
    case "x-likes":
    case "instagram-saved-probe":
      return { ...common, kind: typedKind };
  }
}

export function parseReachConfig(
  value: unknown,
  configDir = process.cwd(),
): ReachConfig {
  if (!isRecord(value)) {
    throw new ReachConfigError(
      "CONFIG_NOT_OBJECT",
      "Reach config must be an object",
    );
  }
  const unknownKey = Object.keys(value).find(
    (key) => !TOP_LEVEL_KEYS.has(key),
  );
  if (unknownKey !== undefined) {
    throw new ReachConfigError(
      "CONFIG_UNKNOWN_KEY",
      `Reach config contains unknown key: ${unknownKey}`,
    );
  }
  for (const required of ["schema", "sources"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new ReachConfigError(
        "CONFIG_MISSING_KEY",
        `Reach config is missing key: ${required}`,
      );
    }
  }
  if (value.schema !== REACH_CONFIG_SCHEMA) {
    throw new ReachConfigError(
      "CONFIG_UNSUPPORTED_SCHEMA",
      `Reach config schema must be ${REACH_CONFIG_SCHEMA}`,
    );
  }
  if (!Array.isArray(value.sources)) {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCES",
      "Reach config sources must be an array",
    );
  }
  const sources = value.sources.map((source, index) =>
    parseSource(source, index, configDir),
  );
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new ReachConfigError(
        "CONFIG_DUPLICATE_SOURCE",
        `Duplicate source id: ${source.id}`,
      );
    }
    ids.add(source.id);
  }
  if (value.dataDir !== undefined && typeof value.dataDir !== "string") {
    throw new ReachConfigError(
      "CONFIG_INVALID_SOURCES",
      "Reach config dataDir must be a string when provided",
    );
  }
  const dataDir =
    typeof value.dataDir === "string" && value.dataDir.trim().length > 0
      ? value.dataDir.trim()
      : undefined;
  return {
    schema: REACH_CONFIG_SCHEMA,
    ...(dataDir === undefined
      ? {}
      : { dataDir: isAbsolute(dataDir) ? dataDir : resolve(configDir, dataDir) }),
    sources,
  };
}

export async function loadReachConfig(path: string): Promise<ReachConfig> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReachConfigError(
      "CONFIG_NOT_OBJECT",
      `Unable to read Reach config: ${message}`,
    );
  }
  return parseReachConfig(parsed, resolve(absolutePath, ".."));
}
