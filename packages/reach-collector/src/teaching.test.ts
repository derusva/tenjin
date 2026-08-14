import { describe, expect, it } from "vitest";

import { createRawSourceItem } from "./contracts/rawSourceItem.js";
import {
  buildTeachingRequest,
  compileCoachTransfer,
  parseTeachingRequest,
  TeachingContractError,
} from "./teaching.js";

const validExcerptId = `sha256:${"a".repeat(64)}`;
const validRevisionKey = `sha256:${"b".repeat(64)}`;

function validTeachingRequest(text = "  原文の空白を残す。\r\n次の行。  ") {
  return {
    schema: "tenjin.reach-teaching-request/v1",
    promptVersion: "tenjin-coach-social-v1",
    excerpts: [
      {
        excerptId: validExcerptId,
        revisionKey: validRevisionKey,
        sourceId: "note.saved",
        platform: "note",
        canonicalUrl: "https://note.com/example/n/n123",
        text,
      },
    ],
  };
}

function expectTeachingRequestInvalid(value: unknown): void {
  expect(() => parseTeachingRequest(value)).toThrowError(
    expect.objectContaining<Partial<TeachingContractError>>({
      code: "TEACHING_REQUEST_INVALID",
    }),
  );
}

const item = createRawSourceItem({
  sourceId: "fixture.social",
  accountScope: "public",
  platform: "fixture",
  externalId: "post-1",
  canonicalUrl: "https://example.test/post-1",
  interaction: "bookmark",
  content: {
    kind: "post",
    text: "大丈夫、手は打ったから。あとは結果を待つしかない。",
  },
  backend: { name: "fixture", version: "1" },
});

describe("teaching handoff", () => {
  it("strictly parses teaching requests without rewriting excerpt text", () => {
    const request = validTeachingRequest();
    const parsed = parseTeachingRequest(request);

    expect(parsed.excerpts[0]!.text).toBe(request.excerpts[0]!.text);
    expect(parsed).toEqual(request);
  });

  it("rejects unknown request and excerpt fields", () => {
    expectTeachingRequestInvalid({ ...validTeachingRequest(), extra: true });

    const request = validTeachingRequest();
    expectTeachingRequestInvalid({
      ...request,
      excerpts: [{ ...request.excerpts[0]!, extra: true }],
    });
  });

  it("rejects invalid digests, platforms, URLs, and empty source text", () => {
    const request = validTeachingRequest();
    const excerpt = request.excerpts[0]!;
    for (const changes of [
      { excerptId: "sha256:not-a-digest" },
      { revisionKey: `sha256:${"A".repeat(64)}` },
      { platform: "linkedin" },
      { canonicalUrl: "file:///private/source" },
      { sourceId: "   " },
      { text: "\r\n\t" },
    ]) {
      expectTeachingRequestInvalid({
        ...request,
        excerpts: [{ ...excerpt, ...changes }],
      });
    }
  });

  it("rejects duplicate excerpt IDs", () => {
    const request = validTeachingRequest();
    expectTeachingRequestInvalid({
      ...request,
      excerpts: [request.excerpts[0]!, { ...request.excerpts[0]! }],
    });
  });

  it("revalidates a request before compiling a Coach transfer", () => {
    const request = validTeachingRequest();
    expect(() =>
      compileCoachTransfer(
        { ...request, extra: true },
        { schema: "tenjin.reach-generation-result/v1", items: [] },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<TeachingContractError>>({
        code: "TEACHING_REQUEST_INVALID",
      }),
    );
  });

  it("binds model output to exact collector excerpts", () => {
    const request = buildTeachingRequest([item]);
    const excerpt = request.excerpts[0]!;
    const output = compileCoachTransfer(request, {
      schema: "tenjin.reach-generation-result/v1",
      items: [
        {
          excerptId: excerpt.excerptId,
          type: "lookup",
          focus: "手を打つ",
          answer: "读音：てをうつ。这里表示采取对策。",
        },
      ],
    });

    expect(output.transfer.items[0]).toEqual({
      type: "lookup",
      focus: "手を打つ",
      sourceExcerpt: excerpt.text,
      answer: "读音：てをうつ。这里表示采取对策。",
    });
    expect(output.sourceSidecar.sources).toEqual([excerpt]);
  });

  it("rejects unknown excerpts and model-written source text", () => {
    const request = buildTeachingRequest([item]);
    expect(() =>
      compileCoachTransfer(request, {
        schema: "tenjin.reach-generation-result/v1",
        items: [
          {
            excerptId: `sha256:${"0".repeat(64)}`,
            type: "lookup",
            focus: "手を打つ",
            answer: "读音：てをうつ。",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TeachingContractError>>({
        code: "GENERATION_UNKNOWN_EXCERPT",
      }),
    );
    expect(() =>
      compileCoachTransfer(request, {
        schema: "tenjin.reach-generation-result/v1",
        items: [
          {
            excerptId: request.excerpts[0]!.excerptId,
            type: "lookup",
            focus: "手を打つ",
            answer: "读音：てをうつ。",
            sourceExcerpt: "rewritten",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TeachingContractError>>({
        code: "GENERATION_INVALID",
      }),
    );
  });
});
