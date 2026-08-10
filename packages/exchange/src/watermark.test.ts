import { describe, expect, it } from "vitest";
import type { Event } from "@tenjin/core";
import { canonicalJson } from "./canonicalJson.js";
import { compareHlc, deriveWatermark } from "./watermark.js";

function stub(deviceId: string, seq: number, wallTime: number, counter = 0): Event {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "capture_discarded",
    captureId: "capture-1",
    payload: { reason: "undo" },
  } as Event;
}

describe("compareHlc", () => {
  it("orders by wallTime then counter", () => {
    expect(compareHlc({ wallTime: 1, counter: 9 }, { wallTime: 2, counter: 0 })).toBeLessThan(0);
    expect(compareHlc({ wallTime: 2, counter: 0 }, { wallTime: 2, counter: 1 })).toBeLessThan(0);
    expect(compareHlc({ wallTime: 2, counter: 1 }, { wallTime: 2, counter: 1 })).toBe(0);
  });
});

describe("deriveWatermark", () => {
  it("returns a zero baseline for an empty ledger", () => {
    expect(deriveWatermark([])).toEqual({
      maxSeqByDevice: {},
      maxHlc: { wallTime: 0, counter: 0 },
    });
  });

  it("keeps the highest seq per device", () => {
    const watermark = deriveWatermark([
      stub("device-a", 1, 10),
      stub("device-a", 7, 20),
      stub("device-a", 3, 30),
      stub("device-b", 2, 40),
    ]);
    expect(watermark.maxSeqByDevice).toEqual({ "device-a": 7, "device-b": 2 });
  });

  it("keeps the highest HLC across every device", () => {
    const watermark = deriveWatermark([
      stub("device-a", 1, 100, 5),
      stub("device-b", 1, 100, 9),
      stub("device-c", 1, 99, 12),
    ]);
    expect(watermark.maxHlc).toEqual({ wallTime: 100, counter: 9 });
  });

  it("is independent of input order", () => {
    const events = [stub("device-a", 4, 40), stub("device-a", 1, 10), stub("device-b", 9, 20)];
    expect(deriveWatermark(events)).toEqual(deriveWatermark([...events].reverse()));
  });

  it("does not invent devices that hold no events", () => {
    expect(Object.keys(deriveWatermark([stub("device-a", 1, 1)]).maxSeqByDevice)).toEqual([
      "device-a",
    ]);
  });

  it("preserves prototype-named device IDs as own enumerable keys", () => {
    const maxSeqByDevice = deriveWatermark([
      stub("device-a", 2, 1),
      stub("__proto__", 3, 2),
      stub("constructor", 4, 3),
      stub("toString", 5, 4),
      stub("__proto__", 7, 5),
    ]).maxSeqByDevice;

    expect(Object.keys(maxSeqByDevice)).toEqual([
      "device-a",
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(Object.hasOwn(maxSeqByDevice, "__proto__")).toBe(true);
    expect(Object.hasOwn(maxSeqByDevice, "constructor")).toBe(true);
    expect(Object.hasOwn(maxSeqByDevice, "toString")).toBe(true);
    expect(maxSeqByDevice["__proto__"]).toBe(7);
    expect(maxSeqByDevice.constructor).toBe(4);
    expect(maxSeqByDevice.toString).toBe(5);

    const roundTripped = JSON.parse(canonicalJson(maxSeqByDevice)) as Record<
      string,
      number
    >;
    expect(Object.keys(roundTripped)).toEqual([
      "__proto__",
      "constructor",
      "device-a",
      "toString",
    ]);
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped["__proto__"]).toBe(7);
    expect(roundTripped.constructor).toBe(4);
    expect(roundTripped.toString).toBe(5);
  });
});
