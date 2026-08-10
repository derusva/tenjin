// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { COACH_TRANSFER_REPAIR_PROMPT } from "./coachPrompt.js";
import {
  canonicalizeCoachTransfer,
  CoachTransferError,
  digestCoachTransfer,
  MAX_COACH_TRANSFER_BYTES,
  parseCoachTransfer,
  type CoachTransferErrorCode,
} from "./coachTransfer.js";

const ITEM = {
  type: "lookup",
  focus: "手を打つ",
  sourceExcerpt: "大丈夫、手は打ったから。",
  answer: "采取措施；这里表示已经采取了对策。",
} as const;

function rawJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "tenjin.coach-transfer/v1",
    items: [ITEM],
    ...overrides,
  });
}

function errorFor(
  input: string,
  expectedCode: CoachTransferErrorCode,
): CoachTransferError {
  try {
    parseCoachTransfer(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CoachTransferError);
    const transferError = error as CoachTransferError;
    expect(transferError.code).toBe(expectedCode);
    expect(transferError.repairPrompt).toBe(COACH_TRANSFER_REPAIR_PROMPT);
    return transferError;
  }
  throw new Error(`Expected ${expectedCode}`);
}

describe("parseCoachTransfer", () => {
  it("accepts the entire raw JSON copied from a code-block Copy button", () => {
    expect(parseCoachTransfer(rawJson())).toEqual({
      schema: "tenjin.coach-transfer/v1",
      items: [ITEM],
    });
  });

  it("accepts one json fence with whitespace-only surroundings", () => {
    const input = ` \r\n\t\`\`\`json\r\n${rawJson()}\r\n\`\`\` \n`;

    expect(parseCoachTransfer(input).items).toEqual([ITEM]);
  });

  it("normalizes surrounding whitespace without rewriting inner content", () => {
    const transfer = parseCoachTransfer(
      rawJson({
        items: [
          {
            type: "lookup",
            focus: "  手を打つ  ",
            sourceExcerpt: "\n大丈夫、手は打ったから。\t",
            answer: "  采取措施；\n这里表示已经采取了对策。  ",
          },
        ],
      }),
    );

    expect(transfer.items).toEqual([
      {
        ...ITEM,
        answer: "采取措施；\n这里表示已经采取了对策。",
      },
    ]);
  });

  it("accepts an empty items array as a normal batch", () => {
    expect(parseCoachTransfer(rawJson({ items: [] }))).toEqual({
      schema: "tenjin.coach-transfer/v1",
      items: [],
    });
  });

  it.each([
    ["", "EMPTY_INPUT"],
    [" \n\t ", "EMPTY_INPUT"],
    ["not json", "INVALID_ENVELOPE"],
    [`说明\n\`\`\`json\n${rawJson()}\n\`\`\``, "INVALID_ENVELOPE"],
    [`\`\`\`JSON\n${rawJson()}\n\`\`\``, "INVALID_ENVELOPE"],
    [
      `\`\`\`json\n${rawJson()}\n\`\`\`\n\`\`\`text\nextra\n\`\`\``,
      "INVALID_ENVELOPE",
    ],
    ["{not json}", "INVALID_JSON"],
    ["```json\n[1, 2]\n```", "INVALID_TOP_LEVEL"],
  ] as const)("rejects malformed transport %#", (input, code) => {
    errorFor(input, code);
  });

  it("rejects a UTF-8 payload over 64 KiB", () => {
    const oversized = `{"${"界".repeat(22_000)}":1}`;

    expect(oversized.length).toBeLessThan(MAX_COACH_TRANSFER_BYTES);
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
      MAX_COACH_TRANSFER_BYTES,
    );
    errorFor(oversized, "INPUT_TOO_LARGE");
  });

  it("accepts exactly 64 KiB but counts surrounding whitespace in the cap", () => {
    const oneByteAnswer = rawJson({ items: [{ ...ITEM, answer: "x" }] });
    const oneByteLength = new TextEncoder().encode(oneByteAnswer).byteLength;
    const exactLimit = rawJson({
      items: [
        {
          ...ITEM,
          answer: "x".repeat(
            1 + MAX_COACH_TRANSFER_BYTES - oneByteLength,
          ),
        },
      ],
    });

    expect(new TextEncoder().encode(exactLimit).byteLength).toBe(
      MAX_COACH_TRANSFER_BYTES,
    );
    expect(parseCoachTransfer(exactLimit).items).toHaveLength(1);
    errorFor(`${exactLimit} `, "INPUT_TOO_LARGE");
  });

  it.each([
    [
      "unknown top-level key",
      { futureField: true },
      "UNKNOWN_TOP_LEVEL_KEY",
    ],
    ["missing schema", { schema: undefined }, "MISSING_TOP_LEVEL_KEY"],
    ["wrong schema", { schema: "tenjin.coach-transfer/v2" }, "UNSUPPORTED_SCHEMA"],
    ["items is not an array", { items: {} }, "INVALID_ITEMS"],
    ["four items", { items: [ITEM, ITEM, ITEM, ITEM] }, "TOO_MANY_ITEMS"],
  ] as const)("rejects %s", (_name, overrides, code) => {
    errorFor(rawJson(overrides), code);
  });

  it("distinguishes a genuinely missing top-level key", () => {
    errorFor(JSON.stringify({ items: [] }), "MISSING_TOP_LEVEL_KEY");
  });

  it.each([
    ["non-object item", null, "INVALID_ITEM"],
    ["unknown item key", { ...ITEM, confidence: 0.9 }, "UNKNOWN_ITEM_KEY"],
    [
      "missing required item key",
      {
        type: "lookup",
        focus: "手を打つ",
        sourceExcerpt: "大丈夫、手は打ったから。",
      },
      "MISSING_ITEM_KEY",
    ],
    ["non-lookup type", { ...ITEM, type: "listening_miss" }, "UNSUPPORTED_ITEM_TYPE"],
    ["non-string field", { ...ITEM, answer: 42 }, "INVALID_ITEM_FIELD_TYPE"],
    ["ASCII whitespace field", { ...ITEM, focus: " \n\t " }, "EMPTY_ITEM_FIELD"],
    ["full-width whitespace field", { ...ITEM, focus: "　" }, "EMPTY_ITEM_FIELD"],
    [
      "unused transfer field",
      { ...ITEM, transferSentence: "早めに手を打つ。" },
      "UNKNOWN_ITEM_KEY",
    ],
  ] as const)("rejects %s", (_name, item, code) => {
    errorFor(rawJson({ items: [item] }), code);
  });
});

describe("Coach transfer canonical digest", () => {
  it("uses the production WebCrypto SHA-256 algorithm", async () => {
    expect(globalThis.crypto?.subtle).toBeDefined();

    await expect(digestCoachTransfer(parseCoachTransfer(rawJson()))).resolves.toBe(
      "sha256:14cca532f146626ed0f274036ba700068fcca2c59768cd881ef9aa0449a5f6af",
    );
  });

  it("uses normalized content and a fixed key order", () => {
    const transfer = parseCoachTransfer(
      JSON.stringify({
        items: [
          {
            answer: ` ${ITEM.answer} `,
            sourceExcerpt: ITEM.sourceExcerpt,
            focus: ITEM.focus,
            type: "lookup",
          },
        ],
        schema: "tenjin.coach-transfer/v1",
      }),
    );

    expect(canonicalizeCoachTransfer(transfer)).toBe(
      JSON.stringify({
        schema: "tenjin.coach-transfer/v1",
        items: [ITEM],
      }),
    );
  });

  it("hashes the canonical UTF-8 bytes and returns lowercase prefixed hex", async () => {
    let hashedText = "";
    const digestBytes = Uint8Array.from({ length: 32 }, () => 0xab);
    const sha256 = vi.fn(async (bytes: ArrayBuffer) => {
      hashedText = new TextDecoder().decode(bytes);
      return digestBytes.buffer;
    });
    const transfer = parseCoachTransfer(rawJson());

    await expect(digestCoachTransfer(transfer, { sha256 })).resolves.toBe(
      `sha256:${"ab".repeat(32)}`,
    );
    expect(sha256).toHaveBeenCalledTimes(1);
    expect(hashedText).toBe(canonicalizeCoachTransfer(transfer));
  });

  it("gives raw and fenced copies of the same batch the same digest", async () => {
    const digestBytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
    const dependencies = {
      sha256: async () => digestBytes.buffer,
    };
    const raw = parseCoachTransfer(rawJson());
    const fenced = parseCoachTransfer(`\`\`\`json\n${rawJson()}\n\`\`\``);

    await expect(digestCoachTransfer(raw, dependencies)).resolves.toBe(
      await digestCoachTransfer(fenced, dependencies),
    );
  });

  it("rejects a digest implementation that does not return SHA-256 bytes", async () => {
    const transfer = parseCoachTransfer(rawJson());

    await expect(
      digestCoachTransfer(transfer, {
        sha256: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    ).rejects.toThrow("exactly 32 bytes");
  });
});
