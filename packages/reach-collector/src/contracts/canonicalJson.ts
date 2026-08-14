import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export class CanonicalJsonError extends Error {
  readonly code = "REACH_CANONICAL_JSON_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function serializeCanonical(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${path} must contain a finite number`);
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(
        `${path} contains an unsupported ${typeof value} value`,
      );
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`${path} contains a circular reference`);
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const entries = value.map((entry, index) =>
        serializeCanonical(entry, `${path}[${index}]`, ancestors),
      );
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`${path} must contain only plain objects`);
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new CanonicalJsonError(`${path}.${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${serializeCanonical(
          entry,
          `${path}.${key}`,
          ancestors,
        )}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable, locale-independent JSON used as the hashing boundary. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, "$", new WeakSet<object>());
}

export function sha256Hex(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
