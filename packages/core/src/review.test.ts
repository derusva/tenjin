import { describe, expect, it } from "vitest";

import type {
  Event,
  ItemCreatedEvent,
  LearningChannel,
  LookupObservedEvent,
  VerificationObservedEvent,
} from "./events.js";
import { deriveLedger } from "./reducer.js";
import { selectReviewItems } from "./review.js";

function eventBuilder() {
  let seq = 0;
  const events: Event[] = [];

  function envelope(occurredAt: string) {
    seq += 1;
    return {
      eventId: `event-${seq}`,
      deviceId: "review-device",
      seq,
      hlc: { wallTime: Date.parse(occurredAt), counter: seq },
      occurredAt,
      recordedAt: occurredAt,
    } as const;
  }

  function item(
    itemId: string,
    targetChannels: readonly LearningChannel[],
  ): void {
    events.push({
      ...envelope("2026-01-01T00:00:00.000Z"),
      kind: "item_created",
      itemId,
      captureId: `capture-${itemId}`,
      payload: {
        display: `display-${itemId}`,
        identityKey: `identity-${itemId}`,
        targetChannels,
      },
    } satisfies ItemCreatedEvent);
  }

  function verify(
    itemId: string,
    channel: LearningChannel,
    result: VerificationObservedEvent["payload"]["result"],
    occurredAt: string,
  ): void {
    events.push({
      ...envelope(occurredAt),
      kind: "verification_observed",
      itemId,
      payload: {
        channel,
        result,
        probeSource: "review",
        immediateRetest: false,
      },
    } satisfies VerificationObservedEvent);
  }

  function lookup(itemId: string, occurredAt: string): void {
    events.push({
      ...envelope(occurredAt),
      kind: "lookup_observed",
      itemId,
      captureId: `capture-lookup-${itemId}`,
      payload: { channel: "R", result: "lookup" },
    } satisfies LookupObservedEvent);
  }

  function stable(itemId: string, dates: readonly string[]): void {
    item(itemId, ["R"]);
    for (const occurredAt of dates) {
      verify(itemId, "R", "pass", occurredAt);
    }
  }

  return { events, item, verify, lookup, stable };
}

function summary(items: ReturnType<typeof selectReviewItems>) {
  return items.map(({ itemId, channel, reason }) => ({
    itemId,
    channel,
    reason,
  }));
}

describe("selectReviewItems", () => {
  it("keeps a recent fail in Tier 1 after a later lookup reset", () => {
    const builder = eventBuilder();
    builder.item("item-history", ["R"]);
    builder.verify(
      "item-history",
      "R",
      "fail",
      "2026-03-20T12:00:00.000Z",
    );
    builder.lookup("item-history", "2026-03-21T12:00:00.000Z");

    expect(summary(selectReviewItems(deriveLedger(builder.events), 1))).toEqual([
      { itemId: "item-history", channel: "R", reason: "recent-failure" },
    ]);
  });

  it("orders fixed-budget tiers and limits stable checking to one channel", () => {
    const builder = eventBuilder();
    builder.item("recent-boundary", ["R"]);
    builder.verify(
      "recent-boundary",
      "R",
      "fail",
      "2026-03-01T12:00:00.000Z",
    );
    builder.item("recent-new", ["L"]);
    builder.verify("recent-new", "L", "fail", "2026-03-20T12:00:00.000Z");
    builder.item("missing", ["R", "L", "P"]);
    builder.item("old-fail", ["R"]);
    builder.verify("old-fail", "R", "fail", "2026-01-15T12:00:00.000Z");
    builder.item("unstable-verified", ["P"]);
    builder.verify(
      "unstable-verified",
      "P",
      "hesitant",
      "2026-03-31T12:00:00.000Z",
    );
    builder.stable("stable-a", [
      "2026-01-01T08:00:00.000Z",
      "2026-01-04T08:00:00.000Z",
      "2026-01-08T08:00:00.000Z",
    ]);
    builder.stable("stable-b", [
      "2026-01-02T08:00:00.000Z",
      "2026-01-05T08:00:00.000Z",
      "2026-01-09T08:00:00.000Z",
    ]);
    const view = deriveLedger(builder.events);

    const selected = selectReviewItems(view, 20);

    expect(summary(selected)).toEqual([
      { itemId: "recent-boundary", channel: "R", reason: "recent-failure" },
      { itemId: "recent-new", channel: "L", reason: "recent-failure" },
      { itemId: "missing", channel: "R", reason: "unstable" },
      { itemId: "missing", channel: "L", reason: "unstable" },
      { itemId: "missing", channel: "P", reason: "unstable" },
      { itemId: "old-fail", channel: "R", reason: "unstable" },
      { itemId: "unstable-verified", channel: "P", reason: "unstable" },
      { itemId: "stable-a", channel: "R", reason: "stable-check" },
    ]);
    expect(selected[0]?.item).toBe(view.itemById.get("recent-boundary"));
  });

  it("returns no work for a non-positive budget and truncates a positive budget", () => {
    const builder = eventBuilder();
    builder.item("item-budget", ["R", "L", "P"]);
    const view = deriveLedger(builder.events);

    expect(selectReviewItems(view, 0)).toEqual([]);
    expect(selectReviewItems(view, -1)).toEqual([]);
    expect(summary(selectReviewItems(view, 2))).toEqual([
      { itemId: "item-budget", channel: "R", reason: "unstable" },
      { itemId: "item-budget", channel: "L", reason: "unstable" },
    ]);
  });
});
