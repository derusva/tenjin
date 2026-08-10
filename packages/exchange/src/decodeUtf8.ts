/**
 * TextDecoder is a runtime global in both browsers and Node, but its type comes
 * from DOM or @types/node. This package ships with neither - pulling in either
 * would weaken the boundary that keeps it usable from both sides - so the one
 * global we need is declared as narrowly as it can be, right where it is used.
 */
declare const TextDecoder: {
  new (
    label: "utf-8",
    options: { readonly fatal: true },
  ): { decode(input: Uint8Array): string };
};

export function decodeUtf8Strict(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${what} is not valid UTF-8`);
  }
}
