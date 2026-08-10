import type { Event } from "@tenjin/core";
import { describe, expect, it, vi } from "vitest";

import { compareEventsCanonically } from "./eventOrder.js";
import {
  validateEvents,
  validateEventsForTest,
} from "./validateEvents.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const TIMESTAMP = "2026-08-05T00:00:00.000Z";

function envelope(
  deviceId: string,
  seq: number,
  wallTime: number,
): {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly hlc: { readonly wallTime: number; readonly counter: 0 };
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: "user";
  readonly ruleVersion: "vertical-slice-v1";
} {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: TIMESTAMP,
    recordedAt: TIMESTAMP,
    actor: "user",
    ruleVersion: "vertical-slice-v1",
  };
}

function capture(
  seq: number,
  options: {
    readonly deviceId?: string;
    readonly wallTime?: number;
    readonly captureId?: string;
    readonly contextHash?: string;
  } = {},
): Event {
  const deviceId = options.deviceId ?? "device-a";
  return {
    ...envelope(deviceId, seq, options.wallTime ?? seq * 10),
    kind: "capture_created",
    captureId: options.captureId ?? `capture-${seq}`,
    contextHash: options.contextHash ?? HASH_A,
    payload: { captureType: "lookup" },
  };
}

function item(
  seq: number,
  captureId: string,
  options: { readonly deviceId?: string; readonly wallTime?: number } = {},
): Event {
  const deviceId = options.deviceId ?? "device-a";
  return {
    ...envelope(deviceId, seq, options.wallTime ?? seq * 10),
    kind: "item_created",
    captureId,
    itemId: `item-${seq}`,
    payload: {
      display: "手を打つ",
      identityKey: "手を打つ",
      targetChannels: ["R"],
    },
  };
}

function lookup(seq: number, captureId: string): Event {
  return {
    ...envelope("device-a", seq, seq * 10),
    kind: "lookup_observed",
    captureId,
    itemId: `item-${seq - 1}`,
    refs: ["device-a:1"],
    payload: { channel: "R", result: "lookup" },
  };
}

function discard(
  seq: number,
  captureId: string,
  options: { readonly wallTime?: number } = {},
): Event {
  return {
    ...envelope("device-a", seq, options.wallTime ?? seq * 10),
    kind: "capture_discarded",
    captureId,
    payload: { reason: "undo" },
  };
}

function jsonl(events: readonly unknown[], trailingNewline = true): string {
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  return body + (trailingNewline && body.length > 0 ? "\n" : "");
}

describe("validateEvents", () => {
  it("returns events in canonical order regardless of JSONL line order", () => {
    const ordered = [capture(1), item(2, "capture-1"), lookup(3, "capture-1")];
    const reversed = [...ordered].reverse();

    expect(validateEvents(jsonl(reversed), new Set([HASH_A]))).toEqual(ordered);
    expect(validateEvents(jsonl(ordered), new Set([HASH_A]))).toEqual(ordered);
  });

  it("accepts an empty event file and any number of trailing empty lines", () => {
    expect(validateEvents("", new Set())).toEqual([]);
    expect(validateEvents("\n\n", new Set())).toEqual([]);
    expect(validateEvents("\r\n\r\n", new Set())).toEqual([]);
    expect(validateEvents(`${jsonl([capture(1)])}\n\n`, new Set([HASH_A]))).toHaveLength(1);
    expect(
      validateEvents(
        `${JSON.stringify(capture(1))}\r\n\r\n`,
        new Set([HASH_A]),
      ),
    ).toHaveLength(1);
  });

  it("rejects a middle empty line without using filter(Boolean)", () => {
    const first = JSON.stringify(capture(1));
    const second = JSON.stringify(item(2, "capture-1"));
    expect(() =>
      validateEvents(`${first}\n\n${second}\n`, new Set([HASH_A])),
    ).toThrow(/empty line.*middle/i);
    expect(() =>
      validateEvents(`${first}\r\n\r\n${second}\r\n`, new Set([HASH_A])),
    ).toThrow(/empty line.*middle/i);
  });

  it("rejects malformed JSON and a JSON value that is not an event object", () => {
    expect(() => validateEvents("{\n", new Set())).toThrow(
      /valid JSON.*line.*1/i,
    );
    expect(() => validateEvents("7\n", new Set())).toThrow(/line 1.*event.*object/i);
  });

  it("validates every event shape before invoking the canonical comparator", () => {
    const badHlc = { ...item(2, "capture-1"), hlc: { wallTime: "bad", counter: 0 } };
    const comparator = vi.fn(compareEventsCanonically);

    expect(() =>
      validateEventsForTest(
        jsonl([capture(1), badHlc]),
        new Set([HASH_A]),
        comparator,
      ),
    ).toThrow(/line 2.*hlc\.wallTime/i);
    expect(comparator).toHaveBeenCalledTimes(0);
  });

  it("uses core closed-schema validation before sorting", () => {
    const unknownField = { ...capture(1), futureField: true };
    expect(() =>
      validateEvents(jsonl([unknownField]), new Set([HASH_A])),
    ).toThrow(/futureField.*not allowed/i);
  });

  it.each([
    ["deviceId", { ...capture(1), deviceId: " device-a" }],
    ["eventId", { ...capture(1), eventId: "device-a:1 " }],
  ])("rejects surrounding whitespace in %s", (_field, event) => {
    expect(() =>
      validateEvents(jsonl([event]), new Set([HASH_A])),
    ).toThrow(/canonical.*whitespace/i);
  });

  it("requires eventId to equal deviceId:seq exactly", () => {
    expect(() =>
      validateEvents(
        jsonl([{ ...capture(1), eventId: "device-a:999" }]),
        new Set([HASH_A]),
      ),
    ).toThrow(/eventId.*deviceId:seq/i);
  });

  it("detects both duplicate eventId and duplicate deviceId-seq coordinates", () => {
    const duplicate = { ...capture(1), captureId: "capture-other" };
    expect(() =>
      validateEvents(jsonl([capture(1), duplicate]), new Set([HASH_A])),
    ).toThrow(/duplicate eventId.*duplicate deviceId,seq/is);
  });

  it("requires per-device seq to increase in canonical order", () => {
    const seqTwoFirst = capture(2, { wallTime: 10, captureId: "capture-2" });
    const seqOneLater = capture(1, { wallTime: 20, captureId: "capture-1" });
    expect(() =>
      validateEvents(jsonl([seqOneLater, seqTwoFirst]), new Set([HASH_A])),
    ).toThrow(/seq.*strictly increase/i);
  });

  it("allows sequence gaps", () => {
    expect(() =>
      validateEvents(
        jsonl([capture(1), capture(7, { captureId: "capture-7" })]),
        new Set([HASH_A]),
      ),
    ).not.toThrow();
  });

  it("uses Map-backed device state for prototype-named IDs", () => {
    const events = [
      capture(1, { deviceId: "__proto__", wallTime: 10 }),
      capture(3, {
        deviceId: "__proto__",
        wallTime: 30,
        captureId: "capture-proto-3",
      }),
      capture(1, { deviceId: "constructor", wallTime: 20 }),
      capture(1, { deviceId: "toString", wallTime: 25 }),
    ];
    expect(validateEvents(jsonl(events), new Set([HASH_A]))).toHaveLength(4);
  });

  it("rejects occurredAt later than recordedAt", () => {
    const event = {
      ...capture(1),
      occurredAt: "2026-08-05T00:00:01.000Z",
      recordedAt: TIMESTAMP,
    };
    expect(() =>
      validateEvents(jsonl([event]), new Set([HASH_A])),
    ).toThrow(/occurredAt.*later.*recordedAt/i);
  });

  it("requires every item_created captureId to resolve to capture_created", () => {
    expect(() =>
      validateEvents(jsonl([item(1, "missing")]), new Set()),
    ).toThrow(/item_created.*captureId.*capture_created/i);
  });

  it("rejects a missing context for an active capture", () => {
    expect(() => validateEvents(jsonl([capture(1)]), new Set())).toThrow(
      /active capture.*context/i,
    );
  });

  it("accepts the production undo/GC shape when the discarded context is gone", () => {
    const events = [
      capture(1),
      item(2, "capture-1"),
      lookup(3, "capture-1"),
      discard(4, "capture-1"),
    ];
    expect(validateEvents(jsonl(events), new Set())).toEqual(events);
  });

  it("uses discard set semantics without requiring temporal order or a capture reference", () => {
    const discardedBeforeCapture = [
      discard(1, "capture-later", { wallTime: 10 }),
      capture(2, {
        wallTime: 20,
        captureId: "capture-later",
        contextHash: HASH_B,
      }),
      discard(3, "capture-never-created", { wallTime: 30 }),
    ];
    expect(validateEvents(jsonl(discardedBeforeCapture), new Set())).toEqual(
      discardedBeforeCapture,
    );
  });

  it("still requires a shared hash while any capture referencing it is active", () => {
    const events = [
      capture(1, { captureId: "capture-discarded" }),
      discard(2, "capture-discarded"),
      capture(3, { captureId: "capture-active" }),
    ];
    expect(() => validateEvents(jsonl(events), new Set())).toThrow(
      /active capture.*context/i,
    );
    expect(() =>
      validateEvents(jsonl(events), new Set([HASH_A])),
    ).not.toThrow();
  });

  it("accepts contexts with no active capture reference", () => {
    expect(validateEvents("", new Set([HASH_A, HASH_B]))).toEqual([]);
  });
});
