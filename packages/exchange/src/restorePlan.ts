import type { Event, HybridLogicalClock } from "@tenjin/core";

import type { ReadLedgerPackage } from "./readPackage.js";
import {
  parseImportReceiptsJson,
  type PackageImportReceipt,
} from "./importReceipts.js";
import { parseLedgerPackageManifest } from "./manifest.js";
import {
  validateContexts,
  type RestoreContextShape,
  type Sha256Hex,
} from "./validateContexts.js";
import { validateEvents } from "./validateEvents.js";
import { validateManifest } from "./validateManifest.js";
import { deriveWatermark } from "./watermark.js";

export interface LedgerRestorePlan {
  readonly events: readonly Event[];
  readonly contexts: readonly RestoreContextShape[];
  readonly importReceipts: readonly PackageImportReceipt[];
  readonly globalHlc: HybridLogicalClock;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly forbiddenDeviceIds: readonly string[];
}

/**
 * Builds a fully validated, storage-compatible restore plan without writing.
 * The order is deliberate: only validated context identities may authorize an
 * active capture, and only validated events may be used for manifest checks or
 * output watermarks.
 */
export async function buildLedgerRestorePlan(
  source: ReadLedgerPackage,
  sha256Hex: Sha256Hex,
): Promise<LedgerRestorePlan> {
  // Parse only the closed shape first so the context hash contract can be
  // selected without interpreting fields from a future schema. Declarative
  // counts and watermarks remain cross-checks after content validation.
  const parsedManifest = parseLedgerPackageManifest(source.manifestJson);
  const contexts = await validateContexts(
    source,
    sha256Hex,
    parsedManifest.schemaVersion,
  );
  const contextHashes = new Set(contexts.map((context) => context.hash));
  const events = validateEvents(source.eventsJsonl, contextHashes);
  let importReceipts: readonly PackageImportReceipt[];
  if (parsedManifest.schemaVersion === 1) {
    if (source.importReceiptsJson !== undefined) {
      throw new TypeError(
        "schemaVersion 1 must not carry import-receipts.json",
      );
    }
    importReceipts = [];
  } else {
    if (source.importReceiptsJson === undefined) {
      throw new TypeError(
        "schemaVersion 2 requires import-receipts.json even when there are no receipts",
      );
    }
    const captureIds = new Set(
      events
        .filter((event) => event.kind === "capture_created")
        .map((event) => event.captureId),
    );
    importReceipts = parseImportReceiptsJson(
      source.importReceiptsJson,
      captureIds,
    );
  }
  const manifest = validateManifest(source.manifestJson, {
    events,
    contextCount: contexts.length,
    importReceiptCount: importReceipts.length,
    hasImportReceiptsEntry: source.importReceiptsJson !== undefined,
  });

  // Derive again for output rather than treating validated manifest claims as
  // the source of truth. The manifest is a cross-check; events own the state.
  const watermark = deriveWatermark(events);
  const forbiddenDeviceIds = new Set(events.map((event) => event.deviceId));
  forbiddenDeviceIds.add(manifest.exportedByDeviceId);

  return {
    events,
    contexts,
    importReceipts,
    globalHlc: watermark.maxHlc,
    maxSeqByDevice: watermark.maxSeqByDevice,
    forbiddenDeviceIds: [...forbiddenDeviceIds].sort(),
  };
}
