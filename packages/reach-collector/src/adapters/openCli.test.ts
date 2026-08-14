import { describe, expect, it, vi } from "vitest";

import { collectOpenCliSource, probeInstagramSaved } from "./openCli.js";

describe("OpenCLI adapters", () => {
  it("hydrates YouTube history rows with per-URL transcript cues", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([{ title: "日本語", channel: "先生", url: "https://www.youtube.com/watch?v=abc" }]) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([{ start: "1.25s", end: "2.50s", text: "こんにちは" }]) });
    const [item] = await collectOpenCliSource({ id: "yt.h", kind: "youtube-history", accountScope: "me", enabled: true, limit: 2, transcriptLanguage: "ja" }, { run });
    expect(item).toMatchObject({ externalId: "abc", interaction: "history", content: { transcript: [{ startMs: 1250, endMs: 2500, text: "こんにちは" }] } });
  });

  it("caps upstream rows before converting or hydrating the item beyond the configured limit", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          { title: "first", url: "https://www.youtube.com/watch?v=first" },
          { title: "second", url: "https://www.youtube.com/watch?v=second" },
          { url: "https://www.youtube.com/watch?v=third" },
        ]),
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "[]" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "[]" });

    const items = await collectOpenCliSource(
      {
        id: "yt.h",
        kind: "youtube-history",
        accountScope: "me",
        enabled: true,
        limit: 2,
        transcriptLanguage: "ja",
      },
      { run },
    );

    expect(items.map((item) => item.externalId)).toEqual(["first", "second"]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.flatMap(([spec]) => spec.args)).not.toContain(
      "https://www.youtube.com/watch?v=third",
    );
  });

  it("normalizes X bookmarks and keeps Instagram as a probe only", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify([{ id: "42", author: "a", text: "勉強します", url: "https://x.com/a/status/42" }]) });
    const [item] = await collectOpenCliSource({ id: "x.b", kind: "x-bookmarks", accountScope: "me", enabled: true, limit: 2 }, { run });
    expect(item).toMatchObject({ externalId: "42", interaction: "bookmark", platform: "x" });
    const probe = await probeInstagramSaved({ id: "ig", kind: "instagram-saved-probe", accountScope: "me", enabled: true, limit: 1 }, { run });
    expect(probe).toEqual({ supported: false, reachable: true, reason: "unstable-identity" });
  });
});
