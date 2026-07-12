import type { CaptureSpikeReaderDependencies } from "./captureSpikeReader.js";

function toLowercaseHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createBrowserCaptureSpikeReaderDependencies(): CaptureSpikeReaderDependencies {
  return {
    readArrayBuffer: (file) => file.arrayBuffer(),
    async sha256(bytes) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return toLowercaseHex(digest);
    },
    now: () => performance.now(),
  };
}
