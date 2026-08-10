import { serializeContextHashInput, type Event } from "@tenjin/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonicalJson.js";
import {
  exportLedgerPackage,
  type ExportContext,
} from "./exportPackage.js";
import { readPackage, type ReadLedgerPackage } from "./readPackage.js";
import { buildLedgerRestorePlan } from "./restorePlan.js";
import type { PackageImportReceipt } from "./importReceipts.js";
import type { Sha256Hex } from "./validateContexts.js";

/**
 * Deterministic comparison-path digest only. This is NOT SHA-256; apps/web T11
 * owns the real crypto.subtle wiring proof.
 */
const fakeSha256Hex: Sha256Hex = async (bytes) => {
  let state = 0x811c9dc5;
  for (const byte of bytes) {
    state = Math.imul(state ^ byte, 0x01000193) >>> 0;
  }
  const words: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    state = Math.imul(state ^ bytes.byteLength ^ index, 0x01000193) >>> 0;
    words.push(state.toString(16).padStart(8, "0"));
  }
  return words.join("");
};

async function context(
  original = "大丈夫、手は打ったから。",
): Promise<ExportContext> {
  const answer = "已经提前采取措施了。";
  const digest = await fakeSha256Hex(
    strToU8(serializeContextHashInput({ original, answer })),
  );
  return {
    hash: `sha256:${digest}`,
    original,
    answer,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

async function focusedContext(): Promise<ExportContext> {
  const original = "The full source sentence contains a focused chunk.";
  const focus = "focused chunk";
  const answer = "target meaning";
  const digest = await fakeSha256Hex(
    strToU8(serializeContextHashInput({ original, focus, answer })),
  );
  return {
    hash: `sha256:${digest}`,
    original,
    focus,
    answer,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function envelope(deviceId: string, seq: number, wallTime: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-10T00:00:00.000Z",
    recordedAt: "2026-08-10T00:00:00.000Z",
    actor: "user" as const,
    ruleVersion: "vertical-slice-v1" as const,
  };
}

function capture(
  deviceId: string,
  seq: number,
  wallTime: number,
  captureId: string,
  contextHash: string,
): Event {
  return {
    ...envelope(deviceId, seq, wallTime),
    kind: "capture_created",
    captureId,
    contextHash,
    payload: { captureType: "lookup" },
  };
}

function item(
  deviceId: string,
  seq: number,
  wallTime: number,
  captureId: string,
): Event {
  return {
    ...envelope(deviceId, seq, wallTime),
    kind: "item_created",
    captureId,
    itemId: `item-${deviceId}-${seq}`,
    payload: {
      display: "手を打つ",
      identityKey: "手を打つ",
      targetChannels: ["R"],
    },
  };
}

function lookup(
  deviceId: string,
  seq: number,
  wallTime: number,
  captureId: string,
): Event {
  return {
    ...envelope(deviceId, seq, wallTime),
    kind: "lookup_observed",
    captureId,
    itemId: `item-${deviceId}-${seq - 1}`,
    payload: { channel: "R", result: "lookup" },
  };
}

async function sourceFromExport(options: {
  readonly events: readonly Event[];
  readonly contexts: readonly ExportContext[];
  readonly importReceipts?: readonly PackageImportReceipt[];
  readonly exportedByDeviceId?: string;
}): Promise<ReadLedgerPackage> {
  return readPackage(
    exportLedgerPackage({
      mode: "full-backup",
      exportedByDeviceId:
        options.exportedByDeviceId ?? "device-exporter",
      exportedAt: "2026-08-10T12:00:00.000Z",
      events: options.events,
      contexts: options.contexts,
      importReceipts: options.importReceipts ?? [],
    }),
  );
}

function reverseEventLines(source: ReadLedgerPackage): ReadLedgerPackage {
  const lines = source.eventsJsonl.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    ...source,
    eventsJsonl: `${lines.reverse().join("\n")}\n`,
  };
}

function withManifest(
  source: ReadLedgerPackage,
  overrides: Readonly<Record<string, unknown>>,
): ReadLedgerPackage {
  const manifest = JSON.parse(source.manifestJson) as Record<string, unknown>;
  return { ...source, manifestJson: canonicalJson({ ...manifest, ...overrides }) };
}

function withoutImportReceiptsEntry(
  source: ReadLedgerPackage,
): ReadLedgerPackage {
  return {
    manifestJson: source.manifestJson,
    eventsJsonl: source.eventsJsonl,
    redactionsJsonl: source.redactionsJsonl,
    contextJsonByHash: source.contextJsonByHash,
    contextImageByHash: source.contextImageByHash,
  };
}

function asV1Package(source: ReadLedgerPackage): ReadLedgerPackage {
  const manifest = JSON.parse(source.manifestJson) as Record<string, unknown>;
  delete manifest.importReceiptCount;
  return {
    ...withoutImportReceiptsEntry(source),
    manifestJson: canonicalJson({
      ...manifest,
      schemaVersion: 1,
      foldExternalState: [],
    }),
  };
}

async function readEmptyV1Package(): Promise<ReadLedgerPackage> {
  const entries = unzipSync(
    exportLedgerPackage({
      mode: "full-backup",
      exportedByDeviceId: "legacy-exporter",
      exportedAt: "2026-08-10T12:00:00.000Z",
      events: [],
      contexts: [],
      importReceipts: [],
    }),
  );
  const manifest = JSON.parse(
    strFromU8(entries["manifest.json"] ?? new Uint8Array()),
  ) as Record<string, unknown>;
  delete manifest.importReceiptCount;
  entries["manifest.json"] = strToU8(
    canonicalJson({ ...manifest, schemaVersion: 1, foldExternalState: [] }),
  );
  delete entries["import-receipts.json"];
  return readPackage(zipSync(entries, { level: 0 }));
}

describe("buildLedgerRestorePlan", () => {
  it("builds a canonical plan from a real export/read path even when event lines are reversed", async () => {
    const storedContext = await context();
    const events = [
      capture("device-a", 1, 10, "capture-1", storedContext.hash),
      item("device-a", 2, 20, "capture-1"),
      lookup("device-a", 3, 30, "capture-1"),
    ];
    const source = reverseEventLines(
      await sourceFromExport({ events, contexts: [storedContext] }),
    );

    const plan = await buildLedgerRestorePlan(source, fakeSha256Hex);

    expect(plan.events).toEqual(events);
    expect(plan.contexts).toEqual([storedContext]);
    expect(plan.importReceipts).toEqual([]);
    expect(plan.globalHlc).toEqual({ wallTime: 30, counter: 0 });
    expect(plan.maxSeqByDevice).toEqual({ "device-a": 3 });
    expect(plan.forbiddenDeviceIds).toEqual([
      "device-a",
      "device-exporter",
    ]);
  });

  it("materialises empty receipts for a legacy v1 package", async () => {
    const source = await readEmptyV1Package();

    await expect(
      buildLedgerRestorePlan(source, fakeSha256Hex),
    ).resolves.toMatchObject({ importReceipts: [] });
  });

  it("round-trips a v2 focused context and receipt into the restore plan", async () => {
    const storedContext = await focusedContext();
    const events = [
      capture("device-a", 1, 10, "capture-1", storedContext.hash),
      item("device-a", 2, 20, "capture-1"),
    ];
    const receipt = {
      digest: `sha256:${"a".repeat(64)}`,
      importedAt: "2026-08-10T00:00:00.000Z",
      captureIds: ["capture-1"],
    } as const;
    const source = await sourceFromExport({
      events,
      contexts: [storedContext],
      importReceipts: [receipt],
    });

    const plan = await buildLedgerRestorePlan(source, fakeSha256Hex);

    expect(plan.contexts).toEqual([storedContext]);
    expect(plan.importReceipts).toEqual([receipt]);
  });

  it("rejects focus and receipt entries carried by schemaVersion 1", async () => {
    const focused = await focusedContext();
    const focusedSource = asV1Package(
      await sourceFromExport({
        events: [capture("device-a", 1, 10, "capture-1", focused.hash)],
        contexts: [focused],
      }),
    );
    await expect(
      buildLedgerRestorePlan(focusedSource, fakeSha256Hex),
    ).rejects.toThrow(/unknown context field.*focus/i);

    const legacy = asV1Package(
      await sourceFromExport({ events: [], contexts: [] }),
    );
    await expect(
      buildLedgerRestorePlan(
        { ...legacy, importReceiptsJson: "[]" },
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/schemaVersion 1.*must not carry/i);
  });

  it("requires the receipt entry for every schemaVersion 2 package", async () => {
    const source = await sourceFromExport({ events: [], contexts: [] });

    await expect(
      buildLedgerRestorePlan(
        withoutImportReceiptsEntry(source),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/schemaVersion 2 requires import-receipts\.json/i);
  });

  it("rejects a receipt with an unknown field or missing capture reference", async () => {
    const storedContext = await context();
    const events = [
      capture("device-a", 1, 10, "capture-1", storedContext.hash),
    ];
    const source = await sourceFromExport({
      events,
      contexts: [storedContext],
      importReceipts: [
        {
          digest: `sha256:${"a".repeat(64)}`,
          importedAt: "2026-08-10T00:00:00.000Z",
          captureIds: ["capture-1"],
        },
      ],
    });
    const parsed = JSON.parse(source.importReceiptsJson ?? "null") as readonly [
      Record<string, unknown>,
    ];

    await expect(
      buildLedgerRestorePlan(
        {
          ...source,
          importReceiptsJson: canonicalJson([
            { ...parsed[0], future: true },
          ]),
        },
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/must contain exactly/i);

    await expect(
      buildLedgerRestorePlan(
        {
          ...source,
          importReceiptsJson: canonicalJson([
            { ...parsed[0], captureIds: ["capture-missing"] },
          ]),
        },
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/unknown captureId capture-missing/i);
  });

  it("forbids the exporting device even when the package has zero events", async () => {
    const source = await sourceFromExport({
      events: [],
      contexts: [],
      exportedByDeviceId: "empty-exporter",
    });

    await expect(
      buildLedgerRestorePlan(source, fakeSha256Hex),
    ).resolves.toMatchObject({
      events: [],
      contexts: [],
      globalHlc: { wallTime: 0, counter: 0 },
      maxSeqByDevice: {},
      forbiddenDeviceIds: ["empty-exporter"],
    });
  });

  it("deduplicates the exporter when it also appears in the event set", async () => {
    const storedContext = await context();
    const source = await sourceFromExport({
      events: [
        capture("device-a", 1, 10, "capture-1", storedContext.hash),
      ],
      contexts: [storedContext],
      exportedByDeviceId: "device-a",
    });

    const plan = await buildLedgerRestorePlan(source, fakeSha256Hex);
    expect(plan.forbiddenDeviceIds).toEqual(["device-a"]);
  });

  it("preserves prototype-named device IDs through watermark and forbidden identity output", async () => {
    const storedContext = await context();
    const events = [
      capture("__proto__", 1, 10, "capture-proto", storedContext.hash),
      capture("constructor", 2, 20, "capture-constructor", storedContext.hash),
      capture("toString", 3, 30, "capture-to-string", storedContext.hash),
    ];
    const source = await sourceFromExport({
      events,
      contexts: [storedContext],
      exportedByDeviceId: "__proto__",
    });

    const plan = await buildLedgerRestorePlan(source, fakeSha256Hex);
    expect(Object.keys(plan.maxSeqByDevice)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(Object.hasOwn(plan.maxSeqByDevice, "__proto__")).toBe(true);
    expect(plan.maxSeqByDevice["__proto__"]).toBe(1);
    expect(plan.maxSeqByDevice.constructor).toBe(2);
    expect(plan.maxSeqByDevice.toString).toBe(3);
    expect(plan.forbiddenDeviceIds).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ]);
  });

  it("rejects an active capture whose context is absent before manifest validation", async () => {
    const storedContext = await context();
    const source = await sourceFromExport({
      events: [
        capture("device-a", 1, 10, "capture-1", storedContext.hash),
      ],
      contexts: [],
    });
    const alsoBadManifest = withManifest(source, { eventCount: 2 });

    await expect(
      buildLedgerRestorePlan(alsoBadManifest, fakeSha256Hex),
    ).rejects.toThrow(/active capture.*context/i);
  });

  it.each([
    ["eventCount", (manifest: Record<string, unknown>) => ({ eventCount: (manifest.eventCount as number) + 1 }), /eventCount.*actual/i],
    ["contextCount", (manifest: Record<string, unknown>) => ({ contextCount: (manifest.contextCount as number) + 1 }), /contextCount.*actual/i],
    ["importReceiptCount", (manifest: Record<string, unknown>) => ({ importReceiptCount: (manifest.importReceiptCount as number) + 1 }), /importReceiptCount.*actual/i],
    ["maxHlc", () => ({ maxHlc: { wallTime: 999, counter: 0 } }), /maxHlc.*derived/i],
    ["maxSeqByDevice", () => ({ maxSeqByDevice: { "device-a": 999 } }), /maxSeqByDevice.*derived/i],
  ])("rejects a manifest %s declaration that differs from validated data", async (_name, mutate, error) => {
    const storedContext = await context();
    const events = [
      capture("device-a", 1, 10, "capture-1", storedContext.hash),
    ];
    const source = await sourceFromExport({
      events,
      contexts: [storedContext],
    });
    const manifest = JSON.parse(source.manifestJson) as Record<string, unknown>;

    await expect(
      buildLedgerRestorePlan(
        withManifest(source, mutate(manifest)),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(error as RegExp);
  });

  it("validates context identity before reading event metadata hashes", async () => {
    const storedContext = await context();
    const source = await sourceFromExport({
      events: [
        capture("device-a", 1, 10, "capture-1", storedContext.hash),
      ],
      contexts: [storedContext],
    });
    const [entryHash, metadataJson] = [...source.contextJsonByHash.entries()][0]!;
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const tampered: ReadLedgerPackage = {
      ...source,
      eventsJsonl: "{",
      contextJsonByHash: new Map([
        [entryHash, canonicalJson({ ...metadata, original: "tampered" })],
      ]),
    };

    await expect(
      buildLedgerRestorePlan(tampered, fakeSha256Hex),
    ).rejects.toThrow(/context sha256.*serialized content/i);
  });
});
