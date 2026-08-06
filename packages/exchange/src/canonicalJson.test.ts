import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonicalJson.js";

describe("canonicalJson", () => {
  it("orders object keys independently of insertion order", () => {
    const left = { b: 1, a: { d: 2, c: 3 } };
    const right = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
  });

  it("rejects values it cannot represent deterministically", () => {
    expect(() => canonicalJson(() => undefined)).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
  });

  it("escapes strings the same way JSON.stringify does", () => {
    expect(canonicalJson({ "日本語\n": 'a"b' })).toBe('{"日本語\\n":"a\\"b"}');
  });
});
