import { type Sha256Digest } from "./canonicalJson.js";
import {
  ReachContractError,
  type RawSourceItemV1,
} from "./rawSourceItem.js";

export const COLLECTOR_STATE_SCHEMA = "tenjin.reach-state/v1" as const;

export interface CollectorSourceStateV1 {
  readonly cursor?: string;
  readonly lastSuccessAt?: string;
}

export interface SeenSourceRevisionV1 {
  readonly sourceIds: readonly string[];
  readonly revisionKey: Sha256Digest;
  readonly contentHash: Sha256Digest;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface CollectorStateV1 {
  readonly schema: typeof COLLECTOR_STATE_SCHEMA;
  readonly sources: Readonly<Record<string, CollectorSourceStateV1>>;
  readonly revisions: Readonly<Record<string, SeenSourceRevisionV1>>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATE_ENTRIES = 100_000;

function invalid(field: string, message: string): never {
  throw new ReachContractError("REACH_CONTRACT_INVALID", field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${field}.${key}`, "field is not allowed");
    }
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(field, "must be a non-empty string");
  }
  return value.trim();
}

function sourceId(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field);
  if (!SOURCE_ID_PATTERN.test(parsed)) {
    invalid(field, "must be a stable sourceId");
  }
  return parsed;
}

function sourceIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(field, "must be a non-empty array of stable sourceIds");
  }
  const parsed = value.map((candidate, index) =>
    sourceId(candidate, `${field}[${index}]`),
  );
  const orderedUnique = [...new Set(parsed)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    orderedUnique.length !== parsed.length ||
    orderedUnique.some((candidate, index) => candidate !== parsed[index])
  ) {
    invalid(field, "must be sorted and contain no duplicates");
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    invalid(field, "must be a canonical ISO-8601 UTC timestamp");
  }
  return parsed;
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(field, "must be sha256: followed by 64 lowercase hex characters");
  }
  return value as Sha256Digest;
}

export function createEmptyCollectorState(): CollectorStateV1 {
  return { schema: COLLECTOR_STATE_SCHEMA, sources: {}, revisions: {} };
}

export function parseCollectorState(value: unknown): CollectorStateV1 {
  if (!isRecord(value)) {
    invalid("$", "must be an object");
  }
  assertExactFields(value, new Set(["schema", "sources", "revisions"]), "$");
  if (value.schema !== COLLECTOR_STATE_SCHEMA) {
    invalid("schema", `must be ${COLLECTOR_STATE_SCHEMA}`);
  }
  if (!isRecord(value.sources)) {
    invalid("sources", "must be an object keyed by sourceId");
  }
  if (!isRecord(value.revisions)) {
    invalid("revisions", "must be an object keyed by itemKey");
  }
  if (Object.keys(value.revisions).length > MAX_STATE_ENTRIES) {
    invalid("revisions", `must not exceed ${MAX_STATE_ENTRIES} entries`);
  }

  const sources: Record<string, CollectorSourceStateV1> = {};
  for (const [sourceId, candidate] of Object.entries(value.sources)) {
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      invalid(`sources.${sourceId}`, "key must be a stable sourceId");
    }
    if (!isRecord(candidate)) {
      invalid(`sources.${sourceId}`, "must be an object");
    }
    assertExactFields(
      candidate,
      new Set(["cursor", "lastSuccessAt"]),
      `sources.${sourceId}`,
    );
    const cursor =
      candidate.cursor === undefined
        ? undefined
        : nonEmptyString(candidate.cursor, `sources.${sourceId}.cursor`);
    const lastSuccessAt =
      candidate.lastSuccessAt === undefined
        ? undefined
        : timestamp(candidate.lastSuccessAt, `sources.${sourceId}.lastSuccessAt`);
    sources[sourceId] = {
      ...(cursor === undefined ? {} : { cursor }),
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    };
  }

  const revisions: Record<string, SeenSourceRevisionV1> = {};
  for (const [itemKey, candidate] of Object.entries(value.revisions)) {
    digest(itemKey, `revisions.${itemKey}`);
    if (!isRecord(candidate)) {
      invalid(`revisions.${itemKey}`, "must be an object");
    }
    assertExactFields(
      candidate,
      new Set([
        "sourceIds",
        "revisionKey",
        "contentHash",
        "firstSeenAt",
        "lastSeenAt",
      ]),
      `revisions.${itemKey}`,
    );
    const parsedSourceIds = sourceIds(
      candidate.sourceIds,
      `revisions.${itemKey}.sourceIds`,
    );
    const firstSeenAt = timestamp(
      candidate.firstSeenAt,
      `revisions.${itemKey}.firstSeenAt`,
    );
    const lastSeenAt = timestamp(
      candidate.lastSeenAt,
      `revisions.${itemKey}.lastSeenAt`,
    );
    if (Date.parse(firstSeenAt) > Date.parse(lastSeenAt)) {
      invalid(`revisions.${itemKey}.lastSeenAt`, "must not precede firstSeenAt");
    }
    revisions[itemKey] = {
      sourceIds: parsedSourceIds,
      revisionKey: digest(
        candidate.revisionKey,
        `revisions.${itemKey}.revisionKey`,
      ),
      contentHash: digest(
        candidate.contentHash,
        `revisions.${itemKey}.contentHash`,
      ),
      firstSeenAt,
      lastSeenAt,
    };
  }

  return { schema: COLLECTOR_STATE_SCHEMA, sources, revisions };
}

export function hasSeenRevision(
  state: CollectorStateV1,
  item: Pick<RawSourceItemV1, "itemKey" | "revisionKey">,
): boolean {
  return state.revisions[item.itemKey]?.revisionKey === item.revisionKey;
}

export function recordSeenRevision(
  state: CollectorStateV1,
  item: Pick<
    RawSourceItemV1,
    "itemKey" | "revisionKey" | "contentHash" | "sourceId"
  >,
  seenAt: string,
): CollectorStateV1 {
  const normalizedSeenAt = timestamp(seenAt, "seenAt");
  const previous = state.revisions[item.itemKey];
  const normalizedSourceId = sourceId(item.sourceId, "item.sourceId");
  const sameRevision =
    previous?.revisionKey === item.revisionKey &&
    previous.contentHash === item.contentHash;
  const observedSourceIds = sameRevision
    ? [...new Set([...previous.sourceIds, normalizedSourceId])].sort((left, right) =>
        left.localeCompare(right),
      )
    : [normalizedSourceId];
  return {
    ...state,
    revisions: {
      ...state.revisions,
      [item.itemKey]: {
        sourceIds: observedSourceIds,
        revisionKey: item.revisionKey,
        contentHash: item.contentHash,
        firstSeenAt: sameRevision ? previous.firstSeenAt : normalizedSeenAt,
        lastSeenAt: normalizedSeenAt,
      },
    },
  };
}

export function recordSourceSuccess(
  state: CollectorStateV1,
  sourceId: string,
  successAt: string,
  cursor?: string,
): CollectorStateV1 {
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    invalid("sourceId", "must be a stable sourceId");
  }
  const source: CollectorSourceStateV1 = {
    lastSuccessAt: timestamp(successAt, "successAt"),
    ...(cursor === undefined
      ? state.sources[sourceId]?.cursor === undefined
        ? {}
        : { cursor: state.sources[sourceId].cursor }
      : { cursor: nonEmptyString(cursor, "cursor") }),
  };
  return { ...state, sources: { ...state.sources, [sourceId]: source } };
}
