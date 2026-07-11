import {
  type Event,
  type LearningChannel,
  type VerificationObservedEvent,
} from "@tenjin/core";
import { describe, expect, it } from "vitest";

import { createLedgerRuntime } from "./ledgerRuntime.js";

const EARLIER = "2026-07-11T01:00:00.000Z";
const LATER = "2026-07-11T02:00:00.000Z";

function existingVerification(
  deviceId: string,
  seq: number,
  wallTime: number,
  counter: number,
): VerificationObservedEvent {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter },
    occurredAt: EARLIER,
    recordedAt: EARLIER,
    actor: "user",
    kind: "verification_observed",
    ruleVersion: "vertical-slice-v1",
    itemId: "item-existing",
    payload: {
      channel: "R",
      result: "pass",
      probeSource: "review",
      immediateRetest: false,
    },
  };
}

function runtimeHarness(options: {
  readonly dates?: readonly string[];
  readonly existingEvents?: readonly Event[];
  readonly digests?: readonly string[];
}) {
  const dates = [...(options.dates ?? [LATER])];
  const uuids = ["capture-uuid", "item-uuid", "next-uuid"];
  const digestInputs: string[] = [];
  const digests = [...(options.digests ?? ["A1B2C3"])]

  const runtime = createLedgerRuntime({
    deviceId: "device-local",
    existingEvents: options.existingEvents ?? [],
    now: () => new Date(dates.shift() ?? LATER),
    randomUUID: () => uuids.shift() ?? "fallback-uuid",
    digest: async (text) => {
      digestInputs.push(text);
      return digests.shift() ?? "d00d";
    },
  });

  return { digestInputs, runtime };
}

describe("createLedgerRuntime", () => {
  it("rejects a blank device ID before creating runtime state", () => {
    expect(() =>
      createLedgerRuntime({
        deviceId: "  ",
        existingEvents: [],
        now: () => new Date(LATER),
        randomUUID: () => "uuid",
        digest: async () => "abc",
      }),
    ).toThrow("deviceId");
  });

  it("continues the local sequence and creates prefixed capture and item IDs", async () => {
    const existingEvents: Event[] = [
      existingVerification("device-local", 7, Date.parse(EARLIER), 0),
      existingVerification("device-other", 99, Date.parse(EARLIER), 1),
    ];
    const { digestInputs, runtime } = runtimeHarness({ existingEvents });

    const transaction = await runtime.createCapture({
      type: "lookup",
      original: "  Tenjin  ",
    });

    expect(transaction.events.map(({ eventId, seq }) => ({ eventId, seq }))).toEqual([
      { eventId: "device-local:8", seq: 8 },
      { eventId: "device-local:9", seq: 9 },
      { eventId: "device-local:10", seq: 10 },
    ]);
    expect(transaction.events[0]).toMatchObject({
      captureId: "capture-capture-uuid",
      contextHash: "sha256:a1b2c3",
    });
    expect(transaction.events[1]).toMatchObject({ itemId: "item-item-uuid" });
    expect(digestInputs).toEqual([JSON.stringify({ original: "Tenjin" })]);
  });

  it("hashes corrected context with deterministic property order", async () => {
    const { digestInputs, runtime } = runtimeHarness({
      digests: ["ABCDEF0123"],
    });

    const transaction = await runtime.createCapture({
      type: "production_correction",
      original: "話すです",
      corrected: "話します",
    });

    expect(digestInputs).toEqual([
      JSON.stringify({ original: "話すです", corrected: "話します" }),
    ]);
    expect(transaction.context.hash).toBe("sha256:abcdef0123");
  });

  it("keeps physical time scoped to each overlapping capture", async () => {
    const resolutions = new Map<string, (digest: string) => void>();
    const dates = [new Date(EARLIER), new Date(LATER)];
    const runtime = createLedgerRuntime({
      deviceId: "device-local",
      existingEvents: [],
      now: () => dates.shift() ?? new Date(LATER),
      randomUUID: () => "uuid",
      digest: (text) =>
        new Promise<string>((resolve) => {
          resolutions.set(text, resolve);
        }),
    });

    const firstPromise = runtime.createCapture({
      type: "lookup",
      original: "first",
    });
    const secondPromise = runtime.createCapture({
      type: "lookup",
      original: "second",
    });

    resolutions.get(JSON.stringify({ original: "first" }))?.("aa");
    const first = await firstPromise;
    expect(first.events.map((event) => event.hlc)).toEqual([
      { wallTime: Date.parse(EARLIER), counter: 0 },
      { wallTime: Date.parse(EARLIER), counter: 1 },
      { wallTime: Date.parse(EARLIER), counter: 2 },
    ]);

    resolutions.get(JSON.stringify({ original: "second" }))?.("bb");
    const second = await secondPromise;
    expect(second.events.map((event) => event.hlc)).toEqual([
      { wallTime: Date.parse(LATER), counter: 0 },
      { wallTime: Date.parse(LATER), counter: 1 },
      { wallTime: Date.parse(LATER), counter: 2 },
    ]);
  });

  it("advances HLC monotonically when physical time is equal or moves backward", () => {
    const persistedWallTime = Date.parse(LATER);
    const existingEvents: Event[] = [
      existingVerification("device-other", 2, persistedWallTime, 4),
    ];
    const { runtime } = runtimeHarness({
      existingEvents,
      dates: [LATER, EARLIER, "2026-07-11T03:00:00.000Z"],
    });

    const first = runtime.createVerification("item-1", "R", "pass");
    const second = runtime.createVerification("item-1", "L", "hesitant");
    const third = runtime.createVerification("item-1", "P", "fail");

    expect(first.hlc).toEqual({ wallTime: persistedWallTime, counter: 5 });
    expect(second.hlc).toEqual({ wallTime: persistedWallTime, counter: 6 });
    expect(third.hlc).toEqual({
      wallTime: Date.parse("2026-07-11T03:00:00.000Z"),
      counter: 0,
    });
  });

  it.each<{
    readonly channel: LearningChannel;
    readonly result: "pass" | "hesitant" | "fail";
  }>([
    { channel: "R", result: "pass" },
    { channel: "L", result: "hesitant" },
    { channel: "P", result: "fail" },
  ])("creates a $channel $result review verification", ({ channel, result }) => {
    const { runtime } = runtimeHarness({});

    const event = runtime.createVerification("item-42", channel, result);

    expect(event).toMatchObject({
      schemaVersion: 1,
      eventId: "device-local:1",
      deviceId: "device-local",
      seq: 1,
      occurredAt: LATER,
      recordedAt: LATER,
      actor: "user",
      kind: "verification_observed",
      ruleVersion: "vertical-slice-v1",
      itemId: "item-42",
      payload: {
        channel,
        result,
        probeSource: "review",
        immediateRetest: false,
      },
    });
  });

  it("creates an undo discard event for a capture", () => {
    const { runtime } = runtimeHarness({});

    const event = runtime.createDiscard("capture-42");

    expect(event).toMatchObject({
      schemaVersion: 1,
      eventId: "device-local:1",
      deviceId: "device-local",
      seq: 1,
      actor: "user",
      kind: "capture_discarded",
      ruleVersion: "vertical-slice-v1",
      captureId: "capture-42",
      payload: { reason: "undo" },
    });
  });
});
