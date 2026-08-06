import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { exportLedgerPackage } from "./exportPackage.js";
import type { ExportContext } from "./exportPackage.js";
import { scanPackagePlaintext } from "./inspectPackage.js";

const SENTINEL_SOURCE = "SENTINEL_SOURCE_TEXT";
const SENTINEL_ANSWER = "SENTINEL_ANSWER_TEXT";

function captureEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "capture_created",
    captureId: `capture-${seq}`,
    contextHash: "sha256:aa",
    payload: { captureType: "lookup" },
  } as Event;
}

/**
 * A real item_created, not a stripped-down stub. createCapture.ts:165 puts the
 * whole source text into payload.display, so this is what production data
 * actually looks like - and it is the reason the abstract mode is deferred.
 */
function itemCreatedEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "item_created",
    captureId: "capture-1",
    itemId: "item-1",
    payload: {
      display: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      identityKey: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      targetChannels: ["R"],
    },
  } as Event;
}

const secretContext: ExportContext = {
  hash: "sha256:aa",
  original: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
  answer: `${SENTINEL_ANSWER}_提前采取措施`,
  createdAt: "2026-08-05T00:00:00.000Z",
  image: {
    mediaType: "image/png",
    name: "shot.png",
    byteLength: 4,
    sha256: "sha256:bb",
    bytes: new Uint8Array([1, 2, 3, 4]),
  },
};

const input = {
  events: [itemCreatedEvent(2, 20), captureEvent(1, 10)],
  contexts: [secretContext],
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
};

describe("exportLedgerPackage", () => {
  it("writes manifest, events and redactions", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain("manifest.json");
    expect(Object.keys(entries)).toContain("events.jsonl");
    expect(Object.keys(entries)).toContain("redactions.jsonl");
    expect(strFromU8(entries["redactions.jsonl"]!)).toBe("");
  });

  it("serialises events in canonical order, one per line", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const lines = strFromU8(entries["events.jsonl"]!).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).eventId).toBe("device-a:1");
    expect(JSON.parse(lines[1]!).eventId).toBe("device-a:2");
  });

  it("carries contexts and raw image bytes", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain("contexts/aa.json");
    expect(entries["contexts/aa.image"]).toEqual(new Uint8Array([1, 2, 3, 4]));
    const stored = JSON.parse(strFromU8(entries["contexts/aa.json"]!));
    expect(stored.hash).toBe("sha256:aa");
    expect(stored.image.sha256).toBe("sha256:bb");
    expect(stored.image.bytes).toBeUndefined();
  });

  it("reports the real context count in the manifest", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(manifest.contextCount).toBe(1);
    expect(manifest.eventCount).toBe(2);
    expect(manifest.mode).toBe("full-backup");
    expect(manifest.foldExternalState).toEqual([]);
  });

  it("produces byte-identical output for the same input", () => {
    expect(exportLedgerPackage(input)).toEqual(exportLedgerPackage(input));
  });

  it("produces byte-identical output when the input arrays are shuffled", () => {
    const forward = exportLedgerPackage(input);
    const shuffled = exportLedgerPackage({
      ...input,
      events: [...input.events].reverse(),
    });
    expect(shuffled).toEqual(forward);
  });

  it("rejects an image whose declared byteLength disagrees with its bytes", () => {
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [
          {
            ...secretContext,
            image: { ...secretContext.image!, byteLength: 99 },
          },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("rejects a context hash without the expected sha256 prefix", () => {
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [{ ...secretContext, hash: "aa" }] }),
    ).toThrow(TypeError);
  });
});

describe("scanPackagePlaintext (positive control)", () => {
  // These assertions are deliberately POSITIVE. A full backup is supposed to
  // carry every byte of the ledger, so there is nothing to prove absent here.
  // What must be proved is that the scanner can actually see through the zip -
  // otherwise the future "an abstract package contains no source text"
  // assertion would pass even when the text is present.

  it("finds text stored inside a context entry", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).toContain(SENTINEL_ANSWER);
  });

  it("finds text stored inside an event payload", () => {
    // This is the exact leak that defers the abstract mode: createCapture.ts
    // writes the whole source text into item_created.payload.display, so the
    // sentence lives in events.jsonl, not only in contexts/.
    const eventsOnly = { ...input, contexts: [] };
    const haystack = scanPackagePlaintext(exportLedgerPackage(eventsOnly));
    expect(haystack).toContain(SENTINEL_SOURCE);
  });

  it("would not find text that is genuinely absent", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).not.toContain("SENTINEL_NEVER_WRITTEN");
  });

  it("does not depend on the raw zip bytes containing the plaintext", () => {
    // Guards the whole approach: scanning the compressed bytes is an
    // always-PASS check, because deflate hides the plaintext.
    const bytes = exportLedgerPackage(input);
    expect(strFromU8(bytes, true)).not.toContain(SENTINEL_ANSWER);
    expect(scanPackagePlaintext(bytes)).toContain(SENTINEL_ANSWER);
  });
});
