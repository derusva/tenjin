import { describe, expect, it } from "vitest";

import { serializeContextHashInput } from "./contextHash.js";

describe("serializeContextHashInput", () => {
  it("emits only the original when nothing else is present", () => {
    expect(serializeContextHashInput({ original: "a" })).toBe(
      JSON.stringify({ original: "a" }),
    );
  });

  it("keeps legacy inputs byte-for-byte identical when focus is absent", () => {
    expect(
      serializeContextHashInput({
        original: "手を打つ",
        answer: "采取措施",
      }),
    ).toBe('{"original":"手を打つ","answer":"采取措施"}');
  });

  it("keeps the fixed field order: original, focus, corrected, answer, imageSha256", () => {
    expect(
      serializeContextHashInput({
        imageSha256: "d".repeat(64),
        answer: "c",
        corrected: "b",
        focus: "手を打つ",
        original: "a",
      }),
    ).toBe(
      JSON.stringify({
        original: "a",
        focus: "手を打つ",
        corrected: "b",
        answer: "c",
        imageSha256: "d".repeat(64),
      }),
    );
  });

  it("includes focus without replacing the complete source excerpt", () => {
    expect(
      serializeContextHashInput({
        original: "大丈夫、手は打ったから。",
        focus: "手を打つ",
        answer: "采取措施",
      }),
    ).toBe(
      '{"original":"大丈夫、手は打ったから。","focus":"手を打つ","answer":"采取措施"}',
    );
  });

  it("omits absent fields entirely rather than emitting null or an empty string", () => {
    expect(serializeContextHashInput({ original: "a", answer: "c" })).toBe(
      JSON.stringify({ original: "a", answer: "c" }),
    );
    expect(serializeContextHashInput({ original: "a" })).not.toContain("null");
  });

  it("is not the canonical serialiser: it must not sort keys", () => {
    // canonicalJson sorts keys. Sorting here would put answer before original
    // and silently change every hash ever computed.
    const serialized = serializeContextHashInput({ original: "z", answer: "a" });
    expect(serialized.indexOf('"original"')).toBeLessThan(
      serialized.indexOf('"answer"'),
    );
  });
});
