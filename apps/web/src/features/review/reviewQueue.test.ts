import type { Event, LearningChannel } from "@tenjin/core";
import { deriveLedger } from "@tenjin/core";
import type { ContextRecord, LedgerSnapshot } from "@tenjin/storage-indexeddb";
import { describe, expect, it } from "vitest";

import { buildReviewQueue } from "./reviewQueue.js";

const NOW = "2026-07-11T01:00:00.000Z";

function captureEvents(
  index: number,
  type: "lookup" | "listening_miss" | "production_correction",
  channel: LearningChannel,
  occurredAt = NOW,
  targetChannels: readonly LearningChannel[] = [channel],
): Event[] {
  const captureId = `capture-${index}`;
  const itemId = `item-${index}`;
  const base = {
    schemaVersion: 1 as const,
    deviceId: "device-review-queue",
    hlc: { wallTime: index, counter: 0 },
    occurredAt,
    recordedAt: occurredAt,
    actor: "user" as const,
    ruleVersion: "vertical-slice-v1",
  };
  const observation =
    channel === "R"
      ? ({ channel: "R", result: "lookup" } as const)
      : channel === "L"
        ? ({ channel: "L", result: "miss" } as const)
        : ({ channel: "P", result: "correction" } as const);
  const observationKind =
    channel === "R"
      ? "lookup_observed"
      : channel === "L"
        ? "listening_miss_observed"
        : "production_correction_observed";

  return [
    {
      ...base,
      eventId: `event-${index}-1`,
      seq: index * 10 + 1,
      kind: "capture_created",
      captureId,
      contextHash: `context-${index}`,
      payload: { captureType: type },
    },
    {
      ...base,
      eventId: `event-${index}-2`,
      seq: index * 10 + 2,
      kind: "item_created",
      captureId,
      itemId,
      refs: [`event-${index}-1`],
      payload: {
        display: channel === "P" ? "話します" : `material-${index}`,
        identityKey: `identity-${index}`,
        targetChannels,
      },
    },
    {
      ...base,
      eventId: `event-${index}-3`,
      seq: index * 10 + 3,
      kind: observationKind,
      captureId,
      itemId,
      refs: [`event-${index}-1`],
      payload: observation,
    } as Event,
  ];
}

function context(
  index: number,
  original: string,
  corrected?: string,
): ContextRecord {
  return {
    hash: `context-${index}`,
    original,
    ...(corrected === undefined ? {} : { corrected }),
    createdAt: NOW,
  };
}

describe("buildReviewQueue", () => {
  it("queues real L material and hides a P correction until reveal", () => {
    const events = [
      ...captureEvents(1, "lookup", "R"),
      ...captureEvents(2, "listening_miss", "L"),
      ...captureEvents(3, "production_correction", "P"),
    ];
    const snapshot: LedgerSnapshot = {
      events,
      contexts: [
        context(1, "一期一会"),
        context(2, "聞き取れなかった音"),
        context(3, "話すです", "話します"),
      ],
    };

    expect(buildReviewQueue(deriveLedger(events), snapshot, 5)).toEqual([
      expect.objectContaining({
        itemId: "item-2",
        channel: "L",
        prompt: "聞き取れなかった音",
        reveal: undefined,
      }),
      expect.objectContaining({
        itemId: "item-3",
        channel: "P",
        prompt: "話すです",
        reveal: { label: "纠正后的表达", text: "話します" },
      }),
    ]);
  });

  it("excludes lookup-only, incomplete P, discarded, and missing-context items", () => {
    const lookup = captureEvents(1, "lookup", "R");
    const incompleteProduction = captureEvents(
      2,
      "production_correction",
      "P",
    );
    const missingContext = captureEvents(3, "listening_miss", "L");
    const discarded = captureEvents(4, "listening_miss", "L");
    const discardEvent: Event = {
      schemaVersion: 1,
      eventId: "event-discard",
      deviceId: "device-review-queue",
      seq: 99,
      hlc: { wallTime: 99, counter: 0 },
      occurredAt: NOW,
      recordedAt: NOW,
      actor: "user",
      ruleVersion: "vertical-slice-v1",
      kind: "capture_discarded",
      captureId: "capture-4",
      payload: { reason: "undo" },
    };
    const events = [
      ...lookup,
      ...incompleteProduction,
      ...missingContext,
      ...discarded,
      discardEvent,
    ];

    expect(
      buildReviewQueue(
        deriveLedger(events),
        {
          events,
          contexts: [
            context(1, "lookup only"),
            context(2, "original without correction"),
            context(4, "discarded material"),
          ],
        },
        5,
      ),
    ).toEqual([]);
  });

  it("uses excluded lookup activity to age an old failure out of the recent tier", () => {
    const oldListening = captureEvents(
      1,
      "listening_miss",
      "L",
      "2026-01-01T00:00:00.000Z",
    );
    const oldFailure: Event = {
      schemaVersion: 1,
      eventId: "event-old-failure",
      deviceId: "device-review-queue",
      seq: 19,
      hlc: { wallTime: 19, counter: 0 },
      occurredAt: "2026-01-02T00:00:00.000Z",
      recordedAt: "2026-01-02T00:00:00.000Z",
      actor: "user",
      ruleVersion: "vertical-slice-v1",
      kind: "verification_observed",
      itemId: "item-1",
      payload: {
        channel: "L",
        result: "fail",
        probeSource: "review",
        immediateRetest: false,
      },
    };
    const recentLookup = captureEvents(
      2,
      "lookup",
      "R",
      "2026-03-15T00:00:00.000Z",
    );
    const events = [...oldListening, oldFailure, ...recentLookup];

    expect(
      buildReviewQueue(
        deriveLedger(events),
        {
          events,
          contexts: [
            context(1, "old listening material"),
            context(2, "recent lookup only"),
          ],
        },
        5,
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "item-1",
        channel: "L",
        reason: "unstable",
      }),
    ]);
  });

  it("binds review material to the capture channel instead of every item channel", () => {
    const events = captureEvents(
      5,
      "production_correction",
      "P",
      NOW,
      ["R", "L", "P"],
    );

    expect(
      buildReviewQueue(
        deriveLedger(events),
        {
          events,
          contexts: [context(5, "話すです", "話します")],
        },
        5,
      ).map(({ channel, prompt, reveal }) => ({ channel, prompt, reveal })),
    ).toEqual([
      {
        channel: "P",
        prompt: "話すです",
        reveal: { label: "纠正后的表达", text: "話します" },
      },
    ]);
  });
});
