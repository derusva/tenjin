import { describe, expect, it } from "vitest";

import { segmentJapanese } from "./segmentJapanese.js";

describe("segmentJapanese", () => {
  it("keeps Japanese sentence punctuation attached", () => {
    expect(segmentJapanese("今日は晴れです。散歩に行きます！\nまたね。"))
      .toEqual(["今日は晴れです。", "散歩に行きます！", "またね。"]);
  });

  it("normalizes CRLF and drops empty or undersized fragments", () => {
    expect(segmentJapanese("\r\n A \r\n 日本語です。\r\n", { minimumCharacters: 2 }))
      .toEqual(["日本語です。"]);
  });

  it("uses a soft break before the hard Unicode character limit", () => {
    const segments = segmentJapanese("あいうえお、かきくけこ、さしすせそ", {
      maximumCharacters: 10,
    });
    expect(segments).toEqual(["あいうえお、", "かきくけこ、", "さしすせそ"]);
    expect(segments.every((segment) => [...segment].length <= 10)).toBe(true);
  });

  it("validates bounds", () => {
    expect(() => segmentJapanese("日本語", { maximumCharacters: 7 })).toThrow(
      RangeError,
    );
    expect(() =>
      segmentJapanese("日本語", { maximumCharacters: 8, minimumCharacters: 9 }),
    ).toThrow(RangeError);
  });
});
