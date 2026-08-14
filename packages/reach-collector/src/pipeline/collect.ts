import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ReachConfig, ReachSourceConfig } from "../config.js";
import {
  hasSeenRevision,
  recordSeenRevision,
  recordSourceSuccess,
  type CollectorStateV1,
} from "../contracts/collectorState.js";
import type { RawSourceItemV1 } from "../contracts/rawSourceItem.js";
import { writeJsonAtomic } from "../state/fileStore.js";

export interface SourceCollectionResult {
  readonly sourceId: string;
  readonly status: "collected" | "probe_only";
  readonly items: readonly RawSourceItemV1[];
  readonly message?: string;
}

export interface CollectionAdapters {
  readonly collect: (
    source: ReachSourceConfig,
  ) => Promise<SourceCollectionResult>;
}

export interface CollectionRunResult {
  readonly state: CollectorStateV1;
  readonly newItems: readonly RawSourceItemV1[];
  readonly sources: readonly SourceCollectionResult[];
}

function rawPath(dataDir: string, item: RawSourceItemV1): string {
  return join(
    dataDir,
    "raw",
    item.itemKey.slice("sha256:".length),
    `${item.contentHash.slice("sha256:".length)}.json`,
  );
}

export async function runCollection(
  config: ReachConfig,
  dataDir: string,
  state: CollectorStateV1,
  adapters: CollectionAdapters,
  sourceIds?: ReadonlySet<string>,
  now = new Date(),
): Promise<CollectionRunResult> {
  await mkdir(dataDir, { recursive: true });
  let nextState = state;
  const newItems: RawSourceItemV1[] = [];
  const sources: SourceCollectionResult[] = [];
  const seenAt = now.toISOString();

  for (const source of config.sources) {
    if (!source.enabled || (sourceIds !== undefined && !sourceIds.has(source.id))) {
      continue;
    }
    const result = await adapters.collect(source);
    sources.push(result);
    if (result.status === "probe_only") {
      continue;
    }
    for (const item of result.items) {
      if (!hasSeenRevision(nextState, item)) {
        await writeJsonAtomic(rawPath(dataDir, item), item);
        newItems.push(item);
      }
      nextState = recordSeenRevision(nextState, item, seenAt);
    }
    nextState = recordSourceSuccess(nextState, source.id, seenAt);
  }
  return { state: nextState, newItems, sources };
}
