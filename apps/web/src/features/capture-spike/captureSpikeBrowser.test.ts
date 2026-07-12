import { describe, expect, it, vi } from "vitest";

import { createBrowserCaptureSpikeReaderDependencies } from "./captureSpikeBrowser.js";

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

describe("createBrowserCaptureSpikeReaderDependencies", () => {
  it("reads bytes through File.arrayBuffer", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const file = new File([expected], "probe.bin");
    const arrayBuffer = vi.fn(async () => copyBuffer(expected));
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: arrayBuffer,
    });

    const dependencies = createBrowserCaptureSpikeReaderDependencies();
    const result = await dependencies.readArrayBuffer(file);

    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
  });

  it("returns the lowercase SHA-256 digest for the UTF-8 abc vector", async () => {
    const bytes = new TextEncoder().encode("abc");
    const dependencies = createBrowserCaptureSpikeReaderDependencies();

    await expect(
      dependencies.sha256(copyBuffer(bytes)),
    ).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses performance.now as its monotonic clock", () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(41.25)
      .mockReturnValueOnce(42.5);

    try {
      const dependencies = createBrowserCaptureSpikeReaderDependencies();
      expect([dependencies.now(), dependencies.now()]).toEqual([41.25, 42.5]);
      expect(now).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
