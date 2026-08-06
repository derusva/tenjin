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
 * Each entry is rendered twice, as UTF-8 and as latin1. The latin1 pass is not
 * about ASCII: TextDecoder resynchronises after invalid bytes, and ASCII bytes
 * (0x00-0x7f) can never be consumed as UTF-8 continuation bytes (0x80-0xbf), so
 * an ASCII marker always survives the UTF-8 pass. What latin1 adds is
 * NON-ASCII needles inside entries that are not UTF-8 at all - in image bytes,
 * 0xe9 spells U+00E9 in latin1 but decodes to a replacement character as UTF-8,
 * so without this pass such a byte would be invisible to the scanner.
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
