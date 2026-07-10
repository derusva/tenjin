import { describe, expect, it } from "vitest";

import {
  validateEvent,
  type CaptureCreatedEvent,
} from "./events.js";

const captureCreatedEvent = {
  eventId: "event-1",
  deviceId: "device-1",
  seq: 1,
  hlc: {
    wallTime: 1_783_702_800_000,
    counter: 0,
  },
  occurredAt: "2026-07-11T00:20:00.000Z",
  recordedAt: "2026-07-11T00:20:01.000Z",
  kind: "capture_created",
  captureId: "capture-1",
  contextHash: "sha256:context-1",
  payload: {
    captureType: "lookup",
    captureDurationMs: 4_200,
  },
} as const satisfies CaptureCreatedEvent;

const supportedEvents = [
  captureCreatedEvent,
  {
    ...captureCreatedEvent,
    kind: "capture_discarded",
    payload: { reason: "undo" },
  },
  {
    ...captureCreatedEvent,
    kind: "item_created",
    itemId: "item-1",
    payload: {
      display: "天神",
      identityKey: "天神",
      targetChannels: ["R"],
    },
  },
  {
    ...captureCreatedEvent,
    kind: "lookup_observed",
    itemId: "item-1",
    payload: { channel: "R", result: "lookup" },
  },
  {
    ...captureCreatedEvent,
    kind: "listening_miss_observed",
    itemId: "item-1",
    payload: { channel: "L", result: "miss" },
  },
  {
    ...captureCreatedEvent,
    kind: "production_correction_observed",
    itemId: "item-1",
    payload: { channel: "P", result: "correction" },
  },
  {
    ...captureCreatedEvent,
    kind: "verification_observed",
    itemId: "item-1",
    payload: {
      channel: "R",
      result: "pass",
      probeSource: "review",
      immediateRetest: false,
    },
  },
] as const;

function expectInvalidField(candidate: unknown, field: string): void {
  const result = validateEvent(candidate);

  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field }),
      ]),
    );
  }
}

describe("validateEvent", () => {
  it("returns the event when its envelope is valid", () => {
    expect(validateEvent(captureCreatedEvent)).toEqual({
      valid: true,
      value: captureCreatedEvent,
    });
  });

  it("rejects non-object input without throwing", () => {
    expect(validateEvent(null)).toEqual({
      valid: false,
      errors: [
        {
          field: "$",
          message: "event must be an object",
        },
      ],
    });
  });

  it.each(["", "   ", 42])(
    "rejects an invalid eventId (%j)",
    (eventId) => {
      expectInvalidField({ ...captureCreatedEvent, eventId }, "eventId");
    },
  );

  it.each(["", "   ", null])(
    "rejects an invalid deviceId (%j)",
    (deviceId) => {
      expectInvalidField({ ...captureCreatedEvent, deviceId }, "deviceId");
    },
  );

  it.each(["input", "correctedSentence"])(
    "rejects raw capture content in payload.%s",
    (rawField) => {
      expectInvalidField(
        {
          ...captureCreatedEvent,
          payload: {
            ...captureCreatedEvent.payload,
            [rawField]: "raw context belongs in context storage",
          },
        },
        `payload.${rawField}`,
      );
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects an invalid seq (%j)",
    (seq) => {
      expectInvalidField({ ...captureCreatedEvent, seq }, "seq");
    },
  );

  it.each([
    [null, "hlc"],
    [{ counter: 0 }, "hlc.wallTime"],
    [{ wallTime: -1, counter: 0 }, "hlc.wallTime"],
    [{ wallTime: 1.5, counter: 0 }, "hlc.wallTime"],
    [{ wallTime: 1_783_702_800_000, counter: -1 }, "hlc.counter"],
    [{ wallTime: 1_783_702_800_000, counter: 0.5 }, "hlc.counter"],
  ])("rejects an invalid HLC %j", (hlc, field) => {
    expectInvalidField({ ...captureCreatedEvent, hlc }, field);
  });

  it.each([
    "",
    "not-a-timestamp",
    1_783_702_800_000,
    "2026-07-11",
    "2026-07-11T08:20:00.000+08:00",
    "2026-07-11T00:20:00Z",
  ])(
    "rejects an invalid occurredAt (%j)",
    (occurredAt) => {
      expectInvalidField(
        { ...captureCreatedEvent, occurredAt },
        "occurredAt",
      );
    },
  );

  it.each([
    "",
    "not-a-timestamp",
    1_783_702_801_000,
    "2026-07-11T08:20:01.000+08:00",
  ])(
    "rejects an invalid recordedAt (%j)",
    (recordedAt) => {
      expectInvalidField(
        { ...captureCreatedEvent, recordedAt },
        "recordedAt",
      );
    },
  );

  it("rejects occurredAt later than recordedAt", () => {
    expectInvalidField(
      {
        ...captureCreatedEvent,
        occurredAt: "2026-07-11T00:20:02.000Z",
        recordedAt: "2026-07-11T00:20:01.000Z",
      },
      "occurredAt",
    );
  });

  it.each(supportedEvents)("accepts the supported kind $kind", (event) => {
    expect(validateEvent(event).valid).toBe(true);
  });

  it("rejects an unsupported kind", () => {
    expectInvalidField(
      { ...captureCreatedEvent, kind: "future_event" },
      "kind",
    );
  });

  it.each([
    [{ ...captureCreatedEvent, captureId: "" }, "captureId"],
    [{ ...captureCreatedEvent, contextHash: "" }, "contextHash"],
    [{ ...captureCreatedEvent, payload: null }, "payload"],
    [
      { ...captureCreatedEvent, payload: { captureDurationMs: 4_200 } },
      "payload.captureType",
    ],
    [
      {
        ...captureCreatedEvent,
        payload: { captureType: "encounter", captureDurationMs: 4_200 },
      },
      "payload.captureType",
    ],
    [
      {
        ...captureCreatedEvent,
        payload: { captureType: "lookup", captureDurationMs: -1 },
      },
      "payload.captureDurationMs",
    ],
  ])("rejects invalid capture_created metadata %j", (candidate, field) => {
    expectInvalidField(candidate, field);
  });

  it.each([
    [{ ...supportedEvents[1], captureId: "" }, "captureId"],
    [{ ...supportedEvents[1], payload: null }, "payload"],
    [{ ...supportedEvents[2], itemId: "" }, "itemId"],
    [{ ...supportedEvents[2], captureId: "" }, "captureId"],
    [
      { ...supportedEvents[2], payload: { ...supportedEvents[2].payload, display: "" } },
      "payload.display",
    ],
    [
      {
        ...supportedEvents[2],
        payload: { ...supportedEvents[2].payload, identityKey: "" },
      },
      "payload.identityKey",
    ],
    [
      {
        ...supportedEvents[2],
        payload: { ...supportedEvents[2].payload, targetChannels: [] },
      },
      "payload.targetChannels",
    ],
    [{ ...supportedEvents[3], itemId: "" }, "itemId"],
    [{ ...supportedEvents[3], captureId: "" }, "captureId"],
    [
      { ...supportedEvents[3], payload: { channel: "L", result: "lookup" } },
      "payload.channel",
    ],
    [
      { ...supportedEvents[3], payload: { channel: "R", result: "miss" } },
      "payload.result",
    ],
    [
      { ...supportedEvents[4], payload: { channel: "R", result: "miss" } },
      "payload.channel",
    ],
    [
      { ...supportedEvents[4], payload: { channel: "L", result: "lookup" } },
      "payload.result",
    ],
    [
      {
        ...supportedEvents[5],
        payload: { channel: "R", result: "correction" },
      },
      "payload.channel",
    ],
    [
      { ...supportedEvents[5], payload: { channel: "P", result: "miss" } },
      "payload.result",
    ],
    [{ ...supportedEvents[6], itemId: "" }, "itemId"],
    [
      { ...supportedEvents[6], payload: { ...supportedEvents[6].payload, channel: "X" } },
      "payload.channel",
    ],
    [
      { ...supportedEvents[6], payload: { ...supportedEvents[6].payload, result: "lookup" } },
      "payload.result",
    ],
    [
      { ...supportedEvents[6], payload: { channel: "R", result: "pass", immediateRetest: false } },
      "payload.probeSource",
    ],
    [
      { ...supportedEvents[6], payload: { channel: "R", result: "pass", probeSource: "review" } },
      "payload.immediateRetest",
    ],
  ])("rejects invalid kind-specific fields %j", (candidate, field) => {
    expectInvalidField(candidate, field);
  });

  it.each([
    [{ ...captureCreatedEvent, schemaVersion: "1" }, "schemaVersion"],
    [{ ...captureCreatedEvent, actor: "admin" }, "actor"],
    [{ ...captureCreatedEvent, ruleVersion: 1 }, "ruleVersion"],
    [{ ...captureCreatedEvent, itemId: 1 }, "itemId"],
    [{ ...captureCreatedEvent, refs: ["event-0", 1] }, "refs"],
  ])("rejects invalid optional envelope fields %j", (candidate, field) => {
    expectInvalidField(candidate, field);
  });

  it("rejects an explicitly undefined captureDurationMs", () => {
    expectInvalidField(
      {
        ...captureCreatedEvent,
        payload: {
          captureType: "lookup",
          captureDurationMs: undefined,
        },
      },
      "payload.captureDurationMs",
    );
  });

  it("rejects an explicitly undefined capture discard reason", () => {
    expectInvalidField(
      {
        ...supportedEvents[1],
        payload: { reason: undefined },
      },
      "payload.reason",
    );
  });
});
