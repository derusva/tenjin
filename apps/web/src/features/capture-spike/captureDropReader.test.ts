import { describe, expect, it } from "vitest";

import {
  readCaptureDropDirectory,
  type CaptureSpikeReaderDependencies,
  type SpikePackageResult,
} from "./captureSpikeReader.js";
import { createSelectedSpikeFile } from "./test/createSpikeFiles.js";

const LOCAL_SHA256 = "d".repeat(64);

function bytesFromText(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function dependencies(
  overrides: Partial<CaptureSpikeReaderDependencies> = {},
): CaptureSpikeReaderDependencies {
  return {
    readArrayBuffer: async (file) => file.arrayBuffer(),
    sha256: async () => LOCAL_SHA256,
    now: () => 0,
    ...overrides,
  };
}

function readyPackage(result: SpikePackageResult): Extract<
  SpikePackageResult,
  { readonly status: "ready" }
> {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error(`Expected ready package, got ${result.status}`);
  }
  return result;
}

describe("readCaptureDropDirectory", () => {
  it("shows the three newest raw captures first", async () => {
    const files = [1, 4, 2, 3].map((second) =>
      createSelectedSpikeFile(
        `2026-07/20260714-00180${second}-000/probe`,
        bytesFromText(`capture ${second}`),
      ),
    );

    const result = await readCaptureDropDirectory(files, dependencies());

    expect(result.packages.map((capture) => capture.packagePath)).toEqual([
      "2026-07/20260714-001804-000",
      "2026-07/20260714-001803-000",
      "2026-07/20260714-001802-000",
    ]);
    expect(result.truncatedPackageCount).toBe(1);
  });

  it("turns the target-iPhone timestamp probe into a generated text package", async () => {
    const text = "基本的には彼女の成長や心境の変化を中心に描かれている。";
    const selected = createSelectedSpikeFile(
      "2026-07/20260714-001800-000/probe",
      bytesFromText(text),
    );

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies(),
    );

    expect(result.ignoredWithoutManifest).toEqual([]);
    const capture = readyPackage(result.packages[0]!);
    expect(capture).toMatchObject({
      packageSource: "raw",
      packagePath: "2026-07/20260714-001800-000",
      manifest: {
        captureId: expect.stringMatching(
          /^spike-20260714-001800-000-\d{6}$/,
        ),
        capturedAt: new Date(2026, 6, 14, 0, 18, 0, 0).toISOString(),
        shardMonth: "2026-07",
        hashMode: "none",
      },
      payloads: [
        {
          kind: "text",
          inputIndex: 1,
          observedType: "Raw Text",
          text,
          localSha256: LOCAL_SHA256,
        },
      ],
    });
  });

  it("recognises ordinary HTTP URLs without requiring their serialised trailing slash", async () => {
    const selected = createSelectedSpikeFile(
      "2026-07/20260714-001801-000/link.txt",
      bytesFromText("https://example.com"),
      "text/plain",
    );

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies(),
    );

    expect(readyPackage(result.packages[0]!).payloads[0]).toMatchObject({
      kind: "url",
      observedType: "Raw URL",
      rawUrl: "https://example.com",
    });
  });

  it("keeps text containing a URL plus whitespace as text", async () => {
    const value = "https://example.com\n为什么保存它";
    const selected = createSelectedSpikeFile(
      "2026-07/20260714-001801-001/note.txt",
      bytesFromText(value),
    );

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies(),
    );

    expect(readyPackage(result.packages[0]!).payloads[0]).toMatchObject({
      kind: "text",
      text: value,
    });
  });

  it("recognises image bytes and preserves deterministic file order", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]).buffer as ArrayBuffer;
    const files = [
      createSelectedSpikeFile(
        "2026-07/20260714-001802-000/02.bin",
        png,
      ),
      createSelectedSpikeFile(
        "2026-07/20260714-001802-000/01.txt",
        bytesFromText("先读这一项"),
      ),
    ];

    const result = await readCaptureDropDirectory(files, dependencies());
    const capture = readyPackage(result.packages[0]!);

    expect(capture.payloads.map((payload) => payload.kind)).toEqual([
      "text",
      "image",
    ]);
    expect(capture.payloads[1]).toMatchObject({
      inputIndex: 2,
      observedType: "Raw Image",
      sourceMediaType: "image/png",
      file: files[0]!.file,
    });
  });

  it("keeps an interrupted manifest package ignored instead of treating it as raw", async () => {
    const packagePath = "2026-07/spike-20260714-001803-000-123456";
    const selected = createSelectedSpikeFile(
      `${packagePath}/payload-001.txt`,
      bytesFromText("unfinished"),
    );

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies(),
    );

    expect(result.packages).toEqual([]);
    expect(result.ignoredWithoutManifest).toEqual([packagePath]);
  });

  it("ignores malformed or month-mismatched raw timestamps", async () => {
    const malformedPath = "2026-07/20261340-256199-000";
    const mismatchedPath = "2026-06/20260714-001800-000";
    const files = [malformedPath, mismatchedPath].map((packagePath) =>
      createSelectedSpikeFile(
        `${packagePath}/probe`,
        bytesFromText("must not be admitted"),
      ),
    );

    const result = await readCaptureDropDirectory(files, dependencies());

    expect(result.packages).toEqual([]);
    expect(result.ignoredWithoutManifest).toEqual([
      mismatchedPath,
      malformedPath,
    ]);
  });

  it("rejects oversized raw files before reading them into memory", async () => {
    const selected = createSelectedSpikeFile(
      "2026-07/20260714-001802-001/huge.heic",
      new ArrayBuffer(0),
      "image/heic",
    );
    Object.defineProperty(selected.file, "size", {
      configurable: true,
      value: 20 * 1024 * 1024 + 1,
    });
    let didRead = false;

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies({
        readArrayBuffer: async () => {
          didRead = true;
          return new ArrayBuffer(0);
        },
      }),
    );

    expect(didRead).toBe(false);
    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [{ code: "raw-file-too-large", retryable: false }],
    });
  });

  it("rejects unsafe paths inside a raw capture", async () => {
    const packagePath = "2026-07/20260714-001803-001";
    const selected = createSelectedSpikeFile(
      `${packagePath}/../escape.txt`,
      bytesFromText("unsafe"),
    );

    const result = await readCaptureDropDirectory(
      [selected],
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      packagePath,
      issues: [{ code: "unsafe-payload-path", retryable: false }],
    });
  });

  it("keeps raw iCloud read failures retryable and does not expose partial payloads", async () => {
    const files = [
      createSelectedSpikeFile(
        "2026-07/20260714-001804-000/01.txt",
        bytesFromText("first"),
      ),
      createSelectedSpikeFile(
        "2026-07/20260714-001804-000/02.txt",
        bytesFromText("second"),
      ),
    ];

    const result = await readCaptureDropDirectory(
      files,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "02.txt") {
            throw new DOMException("not downloaded", "NotReadableError");
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toEqual({
      status: "temporarily-unavailable",
      packagePath: "2026-07/20260714-001804-000",
      issues: [
        {
          disposition: "temporarily-unavailable",
          code: "payload-read-unavailable",
          relativePath: "2026-07/20260714-001804-000/02.txt",
          errorName: "NotReadableError",
          retryable: true,
        },
      ],
    });
  });
});
