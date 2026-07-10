import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  CaptureCreatedEvent,
  CaptureDiscardedEvent,
  Event,
  ItemCreatedEvent,
  LearningChannel,
  ListeningMissObservedEvent,
  LookupObservedEvent,
  ProductionCorrectionObservedEvent,
  VerificationObservedEvent,
} from "./events.js";
import { deriveLedger } from "./reducer.js";

const BASE_TIME = "2026-01-01T00:00:00.000Z";

function envelope(eventId: string, seq: number, occurredAt = BASE_TIME) {
  return {
    eventId,
    deviceId: "device-a",
    seq,
    hlc: { wallTime: Date.parse(occurredAt), counter: seq },
    occurredAt,
    recordedAt: occurredAt,
  } as const;
}

function captureCreated(
  captureId: string,
  captureType: CaptureCreatedEvent["payload"]["captureType"],
  seq = 1,
): CaptureCreatedEvent {
  return {
    ...envelope(`event-${seq}`, seq),
    kind: "capture_created",
    captureId,
    contextHash: `sha256:${captureId}`,
    payload: { captureType },
  };
}

function captureDiscarded(
  captureId: string,
  seq: number,
): CaptureDiscardedEvent {
  return {
    ...envelope(`event-${seq}`, seq),
    kind: "capture_discarded",
    captureId,
    refs: [`capture-event-${captureId}`],
    payload: { reason: "undo" },
  };
}

function itemCreated(
  itemId: string,
  captureId: string,
  targetChannels: readonly LearningChannel[],
  seq = 2,
): ItemCreatedEvent {
  return {
    ...envelope(`event-${seq}`, seq),
    kind: "item_created",
    itemId,
    captureId,
    payload: {
      display: `display-${itemId}`,
      identityKey: `identity-${itemId}`,
      targetChannels,
    },
  };
}

function lookupObserved(
  itemId: string,
  captureId: string,
  seq = 3,
  occurredAt = BASE_TIME,
): LookupObservedEvent {
  return {
    ...envelope(`event-${seq}`, seq, occurredAt),
    kind: "lookup_observed",
    itemId,
    captureId,
    payload: { channel: "R", result: "lookup" },
  };
}

function listeningMissObserved(
  itemId: string,
  captureId: string,
  seq = 3,
): ListeningMissObservedEvent {
  return {
    ...envelope(`event-${seq}`, seq),
    kind: "listening_miss_observed",
    itemId,
    captureId,
    payload: { channel: "L", result: "miss" },
  };
}

function productionCorrectionObserved(
  itemId: string,
  captureId: string,
  seq = 3,
): ProductionCorrectionObservedEvent {
  return {
    ...envelope(`event-${seq}`, seq),
    kind: "production_correction_observed",
    itemId,
    captureId,
    payload: { channel: "P", result: "correction" },
  };
}

function verificationObserved(
  itemId: string,
  channel: LearningChannel,
  result: VerificationObservedEvent["payload"]["result"],
  occurredAt: string,
  seq: number,
  options: {
    readonly immediateRetest?: boolean;
    readonly recordedAt?: string;
  } = {},
): VerificationObservedEvent {
  return {
    ...envelope(`event-${seq}`, seq, occurredAt),
    recordedAt: options.recordedAt ?? occurredAt,
    kind: "verification_observed",
    itemId,
    payload: {
      channel,
      result,
      probeSource: "review",
      immediateRetest: options.immediateRetest ?? false,
    },
  };
}

function stableRecognitionEvents(
  itemId: string,
  captureId: string,
): readonly Event[] {
  return [
    captureCreated(captureId, "lookup", 1),
    itemCreated(itemId, captureId, ["R"], 2),
    verificationObserved(
      itemId,
      "R",
      "pass",
      "2026-01-01T08:00:00.000Z",
      3,
    ),
    verificationObserved(
      itemId,
      "R",
      "pass",
      "2026-01-04T08:00:00.000Z",
      4,
    ),
    verificationObserved(
      itemId,
      "R",
      "pass",
      "2026-01-08T08:00:00.000Z",
      5,
    ),
  ];
}

function expectActivation(
  events: readonly Event[],
  itemId: string,
  channel: LearningChannel,
): void {
  const view = deriveLedger(events);

  expect(view.itemById.get(itemId)?.channels[channel]).toMatchObject({
    state: "unstable",
    lastEvidenceAt: BASE_TIME,
  });
}

describe("deriveLedger capture observations", () => {
  it("activates R as unstable after a lookup", () => {
    const events = Object.freeze([
      lookupObserved("item-r", "capture-r"),
      itemCreated("item-r", "capture-r", ["L"]),
      captureCreated("capture-r", "lookup"),
    ] satisfies readonly Event[]);

    expectActivation(events, "item-r", "R");
  });

  it("activates L as unstable after a listening miss", () => {
    const events = Object.freeze([
      listeningMissObserved("item-l", "capture-l"),
      itemCreated("item-l", "capture-l", ["R"]),
      captureCreated("capture-l", "listening_miss"),
    ] satisfies readonly Event[]);

    expectActivation(events, "item-l", "L");
  });

  it("activates P as unstable after a production correction", () => {
    const events = Object.freeze([
      productionCorrectionObserved("item-p", "capture-p"),
      itemCreated("item-p", "capture-p", ["R"]),
      captureCreated("capture-p", "production_correction"),
    ] satisfies readonly Event[]);

    expectActivation(events, "item-p", "P");
  });

  it("preserves latest fail history when an observation resets the channel", () => {
    const events = [
      captureCreated("capture-history", "lookup"),
      itemCreated("item-history", "capture-history", ["R"]),
      verificationObserved(
        "item-history",
        "R",
        "fail",
        "2026-01-02T08:00:00.000Z",
        3,
      ),
      lookupObserved(
        "item-history",
        "capture-history",
        4,
        "2026-01-03T08:00:00.000Z",
      ),
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-history")?.channels.R).toEqual(
      {
        state: "unstable",
        validPassDates: [],
        lastVerifiedAt: "2026-01-02T08:00:00.000Z",
        lastEvidenceAt: "2026-01-03T08:00:00.000Z",
        atRiskSince: "2026-01-02T08:00:00.000Z",
      },
    );
  });
});

describe("deriveLedger verification state", () => {
  it("records hesitant evidence without promoting or clearing pass dates", () => {
    const events = [
      captureCreated("capture-h", "lookup"),
      itemCreated("item-h", "capture-h", ["R"]),
      verificationObserved(
        "item-h",
        "R",
        "pass",
        "2026-01-01T08:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-h",
        "R",
        "hesitant",
        "2026-01-04T08:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-h",
        "R",
        "pass",
        "2026-01-08T08:00:00.000Z",
        5,
      ),
    ] satisfies readonly Event[];

    const item = deriveLedger(events).itemById.get("item-h");

    expect(item?.channels.R).toMatchObject({
      state: "unstable",
      validPassDates: ["2026-01-01", "2026-01-08"],
      lastVerifiedAt: "2026-01-08T08:00:00.000Z",
      lastEvidenceAt: "2026-01-08T08:00:00.000Z",
    });
    expect(item?.evidenceCount).toBe(3);
  });

  it("clears unfinished pass dates after a fail", () => {
    const events = [
      captureCreated("capture-f", "lookup"),
      itemCreated("item-f", "capture-f", ["R"]),
      verificationObserved(
        "item-f",
        "R",
        "pass",
        "2026-01-01T08:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-f",
        "R",
        "pass",
        "2026-01-04T08:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-f",
        "R",
        "fail",
        "2026-01-05T08:00:00.000Z",
        5,
      ),
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-f")?.channels.R).toMatchObject(
      {
        state: "unstable",
        validPassDates: [],
        lastVerifiedAt: "2026-01-05T08:00:00.000Z",
      },
    );
  });

  it("promotes after three qualified UTC pass dates spanning seven days", () => {
    const events = [
      captureCreated("capture-s", "lookup"),
      itemCreated("item-s", "capture-s", ["R"]),
      verificationObserved(
        "item-s",
        "R",
        "pass",
        "2026-01-01T08:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-s",
        "R",
        "pass",
        "2026-01-04T08:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-s",
        "R",
        "pass",
        "2026-01-08T08:00:00.000Z",
        5,
      ),
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-s")?.channels.R).toMatchObject(
      {
        state: "stable",
        validPassDates: ["2026-01-01", "2026-01-04", "2026-01-08"],
        lastVerifiedAt: "2026-01-08T08:00:00.000Z",
      },
    );
  });

  it("qualifies only timely non-immediate passes and counts one per UTC date", () => {
    const events = [
      captureCreated("capture-q", "lookup"),
      itemCreated("item-q", "capture-q", ["R"]),
      verificationObserved(
        "item-q",
        "R",
        "pass",
        "2026-01-01T01:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-q",
        "R",
        "pass",
        "2026-01-01T20:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-q",
        "R",
        "pass",
        "2026-01-02T08:00:00.000Z",
        5,
        { immediateRetest: true },
      ),
      verificationObserved(
        "item-q",
        "R",
        "pass",
        "2026-01-03T08:00:00.000Z",
        6,
        { recordedAt: "2026-01-04T08:00:00.001Z" },
      ),
      verificationObserved(
        "item-q",
        "R",
        "pass",
        "2026-01-08T01:00:00.000Z",
        7,
        { recordedAt: "2026-01-09T01:00:00.000Z" },
      ),
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-q")?.channels.R).toMatchObject(
      {
        state: "unstable",
        validPassDates: ["2026-01-01", "2026-01-08"],
      },
    );
  });

  it("promotes on a later pass once three dates span seven days", () => {
    const events = [
      captureCreated("capture-later", "lookup"),
      itemCreated("item-later", "capture-later", ["R"]),
      verificationObserved(
        "item-later",
        "R",
        "pass",
        "2026-01-01T08:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-later",
        "R",
        "pass",
        "2026-01-02T08:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-later",
        "R",
        "pass",
        "2026-01-03T08:00:00.000Z",
        5,
      ),
      verificationObserved(
        "item-later",
        "R",
        "pass",
        "2026-01-08T08:00:00.000Z",
        6,
      ),
    ] satisfies readonly Event[];

    expect(
      deriveLedger(events).itemById.get("item-later")?.channels.R.state,
    ).toBe("stable");
  });

  it("starts a fresh risk window when the first fail follows promotion", () => {
    const events = [
      captureCreated("capture-promoted-risk", "lookup"),
      itemCreated("item-promoted-risk", "capture-promoted-risk", ["R"]),
      verificationObserved(
        "item-promoted-risk",
        "R",
        "fail",
        "2026-01-02T08:00:00.000Z",
        3,
      ),
      verificationObserved(
        "item-promoted-risk",
        "R",
        "pass",
        "2026-01-03T08:00:00.000Z",
        4,
      ),
      verificationObserved(
        "item-promoted-risk",
        "R",
        "pass",
        "2026-01-06T08:00:00.000Z",
        5,
      ),
      verificationObserved(
        "item-promoted-risk",
        "R",
        "pass",
        "2026-01-10T08:00:00.000Z",
        6,
      ),
      verificationObserved(
        "item-promoted-risk",
        "R",
        "fail",
        "2026-01-15T08:00:00.000Z",
        7,
      ),
    ] satisfies readonly Event[];

    expect(
      deriveLedger(events).itemById.get("item-promoted-risk")?.channels.R,
    ).toMatchObject({
      state: "stable",
      atRiskSince: "2026-01-15T08:00:00.000Z",
    });
  });

  it("demotes stable after a second fail within the 30-day risk window", () => {
    const firstFail = verificationObserved(
      "item-risk",
      "R",
      "fail",
      "2026-01-10T08:00:00.000Z",
      6,
    );
    const hesitant = verificationObserved(
      "item-risk",
      "R",
      "hesitant",
      "2026-01-11T08:00:00.000Z",
      7,
    );
    const secondFail = verificationObserved(
      "item-risk",
      "R",
      "fail",
      "2026-01-20T08:00:00.000Z",
      8,
    );
    const stableEvents = stableRecognitionEvents("item-risk", "capture-risk");

    expect(
      deriveLedger([...stableEvents, firstFail]).itemById.get("item-risk")
        ?.channels.R,
    ).toMatchObject({
      state: "stable",
      atRiskSince: "2026-01-10T08:00:00.000Z",
    });
    expect(
      deriveLedger([...stableEvents, firstFail, hesitant]).itemById.get(
        "item-risk",
      )?.channels.R,
    ).toMatchObject({
      state: "stable",
      atRiskSince: "2026-01-10T08:00:00.000Z",
      lastVerifiedAt: "2026-01-11T08:00:00.000Z",
    });
    expect(
      deriveLedger([...stableEvents, firstFail, hesitant, secondFail]).itemById.get(
        "item-risk",
      )?.channels.R,
    ).toMatchObject({ state: "unstable", validPassDates: [] });
  });

  it("restarts an expired risk window and clears it only on a qualified pass", () => {
    const stableEvents = stableRecognitionEvents(
      "item-recovery",
      "capture-recovery",
    );
    const firstFail = verificationObserved(
      "item-recovery",
      "R",
      "fail",
      "2026-01-10T08:00:00.000Z",
      6,
    );
    const laterFail = verificationObserved(
      "item-recovery",
      "R",
      "fail",
      "2026-02-10T08:00:00.000Z",
      7,
    );
    const immediatePass = verificationObserved(
      "item-recovery",
      "R",
      "pass",
      "2026-02-11T08:00:00.000Z",
      8,
      { immediateRetest: true },
    );
    const qualifiedPass = verificationObserved(
      "item-recovery",
      "R",
      "pass",
      "2026-02-12T08:00:00.000Z",
      9,
    );

    const restarted = deriveLedger([
      ...stableEvents,
      firstFail,
      laterFail,
      immediatePass,
    ]).itemById.get("item-recovery")?.channels.R;
    expect(restarted).toMatchObject({
      state: "stable",
      atRiskSince: "2026-02-10T08:00:00.000Z",
    });

    const recovered = deriveLedger([
      ...stableEvents,
      firstFail,
      laterFail,
      immediatePass,
      qualifiedPass,
    ]).itemById.get("item-recovery")?.channels.R;
    expect(recovered?.state).toBe("stable");
    expect(recovered?.atRiskSince).toBeUndefined();
  });
});

describe("deriveLedger discarded captures", () => {
  it("excludes the complete capture chain but keeps capture-less verification", () => {
    const events = [
      captureDiscarded("capture-new-discarded", 10),
      productionCorrectionObserved(
        "item-discarded",
        "capture-new-discarded",
        9,
      ),
      itemCreated(
        "item-discarded",
        "capture-new-discarded",
        ["P"],
        8,
      ),
      captureCreated("capture-new-discarded", "production_correction", 7),
      verificationObserved("item-kept", "R", "pass", BASE_TIME, 6),
      captureDiscarded("capture-observation-discarded", 5),
      listeningMissObserved(
        "item-kept",
        "capture-observation-discarded",
        4,
      ),
      captureCreated("capture-observation-discarded", "listening_miss", 3),
      itemCreated("item-kept", "capture-kept", ["R"], 2),
      captureCreated("capture-kept", "lookup", 1),
    ] satisfies readonly Event[];

    const view = deriveLedger(events);

    expect(view.items.map((item) => item.itemId)).toEqual(["item-kept"]);
    expect(view.itemById.get("item-discarded")).toBeUndefined();
    expect(view.itemById.get("item-kept")?.channels.L.state).toBe("untracked");
    expect(view.itemById.get("item-kept")?.channels.R.validPassDates).toEqual([
      "2026-01-01",
    ]);
    expect(view.itemById.get("item-kept")?.evidenceCount).toBe(1);
  });
});

describe("deriveLedger deterministic event-set semantics", () => {
  it("keeps lastOccurredAt at the maximum occurrence under HLC-later backfill", () => {
    const backfilled = {
      ...verificationObserved(
        "item-recency",
        "R",
        "hesitant",
        "2026-01-05T08:00:00.000Z",
        4,
        { recordedAt: "2026-01-11T08:00:00.000Z" },
      ),
      hlc: { wallTime: Date.parse("2026-01-11T08:00:00.000Z"), counter: 0 },
    } satisfies VerificationObservedEvent;
    const events = [
      captureCreated("capture-recency", "lookup"),
      itemCreated("item-recency", "capture-recency", ["R"]),
      verificationObserved(
        "item-recency",
        "R",
        "hesitant",
        "2026-01-10T08:00:00.000Z",
        3,
      ),
      backfilled,
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-recency")?.lastOccurredAt).toBe(
      "2026-01-10T08:00:00.000Z",
    );
  });

  it("ignores observations and verifications for unknown itemIds", () => {
    const view = deriveLedger([
      lookupObserved("missing-item", "capture-missing", 1),
      verificationObserved("missing-item", "R", "fail", BASE_TIME, 2),
    ]);

    expect(view.items).toEqual([]);
    expect(view.itemById.size).toBe(0);
  });

  it("folds an identical eventId only once", () => {
    const observation = lookupObserved("item-once", "capture-once", 3);
    const events = [
      captureCreated("capture-once", "lookup", 1),
      itemCreated("item-once", "capture-once", ["R"], 2),
      observation,
      observation,
    ] satisfies readonly Event[];

    expect(deriveLedger(events).itemById.get("item-once")?.evidenceCount).toBe(
      1,
    );
  });

  it("sorts the returned items by itemId", () => {
    const events = [
      captureCreated("capture-z", "lookup", 1),
      itemCreated("z-item", "capture-z", ["R"], 2),
      captureCreated("capture-a", "lookup", 3),
      itemCreated("a-item", "capture-a", ["R"], 4),
    ] satisfies readonly Event[];

    expect(deriveLedger(events).items.map((item) => item.itemId)).toEqual([
      "a-item",
      "z-item",
    ]);
  });

  it("derives the same LedgerView for randomized event permutations", () => {
    const repeatedObservation = lookupObserved("z-item", "capture-z", 3);
    const eventSet = [
      captureCreated("capture-z", "lookup", 1),
      itemCreated("z-item", "capture-z", ["R"], 2),
      repeatedObservation,
      repeatedObservation,
      captureCreated("capture-a", "listening_miss", 4),
      itemCreated("a-item", "capture-a", ["L"], 5),
      verificationObserved(
        "a-item",
        "L",
        "pass",
        "2026-01-02T08:00:00.000Z",
        6,
      ),
      captureCreated("capture-undone", "production_correction", 7),
      productionCorrectionObserved("a-item", "capture-undone", 8),
      captureDiscarded("capture-undone", 9),
    ] satisfies readonly Event[];
    const expected = deriveLedger(eventSet);

    fc.assert(
      fc.property(
        fc.shuffledSubarray(eventSet, {
          minLength: eventSet.length,
          maxLength: eventSet.length,
        }),
        (permutation) => {
          expect(deriveLedger(permutation)).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
