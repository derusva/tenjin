import { describe, expect, it } from "vitest";
import type { Event } from "@tenjin/core";
import { compareEventsCanonically, sortEventsCanonically } from "./eventOrder.js";

function stub(
  overrides: Partial<{
    eventId: string;
    deviceId: string;
    seq: number;
    wallTime: number;
    counter: number;
  }>,
): Event {
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? "device-a:1",
    deviceId: overrides.deviceId ?? "device-a",
    seq: overrides.seq ?? 1,
    hlc: {
      wallTime: overrides.wallTime ?? 1_000,
      counter: overrides.counter ?? 0,
    },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "item_created",
    itemId: "item-1",
    captureId: "capture-1",
    payload: {
      display: "手を打つ",
      identityKey: "手を打つ",
      targetChannels: ["R"],
    },
  } as Event;
}

describe("compareEventsCanonically", () => {
  it("orders by wallTime first", () => {
    const older = stub({ wallTime: 1 });
    const newer = stub({ wallTime: 2 });
    expect(compareEventsCanonically(older, newer)).toBeLessThan(0);
    expect(compareEventsCanonically(newer, older)).toBeGreaterThan(0);
  });

  it("breaks wallTime ties with the counter", () => {
    const first = stub({ wallTime: 1, counter: 0 });
    const second = stub({ wallTime: 1, counter: 1 });
    expect(compareEventsCanonically(first, second)).toBeLessThan(0);
  });

  it("breaks clock ties with deviceId then seq then eventId", () => {
    const a = stub({ deviceId: "device-a", seq: 2, eventId: "device-a:2" });
    const b = stub({ deviceId: "device-b", seq: 1, eventId: "device-b:1" });
    expect(compareEventsCanonically(a, b)).toBeLessThan(0);

    const seqLow = stub({ deviceId: "device-a", seq: 1, eventId: "x" });
    const seqHigh = stub({ deviceId: "device-a", seq: 2, eventId: "a" });
    expect(compareEventsCanonically(seqLow, seqHigh)).toBeLessThan(0);
  });

  it("returns 0 only for identical ordering keys", () => {
    expect(compareEventsCanonically(stub({}), stub({}))).toBe(0);
  });
});

describe("sortEventsCanonically", () => {
  it("produces the same order regardless of input order", () => {
    const events = [
      stub({ eventId: "device-b:1", deviceId: "device-b", wallTime: 3 }),
      stub({ eventId: "device-a:1", deviceId: "device-a", wallTime: 1 }),
      stub({ eventId: "device-a:2", deviceId: "device-a", seq: 2, wallTime: 2 }),
    ];
    const forward = sortEventsCanonically(events).map((event) => event.eventId);
    const reversed = sortEventsCanonically([...events].reverse()).map(
      (event) => event.eventId,
    );
    expect(forward).toEqual(["device-a:1", "device-a:2", "device-b:1"]);
    expect(reversed).toEqual(forward);
  });

  it("does not mutate the input array", () => {
    const events = [
      stub({ eventId: "b", wallTime: 2 }),
      stub({ eventId: "a", wallTime: 1 }),
    ];
    sortEventsCanonically(events);
    expect(events.map((event) => event.eventId)).toEqual(["b", "a"]);
  });
});
