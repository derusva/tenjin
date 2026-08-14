import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { collectFixtureSource } from "./fixture.js";

describe("collectFixtureSource", () => {
  it("creates hashed contract items and binds them to config identity", async () => {
    const [item] = await collectFixtureSource({
      id: "fixture.override",
      kind: "fixture",
      accountScope: "test-account",
      enabled: true,
      limit: 1,
      path: resolve("fixtures/social-items.json"),
    });
    expect(item).toMatchObject({
      sourceId: "fixture.override",
      accountScope: "test-account",
      platform: "fixture",
      backend: { name: "fixture" },
    });
    expect(item?.itemKey).toMatch(/^sha256:/);
  });
});
