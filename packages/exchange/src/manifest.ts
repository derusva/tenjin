import type { LedgerWatermark } from "./watermark.js";

/**
 * v1 can only produce full backups. The abstract-exchange mode is deferred
 * until `focus` separation lands, because item_created.payload.display
 * currently carries the source sentence (createCapture.ts:165), so an
 * "abstract" package could not honour its only promise. Restorers must reject
 * any mode they do not recognise.
 */
export type LedgerPackageMode = "full-backup";

export interface LedgerPackageManifest {
  readonly packageKind: "tenjin-ledger";
  readonly schemaVersion: 1;
  readonly mode: LedgerPackageMode;
  readonly generation: 0;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly maxHlc: LedgerWatermark["maxHlc"];
  /**
   * Forward-compatibility guard, NOT a reserved slot.
   *
   * A non-empty array means the package carries fold-external state (the first
   * case will be Coach import receipts) that the reading version may not
   * understand. A restorer that does not understand every listed key MUST
   * reject the whole package rather than silently dropping the state - a
   * silent drop produces a restore that looks successful while the idempotency
   * record is gone. v1 exports always emit an empty array; actually adding
   * such state bumps schemaVersion to 2.
   */
  readonly foldExternalState: readonly [];
}

export interface BuildManifestInput {
  readonly mode: LedgerPackageMode;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly watermark: LedgerWatermark;
}

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANIFEST_FIELDS: readonly string[] = [
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

/**
 * The one complete v1 manifest shape validator shared by writer and reader.
 * Keep all shape-only rules here; validateManifest adds only comparisons with
 * the actual package contents.
 */
export function assertManifestV1Shape(
  value: unknown,
): asserts value is LedgerPackageManifest {
  if (!isRecord(value)) {
    throw new TypeError("manifest must be an object");
  }
  assertNoUnknownFields(value, MANIFEST_FIELDS, "manifest");

  if (value.packageKind !== "tenjin-ledger") {
    throw new TypeError('packageKind must equal "tenjin-ledger"');
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError("schemaVersion must equal the number 1");
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

  if (!Array.isArray(value.foldExternalState)) {
    throw new TypeError("foldExternalState must be an array");
  }
  if (value.foldExternalState.length > 0) {
    throw new TypeError(
      "foldExternalState names state this version does not understand; reject the whole package, not discard that state",
    );
  }
}

export function buildManifest(
  input: BuildManifestInput,
): LedgerPackageManifest {
  const candidate = {
    packageKind: "tenjin-ledger",
    schemaVersion: 1,
    mode: input.mode,
    // redaction is not implemented yet, so the ledger generation is always 0.
    // The field exists so that landing redaction does not change the format.
    generation: 0,
    exportedByDeviceId: input.exportedByDeviceId,
    exportedAt: input.exportedAt,
    eventCount: input.eventCount,
    contextCount: input.contextCount,
    maxSeqByDevice: input.watermark.maxSeqByDevice,
    maxHlc: input.watermark.maxHlc,
    foldExternalState: [] as const,
  } satisfies LedgerPackageManifest;

  assertManifestV1Shape(candidate);
  return candidate;
}
