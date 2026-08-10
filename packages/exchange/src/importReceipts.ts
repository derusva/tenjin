export interface PackageImportReceipt {
  readonly digest: string;
  readonly importedAt: string;
  readonly captureIds: readonly string[];
}

const RECEIPT_FIELDS = ["captureIds", "digest", "importedAt"] as const;
const RECEIPT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function assertClosedReceipt(
  value: unknown,
  index: number,
): asserts value is PackageImportReceipt {
  if (!isRecord(value)) {
    throw new TypeError(`import receipt ${index} must be an object`);
  }

  const fields = Reflect.ownKeys(value).map(String).sort();
  if (
    fields.length !== RECEIPT_FIELDS.length ||
    fields.some((field, fieldIndex) => field !== RECEIPT_FIELDS[fieldIndex])
  ) {
    throw new TypeError(
      `import receipt ${index} must contain exactly ${RECEIPT_FIELDS.join(", ")}`,
    );
  }
  if (
    typeof value.digest !== "string" ||
    !RECEIPT_DIGEST_PATTERN.test(value.digest)
  ) {
    throw new TypeError(
      `import receipt ${index} digest must be sha256: followed by 64 lowercase hexadecimal characters`,
    );
  }
  if (
    typeof value.importedAt !== "string" ||
    !CANONICAL_UTC_TIMESTAMP.test(value.importedAt)
  ) {
    throw new TypeError(
      `import receipt ${index} importedAt must be a canonical UTC ISO-8601 timestamp`,
    );
  }
  const importedAtMilliseconds = Date.parse(value.importedAt);
  if (
    !Number.isFinite(importedAtMilliseconds) ||
    new Date(importedAtMilliseconds).toISOString() !== value.importedAt
  ) {
    throw new TypeError(
      `import receipt ${index} importedAt must identify a real date in canonical UTC ISO-8601 form`,
    );
  }
  if (!Array.isArray(value.captureIds) || value.captureIds.length === 0) {
    throw new TypeError(
      `import receipt ${index} captureIds must be a non-empty array`,
    );
  }

  const seenCaptureIds = new Set<string>();
  for (const captureId of value.captureIds) {
    if (typeof captureId !== "string" || captureId.trim().length === 0) {
      throw new TypeError(
        `import receipt ${index} captureIds must contain only non-empty strings`,
      );
    }
    if (seenCaptureIds.has(captureId)) {
      throw new TypeError(
        `import receipt ${index} captureIds must contain unique strings`,
      );
    }
    seenCaptureIds.add(captureId);
  }
}

/**
 * Validates, clones and deterministically orders receipt records. The order of
 * captureIds inside a receipt is identity-bearing storage state and is never
 * normalised.
 */
export function validateImportReceipts(
  value: unknown,
  availableCaptureIds?: ReadonlySet<string>,
): readonly PackageImportReceipt[] {
  if (!Array.isArray(value)) {
    throw new TypeError("import-receipts.json must contain a JSON array");
  }

  const receipts: PackageImportReceipt[] = [];
  const seenDigests = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    assertClosedReceipt(candidate, index);
    if (seenDigests.has(candidate.digest)) {
      throw new TypeError(`duplicate import receipt digest ${candidate.digest}`);
    }
    if (availableCaptureIds !== undefined) {
      for (const captureId of candidate.captureIds) {
        if (!availableCaptureIds.has(captureId)) {
          throw new TypeError(
            `import receipt ${candidate.digest} references unknown captureId ${captureId}`,
          );
        }
      }
    }
    seenDigests.add(candidate.digest);
    receipts.push({
      digest: candidate.digest,
      importedAt: candidate.importedAt,
      captureIds: [...candidate.captureIds],
    });
  }

  receipts.sort((left, right) =>
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
  );
  return receipts;
}

export function parseImportReceiptsJson(
  json: string,
  availableCaptureIds?: ReadonlySet<string>,
): readonly PackageImportReceipt[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(json) as unknown;
  } catch {
    throw new TypeError("import-receipts.json must be valid JSON");
  }
  return validateImportReceipts(candidate, availableCaptureIds);
}
