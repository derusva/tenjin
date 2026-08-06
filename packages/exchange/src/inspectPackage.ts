import { strFromU8, unzipSync } from "fflate";

export function readPackageEntries(
  bytes: Uint8Array,
): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/**
 * Renders every entry of a package as text so that plaintext assertions can be
 * made against its real contents.
 *
 * Decompression is mandatory. A package is deflate-compressed, so scanning the
 * raw zip bytes cannot find the plaintext even when it is present - such a
 * check passes unconditionally and proves nothing.
 *
 * Each entry is rendered twice, as UTF-8 and as latin1, so that ASCII markers
 * are still found inside entries that are not valid UTF-8 (image bytes).
 */
export function scanPackagePlaintext(bytes: Uint8Array): string {
  const entries = readPackageEntries(bytes);
  const parts: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (entry === undefined) {
      continue;
    }
    parts.push(name, strFromU8(entry), strFromU8(entry, true));
  }
  return parts.join("\n");
}
