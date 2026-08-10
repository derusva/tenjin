import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  readPackage,
  readPackageForTest,
} from "./readPackage.js";
import { ZIP_PROBE_FIXTURES } from "./zipProbeFixtures.js";
import { PACKAGE_LIMITS } from "./limits.js";
import {
  type RuntimeZipEntry,
  type RuntimeZipReader,
  type ZipReaderFactory,
  type ZipRuntimeLimits,
} from "./zipRuntime.js";

const SMALL_LIMITS: ZipRuntimeLimits = Object.freeze({
  compressedBytes: 4096,
  entries: 8,
  entryOutputBytes: 32,
  totalOutputBytes: 40,
});

function packageBytes(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  return zipSync(entries, { level: 0 });
}

function validEntries(): Record<string, Uint8Array> {
  return {
    "manifest.json": strToU8("{}"),
    "events.jsonl": strToU8(""),
  };
}

function testDependencies(readerFactory?: ZipReaderFactory) {
  return {
    ...(readerFactory === undefined ? {} : { readerFactory }),
    zipLimits: SMALL_LIMITS,
    entryOutputLimit: () => SMALL_LIMITS.entryOutputBytes,
  };
}

function fakeEntry(
  filename: string,
  data: Uint8Array,
  onGetData: () => void,
  declaredSize = data.byteLength,
): RuntimeZipEntry {
  return {
    filename,
    directory: false,
    encrypted: false,
    compressionMethod: 0,
    diskNumberStart: 0,
    zip64: false,
    compressedSize: data.byteLength,
    uncompressedSize: declaredSize,
    async getData(writer) {
      onGetData();
      const target = writer as {
        init(): Promise<void>;
        writeUint8Array(bytes: Uint8Array): Promise<void>;
        getData(): Promise<Uint8Array>;
      };
      await target.init();
      await target.writeUint8Array(data);
      return target.getData();
    },
  };
}

function fakeReaderFactory(reader: RuntimeZipReader): ZipReaderFactory {
  return () => reader;
}

describe("readPackage", () => {
  it("accepts a missing or empty redactions.jsonl", async () => {
    await expect(readPackage(packageBytes(validEntries()))).resolves.toMatchObject({
      redactionsJsonl: "",
    });
    await expect(
      readPackage(
        packageBytes({ ...validEntries(), "redactions.jsonl": new Uint8Array() }),
      ),
    ).resolves.toMatchObject({ redactionsJsonl: "" });
  });

  it("reads import-receipts.json as strict UTF-8 while keeping it optional for v1", async () => {
    await expect(readPackage(packageBytes(validEntries()))).resolves.not.toHaveProperty(
      "importReceiptsJson",
    );
    await expect(
      readPackage(
        packageBytes({
          ...validEntries(),
          "import-receipts.json": strToU8("[]"),
        }),
      ),
    ).resolves.toMatchObject({ importReceiptsJson: "[]" });
  });

  it("rejects invalid UTF-8 in import-receipts.json", async () => {
    await expect(
      readPackage(
        packageBytes({
          ...validEntries(),
          "import-receipts.json": new Uint8Array([0xc3, 0x28]),
        }),
      ),
    ).rejects.toThrow("import-receipts.json is not valid UTF-8");
  });

  it("applies the text-entry limit to import-receipts.json", async () => {
    const receiptText = " ".repeat(PACKAGE_LIMITS.metadataEntryBytes + 1);
    await expect(
      readPackage(
        packageBytes({
          ...validEntries(),
          "import-receipts.json": strToU8(receiptText),
        }),
      ),
    ).resolves.toMatchObject({ importReceiptsJson: receiptText });
  });

  it("rejects a non-empty redactions.jsonl", async () => {
    await expect(
      readPackage(
        packageBytes({ ...validEntries(), "redactions.jsonl": strToU8("\n") }),
      ),
    ).rejects.toMatchObject({
      code: "PACKAGE_REDACTIONS_UNSUPPORTED",
    });
  });

  it("rejects a path traversal entry name", async () => {
    // Whitelist, not blacklist: anything that is not exactly one of the six
    // legal shapes is rejected, so `../` never needs a special case.
    await expect(
      readPackage(
        packageBytes({ ...validEntries(), "../contexts/escape.json": strToU8("{}") }),
      ),
    ).rejects.toMatchObject({
      code: "PACKAGE_ENTRY_NAME_INVALID",
    });
  });

  it("rejects a near-miss receipt entry name", async () => {
    await expect(
      readPackage(
        packageBytes({
          ...validEntries(),
          "import-receipts.jsonl": strToU8("[]"),
        }),
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_ENTRY_NAME_INVALID" });
  });

  it("rejects a duplicate entry name on the second generator yield", async () => {
    // Feed through getEntriesGenerator(). The project duplicate error must be
    // raised on the second yield, before anything keys it by name; getEntries()
    // is not an allowed implementation because strict mode throws first.
    let getDataCalls = 0;
    let closeCalls = 0;
    const duplicate = fakeEntry("manifest.json", strToU8("{}"), () => {
      getDataCalls += 1;
    });
    const reader: RuntimeZipReader = {
      async *getEntriesGenerator() {
        yield duplicate;
        yield duplicate;
        return true;
      },
      close() {
        closeCalls += 1;
        return Promise.resolve();
      },
    };

    await expect(
      readPackageForTest(
        new Uint8Array([1]),
        testDependencies(fakeReaderFactory(reader)),
      ),
    ).rejects.toMatchObject({
      code: "ZIP_DUPLICATE_ENTRY",
    });
    expect(getDataCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it("exhausts the entry generator before accepting an archive", async () => {
    // Code after the final yield marks natural completion. A return()/early
    // break must not satisfy this assertion, keeping strict tail checks live.
    let exhausted = false;
    const manifest = fakeEntry("manifest.json", strToU8("{}"), () => undefined);
    const events = fakeEntry("events.jsonl", new Uint8Array(), () => undefined);
    const reader: RuntimeZipReader = {
      async *getEntriesGenerator() {
        yield manifest;
        yield events;
        exhausted = true;
        return true;
      },
      close: () => Promise.resolve(),
    };

    await expect(
      readPackageForTest(
        new Uint8Array([1]),
        testDependencies(fakeReaderFactory(reader)),
      ),
    ).resolves.toBeDefined();
    expect(exhausted).toBe(true);
  });

  it("rejects invalid UTF-8 in a text entry", async () => {
    // A non-fatal TextDecoder would silently replace this with U+FFFD.
    await expect(
      readPackage(
        packageBytes({
          ...validEntries(),
          "events.jsonl": new Uint8Array([0xc3, 0x28]),
        }),
      ),
    ).rejects.toThrow("events.jsonl is not valid UTF-8");
  });

  it("collects strict context JSON and raw image entries by hash", async () => {
    const hash = "a".repeat(64);
    const image = new Uint8Array([1, 2, 3]);
    const result = await readPackage(
      packageBytes({
        ...validEntries(),
        [`contexts/${hash}.json`]: strToU8('{"original":"x"}'),
        [`contexts/${hash}.image`]: image,
      }),
    );

    expect(result.contextJsonByHash.get(hash)).toBe('{"original":"x"}');
    expect(result.contextImageByHash.get(hash)).toEqual(image);
  });

  it("rejects compressed input before constructing a reader", async () => {
    // PACKAGE_COMPRESSED_LIMIT must fire before the reader factory.
    let readerFactoryCalls = 0;
    const bytes = { byteLength: SMALL_LIMITS.compressedBytes + 1 } as Uint8Array;
    const factory: ZipReaderFactory = () => {
      readerFactoryCalls += 1;
      throw new Error("reader must not be constructed");
    };

    await expect(
      readPackageForTest(bytes, testDependencies(factory)),
    ).rejects.toMatchObject({
      code: "PACKAGE_COMPRESSED_LIMIT",
    });
    expect(readerFactoryCalls).toBe(0);
  });

  it("rejects declared expansion before extracting an entry", async () => {
    // PACKAGE_DECLARED_LIMIT must leave every entry.getData at zero calls.
    let getDataCalls = 0;
    let closeCalls = 0;
    const entry = fakeEntry(
      "events.jsonl",
      new Uint8Array(),
      () => {
        getDataCalls += 1;
      },
      2,
    );
    const reader: RuntimeZipReader = {
      async *getEntriesGenerator() {
        yield entry;
        return true;
      },
      close() {
        closeCalls += 1;
        return Promise.resolve();
      },
    };

    await expect(
      readPackageForTest(
        new Uint8Array([1]),
        {
          ...testDependencies(fakeReaderFactory(reader)),
          entryOutputLimit: () => 1,
        },
      ),
    ).rejects.toMatchObject({
      code: "PACKAGE_DECLARED_LIMIT",
    });
    expect(getDataCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it("prioritises PACKAGE_OUTPUT_LIMIT over the vendor size error", async () => {
    await expect(
      readPackageForTest(
        ZIP_PROBE_FIXTURES.actualEntryOverflow,
        testDependencies(),
      ),
    ).rejects.toMatchObject({
      code: "PACKAGE_OUTPUT_LIMIT",
    });
  });

  it("enforces the package total against cumulative actual output", async () => {
    await expect(
      readPackageForTest(
        ZIP_PROBE_FIXTURES.actualPackageOverflow,
        testDependencies(),
      ),
    ).rejects.toMatchObject({
      code: "PACKAGE_OUTPUT_LIMIT",
    });
  });

  it("maps only the vendor CRC error to CRC_MISMATCH", async () => {
    await expect(
      readPackageForTest(ZIP_PROBE_FIXTURES.crcMismatch, {
        ...testDependencies(),
        entryOutputLimit: () => 1024,
        zipLimits: {
          ...SMALL_LIMITS,
          entryOutputBytes: 1024,
          totalOutputBytes: 4096,
        },
      }),
    ).rejects.toMatchObject({ code: "CRC_MISMATCH" });
  });
});
