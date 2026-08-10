import type { Event } from "@tenjin/core";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonicalJson.js";
import { exportLedgerPackage } from "./exportPackage.js";
import { buildManifest } from "./manifest.js";
import { readPackage } from "./readPackage.js";
import {
  validateManifest,
  type ManifestActuals,
} from "./validateManifest.js";
import { deriveWatermark } from "./watermark.js";

function event(
  deviceId: string,
  seq: number,
  wallTime: number,
  counter = 0,
): Event {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    actor: "user",
    ruleVersion: "vertical-slice-v1",
    kind: "capture_discarded",
    captureId: `capture-${deviceId}-${seq}`,
    payload: { reason: "undo" },
  } as Event;
}

const events = [
  event("device-a", 1, 10),
  event("device-a", 3, 30, 1),
  event("device-b", 2, 20),
];

const manifest = buildManifest({
  mode: "full-backup",
  exportedByDeviceId: "device-exporter",
  exportedAt: "2026-08-05T12:00:00.000Z",
  eventCount: events.length,
  contextCount: 2,
  importReceiptCount: 0,
  watermark: deriveWatermark(events),
});

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return canonicalJson({ ...manifest, ...overrides });
}

function actuals(overrides: Partial<ManifestActuals> = {}): ManifestActuals {
  return {
    events,
    contextCount: 2,
    importReceiptCount: 0,
    hasImportReceiptsEntry: true,
    ...overrides,
  };
}

describe("validateManifest", () => {
  it("returns a shape-valid manifest whose declarations match package data", () => {
    expect(
      validateManifest(manifestJson(), actuals()),
    ).toEqual(manifest);
  });

  it("runs the shared closed-shape validator before cross-checking", () => {
    expect(() =>
      validateManifest(manifestJson({ futureField: true }), actuals()),
    ).toThrow(/unknown.*futureField/i);
  });

  it.each([
    ["too few", events.length - 1],
    ["too many", events.length + 1],
  ])("rejects an eventCount that is %s", (_name, eventCount) => {
    expect(() =>
      validateManifest(manifestJson({ eventCount }), actuals()),
    ).toThrow(/eventCount.*actual/i);
  });

  it("requires the v2 receipt entry even when the declared count is zero", () => {
    expect(() =>
      validateManifest(
        manifestJson(),
        actuals({ hasImportReceiptsEntry: false }),
      ),
    ).toThrow(/requires import-receipts\.json/i);
  });

  it("cross-checks importReceiptCount against validated receipts", () => {
    expect(() =>
      validateManifest(
        manifestJson({ importReceiptCount: 1 }),
        actuals(),
      ),
    ).toThrow(/importReceiptCount.*actual/i);
  });

  it("accepts v1 only without receipt state and rejects an illicit receipt entry", () => {
    const legacyManifest: Record<string, unknown> = { ...manifest };
    delete legacyManifest.importReceiptCount;
    const legacyJson = canonicalJson({
      ...legacyManifest,
      schemaVersion: 1,
      foldExternalState: [],
    });
    const legacyActuals = actuals({
      importReceiptCount: 0,
      hasImportReceiptsEntry: false,
    });

    expect(validateManifest(legacyJson, legacyActuals).schemaVersion).toBe(1);
    expect(() =>
      validateManifest(
        legacyJson,
        { ...legacyActuals, hasImportReceiptsEntry: true },
      ),
    ).toThrow(/schemaVersion 1.*must not carry/i);
  });

  it.each([
    ["too few", 1],
    ["too many", 3],
  ])("rejects a contextCount that is %s", (_name, contextCount) => {
    expect(() =>
      validateManifest(manifestJson({ contextCount }), actuals()),
    ).toThrow(/contextCount.*actual/i);
  });

  it("rejects maxHlc values that differ from the event-derived value", () => {
    expect(() =>
      validateManifest(
        manifestJson({ maxHlc: { wallTime: 30, counter: 2 } }),
        actuals(),
      ),
    ).toThrow(/maxHlc.*derived/i);
  });

  it.each([
    ["extra device", { ...manifest.maxSeqByDevice, extra: 1 }],
    ["missing device", { "device-a": 3 }],
    ["wrong value", { "device-a": 4, "device-b": 2 }],
  ])("rejects maxSeqByDevice with %s", (_name, maxSeqByDevice) => {
    expect(() =>
      validateManifest(manifestJson({ maxSeqByDevice }), actuals()),
    ).toThrow(/maxSeqByDevice.*derived/i);
  });

  it("rejects malformed JSON and non-object JSON", () => {
    expect(() =>
      validateManifest("{", actuals()),
    ).toThrow(/manifest.*valid JSON/i);
    expect(() =>
      validateManifest("[]", actuals()),
    ).toThrow(/manifest.*object/i);
  });

  it("accepts a complete export -> read -> validate round trip with prototype-named devices", async () => {
    const roundTripEvents = [
      event("device-a", 2, 10),
      event("__proto__", 3, 20),
      event("constructor", 4, 30),
      event("toString", 5, 40),
      event("__proto__", 7, 50),
    ];
    const bytes = exportLedgerPackage({
      mode: "full-backup",
      exportedByDeviceId: "device-exporter",
      exportedAt: "2026-08-05T12:00:00.000Z",
      events: roundTripEvents,
      contexts: [],
      importReceipts: [],
    });

    const read = await readPackage(bytes);
    const readEvents = read.eventsJsonl
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Event);
    const restoredManifest = validateManifest(read.manifestJson, {
      events: readEvents,
      contextCount: read.contextJsonByHash.size,
      importReceiptCount: 0,
      hasImportReceiptsEntry: read.importReceiptsJson !== undefined,
    });

    expect(readEvents).toHaveLength(roundTripEvents.length);
    expect(restoredManifest.exportedAt).toBe("2026-08-05T12:00:00.000Z");
    expect(Object.keys(restoredManifest.maxSeqByDevice).sort()).toEqual([
      "__proto__",
      "constructor",
      "device-a",
      "toString",
    ]);
    expect(Object.hasOwn(restoredManifest.maxSeqByDevice, "__proto__")).toBe(
      true,
    );
    expect(restoredManifest.maxSeqByDevice["__proto__"]).toBe(7);
    expect(restoredManifest.maxSeqByDevice.constructor).toBe(4);
    expect(restoredManifest.maxSeqByDevice.toString).toBe(5);
  });
});
