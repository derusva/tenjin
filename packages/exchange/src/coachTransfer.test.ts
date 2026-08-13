// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

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

interface RuntimeTextEncoder {
  readonly encode: (text: string) => Uint8Array;
}

interface RuntimeTextEncoderConstructor {
  new (): RuntimeTextEncoder;
}

interface RuntimeTextDecoder {
  readonly decode: (bytes: ArrayBuffer) => string;
}

interface RuntimeTextDecoderConstructor {
  new (): RuntimeTextDecoder;
}

interface RuntimeCrypto {
  readonly subtle?: unknown;
}

type TestRuntime = typeof globalThis & {
  readonly crypto?: RuntimeCrypto;
  readonly TextDecoder?: RuntimeTextDecoderConstructor;
  readonly TextEncoder?: RuntimeTextEncoderConstructor;
};

const TEST_RUNTIME = globalThis as TestRuntime;

function encodeUtf8(text: string): Uint8Array {
  const TextEncoderImplementation = TEST_RUNTIME.TextEncoder;
  if (TextEncoderImplementation === undefined) {
    throw new TypeError("UTF-8 TextEncoder is unavailable in this runtime");
  }
  return new TextEncoderImplementation().encode(text);
}

function decodeUtf8(bytes: ArrayBuffer): string {
  const TextDecoderImplementation = TEST_RUNTIME.TextDecoder;
  if (TextDecoderImplementation === undefined) {
    throw new TypeError("UTF-8 TextDecoder is unavailable in this runtime");
  }
  return new TextDecoderImplementation().decode(bytes);
}

function rawJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "tenjin.coach-transfer/v1",
    items: [ITEM],
    ...overrides,
  });
}

const OVERSIZED_UTF8 = `{"${"界".repeat(22_000)}":1}`;

const ERROR_INPUT_BY_CODE = {
  EMPTY_INPUT: "",
  INPUT_TOO_LARGE: OVERSIZED_UTF8,
  INVALID_ENVELOPE: "not json",
  INVALID_JSON: "{not json}",
  INVALID_TOP_LEVEL: "```json\n[1, 2]\n```",
  UNKNOWN_TOP_LEVEL_KEY: rawJson({ futureField: true }),
  MISSING_TOP_LEVEL_KEY: JSON.stringify({ items: [] }),
  UNSUPPORTED_SCHEMA: rawJson({ schema: "tenjin.coach-transfer/v2" }),
  INVALID_ITEMS: rawJson({ items: {} }),
  TOO_MANY_ITEMS: rawJson({ items: [ITEM, ITEM, ITEM, ITEM] }),
  INVALID_ITEM: rawJson({ items: [null] }),
  UNKNOWN_ITEM_KEY: rawJson({
    items: [{ ...ITEM, confidence: 0.9 }],
  }),
  MISSING_ITEM_KEY: rawJson({
    items: [
      {
        type: "lookup",
        focus: ITEM.focus,
        sourceExcerpt: ITEM.sourceExcerpt,
      },
    ],
  }),
  UNSUPPORTED_ITEM_TYPE: rawJson({
    items: [{ ...ITEM, type: "listening_miss" }],
  }),
  INVALID_ITEM_FIELD_TYPE: rawJson({
    items: [{ ...ITEM, answer: 42 }],
  }),
  EMPTY_ITEM_FIELD: rawJson({
    items: [{ ...ITEM, focus: " \n\t " }],
  }),
} satisfies Record<CoachTransferErrorCode, string>;

function expectCode(input: string, code: CoachTransferErrorCode): void {
  try {
    parseCoachTransfer(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CoachTransferError);
    expect((error as CoachTransferError).code).toBe(code);
    expect(error).not.toHaveProperty("repairPrompt");
    return;
  }
  throw new Error(`Expected ${code}`);
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

  it.each(Object.entries(ERROR_INPUT_BY_CODE))(
    "reports stable error code %s",
    (code, input) => {
      expectCode(input, code as CoachTransferErrorCode);
    },
  );

  it.each([
    ["whitespace-only input", " \n\t ", "EMPTY_INPUT"],
    [
      "prose before a fence",
      `说明\n\`\`\`json\n${rawJson()}\n\`\`\``,
      "INVALID_ENVELOPE",
    ],
    [
      "an uppercase fence label",
      `\`\`\`JSON\n${rawJson()}\n\`\`\``,
      "INVALID_ENVELOPE",
    ],
    [
      "multiple fences",
      `\`\`\`json\n${rawJson()}\n\`\`\`\n\`\`\`text\nextra\n\`\`\``,
      "INVALID_ENVELOPE",
    ],
  ] as const)("rejects %s", (_name, input, code) => {
    expectCode(input, code);
  });

  it("rejects a UTF-8 payload over 64 KiB", () => {
    expect(OVERSIZED_UTF8.length).toBeLessThan(MAX_COACH_TRANSFER_BYTES);
    expect(encodeUtf8(OVERSIZED_UTF8).byteLength).toBeGreaterThan(
      MAX_COACH_TRANSFER_BYTES,
    );
    expectCode(OVERSIZED_UTF8, "INPUT_TOO_LARGE");
  });

  it("accepts exactly 64 KiB but counts surrounding whitespace in the cap", () => {
    const oneByteAnswer = rawJson({ items: [{ ...ITEM, answer: "x" }] });
    const oneByteLength = encodeUtf8(oneByteAnswer).byteLength;
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

    expect(encodeUtf8(exactLimit).byteLength).toBe(
      MAX_COACH_TRANSFER_BYTES,
    );
    expect(parseCoachTransfer(exactLimit).items).toHaveLength(1);
    expectCode(`${exactLimit} `, "INPUT_TOO_LARGE");
  });

  it.each([
    ["a separate reading field", { ...ITEM, reading: "てをうつ" }],
    ["a full-width whitespace field", { ...ITEM, focus: "　" }],
    [
      "an unused transfer field",
      { ...ITEM, transferSentence: "早めに手を打つ。" },
    ],
  ] as const)("strictly rejects %s", (name, item) => {
    expectCode(
      rawJson({ items: [item] }),
      name === "a full-width whitespace field"
        ? "EMPTY_ITEM_FIELD"
        : "UNKNOWN_ITEM_KEY",
    );
  });
});

describe("Coach transfer canonical digest", () => {
  it("uses the production WebCrypto SHA-256 algorithm", async () => {
    expect(TEST_RUNTIME.crypto?.subtle).toBeDefined();

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
      hashedText = decodeUtf8(bytes);
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
