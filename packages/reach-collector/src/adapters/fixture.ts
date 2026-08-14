import { readFile } from "node:fs/promises";

import type { FixtureSourceConfig } from "../config.js";
import {
  createRawSourceItem,
  type RawSourceContentV1,
  type RawSourceItemV1,
  type ReachInteraction,
} from "../contracts/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function collectFixtureSource(
  config: FixtureSourceConfig,
): Promise<readonly RawSourceItemV1[]> {
  const parsed = JSON.parse(await readFile(config.path, "utf8")) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : null;
  if (values === null) {
    throw new Error("Fixture must be an array or an object with an items array");
  }
  return values.slice(0, config.limit).map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`Fixture item ${index} must be an object`);
    }
    return createRawSourceItem({
      sourceId: config.id,
      accountScope: config.accountScope,
      platform: "fixture",
      externalId: value.externalId as string,
      canonicalUrl: value.canonicalUrl as string,
      interaction: value.interaction as ReachInteraction,
      content: value.content as RawSourceContentV1,
      backend: { name: "fixture", version: "1" },
      ...(typeof value.publishedAt === "string"
        ? { publishedAt: value.publishedAt }
        : {}),
      ...(typeof value.author === "string" ? { author: value.author } : {}),
    });
  });
}
