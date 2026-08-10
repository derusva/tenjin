import { describe, expect, it } from "vitest";

import {
  assertCompressedPackageWithinLimit,
  assertPackageEntrySizesWithinLimits,
  assertPackageStructureWithinLimits,
  PACKAGE_LIMITS,
} from "./limits.js";

describe("package limits", () => {
  it("accepts the exact non-ZIP64 structure boundaries", () => {
    expect(() =>
      assertPackageStructureWithinLimits({
        eventCount: PACKAGE_LIMITS.events,
        contextCount: 32_766,
        entryCount: 65_535,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "eventCount",
      { eventCount: PACKAGE_LIMITS.events + 1, contextCount: 0, entryCount: 3 },
    ],
    ["contextCount", { eventCount: 0, contextCount: 32_767, entryCount: 3 }],
    ["entryCount", { eventCount: 0, contextCount: 32_766, entryCount: 65_536 }],
  ] as const)("rejects %s above its structural boundary", (_name, counts) => {
    expect(() => assertPackageStructureWithinLimits(counts)).toThrow(RangeError);
  });

  it.each([
    ["image", PACKAGE_LIMITS.imageEntryBytes],
    ["metadata", PACKAGE_LIMITS.metadataEntryBytes],
    ["text", PACKAGE_LIMITS.textEntryBytes],
  ] as const)("accepts and then rejects the %s entry byte boundary", (kind, limit) => {
    expect(() =>
      assertPackageEntrySizesWithinLimits([
        { name: kind, kind, byteLength: limit },
      ]),
    ).not.toThrow();
    expect(() =>
      assertPackageEntrySizesWithinLimits([
        { name: kind, kind, byteLength: limit + 1 },
      ]),
    ).toThrow(RangeError);
  });

  it("enforces cumulative decompressed bytes without allocating the payload", () => {
    const entries = [
      {
        name: "first",
        kind: "text" as const,
        byteLength: PACKAGE_LIMITS.textEntryBytes,
      },
      {
        name: "second",
        kind: "text" as const,
        byteLength: PACKAGE_LIMITS.textEntryBytes,
      },
      {
        name: "third",
        kind: "text" as const,
        byteLength: PACKAGE_LIMITS.textEntryBytes,
      },
      {
        name: "fourth",
        kind: "text" as const,
        byteLength: PACKAGE_LIMITS.textEntryBytes - 6 * 1024 * 1024,
      },
    ];
    expect(() => assertPackageEntrySizesWithinLimits(entries)).not.toThrow();
    expect(() =>
      assertPackageEntrySizesWithinLimits([
        ...entries,
        { name: "overflow", kind: "metadata", byteLength: 1 },
      ]),
    ).toThrow(RangeError);
  });

  it("accepts the compressed boundary and rejects one byte above it", () => {
    expect(() =>
      assertCompressedPackageWithinLimit(PACKAGE_LIMITS.compressedBytes),
    ).not.toThrow();
    expect(() =>
      assertCompressedPackageWithinLimit(PACKAGE_LIMITS.compressedBytes + 1),
    ).toThrow(RangeError);
  });

  it("rejects non-integer and negative values instead of normalising them", () => {
    expect(() =>
      assertPackageStructureWithinLimits({
        eventCount: -1,
        contextCount: 0,
        entryCount: 3,
      }),
    ).toThrow(TypeError);
    expect(() => assertCompressedPackageWithinLimit(0.5)).toThrow(TypeError);
  });
});
