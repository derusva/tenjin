import { describe, expect, it } from "vitest";

import japaneseUnicodeText from "../../../../../fixtures/capture-spike/unicode/japanese-unicode.txt?raw";

import {
  readCaptureLogSpikeDirectory,
  snapshotSelectedFiles,
  type CaptureSpikeReaderDependencies,
  type SelectedSpikeFile,
  type SpikePackageResult,
} from "./captureSpikeReader.js";
import {
  createSelectedSpikeFile,
  createSelectedSpikeFiles,
  createSpikeFiles,
  encodeSpikeManifest,
  SPIKE_CAPTURE_ID,
} from "./test/createSpikeFiles.js";

const LOCAL_SHA256 = "c".repeat(64);

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

function bytesFromText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function joinBytes(
  ...parts: readonly (string | readonly number[])[]
): ArrayBuffer {
  const encoded = parts.map((part) =>
    typeof part === "string"
      ? new TextEncoder().encode(part)
      : Uint8Array.from(part),
  );
  const result = new Uint8Array(
    encoded.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of encoded) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result.buffer as ArrayBuffer;
}

interface PayloadFixture {
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly bytes: ArrayBuffer;
  readonly browserMediaType?: string;
}

function packageSelection(options: {
  readonly packagePath?: string;
  readonly manifestOverrides?: Readonly<Record<string, unknown>>;
  readonly payloads: readonly PayloadFixture[];
  readonly includeManifest?: boolean;
  readonly selectedPayloadIndexes?: readonly number[];
}): readonly SelectedSpikeFile[] {
  const base = createSpikeFiles().manifest;
  const manifest: Readonly<Record<string, unknown>> = {
    ...base,
    payloads: options.payloads.map((payload) => payload.descriptor),
    ...options.manifestOverrides,
  };
  const packagePath =
    options.packagePath ??
    `${String(manifest["shardMonth"])}/${String(manifest["captureId"])}`;
  const indexes =
    options.selectedPayloadIndexes ??
    options.payloads.map((_, index) => index);
  const selected: SelectedSpikeFile[] = [];

  if (options.includeManifest !== false) {
    selected.push(
      createSelectedSpikeFile(
        `${packagePath}/capture.json`,
        encodeSpikeManifest(manifest),
        "application/json",
      ),
    );
  }
  for (const index of indexes) {
    const payload = options.payloads[index];
    if (payload === undefined) {
      throw new Error(`Unknown test payload index: ${index}`);
    }
    selected.push(
      createSelectedSpikeFile(
        `${packagePath}/${String(payload.descriptor.path)}`,
        payload.bytes,
        payload.browserMediaType ?? "",
      ),
    );
  }
  return selected;
}

function oneTextPayload(
  bytes = bytesFromText("日本語をそのまま保存する。"),
  overrides: Readonly<Record<string, unknown>> = {},
): PayloadFixture {
  return {
    descriptor: {
      payloadId: "payload-text-1",
      inputIndex: 1,
      observedType: "Text",
      previewKind: "text",
      path: "payloads/01.txt",
      mediaType: "text/plain; charset=utf-8",
      sourceByteLength: bytes.byteLength,
      ...overrides,
    },
    bytes,
    browserMediaType: "text/plain",
  };
}

function packageFixture(index: number): ReturnType<typeof createSelectedSpikeFiles> {
  const captureId = `spike-20260712-1641${String(index).padStart(2, "0")}-000-${String(index).padStart(6, "0")}`;
  return createSelectedSpikeFiles({
    packagePath: `2026-07/${captureId}`,
    manifestOverrides: { captureId },
  });
}

describe("snapshotSelectedFiles", () => {
  it("copies File and webkitRelativePath immediately without falling back to name", () => {
    const withPath = createSelectedSpikeFile(
      "2026-07/package/capture.json",
      bytesFromText("{}"),
    ).file;
    const withoutPath = createSelectedSpikeFile("", bytesFromText("x")).file;
    let livePath = "2026-07/package/capture.json";
    Object.defineProperty(withPath, "webkitRelativePath", {
      configurable: true,
      get: () => livePath,
    });
    let current = [withPath, withoutPath];
    const files = {
      get length() {
        return current.length;
      },
      item(index: number) {
        return current[index] ?? null;
      },
    } as FileList;

    const snapshot = snapshotSelectedFiles(files);
    livePath = "changed-after-snapshot";
    current = [];

    expect(snapshot).toEqual([
      { file: withPath, relativePath: "2026-07/package/capture.json" },
      { file: withoutPath, relativePath: "" },
    ]);
  });
});

describe("createSelectedSpikeFiles", () => {
  it("rejects a payload manifest override that has no matching fixture bytes", () => {
    expect(() =>
      createSelectedSpikeFiles({
        manifestOverrides: { payloads: [] },
      }),
    ).toThrowError(
      new TypeError(
        "createSelectedSpikeFiles cannot override manifest payloads without matching fixture bytes",
      ),
    );
  });
});

describe("readCaptureLogSpikeDirectory package discovery", () => {
  it.each([1, 2, 3])(
    "reads %s complete packages selected through a month directory",
    async (packageCount) => {
      const fixtures = Array.from({ length: packageCount }, (_, index) =>
        packageFixture(index + 1),
      );
      const files = fixtures.flatMap((fixture) => fixture.selectedFiles).reverse();

      const result = await readCaptureLogSpikeDirectory(
        files,
        dependencies(),
      );

      expect(result.packages).toHaveLength(packageCount);
      expect(result.packages.every((pkg) => pkg.status === "ready")).toBe(true);
      expect(result.truncatedPackageCount).toBe(0);
      expect(result.selectionIssues).toEqual([]);
    },
  );

  it("sorts package paths and reports packages beyond the default limit", async () => {
    const fixtures = [4, 2, 1, 3].map(packageFixture);
    const files = fixtures.flatMap((fixture) => fixture.selectedFiles).reverse();

    const result = await readCaptureLogSpikeDirectory(files, dependencies());

    expect(result.packages.map((pkg) => pkg.packagePath)).toEqual([
      "2026-07/spike-20260712-164101-000-000001",
      "2026-07/spike-20260712-164102-000-000002",
      "2026-07/spike-20260712-164103-000-000003",
    ]);
    expect(result.truncatedPackageCount).toBe(1);
  });

  it("honors a smaller explicit package limit", async () => {
    const files = [1, 2, 3]
      .map(packageFixture)
      .flatMap((fixture) => fixture.selectedFiles);

    const result = await readCaptureLogSpikeDirectory(files, dependencies(), {
      maxPackages: 1,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.truncatedPackageCount).toBe(2);
  });

  it("counts invalid packages toward the package limit", async () => {
    const invalidPath =
      "2026-07/spike-20260712-164100-000-000000/capture.json";
    const files = [
      createSelectedSpikeFile(invalidPath, bytesFromText("not json")),
      ...[1, 2, 3]
        .map(packageFixture)
        .flatMap((fixture) => fixture.selectedFiles),
    ];

    const result = await readCaptureLogSpikeDirectory(files, dependencies(), {
      maxPackages: 1,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.status).toBe("invalid");
    expect(result.truncatedPackageCount).toBe(3);
  });

  it("ignores each unfinished package directory that has no manifest", async () => {
    const complete = packageFixture(1);
    const unfinished = [
      createSelectedSpikeFile(
        "2026-07/unfinished-b/payloads/02.txt",
        bytesFromText("b"),
      ),
      createSelectedSpikeFile(
        "2026-07/unfinished-a/payloads/01.txt",
        bytesFromText("a"),
      ),
    ];

    const result = await readCaptureLogSpikeDirectory(
      [...unfinished, ...complete.selectedFiles],
      dependencies(),
    );

    expect(result.packages).toHaveLength(1);
    expect(result.ignoredWithoutManifest).toEqual([
      "2026-07/unfinished-a",
      "2026-07/unfinished-b",
    ]);
  });

  it("uses manifest payload order instead of selected file order", async () => {
    const fixture = createSelectedSpikeFiles();
    const readOrder: string[] = [];

    const result = await readCaptureLogSpikeDirectory(
      [...fixture.selectedFiles].reverse(),
      dependencies({
        readArrayBuffer: async (file) => {
          readOrder.push(file.name);
          return file.arrayBuffer();
        },
      }),
    );

    const pkg = readyPackage(result.packages[0]!);
    expect(pkg.payloads.map((payload) => payload.payloadId)).toEqual([
      "payload-text-1",
      "payload-image-2",
    ]);
    expect(readOrder).toEqual(["capture.json", "01.txt", "02.png"]);
    expect(pkg.payloads[1]).toMatchObject({
      kind: "image",
      file: fixture.selectedFiles[2]!.file,
    });
  });

  it("uses exact package paths instead of prefix-matching another package", async () => {
    const fixture = createSelectedSpikeFiles({ selectedPayloadIndexes: [] });
    const collidingPayload = createSelectedSpikeFile(
      `2026-07/${SPIKE_CAPTURE_ID}-extra/payloads/01.txt`,
      bytesFromText("wrong package"),
      "text/plain",
    );

    const result = await readCaptureLogSpikeDirectory(
      [...fixture.selectedFiles, collidingPayload],
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [{ code: "payload-missing" }],
    });
    expect(result.ignoredWithoutManifest).toEqual([
      `2026-07/${SPIKE_CAPTURE_ID}-extra`,
    ]);
  });

  it("does not treat a nested YYYY-MM path inside a package as another package", async () => {
    const fixture = createSelectedSpikeFiles();
    const unreferenced = createSelectedSpikeFile(
      `2026-07/${SPIKE_CAPTURE_ID}/assets/2025-12/example/file.bin`,
      bytesFromText("unreferenced"),
    );

    const result = await readCaptureLogSpikeDirectory(
      [...fixture.selectedFiles, unreferenced],
      dependencies(),
    );

    expect(result.packages[0]?.status).toBe("ready");
    expect(result.ignoredWithoutManifest).toEqual([]);
  });

  it("accepts local July sharding when capturedAt is still in UTC June", async () => {
    const fixture = createSelectedSpikeFiles({
      packagePath: `2026-07/${SPIKE_CAPTURE_ID}`,
      manifestOverrides: { capturedAt: "2026-06-30T16:30:00.000Z" },
    });

    const result = await readCaptureLogSpikeDirectory(
      fixture.selectedFiles,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "ready",
      manifest: {
        capturedAt: "2026-06-30T16:30:00.000Z",
        shardMonth: "2026-07",
      },
    });
  });
});

describe("readCaptureLogSpikeDirectory byte preservation", () => {
  it("preserves Japanese, Unicode, whitespace, line endings, and URL bytes", async () => {
    const textBytes = joinBytes(
      "  漢字・ひらがな・カタカナ　全角空格",
      [13, 10],
      "𠮷 / ｶﾀｶﾅ / Ｔｅｎｊｉｎ / 👩‍💻",
      [10],
      "が / か\u3099",
      [13, 10, 13, 10],
      "多段落の終わり  ",
    );
    const urlBytes = bytesFromText(
      "https://example.com/日本語?q=%E5%AD%A6%E7%BF%92&x=100%25",
    );
    const payloads: readonly PayloadFixture[] = [
      {
        descriptor: {
          payloadId: "payload-url-2",
          inputIndex: 2,
          observedType: "URL",
          previewKind: "url",
          path: "payloads/02.url",
          mediaType: "text/uri-list; charset=utf-8",
          sourceByteLength: urlBytes.byteLength,
        },
        bytes: urlBytes,
        browserMediaType: "text/plain",
      },
      oneTextPayload(textBytes),
    ];
    const selected = [...packageSelection({ payloads })].reverse();

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    const pkg = readyPackage(result.packages[0]!);
    const url = pkg.payloads[0];
    const text = pkg.payloads[1];
    expect(url).toMatchObject({
      kind: "url",
      rawUrl: new TextDecoder().decode(urlBytes),
    });
    expect(text).toMatchObject({
      kind: "text",
      text: new TextDecoder().decode(textBytes),
    });
    if (url?.kind !== "url" || text?.kind !== "text") {
      throw new Error("Expected URL and text previews");
    }
    expect(Array.from(new TextEncoder().encode(url.rawUrl))).toEqual(
      Array.from(new Uint8Array(urlBytes)),
    );
    expect(Array.from(new TextEncoder().encode(text.text))).toEqual(
      Array.from(new Uint8Array(textBytes)),
    );
  });

  it("rejects a UTF-8 BOM in a text payload explicitly", async () => {
    const payloadBytes = joinBytes([0xef, 0xbb, 0xbf], "日本語");
    const selected = packageSelection({
      payloads: [oneTextPayload(payloadBytes)],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "unexpected-utf8-bom",
          retryable: false,
        },
      ],
    });
  });

  it("rejects fatal malformed UTF-8 in a URL payload", async () => {
    const payloadBytes = Uint8Array.from([0xc3, 0x28]).buffer as ArrayBuffer;
    const selected = packageSelection({
      payloads: [
        {
          ...oneTextPayload(payloadBytes, {
            payloadId: "payload-url-1",
            observedType: "URL",
            previewKind: "url",
            path: "payloads/01.url",
            mediaType: "text/uri-list",
          }),
        },
      ],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [{ code: "payload-invalid-utf8", retryable: false }],
    });
  });

  it("preserves an internal U+FEFF that is not a leading BOM", async () => {
    const payloadBytes = bytesFromText("前\uFEFF後");
    const selected = packageSelection({
      payloads: [oneTextPayload(payloadBytes)],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    const pkg = readyPackage(result.packages[0]!);
    expect(pkg.payloads[0]).toMatchObject({ kind: "text", text: "前\uFEFF後" });
  });
});

describe("readCaptureLogSpikeDirectory issue classification", () => {
  it("reports an empty relative path as an invalid selection", async () => {
    const selected = createSelectedSpikeFile("", bytesFromText("x"));

    const result = await readCaptureLogSpikeDirectory(
      [selected],
      dependencies(),
    );

    expect(result.selectionIssues).toEqual([
      {
        disposition: "invalid-selection",
        code: "relative-path-unavailable",
        retryable: false,
      },
    ]);
    expect(result.packages).toEqual([]);
  });

  it("reports and excludes duplicate selected relative paths", async () => {
    const path = `2026-07/${SPIKE_CAPTURE_ID}/capture.json`;
    const first = createSelectedSpikeFile(path, bytesFromText("{}"));
    const second = createSelectedSpikeFile(path, bytesFromText("{}"));

    const result = await readCaptureLogSpikeDirectory(
      [first, second],
      dependencies(),
    );

    expect(result.selectionIssues).toEqual([
      {
        disposition: "invalid-selection",
        code: "duplicate-selected-relative-path",
        relativePath: path,
        retryable: false,
      },
    ]);
    expect(result.packages).toEqual([]);
  });

  it("omits a package with a duplicate payload path without synthesizing payload-missing", async () => {
    const ambiguous = packageFixture(1);
    const unrelated = packageFixture(2);
    const originalPayload = ambiguous.selectedFiles.find((selected) =>
      selected.relativePath.endsWith("/payloads/01.txt"),
    );
    if (originalPayload === undefined) {
      throw new Error("Expected the text payload fixture");
    }
    const duplicatePayload = createSelectedSpikeFile(
      originalPayload.relativePath,
      ambiguous.payloads[0]!.bytes,
      "text/plain",
    );

    const result = await readCaptureLogSpikeDirectory(
      [
        ...ambiguous.selectedFiles,
        duplicatePayload,
        ...unrelated.selectedFiles,
      ],
      dependencies(),
    );

    expect(result.selectionIssues).toContainEqual({
      disposition: "invalid-selection",
      code: "duplicate-selected-relative-path",
      relativePath: originalPayload.relativePath,
      retryable: false,
    });
    expect(result.packages.map((pkg) => pkg.packagePath)).toEqual([
      "2026-07/spike-20260712-164102-000-000002",
    ]);
    expect(result.packages[0]?.status).toBe("ready");
    expect(result.packages).not.toContainEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "payload-missing" }),
        ]),
      }),
    );
    expect(result.ignoredWithoutManifest).toEqual([]);
  });

  it("uses duplicate manifest presence to suppress a false unfinished package", async () => {
    const fixture = packageFixture(1);
    const manifest = fixture.selectedFiles.find((selected) =>
      selected.relativePath.endsWith("/capture.json"),
    );
    if (manifest === undefined) {
      throw new Error("Expected the manifest fixture");
    }
    const duplicateManifest = createSelectedSpikeFile(
      manifest.relativePath,
      fixture.captureJson,
      "application/json",
    );

    const result = await readCaptureLogSpikeDirectory(
      [...fixture.selectedFiles, duplicateManifest],
      dependencies(),
    );

    expect(result.selectionIssues).toContainEqual({
      disposition: "invalid-selection",
      code: "duplicate-selected-relative-path",
      relativePath: manifest.relativePath,
      retryable: false,
    });
    expect(result.packages).toEqual([]);
    expect(result.ignoredWithoutManifest).toEqual([]);
  });

  it("keeps a manifest provider failure retryable and distinct from invalid JSON", async () => {
    const fixture = createSelectedSpikeFiles();

    const result = await readCaptureLogSpikeDirectory(
      fixture.selectedFiles,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "capture.json") {
            throw new DOMException("offline", "NotReadableError");
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toEqual({
      status: "temporarily-unavailable",
      packagePath: `2026-07/${SPIKE_CAPTURE_ID}`,
      issues: [
        {
          disposition: "temporarily-unavailable",
          code: "manifest-read-unavailable",
          relativePath: `2026-07/${SPIKE_CAPTURE_ID}/capture.json`,
          errorName: "NotReadableError",
          retryable: true,
        },
      ],
    });
  });

  it("treats a manifest-referenced file missing from selection as retryable", async () => {
    const fixture = createSelectedSpikeFiles({ selectedPayloadIndexes: [0] });

    const result = await readCaptureLogSpikeDirectory(
      fixture.selectedFiles,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      manifest: { captureId: SPIKE_CAPTURE_ID },
      issues: [
        {
          disposition: "temporarily-unavailable",
          code: "payload-missing",
          relativePath: `2026-07/${SPIKE_CAPTURE_ID}/payloads/02.png`,
          retryable: true,
        },
      ],
    });
    expect(result.packages[0]).not.toHaveProperty("payloads");
  });

  it.each([
    "NotReadableError",
    "NotFoundError",
    "AbortError",
    "SecurityError",
    "NotAllowedError",
  ])("keeps %s payload read failures retryable", async (errorName) => {
    const selected = packageSelection({ payloads: [oneTextPayload()] });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "01.txt") {
            throw new DOMException("provider unavailable", errorName);
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [
        {
          disposition: "temporarily-unavailable",
          code: "payload-read-unavailable",
          errorName,
          retryable: true,
        },
      ],
    });
    expect(result.packages[0]).not.toHaveProperty("payloads");
  });

  it("keeps an unknown payload read failure retryable", async () => {
    const selected = packageSelection({ payloads: [oneTextPayload()] });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "01.txt") {
            throw new Error("unknown provider failure");
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [
        {
          code: "payload-read-unavailable",
          errorName: "Error",
          retryable: true,
        },
      ],
    });
  });

  it("keeps a primitive payload read failure retryable without inventing a name", async () => {
    const selected = packageSelection({ payloads: [oneTextPayload()] });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "01.txt") {
            throw "provider offline";
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [
        {
          code: "payload-read-unavailable",
          retryable: true,
        },
      ],
    });
    expect(result.packages[0]).not.toHaveProperty("issues.0.errorName");
  });

  it("keeps classification retryable when an error name getter itself throws", async () => {
    const selected = packageSelection({ payloads: [oneTextPayload()] });
    const hostileError = Object.defineProperty({}, "name", {
      get: () => {
        throw new Error("hostile getter");
      },
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({
        readArrayBuffer: async (file) => {
          if (file.name === "01.txt") {
            throw hostileError;
          }
          return file.arrayBuffer();
        },
      }),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [{ code: "payload-read-unavailable", retryable: true }],
    });
    expect(result.packages[0]).not.toHaveProperty("issues.0.errorName");
  });

  it("classifies malformed manifest JSON as an invalid package", async () => {
    const path = `2026-07/${SPIKE_CAPTURE_ID}/capture.json`;

    const result = await readCaptureLogSpikeDirectory(
      [createSelectedSpikeFile(path, bytesFromText("not json"))],
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "manifest-invalid-json",
          relativePath: path,
          retryable: false,
        },
      ],
    });
  });

  it("preserves every parser issue on an invalid manifest", async () => {
    const fixture = createSpikeFiles();
    const path = `2026-07/${SPIKE_CAPTURE_ID}/capture.json`;
    const bytes = encodeSpikeManifest({
      ...fixture.manifest,
      transport: "future-transport",
      futureField: true,
    });

    const result = await readCaptureLogSpikeDirectory(
      [createSelectedSpikeFile(path, bytes)],
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        { code: "manifest-unknown-field" },
        { code: "invalid-payload" },
      ],
    });
  });

  it("classifies a manifest payload path traversal as invalid", async () => {
    const selected = packageSelection({
      payloads: [oneTextPayload(bytesFromText("x"), { path: "../escape.txt" })],
      selectedPayloadIndexes: [],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "unsafe-payload-path",
          retryable: false,
        },
      ],
    });
  });

  it("rejects a shard month that disagrees with the package parent path", async () => {
    const fixture = createSelectedSpikeFiles({
      packagePath: `2026-06/${SPIKE_CAPTURE_ID}`,
    });

    const result = await readCaptureLogSpikeDirectory(
      fixture.selectedFiles,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "shard-month-path-mismatch",
          retryable: false,
        },
      ],
    });
  });

  it("rejects a source byte length mismatch", async () => {
    const selected = packageSelection({
      payloads: [oneTextPayload(bytesFromText("abc"), { sourceByteLength: 4 })],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "source-byte-length-mismatch",
          retryable: false,
        },
      ],
    });
  });

  it("rejects a source SHA-256 mismatch instead of returning a warning preview", async () => {
    const payload = oneTextPayload(bytesFromText("abc"), {
      sourceSha256: "a".repeat(64),
      sourceHashDurationMs: 1,
    });
    const selected = packageSelection({
      manifestOverrides: { hashMode: "sha256" },
      payloads: [payload],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    expect(result.packages[0]).toMatchObject({
      status: "invalid",
      issues: [
        {
          disposition: "invalid-package",
          code: "source-digest-mismatch",
          retryable: false,
        },
      ],
    });
    expect(result.packages[0]).not.toHaveProperty("payloads");
  });

  it("keeps a local SHA-256 capability failure retryable", async () => {
    const selected = packageSelection({ payloads: [oneTextPayload()] });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({
        sha256: async () => {
          throw new DOMException("crypto unavailable", "NotSupportedError");
        },
      }),
    );

    expect(result.packages[0]).toMatchObject({
      status: "temporarily-unavailable",
      issues: [
        {
          disposition: "temporarily-unavailable",
          code: "local-digest-unavailable",
          errorName: "NotSupportedError",
          retryable: true,
        },
      ],
    });
    expect(result.packages[0]).not.toHaveProperty("payloads");
  });
});

describe("readCaptureLogSpikeDirectory local diagnostics", () => {
  it("round-trips the LF-only Unicode fixture without trimming or normalization", async () => {
    expect(japaneseUnicodeText.startsWith("  Tenjin Unicode fixture\n")).toBe(
      true,
    );
    expect(japaneseUnicodeText).toContain("\n\n");
    expect(japaneseUnicodeText).not.toContain("\r");
    expect(japaneseUnicodeText.endsWith("末尾空白: preserved　　\n")).toBe(
      true,
    );

    const payloadBytes = bytesFromText(japaneseUnicodeText);
    const selected = packageSelection({
      payloads: [oneTextPayload(payloadBytes)],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    const pkg = readyPackage(result.packages[0]!);
    expect(pkg.payloads[0]).toMatchObject({
      kind: "text",
      text: japaneseUnicodeText,
      actualByteLength: payloadBytes.byteLength,
    });
  });

  it("reports deterministic byte length, digest, duration, and source match", async () => {
    const payloadBytes = bytesFromText("計測対象");
    const payload = oneTextPayload(payloadBytes, {
      sourceSha256: LOCAL_SHA256,
      sourceHashDurationMs: 4,
    });
    const selected = packageSelection({
      manifestOverrides: { hashMode: "sha256" },
      payloads: [payload],
    });
    const times = [10, 17.5];

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies({ now: () => times.shift() ?? 999 }),
    );

    const pkg = readyPackage(result.packages[0]!);
    expect(pkg.payloads[0]).toMatchObject({
      kind: "text",
      sourceMediaType: "text/plain; charset=utf-8",
      browserMediaType: "text/plain",
      actualByteLength: payloadBytes.byteLength,
      localSha256: LOCAL_SHA256,
      localHashDurationMs: 7.5,
      sourceDigestMatches: true,
    });
  });

  it("uses the read buffer length even when sourceByteLength is zero", async () => {
    const emptyBytes = new ArrayBuffer(0);
    const selected = packageSelection({
      payloads: [oneTextPayload(emptyBytes, { sourceByteLength: 0 })],
    });

    const result = await readCaptureLogSpikeDirectory(
      selected,
      dependencies(),
    );

    const pkg = readyPackage(result.packages[0]!);
    expect(pkg.payloads[0]).toMatchObject({
      kind: "text",
      text: "",
      actualByteLength: 0,
    });
  });

  it("reads and hashes payloads sequentially", async () => {
    const fixture = createSelectedSpikeFiles();
    const events: string[] = [];
    let activeHashes = 0;
    let maximumActiveHashes = 0;

    const result = await readCaptureLogSpikeDirectory(
      fixture.selectedFiles,
      dependencies({
        readArrayBuffer: async (file) => {
          events.push(`read:${file.name}`);
          return file.arrayBuffer();
        },
        sha256: async (bytes) => {
          activeHashes += 1;
          maximumActiveHashes = Math.max(maximumActiveHashes, activeHashes);
          events.push(`hash:${bytes.byteLength}`);
          await Promise.resolve();
          activeHashes -= 1;
          return LOCAL_SHA256;
        },
      }),
    );

    expect(result.packages[0]?.status).toBe("ready");
    expect(maximumActiveHashes).toBe(1);
    expect(events).toEqual([
      "read:capture.json",
      `read:01.txt`,
      `hash:${fixture.payloads[0]!.bytes.byteLength}`,
      `read:02.png`,
      `hash:${fixture.payloads[1]!.bytes.byteLength}`,
    ]);
  });
});
