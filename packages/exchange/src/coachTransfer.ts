export const COACH_TRANSFER_SCHEMA = "tenjin.coach-transfer/v1" as const;
export const MAX_COACH_TRANSFER_BYTES = 64 * 1024;

export interface CoachTransferItem {
  readonly type: "lookup";
  readonly focus: string;
  readonly sourceExcerpt: string;
  readonly answer: string;
}

export interface CoachTransfer {
  readonly schema: typeof COACH_TRANSFER_SCHEMA;
  readonly items: readonly CoachTransferItem[];
}

export type CoachTransferErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "INVALID_ENVELOPE"
  | "INVALID_JSON"
  | "INVALID_TOP_LEVEL"
  | "UNKNOWN_TOP_LEVEL_KEY"
  | "MISSING_TOP_LEVEL_KEY"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_ITEMS"
  | "TOO_MANY_ITEMS"
  | "INVALID_ITEM"
  | "UNKNOWN_ITEM_KEY"
  | "MISSING_ITEM_KEY"
  | "UNSUPPORTED_ITEM_TYPE"
  | "INVALID_ITEM_FIELD_TYPE"
  | "EMPTY_ITEM_FIELD";

export class CoachTransferError extends Error {
  readonly code: CoachTransferErrorCode;

  constructor(code: CoachTransferErrorCode, message: string) {
    super(message);
    this.name = "CoachTransferError";
    this.code = code;
  }
}

export interface CoachTransferDigestDependencies {
  readonly sha256: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
}

const TOP_LEVEL_KEYS = new Set(["schema", "items"]);
const REQUIRED_TOP_LEVEL_KEYS = ["schema", "items"] as const;
const ITEM_KEYS = new Set([
  "type",
  "focus",
  "sourceExcerpt",
  "answer",
]);
const REQUIRED_ITEM_KEYS = [
  "type",
  "focus",
  "sourceExcerpt",
  "answer",
] as const;
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u;

type CoachTransferStringField =
  | "focus"
  | "sourceExcerpt"
  | "answer";

interface RuntimeTextEncoder {
  readonly encode: (text: string) => Uint8Array;
}

interface RuntimeTextEncoderConstructor {
  new (): RuntimeTextEncoder;
}

interface RuntimeCrypto {
  readonly subtle: {
    readonly digest: (
      algorithm: string,
      bytes: ArrayBuffer,
    ) => Promise<ArrayBuffer>;
  };
}

type CoachTransferRuntime = typeof globalThis & {
  readonly crypto?: RuntimeCrypto;
  readonly TextEncoder?: RuntimeTextEncoderConstructor;
};

const DEFAULT_DIGEST_DEPENDENCIES: CoachTransferDigestDependencies = {
  sha256: (bytes) => {
    const runtimeCrypto = (globalThis as CoachTransferRuntime).crypto;
    if (runtimeCrypto === undefined) {
      throw new TypeError("WebCrypto SHA-256 is unavailable in this runtime");
    }
    return runtimeCrypto.subtle.digest("SHA-256", bytes);
  },
};

function fail(code: CoachTransferErrorCode, message: string): never {
  throw new CoachTransferError(code, message);
}

function utf8Bytes(text: string): Uint8Array {
  const TextEncoderImplementation = (globalThis as CoachTransferRuntime)
    .TextEncoder;
  if (TextEncoderImplementation === undefined) {
    throw new TypeError("UTF-8 TextEncoder is unavailable in this runtime");
  }
  return new TextEncoderImplementation().encode(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function firstUnknownKey(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): string | undefined {
  return Object.keys(record).find((key) => !allowedKeys.has(key));
}

function firstMissingKey(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
): string | undefined {
  return requiredKeys.find((key) => !hasOwn(record, key));
}

function normalizeRequiredString(
  item: Record<string, unknown>,
  field: CoachTransferStringField,
  itemIndex: number,
): string {
  const value = item[field];
  if (typeof value !== "string") {
    fail(
      "INVALID_ITEM_FIELD_TYPE",
      `第 ${itemIndex + 1} 条的 ${field} 必须是字符串`,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(
      "EMPTY_ITEM_FIELD",
      `第 ${itemIndex + 1} 条的 ${field} 不能为空`,
    );
  }
  return normalized;
}

function parseItem(value: unknown, itemIndex: number): CoachTransferItem {
  if (!isRecord(value)) {
    fail("INVALID_ITEM", `第 ${itemIndex + 1} 条必须是对象`);
  }

  const unknownKey = firstUnknownKey(value, ITEM_KEYS);
  if (unknownKey !== undefined) {
    fail(
      "UNKNOWN_ITEM_KEY",
      `第 ${itemIndex + 1} 条包含未知字段：${unknownKey}`,
    );
  }

  const missingKey = firstMissingKey(value, REQUIRED_ITEM_KEYS);
  if (missingKey !== undefined) {
    fail(
      "MISSING_ITEM_KEY",
      `第 ${itemIndex + 1} 条缺少字段：${missingKey}`,
    );
  }

  if (value.type !== "lookup") {
    fail(
      "UNSUPPORTED_ITEM_TYPE",
      `第 ${itemIndex + 1} 条的 type 必须是 lookup`,
    );
  }

  const focus = normalizeRequiredString(value, "focus", itemIndex);
  const sourceExcerpt = normalizeRequiredString(
    value,
    "sourceExcerpt",
    itemIndex,
  );
  const answer = normalizeRequiredString(value, "answer", itemIndex);

  return {
    type: "lookup",
    focus,
    sourceExcerpt,
    answer,
  };
}

export function extractCoachJson(input: string): string {
  if (utf8Bytes(input).byteLength > MAX_COACH_TRANSFER_BYTES) {
    fail("INPUT_TOO_LARGE", "Coach 内容超过 64 KiB");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    fail("EMPTY_INPUT", "没有可解析的 Coach 内容");
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenceMarkerCount = trimmed.match(/```/gu)?.length ?? 0;
  if (fenceMarkerCount !== 2) {
    fail(
      "INVALID_ENVELOPE",
      "请复制完整 JSON 代码块，或点击代码块的“复制代码”",
    );
  }

  const fenced = JSON_FENCE.exec(trimmed);
  if (fenced === null) {
    fail("INVALID_ENVELOPE", "围栏外不能有文字，且代码块必须标记为 json");
  }
  return fenced[1]!.trim();
}

export function parseCoachTransfer(input: string): CoachTransfer {
  const json = extractCoachJson(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    fail("INVALID_JSON", "Coach 内容不是合法 JSON");
  }

  if (!isRecord(parsed)) {
    fail("INVALID_TOP_LEVEL", "Coach JSON 顶层必须是对象");
  }

  const unknownKey = firstUnknownKey(parsed, TOP_LEVEL_KEYS);
  if (unknownKey !== undefined) {
    fail("UNKNOWN_TOP_LEVEL_KEY", `Coach JSON 顶层包含未知字段：${unknownKey}`);
  }

  const missingKey = firstMissingKey(parsed, REQUIRED_TOP_LEVEL_KEYS);
  if (missingKey !== undefined) {
    fail("MISSING_TOP_LEVEL_KEY", `Coach JSON 顶层缺少字段：${missingKey}`);
  }

  if (parsed.schema !== COACH_TRANSFER_SCHEMA) {
    fail(
      "UNSUPPORTED_SCHEMA",
      `Coach JSON schema 必须是 ${COACH_TRANSFER_SCHEMA}`,
    );
  }
  if (!Array.isArray(parsed.items)) {
    fail("INVALID_ITEMS", "Coach JSON items 必须是数组");
  }
  if (parsed.items.length > 3) {
    fail("TOO_MANY_ITEMS", "Coach JSON 每批最多 3 条");
  }

  return {
    schema: COACH_TRANSFER_SCHEMA,
    items: parsed.items.map((item, index) => parseItem(item, index)),
  };
}

export function canonicalizeCoachTransfer(transfer: CoachTransfer): string {
  return JSON.stringify({
    schema: COACH_TRANSFER_SCHEMA,
    items: transfer.items.map((item) => ({
      type: "lookup",
      focus: item.focus,
      sourceExcerpt: item.sourceExcerpt,
      answer: item.answer,
    })),
  });
}

export async function digestCoachTransfer(
  transfer: CoachTransfer,
  dependencies: CoachTransferDigestDependencies = DEFAULT_DIGEST_DEPENDENCIES,
): Promise<`sha256:${string}`> {
  const encoded = utf8Bytes(canonicalizeCoachTransfer(transfer));
  const input = Uint8Array.from(encoded).buffer;
  const digest = new Uint8Array(await dependencies.sha256(input));
  if (digest.byteLength !== 32) {
    throw new TypeError("SHA-256 digest must contain exactly 32 bytes");
  }
  const hexadecimal = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hexadecimal}`;
}
