import { serializeContextHashInput } from "@tenjin/core";
import { strToU8 } from "fflate";

export type Sha256Hex = (input: Uint8Array) => Promise<string>;

export type RestoreContextImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/heic"
  | "image/heif";

export interface RestoreContextImageShape {
  readonly mediaType: RestoreContextImageMediaType;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface RestoreContextShape {
  readonly hash: string;
  readonly original: string;
  readonly focus?: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly image?: RestoreContextImageShape;
  readonly createdAt: string;
}

export interface ContextEntries {
  readonly contextJsonByHash: ReadonlyMap<string, string>;
  readonly contextImageByHash: ReadonlyMap<string, Uint8Array>;
}

/**
 * Blob is a runtime global in the browser and current Node test runtime, while
 * its type belongs to the DOM library. Keep this declaration private and
 * deliberately narrow so @tenjin/exchange remains free of DOM types.
 */
declare const Blob: {
  new (
    parts: readonly Uint8Array[],
    options: { readonly type: string },
  ): { readonly size: number; readonly type: string };
};

const CONTEXT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BARE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTEXT_IMAGE_BYTES = 20 * 1024 * 1024;
const CONTEXT_V1_FIELDS: readonly string[] = [
  "hash",
  "original",
  "corrected",
  "answer",
  "image",
  "createdAt",
];
const CONTEXT_V2_FIELDS: readonly string[] = [
  "hash",
  "original",
  "focus",
  "corrected",
  "answer",
  "image",
  "createdAt",
];
const IMAGE_FIELDS: readonly string[] = [
  "mediaType",
  "name",
  "byteLength",
  "sha256",
];
const CONTEXT_IMAGE_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: "context" | "image",
): void {
  const unknown = Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(
      `unknown ${subject} field(s): ${unknown.join(", ")}`,
    );
  }
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(
  value: Record<string, unknown>,
  field: "focus" | "corrected" | "answer",
): string | undefined {
  if (!Object.hasOwn(value, field)) return undefined;
  return requireNonEmptyString(value[field], `context ${field}`);
}

function requireCanonicalUtcTimestamp(value: unknown): string {
  const timestamp = requireNonEmptyString(value, "context createdAt");
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    throw new TypeError(
      "context createdAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  return timestamp;
}

function isSupportedMediaType(
  value: unknown,
): value is RestoreContextImageMediaType {
  return typeof value === "string" && CONTEXT_IMAGE_MEDIA_TYPES.has(value);
}

function parseContextMetadata(json: string, entryHash: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new TypeError(`context ${entryHash} metadata must be valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`context ${entryHash} metadata must be an object`);
  }
  return parsed;
}

async function checkedDigest(
  sha256Hex: Sha256Hex,
  input: Uint8Array,
): Promise<string> {
  const digest = await sha256Hex(input);
  if (!BARE_DIGEST_PATTERN.test(digest)) {
    throw new TypeError(
      "digest function must return exactly 64 lowercase hexadecimal characters",
    );
  }
  return digest;
}

function assertEntryHash(entryHash: string, kind: "context" | "image"): void {
  if (!BARE_DIGEST_PATTERN.test(entryHash)) {
    throw new TypeError(
      `${kind} entry name must be exactly 64 lowercase hexadecimal characters`,
    );
  }
}

async function validateImage(
  imageValue: unknown,
  entryHash: string,
  imageBytes: Uint8Array | undefined,
  sha256Hex: Sha256Hex,
): Promise<RestoreContextImageShape> {
  if (!isRecord(imageValue)) {
    throw new TypeError(`context ${entryHash} image must be an object`);
  }
  assertNoUnknownFields(imageValue, IMAGE_FIELDS, "image");

  if (!isSupportedMediaType(imageValue.mediaType)) {
    throw new TypeError(
      `context ${entryHash} image mediaType must be supported`,
    );
  }
  const mediaType = imageValue.mediaType;
  const name = requireNonEmptyString(
    imageValue.name,
    `context ${entryHash} image name`,
  );
  const byteLength = imageValue.byteLength;
  if (
    !Number.isSafeInteger(byteLength) ||
    typeof byteLength !== "number" ||
    byteLength < 1 ||
    byteLength > MAX_CONTEXT_IMAGE_BYTES
  ) {
    throw new TypeError(
      `context ${entryHash} image byteLength must be between 1 byte and 20 MiB`,
    );
  }
  if (imageBytes === undefined) {
    throw new TypeError(`context ${entryHash} image entry is missing`);
  }
  if (imageBytes.byteLength !== byteLength) {
    throw new TypeError(
      `context ${entryHash} image declares ${byteLength} bytes but carries ${imageBytes.byteLength} bytes`,
    );
  }

  const declaredDigest = imageValue.sha256;
  if (
    typeof declaredDigest !== "string" ||
    !BARE_DIGEST_PATTERN.test(declaredDigest)
  ) {
    throw new TypeError(
      `context ${entryHash} image sha256 must be exactly 64 lowercase hexadecimal characters with no prefix`,
    );
  }
  const actualDigest = await checkedDigest(sha256Hex, imageBytes);
  if (actualDigest !== declaredDigest) {
    throw new TypeError(
      `context ${entryHash} image sha256 must match the actual bytes`,
    );
  }

  const blob = new Blob([imageBytes], { type: mediaType });
  if (blob.type !== mediaType) {
    throw new TypeError(
      `context ${entryHash} Blob type must equal image mediaType`,
    );
  }

  return {
    mediaType,
    name,
    byteLength,
    sha256: declaredDigest,
    bytes: imageBytes,
  };
}

/**
 * Validates and materialises all contexts before any restore transaction opens.
 * The maps use the bare digest from `contexts/<digest>.(json|image)` as their
 * key; returned context hashes retain the production `sha256:` prefix.
 */
export async function validateContexts(
  entries: ContextEntries,
  sha256Hex: Sha256Hex,
  schemaVersion: 1 | 2 = 1,
): Promise<readonly RestoreContextShape[]> {
  const contexts: RestoreContextShape[] = [];
  const entryHashes = [...entries.contextJsonByHash.keys()].sort();

  for (const entryHash of entryHashes) {
    assertEntryHash(entryHash, "context");
    const json = entries.contextJsonByHash.get(entryHash);
    if (json === undefined) {
      throw new TypeError(`context ${entryHash} metadata entry is missing`);
    }
    const metadata = parseContextMetadata(json, entryHash);
    assertNoUnknownFields(
      metadata,
      schemaVersion === 1 ? CONTEXT_V1_FIELDS : CONTEXT_V2_FIELDS,
      "context",
    );

    const hash = metadata.hash;
    if (typeof hash !== "string" || !CONTEXT_HASH_PATTERN.test(hash)) {
      throw new TypeError(
        `context hash must be sha256: followed by exactly 64 lowercase hexadecimal characters`,
      );
    }
    if (hash !== `sha256:${entryHash}`) {
      throw new TypeError(
        `context ${hash} must equal its metadata entry name ${entryHash}`,
      );
    }

    const original = requireNonEmptyString(
      metadata.original,
      `context ${entryHash} original`,
    );
    const focus =
      schemaVersion === 1
        ? undefined
        : optionalNonEmptyString(metadata, "focus");
    const corrected = optionalNonEmptyString(metadata, "corrected");
    const answer = optionalNonEmptyString(metadata, "answer");
    const createdAt = requireCanonicalUtcTimestamp(metadata.createdAt);

    const hasImage = Object.hasOwn(metadata, "image");
    const image = hasImage
      ? await validateImage(
          metadata.image,
          entryHash,
          entries.contextImageByHash.get(entryHash),
          sha256Hex,
        )
      : undefined;
    if (!hasImage && entries.contextImageByHash.has(entryHash)) {
      throw new TypeError(`context ${entryHash} has an orphan image entry`);
    }

    const actualContextDigest = await checkedDigest(
      sha256Hex,
      strToU8(
        serializeContextHashInput({
          original,
          ...(focus === undefined ? {} : { focus }),
          ...(corrected === undefined ? {} : { corrected }),
          ...(answer === undefined ? {} : { answer }),
          ...(image === undefined ? {} : { imageSha256: image.sha256 }),
        }),
      ),
    );
    if (`sha256:${actualContextDigest}` !== hash) {
      throw new TypeError(
        `context sha256 must match its serialized content for ${entryHash}`,
      );
    }

    contexts.push({
      hash,
      original,
      ...(focus === undefined ? {} : { focus }),
      ...(corrected === undefined ? {} : { corrected }),
      ...(answer === undefined ? {} : { answer }),
      ...(image === undefined ? {} : { image }),
      createdAt,
    });
  }

  for (const imageHash of entries.contextImageByHash.keys()) {
    assertEntryHash(imageHash, "image");
    if (!entries.contextJsonByHash.has(imageHash)) {
      throw new TypeError(`orphan image entry for context ${imageHash}`);
    }
  }

  return contexts;
}
