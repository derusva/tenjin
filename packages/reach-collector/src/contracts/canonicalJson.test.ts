import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  CanonicalJsonError,
  sha256Hex,
} from "./canonicalJson.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: [2, 1] } })).toBe(
      '{"a":{"b":[2,1],"d":4},"z":1}',
    );
  });

  it("normalizes negative zero and rejects non-JSON values", () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalJson({ value: undefined })).toThrow(
      CanonicalJsonError,
    );
  });

  it("rejects circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/i);
  });
});
describe("sha256Hex", () => {
  it("returns a stable prefixed lowercase digest", () => {
    expect(sha256Hex("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
