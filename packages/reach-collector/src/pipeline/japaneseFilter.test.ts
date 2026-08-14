import { describe, expect, it } from "vitest";

import { createRawSourceItem } from "../contracts/rawSourceItem.js";
import {
  classifyJapanese,
  classifySourceItem,
  filterJapaneseItems,
  JAPANESE_FILTER_RULE_VERSION,
} from "./japaneseFilter.js";

function fixture(text: string) {
  return createRawSourceItem({
    sourceId: "fixture.saved",
    accountScope: "local-test",
    platform: "fixture",
    externalId: text,
    canonicalUrl: "https://example.test/item",
    interaction: "bookmark",
    content: { kind: "post", text },
    backend: { name: "fixture" },
  });
}

describe("classifyJapanese", () => {
  it("implements the exact ja-script-v1 eligible threshold", () => {
    const result = classifyJapanese("今日は日本語を勉強します");
    expect(result.ruleVersion).toBe(JAPANESE_FILTER_RULE_VERSION);
    expect(result.decision).toBe("eligible");
    expect(result.japaneseCharacters).toBeGreaterThanOrEqual(8);
    expect(result.kanaCharacters).toBeGreaterThanOrEqual(2);
    expect(result.japaneseLetterRatio).toBeGreaterThanOrEqual(0.35);
  });

  it("routes six or more Japanese characters to review when not eligible", () => {
    expect(classifyJapanese("日本語学習教材").decision).toBe("needs_review");
    expect(classifyJapanese("これは日本語").decision).toBe("needs_review");
  });

  it("skips content below the review floor", () => {
    expect(classifyJapanese("An English post about AI").decision).toBe(
      "skipped_non_japanese",
    );
    expect(classifyJapanese("最高").decision).toBe("skipped_non_japanese");
  });

  it("uses Unicode letters, not punctuation, as the ratio denominator", () => {
    const result = classifyJapanese("！！！今日は日本語を勉強します！！！");
    expect(result.decision).toBe("eligible");
    expect(result.unicodeLetters).toBe(result.japaneseCharacters);
  });
});
describe("source item filtering", () => {
  it("extracts post content and keeps eligible items by default", () => {
    const japanese = fixture("今日は日本語を勉強します");
    const english = fixture("This is only an English source item");
    expect(classifySourceItem(japanese).classification.decision).toBe("eligible");
    expect(filterJapaneseItems([japanese, english])).toEqual([japanese]);
  });

  it("can explicitly include the manual-review lane", () => {
    const review = fixture("日本語学習教材");
    expect(
      filterJapaneseItems([review], new Set(["eligible", "needs_review"])),
    ).toEqual([review]);
  });
});
