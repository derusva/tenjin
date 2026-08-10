import { strToU8, zipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { canonicalJson } from "./canonicalJson.js";
import { sortEventsCanonically } from "./eventOrder.js";
import { buildManifest, type LedgerPackageMode } from "./manifest.js";
import {
  assertCompressedPackageWithinLimit,
  assertPackageEntrySizesWithinLimits,
  assertPackageStructureWithinLimits,
  type PackageEntrySize,
} from "./limits.js";
import { deriveWatermark } from "./watermark.js";

export interface ExportContextImage {
  readonly mediaType: string;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/**
 * Mirrors the production `ContextRecord` exactly - no more, no less.
 *
 * A `focus` field used to be pre-reserved here. It is gone: nothing implemented
 * it, and landing it for real changes what a context hash covers, i.e. content
 * identity. That has to ride a schemaVersion bump, not arrive quietly inside
 * v1 packages.
 */
export interface ExportContext {
  readonly hash: string;
  readonly original: string;
  readonly corrected?: string;
  readonly answer?: string;
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

type ZipEntry = [Uint8Array, { readonly mtime: Date }];

export interface ExportLedgerPackageDependencies {
  readonly zip: (
    files: Readonly<Record<string, ZipEntry>>,
    options: { readonly level: 6 },
  ) => Uint8Array;
}

const DEFAULT_EXPORT_DEPENDENCIES: ExportLedgerPackageDependencies =
  Object.freeze({ zip: zipSync });

const HASH_PREFIX = "sha256:";

/**
 * The two digest shapes this package accepts, and they are NOT the same shape.
 *
 * - A context hash is `sha256:` followed by exactly 64 lowercase hex, because
 *   that is what `hashContext` produces in
 *   `apps/web/src/features/ledger/ledgerRuntime.ts`.
 * - An image digest is a BARE 64-hex string with no prefix, because
 *   `packages/storage-indexeddb/src/repository.ts` validates it against
 *   /^[a-f0-9]{64}$/ and compares it directly to a `crypto.subtle` digest.
 *
 * Length is the part that matters most. A short "digest" is an identity no
 * other component of the system could ever produce, so accepting one lets a
 * package into the world that no restorer can reconcile with the store it
 * came from. A prefixed image digest is likewise guaranteed never to match the
 * bytes it describes.
 */
const CONTEXT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

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
 *    `getMonth`, `getDate`, `getHours`, ...) while a `Date` stores an absolute
 *    instant. The two only cancel when construction and encoding happen in the
 *    same timezone.
 *
 * Hence: built fresh inside every export, never once at module load. A
 * module-scope constant freezes the instant that the *loading* machine's
 * timezone implied, so a process that later runs in another zone encodes
 * different bytes - and westward of the loading zone it reads back as 1979 and
 * the export throws. Measured, one process, same constant: UTC and Asia/Tokyo
 * produced two different package digests, and America/Los_Angeles threw. The
 * real case is a device carried across timezones with the PWA never restarted.
 *
 * Midday rather than midnight avoids the timezones whose DST transition
 * removes local midnight entirely.
 *
 * Deliberately NOT exported: a shared mutable `Date` is not public API, and a
 * test that reads its calendar fields proves only that the constant looks
 * right, not that the exporter uses it. exportPackage.test.ts asserts the DOS
 * fields in the real output bytes instead.
 */
function zipEntryMtime(): Date {
  return new Date(1980, 0, 1, 12, 0, 0, 0);
}

function hashToEntryName(hash: string): string {
  if (!CONTEXT_HASH_PATTERN.test(hash)) {
    throw new TypeError(
      `context hash must be ${HASH_PREFIX} followed by 64 lowercase hexadecimal characters, received ${hash}`,
    );
  }
  return hash.slice(HASH_PREFIX.length);
}

/**
 * schemaVersion 1 has a CLOSED field list, enumerated here rather than derived
 * from a spread. These names are the production `ContextRecord` fields.
 */
const CONTEXT_FIELDS: readonly string[] = [
  "hash",
  "original",
  "corrected",
  "answer",
  "image",
  "createdAt",
];

const CONTEXT_IMAGE_FIELDS: readonly string[] = [
  "mediaType",
  "name",
  "byteLength",
  "sha256",
  "bytes",
];

/**
 * Rejects fields this schema version does not know about.
 *
 * Throwing rather than dropping is the deliberate choice. This is a BACKUP
 * path: a caller that hands the exporter a field and gets a package back
 * without it has silently lost data, and will not find out until a restore. An
 * unknown field means the caller and this schema version disagree about what a
 * context is, which is a bug in one of them - and the bump that resolves it is
 * a schemaVersion bump, because these objects are content-addressed and an
 * extra field manufactures two "same hash, different content" records.
 */
function assertNoUnknownFields(
  value: object,
  allowed: readonly string[],
  subject: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(
      `${subject} carries unknown field(s) ${unknown.join(", ")}; schemaVersion 1 has a closed field list, and a backup must not drop them silently`,
    );
  }
}

function contextMetadata(context: ExportContext): Record<string, unknown> {
  assertNoUnknownFields(context, CONTEXT_FIELDS, `context ${context.hash}`);

  const metadata: Record<string, unknown> = {
    hash: context.hash,
    original: context.original,
    createdAt: context.createdAt,
  };
  if (context.corrected !== undefined) {
    metadata.corrected = context.corrected;
  }
  if (context.answer !== undefined) {
    metadata.answer = context.answer;
  }

  const image = context.image;
  if (image !== undefined) {
    assertNoUnknownFields(
      image,
      CONTEXT_IMAGE_FIELDS,
      `context ${context.hash} image`,
    );
    if (!IMAGE_DIGEST_PATTERN.test(image.sha256)) {
      throw new TypeError(
        `context ${context.hash} image sha256 must be 64 lowercase hexadecimal characters with no ${HASH_PREFIX} prefix, received ${image.sha256}`,
      );
    }
    if (image.bytes.byteLength !== image.byteLength) {
      throw new TypeError(
        `context ${context.hash} declares byteLength ${image.byteLength} but carries ${image.bytes.byteLength} bytes`,
      );
    }
    // `bytes` is the payload, written as its own zip entry; only the metadata
    // describing it belongs in the JSON.
    metadata.image = {
      mediaType: image.mediaType,
      name: image.name,
      byteLength: image.byteLength,
      sha256: image.sha256,
    };
  }

  return metadata;
}

export function exportLedgerPackage(
  input: ExportLedgerPackageInput,
  dependencies: ExportLedgerPackageDependencies = DEFAULT_EXPORT_DEPENDENCIES,
): Uint8Array {
  const imageCount = input.contexts.reduce(
    (count, context) => count + (context.image === undefined ? 0 : 1),
    0,
  );
  assertPackageStructureWithinLimits({
    eventCount: input.events.length,
    contextCount: input.contexts.length,
    entryCount: 3 + input.contexts.length + imageCount,
  });

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

  const mtime = zipEntryMtime();
  const manifestBytes = strToU8(canonicalJson(manifest));
  const eventsBytes = strToU8(eventsJsonl);
  const redactionsBytes = strToU8("");
  const files: Record<string, ZipEntry> = {
    "manifest.json": [manifestBytes, { mtime }],
    "events.jsonl": [eventsBytes, { mtime }],
    "redactions.jsonl": [redactionsBytes, { mtime }],
  };
  const entrySizes: PackageEntrySize[] = [
    {
      name: "manifest.json",
      kind: "metadata",
      byteLength: manifestBytes.byteLength,
    },
    { name: "events.jsonl", kind: "text", byteLength: eventsBytes.byteLength },
    {
      name: "redactions.jsonl",
      kind: "text",
      byteLength: redactionsBytes.byteLength,
    },
  ];

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
    const metadataName = `contexts/${hex}.json`;
    const metadataBytes = strToU8(canonicalJson(contextMetadata(context)));
    files[metadataName] = [metadataBytes, { mtime }];
    entrySizes.push({
      name: metadataName,
      kind: "metadata",
      byteLength: metadataBytes.byteLength,
    });
    if (context.image !== undefined) {
      const imageName = `contexts/${hex}.image`;
      files[imageName] = [context.image.bytes, { mtime }];
      entrySizes.push({
        name: imageName,
        kind: "image",
        byteLength: context.image.bytes.byteLength,
      });
    }
  }

  assertPackageEntrySizesWithinLimits(entrySizes);
  const bytes = dependencies.zip(files, { level: 6 });
  assertCompressedPackageWithinLimit(bytes.byteLength);
  return bytes;
}
