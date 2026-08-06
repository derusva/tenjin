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
  readonly generation: number;
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
  readonly foldExternalState: readonly string[];
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

export function buildManifest(
  input: BuildManifestInput,
): LedgerPackageManifest {
  if (input.exportedByDeviceId.trim().length === 0) {
    throw new TypeError("exportedByDeviceId must be a non-empty string");
  }
  if (!CANONICAL_UTC_TIMESTAMP.test(input.exportedAt)) {
    throw new TypeError(
      `exportedAt must be a canonical UTC ISO-8601 timestamp, received ${input.exportedAt}`,
    );
  }

  return {
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
    foldExternalState: [],
  };
}
