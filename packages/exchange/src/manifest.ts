import type { LedgerWatermark } from "./watermark.js";

/** The only package mode implemented by either supported schema version. */
export type LedgerPackageMode = "full-backup";

interface LedgerPackageManifestBase {
  readonly packageKind: "tenjin-ledger";
  readonly mode: LedgerPackageMode;
  readonly generation: 0;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly maxHlc: LedgerWatermark["maxHlc"];
}

/** Legacy packages have no focus field and no fold-external receipt state. */
export interface LedgerPackageManifestV1 extends LedgerPackageManifestBase {
  readonly schemaVersion: 1;
  readonly foldExternalState: readonly [];
}

/**
 * v2 closes the backup hole introduced by durable Coach import receipts.
 * The singleton descriptor is an active compatibility guard: a reader must
 * understand and restore the named state rather than silently discard it.
 */
export interface LedgerPackageManifestV2 extends LedgerPackageManifestBase {
  readonly schemaVersion: 2;
  readonly importReceiptCount: number;
  readonly foldExternalState: readonly ["importReceipts"];
}

export type LedgerPackageManifest =
  | LedgerPackageManifestV1
  | LedgerPackageManifestV2;

export interface BuildManifestInput {
  readonly mode: LedgerPackageMode;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly importReceiptCount: number;
  readonly watermark: LedgerWatermark;
}

export type UnsupportedSchemaVersionErrorCode =
  "UNSUPPORTED_SCHEMA_VERSION";

/** A stable, machine-readable refusal for packages from a future schema. */
export class UnsupportedSchemaVersionError extends TypeError {
  readonly code: UnsupportedSchemaVersionErrorCode =
    "UNSUPPORTED_SCHEMA_VERSION";
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(
      `UNSUPPORTED_SCHEMA_VERSION: package schemaVersion ${schemaVersion} is newer than supported schemaVersion 2`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

const CANONICAL_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANIFEST_V1_FIELDS: readonly string[] = [
  "packageKind",
  "schemaVersion",
  "mode",
  "generation",
  "exportedByDeviceId",
  "exportedAt",
  "eventCount",
  "contextCount",
  "maxSeqByDevice",
  "maxHlc",
  "foldExternalState",
];
const MANIFEST_V2_FIELDS: readonly string[] = [
  ...MANIFEST_V1_FIELDS,
  "importReceiptCount",
];
const MAX_HLC_FIELDS: readonly string[] = ["wallTime", "counter"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unknown = Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(
      `${subject} carries unknown field(s): ${unknown.join(", ")}`,
    );
  }
}

function isCanonicalDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim()
  );
}

function assertNonNegativeSafeInteger(value: unknown, field: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function assertMaxHlc(
  value: unknown,
): asserts value is LedgerWatermark["maxHlc"] {
  if (!isRecord(value)) {
    throw new TypeError("maxHlc must be an object");
  }
  assertNoUnknownFields(value, MAX_HLC_FIELDS, "maxHlc");
  assertNonNegativeSafeInteger(value.wallTime, "maxHlc wallTime");
  assertNonNegativeSafeInteger(value.counter, "maxHlc counter");
}

function assertMaxSeqByDevice(
  value: unknown,
): asserts value is Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    throw new TypeError("maxSeqByDevice must be an object");
  }
  for (const [deviceId, sequence] of Object.entries(value)) {
    if (!isCanonicalDeviceId(deviceId)) {
      throw new TypeError(
        `maxSeqByDevice deviceId must be non-empty and canonical, received ${JSON.stringify(deviceId)}`,
      );
    }
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      throw new TypeError(
        `maxSeqByDevice values must be positive safe integers; ${JSON.stringify(deviceId)} has ${String(sequence)}`,
      );
    }
  }
}

function assertCommonManifestShape(value: Record<string, unknown>): void {
  if (value.packageKind !== "tenjin-ledger") {
    throw new TypeError('packageKind must equal "tenjin-ledger"');
  }
  if (value.mode !== "full-backup") {
    throw new TypeError(
      `mode must equal "full-backup", received ${JSON.stringify(value.mode)}`,
    );
  }
  if (
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation !== 0
  ) {
    throw new TypeError("generation must equal the integer 0");
  }
  if (!isCanonicalDeviceId(value.exportedByDeviceId)) {
    throw new TypeError(
      "exportedByDeviceId must be a non-empty canonical string without surrounding whitespace",
    );
  }
  if (
    typeof value.exportedAt !== "string" ||
    !CANONICAL_UTC_TIMESTAMP.test(value.exportedAt)
  ) {
    throw new TypeError(
      "exportedAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  const exportedAtMilliseconds = Date.parse(value.exportedAt);
  if (
    !Number.isFinite(exportedAtMilliseconds) ||
    new Date(exportedAtMilliseconds).toISOString() !== value.exportedAt
  ) {
    throw new TypeError(
      "exportedAt must identify a real date in canonical UTC ISO-8601 form",
    );
  }

  assertNonNegativeSafeInteger(value.eventCount, "eventCount");
  assertNonNegativeSafeInteger(value.contextCount, "contextCount");
  assertMaxHlc(value.maxHlc);
  assertMaxSeqByDevice(value.maxSeqByDevice);
}

/** The complete closed legacy shape validator. */
export function assertManifestV1Shape(
  value: unknown,
): asserts value is LedgerPackageManifestV1 {
  if (!isRecord(value)) {
    throw new TypeError("manifest must be an object");
  }
  assertNoUnknownFields(value, MANIFEST_V1_FIELDS, "manifest");
  if (value.schemaVersion !== 1) {
    throw new TypeError("schemaVersion must equal the number 1");
  }
  assertCommonManifestShape(value);
  if (!Array.isArray(value.foldExternalState)) {
    throw new TypeError("foldExternalState must be an array");
  }
  if (value.foldExternalState.length > 0) {
    throw new TypeError(
      "foldExternalState names state this version does not understand; reject the whole package, not discard that state",
    );
  }
}

/** The complete closed active writer/reader shape validator. */
export function assertManifestV2Shape(
  value: unknown,
): asserts value is LedgerPackageManifestV2 {
  if (!isRecord(value)) {
    throw new TypeError("manifest must be an object");
  }
  assertNoUnknownFields(value, MANIFEST_V2_FIELDS, "manifest");
  if (value.schemaVersion !== 2) {
    throw new TypeError("schemaVersion must equal the number 2");
  }
  assertCommonManifestShape(value);
  assertNonNegativeSafeInteger(
    value.importReceiptCount,
    "importReceiptCount",
  );
  if (
    !Array.isArray(value.foldExternalState) ||
    value.foldExternalState.length !== 1 ||
    value.foldExternalState[0] !== "importReceipts"
  ) {
    throw new TypeError(
      'foldExternalState must equal exactly ["importReceipts"] for schemaVersion 2',
    );
  }
}

/** Dispatches without interpreting fields from a future schema. */
export function assertLedgerPackageManifestShape(
  value: unknown,
): asserts value is LedgerPackageManifest {
  if (!isRecord(value)) {
    throw new TypeError("manifest must be an object");
  }
  if (value.schemaVersion === 1) {
    assertManifestV1Shape(value);
    return;
  }
  if (value.schemaVersion === 2) {
    assertManifestV2Shape(value);
    return;
  }
  if (
    typeof value.schemaVersion === "number" &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion >= 3
  ) {
    throw new UnsupportedSchemaVersionError(value.schemaVersion);
  }
  throw new TypeError("schemaVersion must equal a supported number (1 or 2)");
}

export function parseLedgerPackageManifest(
  manifestJson: string,
): LedgerPackageManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new TypeError("manifest must be valid JSON");
  }
  assertLedgerPackageManifestShape(candidate);
  return candidate;
}

/** Active writers always produce schemaVersion 2 packages. */
export function buildManifest(
  input: BuildManifestInput,
): LedgerPackageManifestV2 {
  const candidate = {
    packageKind: "tenjin-ledger",
    schemaVersion: 2,
    mode: input.mode,
    generation: 0,
    exportedByDeviceId: input.exportedByDeviceId,
    exportedAt: input.exportedAt,
    eventCount: input.eventCount,
    contextCount: input.contextCount,
    importReceiptCount: input.importReceiptCount,
    maxSeqByDevice: input.watermark.maxSeqByDevice,
    maxHlc: input.watermark.maxHlc,
    foldExternalState: ["importReceipts"] as const,
  } satisfies LedgerPackageManifestV2;

  assertManifestV2Shape(candidate);
  return candidate;
}
