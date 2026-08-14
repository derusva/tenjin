import { describe, expect, it } from "vitest";

import {
  parseReachConfig,
  ReachConfigError,
  REACH_CONFIG_SCHEMA,
} from "./config.js";

describe("Reach config", () => {
  it("parses fixed source kinds with safe defaults", () => {
    expect(
      parseReachConfig(
        {
          schema: REACH_CONFIG_SCHEMA,
          sources: [
            {
              id: "note-official",
              kind: "note-rss",
              accountScope: "public",
              feedUrl: "https://note.com/info/rss",
            },
            {
              id: "youtube-history",
              kind: "youtube-history",
              accountScope: "primary",
              enabled: false,
              transcriptLanguage: "ja",
            },
          ],
        },
        "C:/config",
      ).sources,
    ).toEqual([
      {
        id: "note-official",
        kind: "note-rss",
        accountScope: "public",
        enabled: true,
        limit: 20,
        feedUrl: "https://note.com/info/rss",
        fetchFullText: true,
      },
      {
        id: "youtube-history",
        kind: "youtube-history",
        accountScope: "primary",
        enabled: false,
        limit: 20,
        transcriptLanguage: "ja",
      },
    ]);
  });

  it.each([
    [{ schema: REACH_CONFIG_SCHEMA, sources: [], extra: true }, "CONFIG_UNKNOWN_KEY"],
    [{ schema: REACH_CONFIG_SCHEMA, sources: "all" }, "CONFIG_INVALID_SOURCES"],
    [
      {
        schema: REACH_CONFIG_SCHEMA,
        sources: [
          { id: "same", kind: "x-likes", accountScope: "primary" },
          { id: "same", kind: "x-bookmarks", accountScope: "primary" },
        ],
      },
      "CONFIG_DUPLICATE_SOURCE",
    ],
  ] as const)("fails closed for invalid config %#", (input, code) => {
    expect(() => parseReachConfig(input)).toThrowError(
      expect.objectContaining<Partial<ReachConfigError>>({ code }),
    );
  });
});
