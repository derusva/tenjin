import {
  canonicalJson,
  sha256Hex,
  type Sha256Digest,
} from "./canonicalJson.js";

export const RAW_SOURCE_ITEM_SCHEMA = "tenjin.reach-source-item/v1" as const;

export const REACH_PLATFORMS = [
  "fixture",
  "note",
  "youtube",
  "x",
  "instagram",
] as const;
export type ReachPlatform = (typeof REACH_PLATFORMS)[number];

export const REACH_INTERACTIONS = [
  "rss_magazine",
  "playlist_item",
  "bookmark",
  "like",
  "saved",
  "history",
  "watch_later",
] as const;
export type ReachInteraction = (typeof REACH_INTERACTIONS)[number];

export const REACH_BACKENDS = [
  "fixture",
  "rss-http",
  "yt-dlp",
  "opencli",
  "twitter-cli",
] as const;
export type ReachBackendName = (typeof REACH_BACKENDS)[number];

export interface ReachBackendV1 {
  readonly name: ReachBackendName;
  readonly version?: string;
}

interface TextSourceContentV1 {
  readonly title?: string;
  readonly text: string;
}

export interface ArticleSourceContentV1 extends TextSourceContentV1 {
  readonly kind: "article";
}

export interface PostSourceContentV1 extends TextSourceContentV1 {
  readonly kind: "post";
}

export interface VideoTranscriptCueV1 {
  readonly startMs: number;
  readonly endMs?: number;
  readonly text: string;
}

export interface VideoSourceContentV1 {
  readonly kind: "video";
  readonly title?: string;
  readonly description?: string;
  readonly transcript?: readonly VideoTranscriptCueV1[];
}

export type RawSourceContentV1 =
  | ArticleSourceContentV1
  | PostSourceContentV1
  | VideoSourceContentV1;

export interface RawSourceItemV1 {
  readonly schema: typeof RAW_SOURCE_ITEM_SCHEMA;
  readonly itemKey: Sha256Digest;
  readonly revisionKey: Sha256Digest;
  readonly sourceId: string;
  readonly accountScope: string;
  readonly platform: ReachPlatform;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly interaction: ReachInteraction;
  readonly content: RawSourceContentV1;
  readonly backend: ReachBackendV1;
  readonly contentHash: Sha256Digest;
  readonly publishedAt?: string;
  readonly author?: string;
}

export type NewRawSourceItemV1 = Omit<
  RawSourceItemV1,
  "schema" | "itemKey" | "revisionKey" | "contentHash"
>;

export interface SourceIdentityV1 {
  readonly sourceId: string;
  readonly accountScope: string;
  readonly platform: ReachPlatform;
  readonly externalId: string;
  readonly interaction: ReachInteraction;
}

export interface SourceItemKeysV1 {
  readonly itemKey: Sha256Digest;
  readonly revisionKey: Sha256Digest;
  readonly contentHash: Sha256Digest;
}

export type ReachContractErrorCode =
  | "REACH_CONTRACT_INVALID"
  | "REACH_CONTRACT_INTEGRITY";

export class ReachContractError extends Error {
  readonly code: ReachContractErrorCode;
  readonly field: string;

  constructor(code: ReachContractErrorCode, field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ReachContractError";
    this.code = code;
    this.field = field;
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTRACT_BYTES = 1_048_576;
const MAX_TITLE_CHARS = 1_000;
const MAX_BODY_CHARS = 500_000;
const MAX_AUTHOR_CHARS = 500;
const MAX_EXTERNAL_ID_CHARS = 2_000;
const MAX_TRANSCRIPT_CUES = 20_000;

const platformSet = new Set<unknown>(REACH_PLATFORMS);
const interactionSet = new Set<unknown>(REACH_INTERACTIONS);
const backendSet = new Set<unknown>(REACH_BACKENDS);

const PLATFORM_INTERACTIONS: Readonly<
  Record<ReachPlatform, ReadonlySet<ReachInteraction>>
> = {
  fixture: new Set(REACH_INTERACTIONS),
  note: new Set(["rss_magazine", "bookmark", "like"]),
  youtube: new Set(["playlist_item", "like", "history", "watch_later"]),
  x: new Set(["bookmark", "like"]),
  instagram: new Set(["saved", "like"]),
};

const PLATFORM_BACKENDS: Readonly<
  Record<ReachPlatform, ReadonlySet<ReachBackendName>>
> = {
  fixture: new Set(["fixture"]),
  note: new Set(["rss-http", "opencli"]),
  youtube: new Set(["yt-dlp", "opencli"]),
  x: new Set(["opencli", "twitter-cli"]),
  instagram: new Set(["opencli"]),
};

function invalid(field: string, message: string): never {
  throw new ReachContractError("REACH_CONTRACT_INVALID", field, message);
}

function integrity(field: string, message: string): never {
  throw new ReachContractError("REACH_CONTRACT_INTEGRITY", field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(field === "$" ? key : `${field}.${key}`, "field is not allowed");
    }
  }
}

function normalizeText(
  value: unknown,
  field: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    invalid(field, "must be a string");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    invalid(field, "must be non-empty");
  }
  if ([...normalized].length > maximumCharacters) {
    invalid(field, `must not exceed ${maximumCharacters} characters`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maximumCharacters: number,
): string | undefined {
  return value === undefined
    ? undefined
    : normalizeText(value, field, maximumCharacters);
}

function normalizeTimestamp(value: unknown, field: string): string {
  const normalized = normalizeText(value, field, 64);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    invalid(field, "must be a canonical ISO-8601 UTC timestamp");
  }
  return normalized;
}

function normalizeUrl(value: unknown): string {
  const normalized = normalizeText(value, "canonicalUrl", 8_192);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return invalid("canonicalUrl", "must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    invalid("canonicalUrl", "must use http or https");
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeBackend(value: unknown): ReachBackendV1 {
  if (!isRecord(value)) {
    invalid("backend", "must be an object");
  }
  assertExactFields(value, new Set(["name", "version"]), "backend");
  if (!backendSet.has(value.name)) {
    invalid("backend.name", "is not supported");
  }
  const version = normalizeOptionalText(value.version, "backend.version", 200);
  return version === undefined
    ? { name: value.name as ReachBackendName }
    : { name: value.name as ReachBackendName, version };
}

function normalizeCue(value: unknown, index: number): VideoTranscriptCueV1 {
  const field = `content.transcript[${index}]`;
  if (!isRecord(value)) {
    invalid(field, "must be an object");
  }
  assertExactFields(value, new Set(["startMs", "endMs", "text"]), field);
  if (!Number.isSafeInteger(value.startMs) || (value.startMs as number) < 0) {
    invalid(`${field}.startMs`, "must be a non-negative safe integer");
  }
  if (
    value.endMs !== undefined &&
    (!Number.isSafeInteger(value.endMs) ||
      (value.endMs as number) <= (value.startMs as number))
  ) {
    invalid(`${field}.endMs`, "must be a safe integer greater than startMs");
  }
  const text = normalizeText(value.text, `${field}.text`, 10_000);
  return value.endMs === undefined
    ? { startMs: value.startMs as number, text }
    : {
        startMs: value.startMs as number,
        endMs: value.endMs as number,
        text,
      };
}

function normalizeContent(value: unknown): RawSourceContentV1 {
  if (!isRecord(value)) {
    invalid("content", "must be an object");
  }

  if (value.kind === "article" || value.kind === "post") {
    assertExactFields(value, new Set(["kind", "title", "text"]), "content");
    const title = normalizeOptionalText(value.title, "content.title", MAX_TITLE_CHARS);
    const text = normalizeText(value.text, "content.text", MAX_BODY_CHARS);
    return title === undefined
      ? { kind: value.kind, text }
      : { kind: value.kind, title, text };
  }

  if (value.kind === "video") {
    assertExactFields(
      value,
      new Set(["kind", "title", "description", "transcript"]),
      "content",
    );
    const title = normalizeOptionalText(value.title, "content.title", MAX_TITLE_CHARS);
    const description = normalizeOptionalText(
      value.description,
      "content.description",
      MAX_BODY_CHARS,
    );
    let transcript: readonly VideoTranscriptCueV1[] | undefined;
    if (value.transcript !== undefined) {
      if (!Array.isArray(value.transcript) || value.transcript.length === 0) {
        invalid("content.transcript", "must be a non-empty array when present");
      }
      if (value.transcript.length > MAX_TRANSCRIPT_CUES) {
        invalid(
          "content.transcript",
          `must not exceed ${MAX_TRANSCRIPT_CUES} cues`,
        );
      }
      transcript = value.transcript.map(normalizeCue);
      for (let index = 1; index < transcript.length; index += 1) {
        if (transcript[index]!.startMs < transcript[index - 1]!.startMs) {
          invalid("content.transcript", "cues must be ordered by startMs");
        }
      }
    }
    if (title === undefined && description === undefined && transcript === undefined) {
      invalid("content", "video content must include title, description, or transcript");
    }
    return {
      kind: "video",
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(transcript === undefined ? {} : { transcript }),
    };
  }

  return invalid("content.kind", "must be article, post, or video");
}

function normalizeIdentity(value: {
  readonly sourceId?: unknown;
  readonly accountScope?: unknown;
  readonly platform?: unknown;
  readonly externalId?: unknown;
  readonly interaction?: unknown;
}): SourceIdentityV1 {
  const sourceId = normalizeText(value.sourceId, "sourceId", 128);
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    invalid("sourceId", "must be a stable ASCII identifier");
  }
  const accountScope = normalizeText(value.accountScope, "accountScope", 500);
  const externalId = normalizeText(
    value.externalId,
    "externalId",
    MAX_EXTERNAL_ID_CHARS,
  );
  if (!platformSet.has(value.platform)) {
    invalid("platform", "is not supported");
  }
  if (!interactionSet.has(value.interaction)) {
    invalid("interaction", "is not supported");
  }
  const platform = value.platform as ReachPlatform;
  const interaction = value.interaction as ReachInteraction;
  if (!PLATFORM_INTERACTIONS[platform].has(interaction)) {
    invalid("interaction", `is not supported for ${platform}`);
  }
  return { sourceId, accountScope, platform, externalId, interaction };
}

export function computeItemKeys(
  identityInput: SourceIdentityV1,
  contentInput: RawSourceContentV1,
): SourceItemKeysV1 {
  const identity = normalizeIdentity(identityInput);
  const content = normalizeContent(contentInput);
  const stableIdentity = {
    accountScope: identity.accountScope,
    platform: identity.platform,
    externalId: identity.externalId,
    interaction: identity.interaction,
  };
  const itemKey = sha256Hex(canonicalJson(stableIdentity));
  const contentHash = sha256Hex(canonicalJson(content));
  const revisionKey = sha256Hex(canonicalJson({ itemKey, contentHash }));
  return { itemKey, revisionKey, contentHash };
}

function normalizeNewItem(value: unknown): NewRawSourceItemV1 {
  if (!isRecord(value)) {
    invalid("$", "must be an object");
  }
  const identity = normalizeIdentity(value);
  const canonicalUrl = normalizeUrl(value.canonicalUrl);
  const content = normalizeContent(value.content);
  const backend = normalizeBackend(value.backend);
  if (!PLATFORM_BACKENDS[identity.platform].has(backend.name)) {
    invalid("backend.name", `is not supported for ${identity.platform}`);
  }
  if (identity.platform === "youtube" && content.kind !== "video") {
    invalid("content.kind", "youtube items must use video content");
  }
  if (
    (identity.platform === "note" ||
      identity.platform === "x" ||
      identity.platform === "instagram") &&
    content.kind === "video"
  ) {
    invalid("content.kind", `${identity.platform} V0 items must use article or post content`);
  }
  const publishedAt =
    value.publishedAt === undefined
      ? undefined
      : normalizeTimestamp(value.publishedAt, "publishedAt");
  const author = normalizeOptionalText(value.author, "author", MAX_AUTHOR_CHARS);
  return {
    ...identity,
    canonicalUrl,
    content,
    backend,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(author === undefined ? {} : { author }),
  };
}

export function createRawSourceItem(input: NewRawSourceItemV1): RawSourceItemV1 {
  const normalized = normalizeNewItem(input);
  const keys = computeItemKeys(normalized, normalized.content);
  const item: RawSourceItemV1 = {
    schema: RAW_SOURCE_ITEM_SCHEMA,
    ...keys,
    ...normalized,
  };
  if (Buffer.byteLength(canonicalJson(item), "utf8") > MAX_CONTRACT_BYTES) {
    invalid("$", `must not exceed ${MAX_CONTRACT_BYTES} UTF-8 bytes`);
  }
  return item;
}

export function parseRawSourceItem(value: unknown): RawSourceItemV1 {
  if (!isRecord(value)) {
    invalid("$", "must be an object");
  }
  assertExactFields(
    value,
    new Set([
      "schema",
      "itemKey",
      "revisionKey",
      "sourceId",
      "accountScope",
      "platform",
      "externalId",
      "canonicalUrl",
      "interaction",
      "content",
      "backend",
      "contentHash",
      "publishedAt",
      "author",
    ]),
    "$",
  );
  if (value.schema !== RAW_SOURCE_ITEM_SCHEMA) {
    invalid("schema", `must be ${RAW_SOURCE_ITEM_SCHEMA}`);
  }
  for (const field of ["itemKey", "revisionKey", "contentHash"] as const) {
    if (typeof value[field] !== "string" || !SHA256_PATTERN.test(value[field])) {
      invalid(field, "must be sha256: followed by 64 lowercase hex characters");
    }
  }

  const normalized = normalizeNewItem(value);
  const expected = computeItemKeys(normalized, normalized.content);
  for (const field of ["itemKey", "revisionKey", "contentHash"] as const) {
    if (value[field] !== expected[field]) {
      integrity(field, "does not match the canonical source identity and content");
    }
  }
  return {
    schema: RAW_SOURCE_ITEM_SCHEMA,
    ...expected,
    ...normalized,
  };
}
