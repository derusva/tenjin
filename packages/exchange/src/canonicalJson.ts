function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Deterministic JSON used for package bytes only.
 *
 * This is NOT the context-hash serialiser. The context hash uses a fixed
 * literal field order over four fields and is part of content identity;
 * changing it would change historical hashes. This function recursively
 * sorts every key and exists purely so that the same ledger exports to the
 * same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalJson cannot serialise the non-finite number ${String(value)}`,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(
    `canonicalJson cannot serialise a value of type ${Object.prototype.toString.call(value)}`,
  );
}
