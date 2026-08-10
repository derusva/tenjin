import type { Event, HybridLogicalClock } from "@tenjin/core";

import type { ReadLedgerPackage } from "./readPackage.js";
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
  const contexts = await validateContexts(source, sha256Hex);
  const contextHashes = new Set(contexts.map((context) => context.hash));
  const events = validateEvents(source.eventsJsonl, contextHashes);
  const manifest = validateManifest(source.manifestJson, {
    events,
    contextCount: contexts.length,
  });

  // Derive again for output rather than treating validated manifest claims as
  // the source of truth. The manifest is a cross-check; events own the state.
  const watermark = deriveWatermark(events);
  const forbiddenDeviceIds = new Set(events.map((event) => event.deviceId));
  forbiddenDeviceIds.add(manifest.exportedByDeviceId);

  return {
    events,
    contexts,
    globalHlc: watermark.maxHlc,
    maxSeqByDevice: watermark.maxSeqByDevice,
    forbiddenDeviceIds: [...forbiddenDeviceIds].sort(),
  };
}
