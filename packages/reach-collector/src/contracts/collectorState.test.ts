import { describe, expect, it } from "vitest";

import {
  createEmptyCollectorState,
  hasSeenRevision,
  parseCollectorState,
  recordSeenRevision,
  recordSourceSuccess,
} from "./collectorState.js";
import { createRawSourceItem } from "./rawSourceItem.js";

const ITEM = createRawSourceItem({
  sourceId: "fixture.saved",
  accountScope: "test",
  platform: "fixture",
  externalId: "1",
  canonicalUrl: "https://example.test/1",
  interaction: "saved",
  content: { kind: "post", text: "今日は日本語を勉強します。" },
  backend: { name: "fixture" },
});

const SAME_REVISION_FROM_ANOTHER_SOURCE = createRawSourceItem({
  ...ITEM,
  sourceId: "fixture.alpha",
});

describe("CollectorStateV1", () => {
  it("records source cursors and stable seen revisions", () => {
    const empty = createEmptyCollectorState();
    const withSource = recordSourceSuccess(
      empty,
      ITEM.sourceId,
      "2026-08-12T01:00:00.000Z",
      "cursor-2",
    );
    const first = recordSeenRevision(
      withSource,
      ITEM,
      "2026-08-12T01:01:00.000Z",
    );
    const seenAgain = recordSeenRevision(
      first,
      ITEM,
      "2026-08-12T02:01:00.000Z",
    );
    expect(hasSeenRevision(seenAgain, ITEM)).toBe(true);
    expect(seenAgain.revisions[ITEM.itemKey]).toMatchObject({
      sourceIds: [ITEM.sourceId],
      firstSeenAt: "2026-08-12T01:01:00.000Z",
      lastSeenAt: "2026-08-12T02:01:00.000Z",
    });
    expect(parseCollectorState(seenAgain)).toEqual(seenAgain);
  });

  it("tracks every source that observed the same revision in stable order", () => {
    const first = recordSeenRevision(
      createEmptyCollectorState(),
      ITEM,
      "2026-08-12T01:00:00.000Z",
    );
    const observedByBoth = recordSeenRevision(
      first,
      SAME_REVISION_FROM_ANOTHER_SOURCE,
      "2026-08-12T02:00:00.000Z",
    );

    expect(SAME_REVISION_FROM_ANOTHER_SOURCE.itemKey).toBe(ITEM.itemKey);
    expect(SAME_REVISION_FROM_ANOTHER_SOURCE.revisionKey).toBe(ITEM.revisionKey);
    expect(observedByBoth.revisions[ITEM.itemKey]).toMatchObject({
      sourceIds: ["fixture.alpha", "fixture.saved"],
      firstSeenAt: "2026-08-12T01:00:00.000Z",
      lastSeenAt: "2026-08-12T02:00:00.000Z",
    });
    expect(parseCollectorState(observedByBoth)).toEqual(observedByBoth);
  });

  it("resets source ownership and first-seen time for a new revision", () => {
    const first = recordSeenRevision(
      createEmptyCollectorState(),
      ITEM,
      "2026-08-12T01:00:00.000Z",
    );
    const revised = createRawSourceItem({
      ...ITEM,
      sourceId: "fixture.alpha",
      content: {
        kind: "post",
        text: "\u65b0\u3057\u3044\u5185\u5bb9\u3067\u65e5\u672c\u8a9e\u3092\u5fa9\u7fd2\u3057\u307e\u3059\u3002",
      },
    });
    const second = recordSeenRevision(
      first,
      revised,
      "2026-08-12T03:00:00.000Z",
    );

    expect(second.revisions[ITEM.itemKey]).toMatchObject({
      sourceIds: ["fixture.alpha"],
      revisionKey: revised.revisionKey,
      firstSeenAt: "2026-08-12T03:00:00.000Z",
      lastSeenAt: "2026-08-12T03:00:00.000Z",
    });
  });

  it("preserves the previous cursor when success has no new cursor", () => {
    const first = recordSourceSuccess(
      createEmptyCollectorState(),
      ITEM.sourceId,
      "2026-08-12T01:00:00.000Z",
      "cursor-2",
    );
    expect(
      recordSourceSuccess(first, ITEM.sourceId, "2026-08-12T02:00:00.000Z")
        .sources[ITEM.sourceId]?.cursor,
    ).toBe("cursor-2");
  });

  it("fails closed on unknown fields and malformed digests", () => {
    const state = recordSeenRevision(
      createEmptyCollectorState(),
      ITEM,
      "2026-08-12T01:00:00.000Z",
    );
    expect(() => parseCollectorState({ ...state, future: true })).toThrow(
      /not allowed/,
    );
    expect(() =>
      parseCollectorState({
        ...state,
        revisions: {
          short: state.revisions[ITEM.itemKey],
        },
      }),
    ).toThrow(/sha256/);
  });

  it("rejects duplicate or non-deterministically ordered source IDs", () => {
    const state = recordSeenRevision(
      createEmptyCollectorState(),
      ITEM,
      "2026-08-12T01:00:00.000Z",
    );
    const revision = state.revisions[ITEM.itemKey]!;

    for (const sourceIds of [
      [ITEM.sourceId, ITEM.sourceId],
      ["fixture.saved", "fixture.alpha"],
    ]) {
      expect(() =>
        parseCollectorState({
          ...state,
          revisions: {
            [ITEM.itemKey]: { ...revision, sourceIds },
          },
        }),
      ).toThrow(/sorted and contain no duplicates/);
    }
  });

  it("rejects time travel in a revision record", () => {
    const state = recordSeenRevision(
      createEmptyCollectorState(),
      ITEM,
      "2026-08-12T01:00:00.000Z",
    );
    expect(() =>
      parseCollectorState({
        ...state,
        revisions: {
          [ITEM.itemKey]: {
            ...state.revisions[ITEM.itemKey],
            firstSeenAt: "2026-08-12T03:00:00.000Z",
          },
        },
      }),
    ).toThrow(/must not precede/);
  });
});
