import { describe, expect, it } from "vitest";

import { decodeUtf8Strict } from "./decodeUtf8.js";

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8", () => {
    expect(
      decodeUtf8Strict(
        new Uint8Array([0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac, 0xe8, 0xaa, 0x9e]),
        "sample",
      ),
    ).toBe("日本語");
  });

  it("rejects invalid UTF-8 instead of inserting replacement characters", () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xc3, 0x28]), "events.jsonl")).toThrow(
      "events.jsonl is not valid UTF-8",
    );
  });
});
