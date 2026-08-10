export const RESTORE_COMMIT_KEY = "restore-commit";

export interface RestoreCommitRecord {
  readonly key: "restore-commit";
  readonly type: "restore-commit";
  readonly newDeviceId: string;
  readonly committedAt: string;
}

const RESTORE_COMMIT_FIELDS: readonly string[] = [
  "key",
  "type",
  "newDeviceId",
  "committedAt",
];

export class RestoreCommitRecordError extends TypeError {
  override readonly name = "RestoreCommitRecordError";

  constructor(message: string) {
    super(`Invalid restore commit marker: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function isCanonicalDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim()
  );
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

/** Validates the durable fact that a restore transaction committed. */
export function assertRestoreCommitRecord(
  value: unknown,
): asserts value is RestoreCommitRecord {
  if (!isRecord(value)) {
    throw new RestoreCommitRecordError("record must be an object");
  }
  const unknownFields = Reflect.ownKeys(value)
    .filter(
      (field) =>
        typeof field !== "string" || !RESTORE_COMMIT_FIELDS.includes(field),
    )
    .map(String)
    .sort();
  if (unknownFields.length > 0) {
    throw new RestoreCommitRecordError(
      `unknown field(s): ${unknownFields.join(", ")}`,
    );
  }
  if (value.key !== RESTORE_COMMIT_KEY) {
    throw new RestoreCommitRecordError('key must equal "restore-commit"');
  }
  if (value.type !== "restore-commit") {
    throw new RestoreCommitRecordError('type must equal "restore-commit"');
  }
  if (!isCanonicalDeviceId(value.newDeviceId)) {
    throw new RestoreCommitRecordError(
      "newDeviceId must be a non-empty canonical string without surrounding whitespace",
    );
  }
  if (!isCanonicalUtcTimestamp(value.committedAt)) {
    throw new RestoreCommitRecordError(
      "committedAt must be a canonical UTC ISO-8601 timestamp",
    );
  }
}
