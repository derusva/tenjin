import { describe, expect, it } from "vitest";

import {
  createRawSourceItem,
  parseRawSourceItem,
  RAW_SOURCE_ITEM_SCHEMA,
  ReachContractError,
} from "./rawSourceItem.js";

function noteItem() {
  return createRawSourceItem({
    sourceId: "note.magazine",
    accountScope: "note:local-account",
    platform: "note",
    externalId: "n123",
    canonicalUrl: "https://note.com/example/n/n123#fragment",
    interaction: "rss_magazine",
    content: {
      kind: "article",
      title: " 学びの記録 ",
      text: "今日は日本語を勉強します。\r\n楽しいです。 ",
    },
    backend: { name: "rss-http", version: "1" },
    author: " author ",
    publishedAt: "2026-08-12T01:02:03.000Z",
  });
}

describe("RawSourceItemV1", () => {
  it("creates a canonical strict V1 item with computed identities", () => {
    const item = noteItem();
    expect(item).toMatchObject({
      schema: RAW_SOURCE_ITEM_SCHEMA,
      sourceId: "note.magazine",
      canonicalUrl: "https://note.com/example/n/n123",
      author: "author",
      content: {
        kind: "article",
        title: "学びの記録",
        text: "今日は日本語を勉強します。\n楽しいです。",
      },
    });
    expect(item.itemKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(item.revisionKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(item.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseRawSourceItem(item)).toEqual(item);
  });

  it("keeps item identity stable across content revisions", () => {
    const first = noteItem();
    const revised = createRawSourceItem({
      ...first,
      canonicalUrl: "https://note.com/example/n/n123?ref=updated",
      backend: { name: "rss-http", version: "2" },
      content: {
        kind: "article",
        title: "学びの記録",
        text: "内容が更新されました。",
      },
    });
    expect(revised.itemKey).toBe(first.itemKey);
    expect(revised.contentHash).not.toBe(first.contentHash);
    expect(revised.revisionKey).not.toBe(first.revisionKey);
  });

  it("keeps item identity stable across equivalent configured source IDs", () => {
    const first = noteItem();
    const renamedSource = createRawSourceItem({
      ...first,
      sourceId: "note.magazine.renamed",
    });

    expect(renamedSource.sourceId).not.toBe(first.sourceId);
    expect(renamedSource.itemKey).toBe(first.itemKey);
    expect(renamedSource.contentHash).toBe(first.contentHash);
    expect(renamedSource.revisionKey).toBe(first.revisionKey);
  });

  it("rejects unknown fields and integrity tampering", () => {
    const item = noteItem();
    expect(() => parseRawSourceItem({ ...item, cookie: "secret" })).toThrow(
      ReachContractError,
    );
    expect(() =>
      parseRawSourceItem({ ...item, contentHash: `sha256:${"a".repeat(64)}` }),
    ).toThrow(/does not match/);
  });

  it("enforces platform, interaction, backend, and content compatibility", () => {
    const base = noteItem();
    expect(() =>
      createRawSourceItem({ ...base, interaction: "watch_later" }),
    ).toThrow(/interaction/);
    expect(() =>
      createRawSourceItem({ ...base, backend: { name: "yt-dlp" } }),
    ).toThrow(/backend.name/);
    expect(() =>
      createRawSourceItem({
        ...base,
        content: { kind: "video", title: "動画" },
      }),
    ).toThrow(/content.kind/);
  });

  it("accepts ordered YouTube transcript cues and rejects reversed timing", () => {
    const video = createRawSourceItem({
      sourceId: "youtube.watch-later",
      accountScope: "youtube:local-account",
      platform: "youtube",
      externalId: "video-1",
      canonicalUrl: "https://www.youtube.com/watch?v=video-1",
      interaction: "watch_later",
      content: {
        kind: "video",
        title: "日本語の動画",
        transcript: [
          { startMs: 0, endMs: 900, text: "こんにちは。" },
          { startMs: 1_000, text: "始めましょう。" },
        ],
      },
      backend: { name: "yt-dlp" },
    });
    expect(parseRawSourceItem(video)).toEqual(video);
    expect(() =>
      createRawSourceItem({
        ...video,
        content: {
          kind: "video",
          transcript: [
            { startMs: 1_000, text: "後" },
            { startMs: 0, text: "前" },
          ],
        },
      }),
    ).toThrow(/ordered/);
  });

  it("requires canonical UTC timestamps and safe URLs", () => {
    const base = noteItem();
    expect(() =>
      createRawSourceItem({ ...base, publishedAt: "2026-08-12" }),
    ).toThrow(/publishedAt/);
    expect(() =>
      createRawSourceItem({ ...base, canonicalUrl: "javascript:alert(1)" }),
    ).toThrow(/http or https/);
  });
});
