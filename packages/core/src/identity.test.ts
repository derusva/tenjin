import { describe, expect, it } from "vitest";

import { normalizeIdentity } from "./identity.js";

describe("normalizeIdentity", () => {
  it("normalizes compatibility-width ASCII, trims, and lowercases ASCII", () => {
    expect(normalizeIdentity(" ＴｅｎＪｉｎ ")).toBe("tenjin");
  });

  it("converts katakana to hiragana", () => {
    expect(normalizeIdentity("カタカナ")).toBe("かたかな");
  });
});
