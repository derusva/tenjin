import {
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_INVALID_SIGNATURE,
  ERR_OVERLAPPING_ENTRY,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";
import { validateEvent } from "@tenjin/core";
import { inflateSync, strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createNonZip64MaxEntriesFixture,
  ZIP_PROBE_EXPECTED,
  ZIP_PROBE_FIXTURES,
} from "./zipProbeFixtures.js";
import {
  readZipEntriesWithRuntime,
  runZipRuntimeProbe,
  ZIP_ENTRY_OPTIONS,
  ZIP_READER_OPTIONS,
  ZIP_WORKER_OPTIONS,
  ZipRuntimeError,
  type RuntimeZipEntry,
  type RuntimeZipReader,
  type ZipReaderFactory,
  type ZipRuntimeErrorCode,
  type ZipRuntimeLimits,
} from "./zipRuntime.js";

const SMALL_LIMITS: ZipRuntimeLimits = Object.freeze({
  compressedBytes: 4096,
  entries: 8,
  entryOutputBytes: 32,
  totalOutputBytes: 40,
});

function observation() {
  return {
    readerFactoryCalls: 0,
    getDataCalls: 0,
    closeCalls: 0,
    signals: [] as Array<{ readonly aborted: boolean }>,
  };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: ZipRuntimeErrorCode,
): Promise<ZipRuntimeError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ZipRuntimeError);
    expect((error as ZipRuntimeError).code).toBe(code);
    return error as ZipRuntimeError;
  }
  throw new Error(`Expected ${code}`);
}

function fakeEntry(
  filename: string,
  onOptions: (options: Record<string, unknown>) => void,
): RuntimeZipEntry {
  return {
    filename,
    directory: false,
    encrypted: false,
    compressionMethod: 0,
    diskNumberStart: 0,
    zip64: false,
    compressedSize: 1,
    uncompressedSize: 1,
    async getData(writer, options) {
      onOptions(options as Record<string, unknown>);
      const target = writer as {
        init(): Promise<void>;
        writeUint8Array(bytes: Uint8Array): Promise<void>;
        getData(): Promise<Uint8Array>;
      };
      await target.init();
      await target.writeUint8Array(new Uint8Array([1]));
      return target.getData();
    },
  };
}

const closeFailingFactory: ZipReaderFactory = (bytes, options) => {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
  return {
    async *getEntriesGenerator() {
      for await (const entry of reader.getEntriesGenerator()) {
        yield entry as unknown as RuntimeZipEntry;
      }
      return true;
    },
    async close() {
      await reader.close();
      throw new Error("synthetic close failure");
    },
  };
};

describe("T0 G0 - frozen configuration is used", () => {
  it("passes every reader/entry option and creates a fresh signal per getData", async () => {
    let readerOptions: unknown;
    const entryOptions: Array<Record<string, unknown>> = [];
    let closed = 0;
    const entries = [
      fakeEntry("a", (options) => entryOptions.push(options)),
      fakeEntry("b", (options) => entryOptions.push(options)),
    ];
    const factory: ZipReaderFactory = (bytes, options) => {
      expect(bytes).toEqual(new Uint8Array([1]));
      readerOptions = options;
      return {
        async *getEntriesGenerator() {
          for (const entry of entries) yield entry;
          return true;
        },
        async close() {
          closed += 1;
        },
      } satisfies RuntimeZipReader;
    };

    await readZipEntriesWithRuntime(
      new Uint8Array([1]),
      SMALL_LIMITS,
      factory,
    );

    expect(readerOptions).toEqual(ZIP_READER_OPTIONS);
    expect(Object.keys(readerOptions as object).sort()).toEqual(
      Object.keys(ZIP_READER_OPTIONS).sort(),
    );
    expect(entryOptions).toHaveLength(2);
    for (const options of entryOptions) {
      expect(options).toMatchObject(ZIP_ENTRY_OPTIONS);
      expect(Object.keys(options).sort()).toEqual(
        [...Object.keys(ZIP_ENTRY_OPTIONS), "signal"].sort(),
      );
      expect(options.signal).toBeDefined();
    }
    expect(entryOptions[0]?.signal).not.toBe(entryOptions[1]?.signal);
    expect(closed).toBe(1);
    expect(ZIP_WORKER_OPTIONS).toEqual({
      useWebWorkers: true,
      useCompressionStream: true,
      transferStreams: true,
    });
  });
});

async function rawRead(
  bytes: Uint8Array,
  strictness: "strict" | "balanced" = "strict",
): Promise<Uint8Array[]> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    ...ZIP_READER_OPTIONS,
    strictness,
  });
  try {
    const output: Uint8Array[] = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.directory) continue;
      output.push(
        await entry.getData(new Uint8ArrayWriter(), {
          ...ZIP_ENTRY_OPTIONS,
          strictness,
        }),
      );
    }
    return output;
  } finally {
    await reader.close();
  }
}

async function entrySizeMetadata(
  bytes: Uint8Array,
): Promise<
  Array<{ compressionMethod: number; signature: number; uncompressedSize: number }>
> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    ...ZIP_READER_OPTIONS,
    strictness: "balanced",
  });
  try {
    const metadata = [];
    for await (const entry of reader.getEntriesGenerator()) {
      metadata.push({
        compressionMethod: entry.compressionMethod,
        signature: entry.signature,
        uncompressedSize: entry.uncompressedSize,
      });
    }
    return metadata;
  } finally {
    await reader.close();
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function crc32ForTest(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateLocalEntries(bytes: Uint8Array): Array<{
  actualSize: number;
  compressionMethod: number;
  declaredSize: number;
  signature: number;
}> {
  const entries = [];
  let offset = 0;
  while (readU32(bytes, offset) === 0x04034b50) {
    const compressionMethod = readU16(bytes, offset + 8);
    const signature = readU32(bytes, offset + 14);
    const compressedSize = readU32(bytes, offset + 18);
    const declaredSize = readU32(bytes, offset + 22);
    const dataOffset =
      offset + 30 + readU16(bytes, offset + 26) + readU16(bytes, offset + 28);
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const actual = compressionMethod === 8 ? inflateSync(compressed) : compressed;
    expect(signature).toBe(crc32ForTest(actual));
    entries.push({
      actualSize: actual.byteLength,
      compressionMethod,
      declaredSize,
      signature,
    });
    offset = dataOffset + compressedSize;
  }
  return entries;
}

describe("T0 G1/G4 - strictness, overlap, and CRC", () => {
  it("rejects only the filename mismatch in strict mode and fully reads it in balanced mode", async () => {
    await expect(rawRead(ZIP_PROBE_FIXTURES.filenameMismatch)).rejects.toThrow(
      ERR_AMBIGUOUS_ARCHIVE,
    );
    const balanced = await rawRead(
      ZIP_PROBE_FIXTURES.filenameMismatch,
      "balanced",
    );
    expect(balanced).toEqual([ZIP_PROBE_EXPECTED.balancedPayload]);
  });

  it("detects overlap only after reading A and then B", async () => {
    await expect(rawRead(ZIP_PROBE_FIXTURES.overlappingEntries)).rejects.toThrow(
      ERR_OVERLAPPING_ENTRY,
    );
  });

  it("pins the vendor CRC error and maps only it with the original cause", async () => {
    const tamperedEntries = unzipSync(ZIP_PROBE_FIXTURES.crcMismatch);
    const tamperedJson: unknown = JSON.parse(
      strFromU8(tamperedEntries["events.jsonl"] ?? new Uint8Array()),
    );
    const validation = validateEvent(tamperedJson);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error("CRC fixture must remain a valid event");
    if (validation.value.kind !== "item_created") {
      throw new Error("CRC fixture must remain an item_created event");
    }
    expect(validation.value.payload.display).toBe("bravo");

    await expect(rawRead(ZIP_PROBE_FIXTURES.crcMismatch)).rejects.toThrow(
      ERR_INVALID_SIGNATURE,
    );
    const error = await expectCode(
      () =>
        readZipEntriesWithRuntime(ZIP_PROBE_FIXTURES.crcMismatch, {
          ...SMALL_LIMITS,
          entryOutputBytes: 1024,
          totalOutputBytes: 4096,
        }),
      "CRC_MISMATCH",
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(ERR_INVALID_SIGNATURE);

    await expect(
      readZipEntriesWithRuntime(ZIP_PROBE_FIXTURES.filenameMismatch, SMALL_LIMITS),
    ).rejects.toThrow(ERR_AMBIGUOUS_ARCHIVE);
  });
});

describe("T0 G2 - unsupported archives fail before entry output", () => {
  const cases = [
    [ZIP_PROBE_FIXTURES.encrypted, "ZIP_ENCRYPTED_UNSUPPORTED", false],
    [ZIP_PROBE_FIXTURES.unsupportedCompression, "ZIP_COMPRESSION_UNSUPPORTED", false],
    [ZIP_PROBE_FIXTURES.archiveMultiDisk, "ZIP_MULTI_DISK_UNSUPPORTED", true],
    [ZIP_PROBE_FIXTURES.entryMultiDisk, "ZIP_MULTI_DISK_UNSUPPORTED", false],
    [ZIP_PROBE_FIXTURES.zip64Entry, "ZIP64_ENTRY_UNSUPPORTED", false],
    [ZIP_PROBE_FIXTURES.zip64Archive, "ZIP64_ARCHIVE_UNSUPPORTED", true],
    [
      ZIP_PROBE_FIXTURES.zip64ArchiveSentinels,
      "ZIP64_ARCHIVE_UNSUPPORTED",
      true,
    ],
  ] as const;

  for (const [bytes, code, rejectedBeforeFactory] of cases) {
    it(code, async () => {
      const seen = observation();
      await expectCode(
        () => readZipEntriesWithRuntime(bytes, SMALL_LIMITS, undefined, seen),
        code,
      );
      expect(seen.getDataCalls).toBe(0);
      expect(seen.signals).toHaveLength(0);
      expect(seen.readerFactoryCalls).toBe(rejectedBeforeFactory ? 0 : 1);
      expect(seen.closeCalls).toBe(rejectedBeforeFactory ? 0 : 1);
    });
  }

  it("marks only the entry fixture as zip64 and ignores magic bytes in data/comment", async () => {
    const entryReader = new ZipReader(
      new Uint8ArrayReader(ZIP_PROBE_FIXTURES.zip64Entry),
      { ...ZIP_READER_OPTIONS, strictness: "balanced" },
    );
    const archiveReader = new ZipReader(
      new Uint8ArrayReader(ZIP_PROBE_FIXTURES.zip64Archive),
      { ...ZIP_READER_OPTIONS, strictness: "balanced" },
    );
    try {
      const entryValues = [];
      for await (const entry of entryReader.getEntriesGenerator()) entryValues.push(entry);
      const archiveValues = [];
      for await (const entry of archiveReader.getEntriesGenerator()) archiveValues.push(entry);
      expect(entryValues[0]?.zip64).toBe(true);
      expect(archiveValues[0]?.zip64).not.toBe(true);
    } finally {
      await entryReader.close();
      await archiveReader.close();
    }

    await expect(
      readZipEntriesWithRuntime(
        ZIP_PROBE_FIXTURES.magicBytesInPayloadAndComment,
        { ...SMALL_LIMITS, entryOutputBytes: 1024, totalOutputBytes: 4096 },
      ),
    ).resolves.toMatchObject({ entryCount: 1 });
  });

  it("enumerates the fflate 0xffff boundary without ZIP64", async () => {
    const reader = new ZipReader(
      new Uint8ArrayReader(createNonZip64MaxEntriesFixture()),
      { ...ZIP_READER_OPTIONS, strictness: "balanced" },
    );
    let count = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        count += 1;
        expect(entry.zip64).not.toBe(true);
      }
    } finally {
      await reader.close();
    }
    expect(count).toBe(65_535);
  }, 60_000);
});

describe("T0 G3 - compressed, declared, and actual-output limits", () => {
  it("rejects compressed bytes before constructing a reader", async () => {
    let calls = 0;
    const factory: ZipReaderFactory = () => {
      calls += 1;
      throw new Error("must not be called");
    };
    await expectCode(
      () =>
        readZipEntriesWithRuntime(
          new Uint8Array(2),
          { ...SMALL_LIMITS, compressedBytes: 1 },
          factory,
        ),
      "PACKAGE_COMPRESSED_LIMIT",
    );
    expect(calls).toBe(0);
  });

  it("rejects declared size with no getData and always closes", async () => {
    const seen = observation();
    await expectCode(
      () =>
        readZipEntriesWithRuntime(
          ZIP_PROBE_FIXTURES.valid,
          { ...SMALL_LIMITS, entryOutputBytes: 1 },
          undefined,
          seen,
        ),
      "PACKAGE_DECLARED_LIMIT",
    );
    expect(seen.readerFactoryCalls).toBe(1);
    expect(seen.getDataCalls).toBe(0);
    expect(seen.closeCalls).toBe(1);
  });

  it("accepts actual output exactly at both byte limits", async () => {
    const exactBytes = ZIP_PROBE_EXPECTED.validPayload.byteLength;
    const result = await readZipEntriesWithRuntime(ZIP_PROBE_FIXTURES.valid, {
      ...SMALL_LIMITS,
      entryOutputBytes: exactBytes,
      totalOutputBytes: exactBytes,
    });

    expect(result.entryCount).toBe(1);
    expect(result.totalOutputBytes).toBe(exactBytes);
    expect(result.entries.get("valid.txt")).toEqual(ZIP_PROBE_EXPECTED.validPayload);
  });

  it("stops a producer at the crossing chunk instead of consuming another chunk", async () => {
    let attemptedAfterCrossing = false;
    const factory: ZipReaderFactory = () => ({
      async *getEntriesGenerator() {
        yield {
          filename: "events.jsonl",
          directory: false,
          encrypted: false,
          compressionMethod: 8,
          diskNumberStart: 0,
          zip64: false,
          compressedSize: 1,
          uncompressedSize: 32,
          async getData(writer) {
            const target = writer as {
              init(): Promise<void>;
              writeUint8Array(bytes: Uint8Array): Promise<void>;
              getData(): Promise<Uint8Array>;
            };
            await target.init();
            await target.writeUint8Array(new Uint8Array(33));
            attemptedAfterCrossing = true;
            await target.writeUint8Array(new Uint8Array([1]));
            return target.getData();
          },
        } satisfies RuntimeZipEntry;
        return true;
      },
      close: () => Promise.resolve(),
    });

    await expectCode(
      () =>
        readZipEntriesWithRuntime(
          new Uint8Array([1]),
          SMALL_LIMITS,
          factory,
        ),
      "PACKAGE_OUTPUT_LIMIT",
    );
    expect(attemptedAfterCrossing).toBe(false);
  });

  it("uses actual chunks, aborts, closes, and preserves limit priority", async () => {
    const entryLocal = inflateLocalEntries(ZIP_PROBE_FIXTURES.actualEntryOverflow);
    expect(entryLocal).toMatchObject([
      { actualSize: 33, compressionMethod: 8, declaredSize: 32 },
    ]);
    expect(await entrySizeMetadata(ZIP_PROBE_FIXTURES.actualEntryOverflow)).toEqual([
      {
        compressionMethod: 8,
        signature: entryLocal[0]?.signature,
        uncompressedSize: 32,
      },
    ]);
    const packageLocal = inflateLocalEntries(
      ZIP_PROBE_FIXTURES.actualPackageOverflow,
    );
    expect(packageLocal).toMatchObject([
      { actualSize: 20, compressionMethod: 8, declaredSize: 20 },
      { actualSize: 21, compressionMethod: 8, declaredSize: 20 },
    ]);
    expect(await entrySizeMetadata(ZIP_PROBE_FIXTURES.actualPackageOverflow)).toEqual([
      {
        compressionMethod: 8,
        signature: packageLocal[0]?.signature,
        uncompressedSize: 20,
      },
      {
        compressionMethod: 8,
        signature: packageLocal[1]?.signature,
        uncompressedSize: 20,
      },
    ]);

    const entrySeen = observation();
    const entryError = await expectCode(
      () =>
        readZipEntriesWithRuntime(
          ZIP_PROBE_FIXTURES.actualEntryOverflow,
          SMALL_LIMITS,
          undefined,
          entrySeen,
        ),
      "PACKAGE_OUTPUT_LIMIT",
    );
    expect(entryError.cause).toBeDefined();
    expect(entrySeen.getDataCalls).toBe(1);
    expect(entrySeen.signals[0]?.aborted).toBe(true);
    expect(entrySeen.closeCalls).toBe(1);

    const totalSeen = observation();
    await expectCode(
      () =>
        readZipEntriesWithRuntime(
          ZIP_PROBE_FIXTURES.actualPackageOverflow,
          SMALL_LIMITS,
          undefined,
          totalSeen,
        ),
      "PACKAGE_OUTPUT_LIMIT",
    );
    expect(totalSeen.getDataCalls).toBe(2);
    expect(totalSeen.signals[1]?.aborted).toBe(true);
    expect(totalSeen.closeCalls).toBe(1);
  });

  it("keeps the output-limit error when reader close also fails", async () => {
    const seen = observation();
    await expectCode(
      () =>
        readZipEntriesWithRuntime(
          ZIP_PROBE_FIXTURES.actualEntryOverflow,
          SMALL_LIMITS,
          closeFailingFactory,
          seen,
        ),
      "PACKAGE_OUTPUT_LIMIT",
    );
    expect(seen.closeCalls).toBe(1);
  });

  it("surfaces a reader close failure after an otherwise successful read", async () => {
    const exactBytes = ZIP_PROBE_EXPECTED.validPayload.byteLength;
    await expect(
      readZipEntriesWithRuntime(
        ZIP_PROBE_FIXTURES.valid,
        {
          ...SMALL_LIMITS,
          entryOutputBytes: exactBytes,
          totalOutputBytes: exactBytes,
        },
        closeFailingFactory,
      ),
    ).rejects.toThrow("synthetic close failure");
  });
});

describe("retained public probe", () => {
  it("passes every T0 vendor capability case", async () => {
    const result = await runZipRuntimeProbe();
    expect(result.cases.filter((testCase) => !testCase.pass)).toEqual([]);
    expect(result.pass).toBe(true);
  }, 60_000);
});
