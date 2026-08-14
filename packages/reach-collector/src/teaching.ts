import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalizeCoachTransfer,
  parseCoachTransfer,
  type CoachTransfer,
} from "@tenjin/exchange";

import { sha256Hex } from "./contracts/canonicalJson.js";
import {
  REACH_PLATFORMS,
  type RawSourceItemV1,
} from "./contracts/rawSourceItem.js";
import { classifyJapanese, sourceItemText } from "./pipeline/japaneseFilter.js";
import { segmentJapanese } from "./pipeline/segmentJapanese.js";

export const REACH_TEACHING_REQUEST_SCHEMA =
  "tenjin.reach-teaching-request/v1" as const;
export const REACH_GENERATION_RESULT_SCHEMA =
  "tenjin.reach-generation-result/v1" as const;

export interface TeachingExcerptV1 {
  readonly excerptId: `sha256:${string}`;
  readonly revisionKey: `sha256:${string}`;
  readonly sourceId: string;
  readonly platform: RawSourceItemV1["platform"];
  readonly canonicalUrl: string;
  readonly text: string;
}

export interface ReachTeachingRequestV1 {
  readonly schema: typeof REACH_TEACHING_REQUEST_SCHEMA;
  readonly promptVersion: "tenjin-coach-social-v1";
  readonly excerpts: readonly TeachingExcerptV1[];
}

export interface ReachGenerationItemV1 {
  readonly excerptId: `sha256:${string}`;
  readonly type: "lookup";
  readonly focus: string;
  readonly answer: string;
}

export interface ReachGenerationResultV1 {
  readonly schema: typeof REACH_GENERATION_RESULT_SCHEMA;
  readonly items: readonly ReachGenerationItemV1[];
}

export interface ExportedCoachTransferV1 {
  readonly transfer: CoachTransfer;
  readonly sourceSidecar: {
    readonly schema: "tenjin.reach-transfer-sources/v1";
    readonly sources: readonly TeachingExcerptV1[];
  };
}

export class TeachingContractError extends Error {
  readonly code:
    | "TEACHING_REQUEST_INVALID"
    | "GENERATION_INVALID"
    | "GENERATION_UNKNOWN_EXCERPT"
    | "GENERATION_TOO_MANY_ITEMS";

  constructor(code: TeachingContractError["code"], message: string) {
    super(message);
    this.name = "TeachingContractError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const reachPlatformSet = new Set<unknown>(REACH_PLATFORMS);

function invalidTeachingRequest(message: string): never {
  throw new TeachingContractError("TEACHING_REQUEST_INVALID", message);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseTeachingRequest(value: unknown): ReachTeachingRequestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema", "promptVersion", "excerpts"]) ||
    value.schema !== REACH_TEACHING_REQUEST_SCHEMA ||
    value.promptVersion !== "tenjin-coach-social-v1" ||
    !Array.isArray(value.excerpts)
  ) {
    return invalidTeachingRequest(
      "Teaching request must match tenjin.reach-teaching-request/v1",
    );
  }

  const seenExcerptIds = new Set<string>();
  const excerpts = value.excerpts.map((excerpt, index): TeachingExcerptV1 => {
    if (
      !isRecord(excerpt) ||
      !exactKeys(excerpt, [
        "excerptId",
        "revisionKey",
        "sourceId",
        "platform",
        "canonicalUrl",
        "text",
      ]) ||
      typeof excerpt.excerptId !== "string" ||
      !SHA256_PATTERN.test(excerpt.excerptId) ||
      typeof excerpt.revisionKey !== "string" ||
      !SHA256_PATTERN.test(excerpt.revisionKey) ||
      typeof excerpt.sourceId !== "string" ||
      excerpt.sourceId.trim().length === 0 ||
      !reachPlatformSet.has(excerpt.platform) ||
      typeof excerpt.canonicalUrl !== "string" ||
      !isHttpUrl(excerpt.canonicalUrl) ||
      typeof excerpt.text !== "string" ||
      excerpt.text.trim().length === 0
    ) {
      return invalidTeachingRequest(`Teaching excerpt ${index + 1} is invalid`);
    }
    if (seenExcerptIds.has(excerpt.excerptId)) {
      return invalidTeachingRequest(
        `Teaching excerpt ${index + 1} repeats excerptId ${excerpt.excerptId}`,
      );
    }
    seenExcerptIds.add(excerpt.excerptId);
    return {
      excerptId: excerpt.excerptId as `sha256:${string}`,
      revisionKey: excerpt.revisionKey as `sha256:${string}`,
      sourceId: excerpt.sourceId,
      platform: excerpt.platform as RawSourceItemV1["platform"],
      canonicalUrl: excerpt.canonicalUrl,
      text: excerpt.text,
    };
  });

  return {
    schema: REACH_TEACHING_REQUEST_SCHEMA,
    promptVersion: "tenjin-coach-social-v1",
    excerpts,
  };
}

function sourceSentences(item: RawSourceItemV1): readonly string[] {
  if (item.content.kind === "video" && item.content.transcript !== undefined) {
    return segmentJapanese(
      item.content.transcript.map((cue) => cue.text).join(""),
      { minimumCharacters: 8, maximumCharacters: 240 },
    );
  }
  return segmentJapanese(sourceItemText(item), {
    minimumCharacters: 8,
    maximumCharacters: 240,
  });
}

export function buildTeachingRequest(
  items: readonly RawSourceItemV1[],
  limit = 12,
): ReachTeachingRequestV1 {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Teaching request limit must be between 1 and 100");
  }
  const excerpts: TeachingExcerptV1[] = [];
  for (const item of items) {
    for (const text of sourceSentences(item)) {
      if (classifyJapanese(text).decision !== "eligible") {
        continue;
      }
      const excerptId = sha256Hex(`${item.revisionKey}\n${text}`);
      excerpts.push({
        excerptId,
        revisionKey: item.revisionKey,
        sourceId: item.sourceId,
        platform: item.platform,
        canonicalUrl: item.canonicalUrl,
        text,
      });
      if (excerpts.length >= limit) {
        return {
          schema: REACH_TEACHING_REQUEST_SCHEMA,
          promptVersion: "tenjin-coach-social-v1",
          excerpts,
        };
      }
    }
  }
  return {
    schema: REACH_TEACHING_REQUEST_SCHEMA,
    promptVersion: "tenjin-coach-social-v1",
    excerpts,
  };
}

export function parseGenerationResult(value: unknown): ReachGenerationResultV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema", "items"]) ||
    value.schema !== REACH_GENERATION_RESULT_SCHEMA ||
    !Array.isArray(value.items)
  ) {
    throw new TeachingContractError(
      "GENERATION_INVALID",
      "Generation result must match tenjin.reach-generation-result/v1",
    );
  }
  if (value.items.length > 3) {
    throw new TeachingContractError(
      "GENERATION_TOO_MANY_ITEMS",
      "Generation result may contain at most 3 items",
    );
  }
  const items = value.items.map((item, index): ReachGenerationItemV1 => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["excerptId", "type", "focus", "answer"]) ||
      typeof item.excerptId !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(item.excerptId) ||
      item.type !== "lookup" ||
      typeof item.focus !== "string" ||
      item.focus.trim().length === 0 ||
      typeof item.answer !== "string" ||
      item.answer.trim().length === 0
    ) {
      throw new TeachingContractError(
        "GENERATION_INVALID",
        `Generation item ${index + 1} is invalid`,
      );
    }
    return {
      excerptId: item.excerptId as `sha256:${string}`,
      type: "lookup",
      focus: item.focus.trim(),
      answer: item.answer.trim(),
    };
  });
  return { schema: REACH_GENERATION_RESULT_SCHEMA, items };
}

export function compileCoachTransfer(
  requestInput: unknown,
  resultInput: unknown,
): ExportedCoachTransferV1 {
  const request = parseTeachingRequest(requestInput);
  const result = parseGenerationResult(resultInput);
  const byId = new Map(request.excerpts.map((excerpt) => [excerpt.excerptId, excerpt]));
  const used = new Set<string>();
  const sources: TeachingExcerptV1[] = [];
  const items = result.items.map((item) => {
    const excerpt = byId.get(item.excerptId);
    if (excerpt === undefined || used.has(item.excerptId)) {
      throw new TeachingContractError(
        "GENERATION_UNKNOWN_EXCERPT",
        `Unknown or duplicate excerptId: ${item.excerptId}`,
      );
    }
    used.add(item.excerptId);
    sources.push(excerpt);
    return {
      type: "lookup" as const,
      focus: item.focus,
      sourceExcerpt: excerpt.text,
      answer: item.answer,
    };
  });
  const transfer = parseCoachTransfer(
    JSON.stringify({ schema: "tenjin.coach-transfer/v1", items }),
  );
  return {
    transfer,
    sourceSidecar: {
      schema: "tenjin.reach-transfer-sources/v1",
      sources,
    },
  };
}

export async function loadTeachingRequest(
  dataDir: string,
  path?: string,
): Promise<ReachTeachingRequestV1> {
  const serialized = await readFile(
    path ?? join(dataDir, "teaching-request.json"),
    "utf8",
  );
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    return invalidTeachingRequest("Teaching request must be valid JSON");
  }
  return parseTeachingRequest(input);
}

export function serializeCoachTransfer(transfer: CoachTransfer): string {
  return `${canonicalizeCoachTransfer(transfer)}\n`;
}
