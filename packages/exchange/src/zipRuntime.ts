import {
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_INVALID_SIGNATURE,
  ERR_OVERLAPPING_ENTRY,
  Uint8ArrayReader,
  Writer,
  ZipReader,
} from "@zip.js/zip.js";

import {
  createNonZip64MaxEntriesFixture,
  ZIP_PROBE_EXPECTED,
  ZIP_PROBE_FIXTURES,
} from "./zipProbeFixtures.js";

export const ZIP_WORKER_OPTIONS = Object.freeze({
  useWebWorkers: true,
  useCompressionStream: true,
  transferStreams: true,
} as const);

export const ZIP_READER_OPTIONS = Object.freeze({
  ...ZIP_WORKER_OPTIONS,
  strictness: "strict",
  checkOverlappingEntry: true,
} as const);

export const ZIP_ENTRY_OPTIONS = Object.freeze({
  ...ZIP_WORKER_OPTIONS,
  strictness: "strict",
  checkOverlappingEntry: true,
  checkSignature: true,
} as const);

export type ZipRuntimeErrorCode =
  | "ZIP_ENCRYPTED_UNSUPPORTED"
  | "ZIP_COMPRESSION_UNSUPPORTED"
  | "ZIP_MULTI_DISK_UNSUPPORTED"
  | "ZIP64_ENTRY_UNSUPPORTED"
  | "ZIP64_ARCHIVE_UNSUPPORTED"
  | "ZIP_DUPLICATE_ENTRY"
  | "PACKAGE_COMPRESSED_LIMIT"
  | "PACKAGE_DECLARED_LIMIT"
  | "PACKAGE_OUTPUT_LIMIT"
  | "CRC_MISMATCH";

export class ZipRuntimeError extends Error {
  readonly code: ZipRuntimeErrorCode;
  override readonly cause?: unknown;

  constructor(code: ZipRuntimeErrorCode, cause?: unknown) {
    super(code);
    this.name = "ZipRuntimeError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface ZipRuntimeLimits {
  readonly compressedBytes: number;
  readonly entries: number;
  readonly entryOutputBytes: number;
  readonly totalOutputBytes: number;
}

interface RuntimeCancellationFlag {
  readonly aborted: boolean;
}

interface RuntimeAbortController {
  readonly signal: RuntimeCancellationFlag;
  abort(reason?: unknown): void;
}

declare const AbortController: {
  new (): RuntimeAbortController;
};

export interface RuntimeZipEntry {
  readonly filename: string;
  readonly directory: boolean;
  readonly encrypted: boolean;
  readonly compressionMethod: number;
  readonly diskNumberStart: number;
  readonly zip64?: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  getData(writer: unknown, options: unknown): Promise<unknown>;
}

export interface RuntimeZipReader {
  getEntriesGenerator(): AsyncGenerator<RuntimeZipEntry, boolean>;
  close(): Promise<void>;
}

export type ZipReaderFactory = (
  bytes: Uint8Array,
  options: typeof ZIP_READER_OPTIONS,
) => RuntimeZipReader;

export interface ZipRuntimeObservation {
  readonly readerFactoryCalls?: number;
  readonly getDataCalls?: number;
  readonly closeCalls?: number;
  readonly signals?: readonly RuntimeCancellationFlag[];
}

export interface ZipRuntimeReadResult {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly entryCount: number;
  readonly totalOutputBytes: number;
}

export interface ZipRuntimeReadPolicy {
  readonly validateEntry?: (entry: RuntimeZipEntry) => void;
  readonly entryOutputLimit?: (entry: RuntimeZipEntry) => number;
}

function defaultReaderFactory(
  bytes: Uint8Array,
  options: typeof ZIP_READER_OPTIONS,
): RuntimeZipReader {
  return new ZipReader(new Uint8ArrayReader(bytes), options) as unknown as RuntimeZipReader;
}

function getU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function getU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function getU64(bytes: Uint8Array, offset: number): number | undefined {
  const low = getU32(bytes, offset);
  const high = getU32(bytes, offset + 4);
  const value = high * 0x1_0000_0000 + low;
  return Number.isSafeInteger(value) ? value : undefined;
}

function findLastLegalEocd(bytes: Uint8Array): number | undefined {
  const first = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (
      getU32(bytes, offset) === 0x06054b50 &&
      offset + 22 + getU16(bytes, offset + 20) === bytes.byteLength
    ) {
      return offset;
    }
  }
  return undefined;
}

/** Archive-envelope checks that must happen before zip.js starts entry I/O. */
export function assertSupportedZipEnvelope(bytes: Uint8Array): void {
  const eocd = findLastLegalEocd(bytes);
  if (eocd === undefined) return;
  if (getU16(bytes, eocd + 4) !== 0 || getU16(bytes, eocd + 6) !== 0) {
    throw new ZipRuntimeError("ZIP_MULTI_DISK_UNSUPPORTED");
  }

  const locator = eocd - 20;
  if (locator >= 0 && getU32(bytes, locator) === 0x07064b50) {
    if (getU32(bytes, locator + 4) !== 0 || getU32(bytes, locator + 16) !== 1) {
      throw new ZipRuntimeError("ZIP_MULTI_DISK_UNSUPPORTED");
    }
    const zip64Offset = getU64(bytes, locator + 8);
    if (
      zip64Offset !== undefined &&
      zip64Offset + 56 <= locator &&
      getU32(bytes, zip64Offset) === 0x06064b50
    ) {
      if (
        getU32(bytes, zip64Offset + 16) !== 0 ||
        getU32(bytes, zip64Offset + 20) !== 0
      ) {
        throw new ZipRuntimeError("ZIP_MULTI_DISK_UNSUPPORTED");
      }
      throw new ZipRuntimeError("ZIP64_ARCHIVE_UNSUPPORTED");
    }
    throw new ZipRuntimeError("ZIP64_ARCHIVE_UNSUPPORTED");
  }

  const entriesOnDisk = getU16(bytes, eocd + 8);
  const totalEntries = getU16(bytes, eocd + 10);
  if (
    getU32(bytes, eocd + 12) === 0xffffffff ||
    getU32(bytes, eocd + 16) === 0xffffffff ||
    (entriesOnDisk === 0xffff) !== (totalEntries === 0xffff)
  ) {
    throw new ZipRuntimeError("ZIP64_ARCHIVE_UNSUPPORTED");
  }
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function mapEntryError(error: unknown): unknown {
  return messageOf(error) === ERR_INVALID_SIGNATURE
    ? new ZipRuntimeError("CRC_MISMATCH", error)
    : error;
}

function validateEntry(entry: RuntimeZipEntry): void {
  if (entry.encrypted) {
    throw new ZipRuntimeError("ZIP_ENCRYPTED_UNSUPPORTED");
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new ZipRuntimeError("ZIP_COMPRESSION_UNSUPPORTED");
  }
  if (entry.diskNumberStart !== 0) {
    throw new ZipRuntimeError("ZIP_MULTI_DISK_UNSUPPORTED");
  }
  if (entry.zip64 === true) {
    throw new ZipRuntimeError("ZIP64_ENTRY_UNSUPPORTED");
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class CountingWriter extends Writer<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private entryBytes = 0;

  constructor(
    private readonly controller: RuntimeAbortController,
    private readonly entryLimit: number,
    private readonly totalLimit: number,
    private readonly total: { value: number; limitExceeded: boolean },
  ) {
    super();
  }

  override init(): Promise<void> {
    return super.init?.() ?? Promise.resolve();
  }

  override writeUint8Array(chunk: Uint8Array): Promise<void> {
    const nextEntry = this.entryBytes + chunk.byteLength;
    const nextTotal = this.total.value + chunk.byteLength;
    if (nextEntry > this.entryLimit || nextTotal > this.totalLimit) {
      this.total.limitExceeded = true;
      const error = new ZipRuntimeError("PACKAGE_OUTPUT_LIMIT");
      this.controller.abort(error);
      return Promise.reject(error);
    }
    this.entryBytes = nextEntry;
    this.total.value = nextTotal;
    this.chunks.push(chunk.slice());
    return Promise.resolve();
  }

  override getData(): Promise<Uint8Array> {
    return Promise.resolve(concatChunks(this.chunks));
  }
}

const NO_OBSERVATION: ZipRuntimeObservation = Object.freeze({});
const NO_POLICY: ZipRuntimeReadPolicy = Object.freeze({});

export async function readZipEntriesWithRuntime(
  bytes: Uint8Array,
  limits: ZipRuntimeLimits,
  factory: ZipReaderFactory = defaultReaderFactory,
  observation: {
    readerFactoryCalls: number;
    getDataCalls: number;
    closeCalls: number;
    signals: RuntimeCancellationFlag[];
  } | ZipRuntimeObservation = NO_OBSERVATION,
  policy: ZipRuntimeReadPolicy = NO_POLICY,
): Promise<ZipRuntimeReadResult> {
  if (bytes.byteLength > limits.compressedBytes) {
    throw new ZipRuntimeError("PACKAGE_COMPRESSED_LIMIT");
  }
  assertSupportedZipEnvelope(bytes);

  const mutable = observation as {
    readerFactoryCalls?: number;
    getDataCalls?: number;
    closeCalls?: number;
    signals?: RuntimeCancellationFlag[];
  };
  if (mutable.readerFactoryCalls !== undefined) mutable.readerFactoryCalls += 1;
  const reader = factory(bytes, { ...ZIP_READER_OPTIONS });
  let operationFailed = false;
  let operationError: unknown;
  let result: ZipRuntimeReadResult | undefined;
  try {
    const entries: Array<{
      readonly entry: RuntimeZipEntry;
      readonly outputLimit: number;
    }> = [];
    const seenNames = new Set<string>();
    let declaredTotal = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      validateEntry(entry);
      policy.validateEntry?.(entry);
      if (seenNames.has(entry.filename)) {
        throw new ZipRuntimeError("ZIP_DUPLICATE_ENTRY");
      }
      seenNames.add(entry.filename);
      const outputLimit =
        policy.entryOutputLimit?.(entry) ?? limits.entryOutputBytes;
      if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) {
        throw new TypeError("entry output limit must be a non-negative safe integer");
      }
      entries.push({ entry, outputLimit });
      declaredTotal += entry.uncompressedSize;
      if (
        entries.length > limits.entries ||
        entry.uncompressedSize > outputLimit ||
        declaredTotal > limits.totalOutputBytes
      ) {
        throw new ZipRuntimeError("PACKAGE_DECLARED_LIMIT");
      }
    }

    const output = new Map<string, Uint8Array>();
    const total = { value: 0, limitExceeded: false };
    for (const { entry, outputLimit } of entries) {
      if (entry.directory) continue;
      const controller = new AbortController();
      mutable.signals?.push(controller.signal);
      const writer = new CountingWriter(
        controller,
        outputLimit,
        limits.totalOutputBytes,
        total,
      );
      if (mutable.getDataCalls !== undefined) mutable.getDataCalls += 1;
      try {
        const data = await entry.getData(writer, {
          ...ZIP_ENTRY_OPTIONS,
          signal: controller.signal,
        });
        output.set(entry.filename, data as Uint8Array);
      } catch (error) {
        if (total.limitExceeded) {
          throw new ZipRuntimeError("PACKAGE_OUTPUT_LIMIT", error);
        }
        throw mapEntryError(error);
      }
    }
    result = Object.freeze({
      entries: output,
      entryCount: entries.length,
      totalOutputBytes: total.value,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  if (mutable.closeCalls !== undefined) mutable.closeCalls += 1;
  try {
    await reader.close();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }

  if (operationFailed) throw operationError;
  if (closeFailed) throw closeError;
  if (result === undefined) throw new TypeError("ZIP read completed without a result");
  return result;
}

export interface ZipRuntimeProbeCase {
  readonly name: string;
  readonly pass: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface ZipRuntimeProbeResult {
  readonly pass: boolean;
  readonly cases: readonly ZipRuntimeProbeCase[];
}

const PROBE_LIMITS: ZipRuntimeLimits = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  entries: 65_535,
  entryOutputBytes: 32,
  totalOutputBytes: 40,
});

async function captureCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "OK";
  } catch (error) {
    if (error instanceof ZipRuntimeError) return error.code;
    return messageOf(error) ?? String(error);
  }
}

async function rawEntryError(
  bytes: Uint8Array,
  strictness: "strict" | "balanced",
  overlap = false,
): Promise<{ readonly code: string; readonly data?: Uint8Array }> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    ...ZIP_READER_OPTIONS,
    strictness,
  });
  try {
    const entries = [];
    for await (const entry of reader.getEntriesGenerator()) entries.push(entry);
    let data: Uint8Array | undefined;
    for (const entry of entries) {
      if (entry.directory) continue;
      const writer = new CountingWriter(
        new AbortController(),
        1024,
        4096,
        { value: 0, limitExceeded: false },
      );
      data = await entry.getData(writer, {
        ...ZIP_ENTRY_OPTIONS,
        strictness,
        checkOverlappingEntry: overlap || ZIP_ENTRY_OPTIONS.checkOverlappingEntry,
        signal: new AbortController().signal,
      });
    }
    return data === undefined ? { code: "OK" } : { code: "OK", data };
  } catch (error) {
    return { code: messageOf(error) ?? String(error) };
  } finally {
    await reader.close();
  }
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

/** Runs the retained T0 vendor capability probe in Node or a browser. */
export async function runZipRuntimeProbe(): Promise<ZipRuntimeProbeResult> {
  const cases: ZipRuntimeProbeCase[] = [];
  const record = (name: string, expected: string, actual: string): void => {
    cases.push(Object.freeze({ name, expected, actual, pass: expected === actual }));
  };

  let readerOptionsMatch = false;
  const receivedEntryOptions: Array<Record<string, unknown>> = [];
  const probeEntry = (filename: string): RuntimeZipEntry => ({
    filename,
    directory: false,
    encrypted: false,
    compressionMethod: 0,
    diskNumberStart: 0,
    zip64: false,
    compressedSize: 1,
    uncompressedSize: 1,
    async getData(writer, options) {
      receivedEntryOptions.push(options as Record<string, unknown>);
      const target = writer as {
        init(): Promise<void>;
        writeUint8Array(bytes: Uint8Array): Promise<void>;
        getData(): Promise<Uint8Array>;
      };
      await target.init();
      await target.writeUint8Array(new Uint8Array([1]));
      return target.getData();
    },
  });
  const optionFactory: ZipReaderFactory = (_bytes, options) => {
    readerOptionsMatch =
      Object.keys(options).length === Object.keys(ZIP_READER_OPTIONS).length &&
      Object.entries(ZIP_READER_OPTIONS).every(
        ([key, value]) => (options as Record<string, unknown>)[key] === value,
      );
    return {
      async *getEntriesGenerator() {
        yield probeEntry("a");
        yield probeEntry("b");
        return true;
      },
      close: () => Promise.resolve(),
    };
  };
  await readZipEntriesWithRuntime(new Uint8Array([1]), PROBE_LIMITS, optionFactory);
  const expectedEntryKeys = [...Object.keys(ZIP_ENTRY_OPTIONS), "signal"].sort();
  const entriesMatch = receivedEntryOptions.every(
    (options) =>
      Object.keys(options).sort().join("|") === expectedEntryKeys.join("|") &&
      Object.entries(ZIP_ENTRY_OPTIONS).every(
        ([key, value]) => options[key] === value,
      ),
  );
  const freshSignals =
    receivedEntryOptions.length === 2 &&
    receivedEntryOptions[0]?.signal !== receivedEntryOptions[1]?.signal;
  record(
    "configuration forwarding",
    "true:true:true",
    `${String(readerOptionsMatch)}:${String(entriesMatch)}:${String(freshSignals)}`,
  );

  const strict = await rawEntryError(ZIP_PROBE_FIXTURES.filenameMismatch, "strict");
  record("strict filename mismatch", ERR_AMBIGUOUS_ARCHIVE, strict.code);
  const balanced = await rawEntryError(
    ZIP_PROBE_FIXTURES.filenameMismatch,
    "balanced",
  );
  record(
    "balanced filename mismatch control",
    "OK:payload",
    balanced.code === "OK" &&
      bytesEqual(balanced.data, ZIP_PROBE_EXPECTED.balancedPayload)
      ? "OK:payload"
      : balanced.code,
  );

  const rawCrc = await rawEntryError(ZIP_PROBE_FIXTURES.crcMismatch, "strict");
  record("CRC raw", ERR_INVALID_SIGNATURE, rawCrc.code);
  record(
    "CRC mapping",
    "CRC_MISMATCH",
    await captureCode(() =>
      readZipEntriesWithRuntime(ZIP_PROBE_FIXTURES.crcMismatch, {
        ...PROBE_LIMITS,
        entryOutputBytes: 1024,
        totalOutputBytes: 4096,
      }),
    ),
  );

  const overlap = await rawEntryError(
    ZIP_PROBE_FIXTURES.overlappingEntries,
    "strict",
    true,
  );
  record("overlap", ERR_OVERLAPPING_ENTRY, overlap.code);

  const rejected = [
    ["encrypted", ZIP_PROBE_FIXTURES.encrypted, "ZIP_ENCRYPTED_UNSUPPORTED"],
    [
      "compression",
      ZIP_PROBE_FIXTURES.unsupportedCompression,
      "ZIP_COMPRESSION_UNSUPPORTED",
    ],
    [
      "archive multi-disk",
      ZIP_PROBE_FIXTURES.archiveMultiDisk,
      "ZIP_MULTI_DISK_UNSUPPORTED",
    ],
    [
      "entry multi-disk",
      ZIP_PROBE_FIXTURES.entryMultiDisk,
      "ZIP_MULTI_DISK_UNSUPPORTED",
    ],
    ["entry ZIP64", ZIP_PROBE_FIXTURES.zip64Entry, "ZIP64_ENTRY_UNSUPPORTED"],
    [
      "archive ZIP64",
      ZIP_PROBE_FIXTURES.zip64Archive,
      "ZIP64_ARCHIVE_UNSUPPORTED",
    ],
    [
      "archive ZIP64 sentinels",
      ZIP_PROBE_FIXTURES.zip64ArchiveSentinels,
      "ZIP64_ARCHIVE_UNSUPPORTED",
    ],
  ] as const;
  for (const [name, bytes, expected] of rejected) {
    const seen = {
      readerFactoryCalls: 0,
      getDataCalls: 0,
      closeCalls: 0,
      signals: [] as RuntimeCancellationFlag[],
    };
    record(
      name,
      `${expected}:0`,
      `${await captureCode(() => readZipEntriesWithRuntime(bytes, PROBE_LIMITS, defaultReaderFactory, seen))}:${seen.getDataCalls}`,
    );
  }

  record(
    "magic-byte negative control",
    "OK",
    await captureCode(() =>
      readZipEntriesWithRuntime(ZIP_PROBE_FIXTURES.magicBytesInPayloadAndComment, {
        ...PROBE_LIMITS,
        entryOutputBytes: 1024,
        totalOutputBytes: 4096,
      }),
    ),
  );
  let compressedFactoryCalls = 0;
  record(
    "compressed input limit",
    "PACKAGE_COMPRESSED_LIMIT:0",
    `${await captureCode(() =>
      readZipEntriesWithRuntime(
        new Uint8Array(2),
        { ...PROBE_LIMITS, compressedBytes: 1 },
        () => {
          compressedFactoryCalls += 1;
          throw new Error("reader factory must not run");
        },
      ))}:${compressedFactoryCalls}`,
  );

  const declaredSeen = {
    readerFactoryCalls: 0,
    getDataCalls: 0,
    closeCalls: 0,
    signals: [] as RuntimeCancellationFlag[],
  };
  record(
    "declared output limit",
    "PACKAGE_DECLARED_LIMIT:0:1",
    `${await captureCode(() =>
      readZipEntriesWithRuntime(
        ZIP_PROBE_FIXTURES.valid,
        { ...PROBE_LIMITS, entryOutputBytes: 1 },
        defaultReaderFactory,
        declaredSeen,
      ))}:${declaredSeen.getDataCalls}:${declaredSeen.closeCalls}`,
  );

  for (const [name, bytes, expectedCalls] of [
    ["actual entry output limit", ZIP_PROBE_FIXTURES.actualEntryOverflow, 1],
    ["actual package output limit", ZIP_PROBE_FIXTURES.actualPackageOverflow, 2],
  ] as const) {
    const seen = {
      readerFactoryCalls: 0,
      getDataCalls: 0,
      closeCalls: 0,
      signals: [] as RuntimeCancellationFlag[],
    };
    const code = await captureCode(() =>
      readZipEntriesWithRuntime(bytes, PROBE_LIMITS, defaultReaderFactory, seen),
    );
    record(
      name,
      `PACKAGE_OUTPUT_LIMIT:${expectedCalls}:true:1`,
      `${code}:${seen.getDataCalls}:${String(seen.signals.at(-1)?.aborted)}:${seen.closeCalls}`,
    );
  }

  const maxFixture = createNonZip64MaxEntriesFixture();
  let maxCount = 0;
  let maxZip64 = false;
  const maxReader = new ZipReader(new Uint8ArrayReader(maxFixture), {
    ...ZIP_READER_OPTIONS,
    strictness: "balanced",
  });
  try {
    for await (const entry of maxReader.getEntriesGenerator()) {
      maxCount += 1;
      maxZip64 ||= entry.zip64 === true;
    }
  } finally {
    await maxReader.close();
  }
  record(
    "non-ZIP64 65535-entry control",
    "65535:false",
    `${maxCount}:${String(maxZip64)}`,
  );

  return Object.freeze({
    pass: cases.every((testCase) => testCase.pass),
    cases: Object.freeze(cases),
  });
}
