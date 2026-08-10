import type { Event } from "@tenjin/core";

import {
  parseLedgerPackageManifest,
  type LedgerPackageManifest,
} from "./manifest.js";
import { deriveWatermark } from "./watermark.js";

export interface ManifestActuals {
  readonly events: readonly Event[];
  readonly contextCount: number;
  readonly importReceiptCount: number;
  readonly hasImportReceiptsEntry: boolean;
}

function sameNumberRecord(
  declared: Readonly<Record<string, number>>,
  derived: Readonly<Record<string, number>>,
): boolean {
  const declaredKeys = Object.keys(declared).sort();
  const derivedKeys = Object.keys(derived).sort();
  if (
    declaredKeys.length !== derivedKeys.length ||
    declaredKeys.some((key, index) => key !== derivedKeys[index])
  ) {
    return false;
  }
  return derivedKeys.every(
    (key) => Object.hasOwn(declared, key) && declared[key] === derived[key],
  );
}

/**
 * Validates the manifest read from a package. Shape rules live exclusively in
 * the version-dispatched manifest parser; this layer only cross-checks claims
 * against bytes that were independently read and events that were independently
 * validated.
 */
export function validateManifest(
  manifestJson: string,
  actuals: ManifestActuals,
): LedgerPackageManifest {
  const candidate = parseLedgerPackageManifest(manifestJson);

  if (candidate.eventCount !== actuals.events.length) {
    throw new TypeError(
      `manifest eventCount ${candidate.eventCount} does not equal actual event count ${actuals.events.length}`,
    );
  }
  if (candidate.contextCount !== actuals.contextCount) {
    throw new TypeError(
      `manifest contextCount ${candidate.contextCount} does not equal actual context count ${actuals.contextCount}`,
    );
  }
  if (candidate.schemaVersion === 1) {
    if (actuals.hasImportReceiptsEntry || actuals.importReceiptCount !== 0) {
      throw new TypeError(
        "schemaVersion 1 must not carry import-receipts.json or import receipts",
      );
    }
  } else {
    if (!actuals.hasImportReceiptsEntry) {
      throw new TypeError(
        "schemaVersion 2 requires import-receipts.json even when importReceiptCount is zero",
      );
    }
    if (candidate.importReceiptCount !== actuals.importReceiptCount) {
      throw new TypeError(
        `manifest importReceiptCount ${candidate.importReceiptCount} does not equal actual import receipt count ${actuals.importReceiptCount}`,
      );
    }
  }

  const derived = deriveWatermark(actuals.events);
  if (
    candidate.maxHlc.wallTime !== derived.maxHlc.wallTime ||
    candidate.maxHlc.counter !== derived.maxHlc.counter
  ) {
    throw new TypeError("manifest maxHlc does not equal the event-derived maxHlc");
  }
  if (!sameNumberRecord(candidate.maxSeqByDevice, derived.maxSeqByDevice)) {
    throw new TypeError(
      "manifest maxSeqByDevice does not equal the event-derived maxSeqByDevice",
    );
  }

  return candidate;
}
