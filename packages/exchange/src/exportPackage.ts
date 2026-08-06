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
 * Two separate traps are encoded in this one value.
 *
 * 1. A zip stores a DOS date, which only covers 1980-2099. `mtime: 0` (the
 *    Unix epoch, 1970) is not merely non-deterministic, it is rejected
 *    outright - fflate throws "date not in range 1980-2099".
 * 2. fflate reads the fields back with local-time getters (`getFullYear`,
 *    `getMonth`, `getDate`, `getHours`, ...). A fixed number of milliseconds
 *    would therefore still encode different bytes in different timezones,
 *    silently breaking determinism across machines while looking fine on the
 *    machine that wrote the test. A `Date` built from local calendar fields
 *    round-trips to those same fields everywhere.
 *
 * Midday rather than midnight avoids the timezones whose DST transition
 * removes local midnight entirely.
 *
 * Exported so that exportPackage.test.ts can pin the calendar fields. The two
 * byte-identical tests cannot catch a regression here on their own: this
 * constant is evaluated once per process, and DOS timestamps have 2-second
 * resolution, so even a live clock would let them pass.
 */
export const ZIP_ENTRY_MTIME = new Date(1980, 0, 1, 12, 0, 0, 0);

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

  const seenHashes = new Set<string>();
  for (const context of contexts) {
    const hex = hashToEntryName(context.hash);
    // Two contexts sharing a hash would collapse onto one zip key while
    // contextCount still counts the input array, leaving the manifest claiming
    // more contexts than the package holds. Contexts are content-addressed and
    // the store is keyed by hash, so this can only mean an upstream bug; fail
    // loudly rather than emit a package a restorer would judge corrupt.
    if (seenHashes.has(context.hash)) {
      throw new TypeError(`duplicate context hash: ${context.hash}`);
    }
    seenHashes.add(context.hash);
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
