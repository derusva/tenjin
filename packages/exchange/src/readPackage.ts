import { decodeUtf8Strict } from "./decodeUtf8.js";
import { PACKAGE_LIMITS } from "./limits.js";
import {
  readZipEntriesWithRuntime,
  type RuntimeZipEntry,
  type ZipReaderFactory,
  type ZipRuntimeLimits,
} from "./zipRuntime.js";

const CONTEXT_ENTRY_PATTERN =
  /^contexts\/([0-9a-f]{64})\.(json|image)$/;

export type ReadPackageErrorCode =
  | "PACKAGE_ENTRY_NAME_INVALID"
  | "PACKAGE_REQUIRED_ENTRY_MISSING"
  | "PACKAGE_REDACTIONS_UNSUPPORTED";

export class ReadPackageError extends Error {
  readonly code: ReadPackageErrorCode;

  constructor(code: ReadPackageErrorCode, subject?: string) {
    super(subject === undefined ? code : `${code}: ${subject}`);
    this.name = "ReadPackageError";
    this.code = code;
  }
}

export interface ReadLedgerPackage {
  readonly manifestJson: string;
  readonly eventsJsonl: string;
  readonly importReceiptsJson?: string;
  readonly redactionsJsonl: "";
  readonly contextJsonByHash: ReadonlyMap<string, string>;
  readonly contextImageByHash: ReadonlyMap<string, Uint8Array>;
}

interface ReadPackageDependencies {
  readonly readerFactory?: ZipReaderFactory;
  readonly zipLimits: ZipRuntimeLimits;
  readonly entryOutputLimit: (entry: RuntimeZipEntry) => number;
}

const PRODUCTION_ZIP_LIMITS: ZipRuntimeLimits = Object.freeze({
  compressedBytes: PACKAGE_LIMITS.compressedBytes,
  entries: PACKAGE_LIMITS.entries,
  entryOutputBytes: PACKAGE_LIMITS.textEntryBytes,
  totalOutputBytes: PACKAGE_LIMITS.decompressedBytes,
});

function entryKind(filename: string): "image" | "metadata" | "text" {
  if (filename.endsWith(".image")) return "image";
  if (
    filename === "events.jsonl" ||
    filename === "redactions.jsonl" ||
    filename === "import-receipts.json"
  ) {
    return "text";
  }
  return "metadata";
}

function productionEntryOutputLimit(entry: RuntimeZipEntry): number {
  switch (entryKind(entry.filename)) {
    case "image":
      return PACKAGE_LIMITS.imageEntryBytes;
    case "metadata":
      return PACKAGE_LIMITS.metadataEntryBytes;
    case "text":
      return PACKAGE_LIMITS.textEntryBytes;
  }
}

const PRODUCTION_DEPENDENCIES: ReadPackageDependencies = Object.freeze({
  zipLimits: PRODUCTION_ZIP_LIMITS,
  entryOutputLimit: productionEntryOutputLimit,
});

function assertAllowedEntry(entry: RuntimeZipEntry): void {
  if (entry.directory) {
    throw new ReadPackageError("PACKAGE_ENTRY_NAME_INVALID", entry.filename);
  }
  if (
    entry.filename === "manifest.json" ||
    entry.filename === "events.jsonl" ||
    entry.filename === "redactions.jsonl" ||
    entry.filename === "import-receipts.json" ||
    CONTEXT_ENTRY_PATTERN.test(entry.filename)
  ) {
    return;
  }
  throw new ReadPackageError("PACKAGE_ENTRY_NAME_INVALID", entry.filename);
}

function requiredEntry(
  entries: ReadonlyMap<string, Uint8Array>,
  name: string,
): Uint8Array {
  const bytes = entries.get(name);
  if (bytes === undefined) {
    throw new ReadPackageError("PACKAGE_REQUIRED_ENTRY_MISSING", name);
  }
  return bytes;
}

async function readPackageWithDependencies(
  bytes: Uint8Array,
  dependencies: ReadPackageDependencies,
): Promise<ReadLedgerPackage> {
  const raw = await readZipEntriesWithRuntime(
    bytes,
    dependencies.zipLimits,
    dependencies.readerFactory,
    undefined,
    {
      validateEntry: assertAllowedEntry,
      entryOutputLimit: dependencies.entryOutputLimit,
    },
  );

  const manifestJson = decodeUtf8Strict(
    requiredEntry(raw.entries, "manifest.json"),
    "manifest.json",
  );
  const eventsJsonl = decodeUtf8Strict(
    requiredEntry(raw.entries, "events.jsonl"),
    "events.jsonl",
  );
  const importReceiptsBytes = raw.entries.get("import-receipts.json");
  const importReceiptsJson =
    importReceiptsBytes === undefined
      ? undefined
      : decodeUtf8Strict(importReceiptsBytes, "import-receipts.json");
  const redactionsBytes = raw.entries.get("redactions.jsonl");
  if (redactionsBytes !== undefined && redactionsBytes.byteLength !== 0) {
    throw new ReadPackageError(
      "PACKAGE_REDACTIONS_UNSUPPORTED",
      "redactions.jsonl must be empty",
    );
  }

  const contextJsonByHash = new Map<string, string>();
  const contextImageByHash = new Map<string, Uint8Array>();
  for (const [name, entryBytes] of raw.entries) {
    const match = CONTEXT_ENTRY_PATTERN.exec(name);
    if (match === null) continue;
    const hash = match[1];
    if (hash === undefined) {
      throw new ReadPackageError("PACKAGE_ENTRY_NAME_INVALID", name);
    }
    if (match[2] === "json") {
      contextJsonByHash.set(hash, decodeUtf8Strict(entryBytes, name));
    } else {
      contextImageByHash.set(hash, entryBytes);
    }
  }

  return Object.freeze({
    manifestJson,
    eventsJsonl,
    ...(importReceiptsJson === undefined ? {} : { importReceiptsJson }),
    redactionsJsonl: "" as const,
    contextJsonByHash,
    contextImageByHash,
  });
}

export function readPackage(bytes: Uint8Array): Promise<ReadLedgerPackage> {
  return readPackageWithDependencies(bytes, PRODUCTION_DEPENDENCIES);
}

/** Package-internal test seam; it is deliberately not exported from index.ts. */
export function readPackageForTest(
  bytes: Uint8Array,
  dependencies: ReadPackageDependencies,
): Promise<ReadLedgerPackage> {
  return readPackageWithDependencies(bytes, dependencies);
}
