import { isCanonicalUtcTimestamp } from "./restoreCommit.js";

export interface CoachImportReceipt {
  readonly digest: string;
  readonly importedAt: string;
  readonly captureIds: readonly string[];
}

const RECEIPT_FIELDS = ["digest", "importedAt", "captureIds"] as const;
const RECEIPT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function assertCoachImportDigest(
  digest: unknown,
): asserts digest is string {
  if (typeof digest !== "string" || !RECEIPT_DIGEST_PATTERN.test(digest)) {
    throw new TypeError(
      "Coach import receipt digest must be sha256: followed by 64 lowercase hexadecimal characters",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Package-internal closed validator for durable Coach import receipts. */
export function assertCoachImportReceipt(
  value: unknown,
): asserts value is CoachImportReceipt {
  if (!isRecord(value)) {
    throw new TypeError("Coach import receipt must be an object");
  }

  const fields = Reflect.ownKeys(value).map(String).sort();
  const expectedFields = [...RECEIPT_FIELDS].sort();
  if (
    fields.length !== expectedFields.length ||
    fields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new TypeError(
      `Coach import receipt must contain exactly ${expectedFields.join(", ")}`,
    );
  }

  assertCoachImportDigest(value.digest);
  if (!isCanonicalUtcTimestamp(value.importedAt)) {
    throw new TypeError(
      "Coach import receipt importedAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
  if (!Array.isArray(value.captureIds) || value.captureIds.length === 0) {
    throw new TypeError(
      "Coach import receipt captureIds must be a non-empty array",
    );
  }

  const captureIds = new Set<string>();
  for (const captureId of value.captureIds) {
    if (typeof captureId !== "string" || captureId.trim().length === 0) {
      throw new TypeError(
        "Coach import receipt captureIds must contain only non-empty strings",
      );
    }
    if (captureIds.has(captureId)) {
      throw new TypeError(
        "Coach import receipt captureIds must contain unique strings",
      );
    }
    captureIds.add(captureId);
  }
}
