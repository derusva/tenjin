import { describe, expect, it } from "vitest";

import { collectNoteRssSource } from "./noteRss.js";

describe("collectNoteRssSource", () => {
  it("parses RSS and optionally replaces summaries with Jina Reader text", async () => {
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => url.startsWith("https://r.jina.ai/")
        ? "今日は本文を読みます。"
        : `<?xml version="1.0"?><rss><channel><item><guid>n1</guid><link>https://note.com/a/n/n1</link><title>題名</title><description>要約</description><pubDate>Tue, 11 Aug 2026 00:00:00 GMT</pubDate></item></channel></rss>`,
    });
    const [item] = await collectNoteRssSource({
      id: "note.saved",
      kind: "note-rss",
      accountScope: "me",
      enabled: true,
      limit: 10,
      feedUrl: "https://note.com/a/rss",
      fetchFullText: true,
    }, { fetch });
    expect(item).toMatchObject({
      externalId: "n1",
      content: { kind: "article", text: "今日は本文を読みます。" },
      publishedAt: "2026-08-11T00:00:00.000Z",
    });
  });
});
