import {
  serializeContextHashInput,
  validateEvent,
  type Event,
} from "@tenjin/core";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonicalJson.js";
import {
  exportLedgerPackage,
  type ExportContext,
} from "./exportPackage.js";
import { readPackage, type ReadLedgerPackage } from "./readPackage.js";
import { buildLedgerRestorePlan } from "./restorePlan.js";
import type { Sha256Hex } from "./validateContexts.js";
import { ZIP_PROBE_FIXTURES } from "./zipProbeFixtures.js";
import { ZipRuntimeError } from "./zipRuntime.js";

/**
 * A1 T12 package-level mutation matrix.
 *
 * Every negative changes one invariant only and asserts the named rejecting
 * layer. The digest is deliberately deterministic rather than cryptographic;
 * apps/web T11 owns the real WebCrypto wiring proof.
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

const CREATED_AT = "2026-08-11T00:00:00.000Z";
const EXPORTED_AT = "2026-08-11T01:00:00.000Z";

function envelope(deviceId: string, seq: number, wallTime = seq) {
  return {
    schemaVersion: 1 as const,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: CREATED_AT,
    recordedAt: CREATED_AT,
    actor: "user" as const,
    ruleVersion: "vertical-slice-v1" as const,
  };
}

function capture(
  deviceId: string,
  seq: number,
  captureId: string,
  contextHash: string,
): Event {
  return {
    ...envelope(deviceId, seq),
    kind: "capture_created",
    captureId,
    contextHash,
    payload: { captureType: "lookup" },
  };
}

function discard(deviceId: string, seq: number, captureId: string): Event {
  return {
    ...envelope(deviceId, seq),
    kind: "capture_discarded",
    captureId,
    payload: { reason: "undo" },
  };
}

async function textContext(): Promise<ExportContext> {
  const original = "大丈夫、手は打ったから。";
  const answer = "没关系，已经采取措施了。";
  const digest = await fakeSha256Hex(
    strToU8(serializeContextHashInput({ original, answer })),
  );
  return {
    hash: `sha256:${digest}`,
    original,
    answer,
    createdAt: CREATED_AT,
  };
}

async function imageContext(): Promise<ExportContext> {
  const original = "パッとしない生徒がいましてねぇ。";
  const answer = "平平无奇、不起眼。";
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const imageSha256 = await fakeSha256Hex(bytes);
  const digest = await fakeSha256Hex(
    strToU8(
      serializeContextHashInput({ original, answer, imageSha256 }),
    ),
  );
  return {
    hash: `sha256:${digest}`,
    original,
    answer,
    image: {
      mediaType: "image/png",
      name: "p5r.png",
      byteLength: bytes.byteLength,
      sha256: imageSha256,
      bytes,
    },
    createdAt: CREATED_AT,
  };
}

async function exportedSource(options: {
  readonly events: readonly Event[];
  readonly contexts?: readonly ExportContext[];
}): Promise<ReadLedgerPackage> {
  return readPackage(
    exportLedgerPackage({
      mode: "full-backup",
      exportedByDeviceId: "device-exporter",
      exportedAt: EXPORTED_AT,
      events: options.events,
      contexts: options.contexts ?? [],
    }),
  );
}

function withManifest(
  source: ReadLedgerPackage,
  overrides: Readonly<Record<string, unknown>>,
): ReadLedgerPackage {
  const manifest = JSON.parse(source.manifestJson) as Record<string, unknown>;
  return {
    ...source,
    manifestJson: canonicalJson({ ...manifest, ...overrides }),
  };
}

async function expectNamedTypeError(
  operation: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  const error = await operation.catch((candidate: unknown) => candidate);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toMatch(message);
}

describe("A1 T12 package mutation matrix", () => {
  it("#1 rejects a context whose answer was deleted without changing its hash", async () => {
    const context = await textContext();
    const source = await exportedSource({
      events: [capture("device-a", 1, "capture-1", context.hash)],
      contexts: [context],
    });
    const entryHash = context.hash.slice("sha256:".length);
    const metadata = JSON.parse(
      source.contextJsonByHash.get(entryHash) ?? "null",
    ) as Record<string, unknown>;
    delete metadata.answer;
    const tampered = {
      ...source,
      contextJsonByHash: new Map([
        [entryHash, canonicalJson(metadata)],
      ]),
    };

    await expectNamedTypeError(
      buildLedgerRestorePlan(tampered, fakeSha256Hex),
      /context sha256 must match its serialized content/i,
    );
  });

  it("#3 rejects a shorter image even when its image digest and length are made self-consistent", async () => {
    const context = await imageContext();
    const source = await exportedSource({
      events: [capture("device-a", 1, "capture-1", context.hash)],
      contexts: [context],
    });
    const entryHash = context.hash.slice("sha256:".length);
    const metadata = JSON.parse(
      source.contextJsonByHash.get(entryHash) ?? "null",
    ) as Record<string, unknown>;
    const originalBytes = source.contextImageByHash.get(entryHash);
    if (originalBytes === undefined) throw new Error("image fixture missing bytes");
    const shorter = originalBytes.slice(0, -1);
    const image = metadata.image as Record<string, unknown>;
    metadata.image = {
      ...image,
      byteLength: shorter.byteLength,
      sha256: await fakeSha256Hex(shorter),
    };
    const tampered = {
      ...source,
      contextJsonByHash: new Map([[entryHash, canonicalJson(metadata)]]),
      contextImageByHash: new Map([[entryHash, shorter]]),
    };

    await expectNamedTypeError(
      buildLedgerRestorePlan(tampered, fakeSha256Hex),
      /context sha256 must match its serialized content/i,
    );
  });

  it("#4 rejects a 200-event package with one middle event removed", async () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      discard("device-a", index + 1, `capture-${index + 1}`),
    );
    const source = await exportedSource({ events });
    const lines = source.eventsJsonl.trimEnd().split("\n");
    lines.splice(99, 1);
    const tampered = { ...source, eventsJsonl: `${lines.join("\n")}\n` };

    await expectNamedTypeError(
      buildLedgerRestorePlan(tampered, fakeSha256Hex),
      /eventCount/i,
    );
  });

  it("#6 rejects a future manifest schema version", async () => {
    const source = await exportedSource({ events: [] });

    await expectNamedTypeError(
      buildLedgerRestorePlan(
        withManifest(source, { schemaVersion: 3 }),
        fakeSha256Hex,
      ),
      /schemaVersion/i,
    );
  });

  it("#7 rejects a duplicate eventId whose second event has different content", async () => {
    const first = discard("device-a", 1, "capture-1");
    const source = await exportedSource({ events: [first] });
    const second = { ...first, captureId: "capture-2" } satisfies Event;
    const tampered = {
      ...source,
      eventsJsonl: `${source.eventsJsonl.trimEnd()}\n${JSON.stringify(second)}\n`,
    };

    await expectNamedTypeError(
      buildLedgerRestorePlan(tampered, fakeSha256Hex),
      /eventId/i,
    );
  });

  it("#9 rejects a manifest maxSeqByDevice that disagrees with events", async () => {
    const source = await exportedSource({
      events: [discard("device-a", 1, "capture-1")],
    });

    await expectNamedTypeError(
      buildLedgerRestorePlan(
        withManifest(source, { maxSeqByDevice: { "device-a": 2 } }),
        fakeSha256Hex,
      ),
      /maxSeqByDevice/i,
    );
  });

  it("#11 maps valid-schema compressed data corruption to CRC_MISMATCH with the vendor cause", async () => {
    const entries = unzipSync(ZIP_PROBE_FIXTURES.crcMismatch);
    const tamperedEvent: unknown = JSON.parse(
      strFromU8(entries["events.jsonl"] ?? new Uint8Array()),
    );
    const validation = validateEvent(tamperedEvent);
    expect(validation.valid).toBe(true);
    if (!validation.valid || validation.value.kind !== "item_created") {
      throw new Error("CRC fixture must remain a production-shape item event");
    }
    expect(validation.value.payload.display).toBe("bravo");

    const error = await readPackage(ZIP_PROBE_FIXTURES.crcMismatch).catch(
      (candidate: unknown) => candidate,
    );
    expect(error).toBeInstanceOf(ZipRuntimeError);
    expect((error as ZipRuntimeError).code).toBe("CRC_MISMATCH");
    expect((error as ZipRuntimeError).cause).toBeInstanceOf(Error);
    expect(((error as ZipRuntimeError).cause as Error).message).toBe(
      "Invalid signature",
    );
  });

});
