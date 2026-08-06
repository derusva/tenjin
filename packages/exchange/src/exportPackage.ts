import { strToU8, zipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { canonicalJson } from "./canonicalJson.js";
import { sortEventsCanonically } from "./eventOrder.js";
import { buildManifest, type LedgerPackageMode } from "./manifest.js";
import { deriveWatermark } from "./watermark.js";

export interface ExportContextImage {
  readonly mediaType: string;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface ExportContext {
  readonly hash: string;
  readonly original: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly focus?: string;
  readonly image?: ExportContextImage;
  readonly createdAt: string;
}

export interface ExportLedgerPackageInput {
  readonly events: readonly Event[];
  readonly contexts: readonly ExportContext[];
  readonly mode: LedgerPackageMode;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
}

const HASH_PREFIX = "sha256:";

/**
 * The fixed entry timestamp, so that exporting the same ledger twice produces
 * the same bytes. fflate defaults to `Date.now()`, which would make every
 * export differ.
 *
 * It is a `Date` built from local calendar fields rather than a number of
 * milliseconds, for two reasons. A zip stores a DOS date, which only covers
 * 1980-2099, so `mtime: 0` (the Unix epoch) is rejected outright. And fflate
 * reads the fields back with local-time getters (`getFullYear`, `getMonth`,
 * ...), so a fixed epoch number would still encode differently in different
 * timezones; local fields round-trip to themselves everywhere. Midday avoids
 * the timezones whose DST transition removes local midnight.
 */
const ZIP_ENTRY_MTIME = new Date(1980, 0, 1, 12, 0, 0, 0);

function hashToEntryName(hash: string): string {
  if (!hash.startsWith(HASH_PREFIX)) {
    throw new TypeError(`context hash must start with ${HASH_PREFIX}: ${hash}`);
  }
  const hex = hash.slice(HASH_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`context hash must be lowercase hexadecimal: ${hash}`);
  }
  return hex;
}

function contextMetadata(context: ExportContext): Record<string, unknown> {
  const { image, ...rest } = context;
  if (image === undefined) {
    return { ...rest };
  }
  const { bytes, ...imageRest } = image;
  if (bytes.byteLength !== image.byteLength) {
    throw new TypeError(
      `context ${context.hash} declares byteLength ${image.byteLength} but carries ${bytes.byteLength} bytes`,
    );
  }
  return { ...rest, image: { ...imageRest } };
}

export function exportLedgerPackage(
  input: ExportLedgerPackageInput,
): Uint8Array {
  const events = sortEventsCanonically(input.events);
  const contexts = [...input.contexts].sort((left, right) =>
    left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
  );

  const manifest = buildManifest({
    mode: input.mode,
    exportedByDeviceId: input.exportedByDeviceId,
    exportedAt: input.exportedAt,
    eventCount: events.length,
    contextCount: contexts.length,
    watermark: deriveWatermark(events),
  });

  const eventsJsonl =
    events.map((event) => canonicalJson(event)).join("\n") +
    (events.length > 0 ? "\n" : "");

  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    "manifest.json": [
      strToU8(canonicalJson(manifest)),
      { mtime: ZIP_ENTRY_MTIME },
    ],
    "events.jsonl": [strToU8(eventsJsonl), { mtime: ZIP_ENTRY_MTIME }],
    "redactions.jsonl": [strToU8(""), { mtime: ZIP_ENTRY_MTIME }],
  };

  for (const context of contexts) {
    const hex = hashToEntryName(context.hash);
    files[`contexts/${hex}.json`] = [
      strToU8(canonicalJson(contextMetadata(context))),
      { mtime: ZIP_ENTRY_MTIME },
    ];
    if (context.image !== undefined) {
      files[`contexts/${hex}.image`] = [
        context.image.bytes,
        { mtime: ZIP_ENTRY_MTIME },
      ];
    }
  }

  return zipSync(files, { level: 6 });
}
