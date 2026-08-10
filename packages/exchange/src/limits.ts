export const PACKAGE_LIMITS = {
  /**
   * PRODUCT CONSTRAINT, not a security ceiling: the storage layer caps a single
   * capture image at 20 MiB (MAX_CONTEXT_IMAGE_BYTES).
   */
  imageEntryBytes: 20 * 1024 * 1024,

  /**
   * STRUCTURAL, not provisional: without ZIP64 a central directory holds at
   * most 65,535 entries. Four fixed v2 entries plus up to two per context
   * means 32,765 contexts is the largest image-bearing package that remains
   * below that ceiling (2 * 32_765 + 4 = 65_534).
   */
  entries: 65_535,
  contexts: 32_765,

  /**
   * PROVISIONAL SECURITY CEILINGS. Refusal thresholds, nothing more - never
   * quote them as supported capacity. They may only be frozen after boundary
   * validation at 80% and 100% of each, with both a text-heavy and an
   * image-heavy package, on the user's actual iPhone.
   */
  compressedBytes: 100 * 1024 * 1024,
  decompressedBytes: 250 * 1024 * 1024,
  textEntryBytes: 64 * 1024 * 1024,
  metadataEntryBytes: 1 * 1024 * 1024,
  events: 200_000,
} as const;

export interface PackageStructureCounts {
  readonly eventCount: number;
  readonly contextCount: number;
  readonly entryCount: number;
}

export type PackageEntryKind = "image" | "metadata" | "text";

export interface PackageEntrySize {
  readonly name: string;
  readonly kind: PackageEntryKind;
  readonly byteLength: number;
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function assertPackageStructureWithinLimits(
  counts: PackageStructureCounts,
): void {
  assertCount(counts.eventCount, "eventCount");
  assertCount(counts.contextCount, "contextCount");
  assertCount(counts.entryCount, "entryCount");
  if (counts.eventCount > PACKAGE_LIMITS.events) {
    throw new RangeError(
      `eventCount ${counts.eventCount} exceeds package limit ${PACKAGE_LIMITS.events}`,
    );
  }
  if (counts.contextCount > PACKAGE_LIMITS.contexts) {
    throw new RangeError(
      `contextCount ${counts.contextCount} exceeds package limit ${PACKAGE_LIMITS.contexts}`,
    );
  }
  if (counts.entryCount > PACKAGE_LIMITS.entries) {
    throw new RangeError(
      `entryCount ${counts.entryCount} exceeds package limit ${PACKAGE_LIMITS.entries}`,
    );
  }
}

function entryLimit(kind: PackageEntryKind): number {
  switch (kind) {
    case "image":
      return PACKAGE_LIMITS.imageEntryBytes;
    case "metadata":
      return PACKAGE_LIMITS.metadataEntryBytes;
    case "text":
      return PACKAGE_LIMITS.textEntryBytes;
  }
}

export function assertPackageEntrySizesWithinLimits(
  entries: readonly PackageEntrySize[],
): void {
  let total = 0;
  for (const entry of entries) {
    assertCount(entry.byteLength, `${entry.name} byteLength`);
    const limit = entryLimit(entry.kind);
    if (entry.byteLength > limit) {
      throw new RangeError(
        `${entry.name} byteLength ${entry.byteLength} exceeds ${entry.kind} entry limit ${limit}`,
      );
    }
    total += entry.byteLength;
    if (!Number.isSafeInteger(total) || total > PACKAGE_LIMITS.decompressedBytes) {
      throw new RangeError(
        `decompressed package bytes exceed limit ${PACKAGE_LIMITS.decompressedBytes}`,
      );
    }
  }
}

export function assertCompressedPackageWithinLimit(byteLength: number): void {
  assertCount(byteLength, "compressed package byteLength");
  if (byteLength > PACKAGE_LIMITS.compressedBytes) {
    throw new RangeError(
      `compressed package byteLength ${byteLength} exceeds limit ${PACKAGE_LIMITS.compressedBytes}`,
    );
  }
}
