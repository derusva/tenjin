import { describe, expect, it } from "vitest";

import {
  parseCaptureSpikeManifestV0,
  type ParseCaptureSpikeManifestResult,
  type SpikeManifestIssueCode,
} from "./captureSpikeV0.js";
import {
  createSpikeFiles,
  encodeSpikeManifest,
  SPIKE_CAPTURE_ID,
  SPIKE_SHA256,
} from "./test/createSpikeFiles.js";

function parseJson(value: unknown): ParseCaptureSpikeManifestResult {
  return parseCaptureSpikeManifestV0(encodeSpikeManifest(value));
}

function withManifest(
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...createSpikeFiles().manifest,
    ...overrides,
  };
}

function expectIssue(
  result: ParseCaptureSpikeManifestResult,
  code: SpikeManifestIssueCode,
  fieldPath?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected ${code}`);
  }

  expect(result.issues).toContainEqual(
    fieldPath === undefined ? { code } : { code, fieldPath },
  );
}

describe("parseCaptureSpikeManifestV0", () => {
  it("parses the disposable v0 manifest and preserves payload order", () => {
    const fixture = createSpikeFiles();

    const result = parseCaptureSpikeManifestV0(fixture.captureJson);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected a valid spike manifest");
    }
    expect(result.value.payloads.map((payload) => payload.payloadId)).toEqual([
      "payload-text-1",
      "payload-image-2",
    ]);
    expect(result.value.payloads.map((payload) => payload.originalName)).toEqual([
      "学習メモ.txt",
      "問題.png",
    ]);
  });

  it("accepts manifests without optional media observations", () => {
    const payload = {
      payloadId: "payload-url-1",
      inputIndex: 1,
      observedType: "URL",
      previewKind: "url",
      path: "payloads/01.url",
    };

    const result = parseJson(withManifest({ payloads: [payload] }));

    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ["text/plain", "url"],
    ["text/plain; charset=utf-8", "url"],
    ["text/uri-list", "url"],
    ["text/uri-list; charset=UTF-8", "url"],
    ["image/png", "image"],
  ])("accepts %s for a %s preview", (mediaType, previewKind) => {
    const payload = {
      payloadId: "payload-1",
      inputIndex: 1,
      observedType: "Observed",
      previewKind,
      path: "payloads/01.bin",
      mediaType,
    };

    expect(parseJson(withManifest({ payloads: [payload] }))).toMatchObject({
      ok: true,
    });
  });

  it("accepts a complete sha256 diagnostic manifest", () => {
    const payloads = createSpikeFiles().manifest.payloads as readonly Record<
      string,
      unknown
    >[];
    const hashedPayloads = payloads.map((payload, index) => ({
      ...payload,
      sourceSha256: index === 0 ? SPIKE_SHA256 : "b".repeat(64),
      sourceHashDurationMs: index + 0.25,
    }));

    expect(
      parseJson(
        withManifest({ hashMode: "sha256", payloads: hashedPayloads }),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([0, 0.25])(
    "accepts a finite non-negative source hash duration: %s",
    (sourceHashDurationMs) => {
      const payloads = createSpikeFiles().manifest.payloads as readonly Record<
        string,
        unknown
      >[];
      const hashedPayloads = payloads.map((payload, index) => ({
        ...payload,
        sourceSha256: index === 0 ? SPIKE_SHA256 : "b".repeat(64),
        sourceHashDurationMs,
      }));

      expect(
        parseJson(
          withManifest({ hashMode: "sha256", payloads: hashedPayloads }),
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it("rejects unknown top-level fields", () => {
    expectIssue(
      parseJson(withManifest({ futureField: true })),
      "manifest-unknown-field",
      "futureField",
    );
  });

  it("rejects unknown payload fields", () => {
    const payloads = createSpikeFiles().manifest.payloads as readonly Record<
      string,
      unknown
    >[];
    const payload = { ...payloads[0], futureField: true };

    expectIssue(
      parseJson(withManifest({ payloads: [payload] })),
      "payload-unknown-field",
      "payloads[0].futureField",
    );
  });

  it.each([
    ["schemaVersion", 1, "unsupported-schema-version"],
    ["spikeBuild", 2, "unsupported-spike-build"],
    ["transport", "future-transport", "invalid-payload"],
  ] as const)("rejects an unsupported %s", (field, value, code) => {
    expectIssue(parseJson(withManifest({ [field]: value })), code, field);
  });

  it.each([[], new Array(21).fill(null)])(
    "rejects a payload list outside the 1-20 boundary",
    (payloads) => {
      expectIssue(
        parseJson(withManifest({ payloads })),
        "invalid-payload",
        "payloads",
      );
    },
  );

  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "spike-20260712-164100-000-48273",
    "spike-20260712-164100-00-482731",
    "spike-20260712T164100-000-482731",
    "spike-２０２６０７１２-１６４１００-０００-４８２７３１",
  ])("rejects a non-v0 captureId: %s", (captureId) => {
    expectIssue(
      parseJson(withManifest({ captureId })),
      "invalid-capture-id",
      "captureId",
    );
  });

  it("accepts the disposable timestamp-and-random captureId", () => {
    expect(parseJson(withManifest({ captureId: SPIKE_CAPTURE_ID }))).toMatchObject(
      { ok: true },
    );
  });

  it.each([
    "2026-07-12T08:41:00.000+00:00",
    "2026-07-12T08:41:00.000",
    "2026-02-30T08:41:00.000Z",
    "2025-02-29T08:41:00.000Z",
    "2026-07-12T24:00:00.000Z",
  ])("rejects a non-real RFC 3339 UTC capturedAt: %s", (capturedAt) => {
    expectIssue(
      parseJson(withManifest({ capturedAt })),
      "invalid-captured-at",
      "capturedAt",
    );
  });

  it.each(["2026-00", "2026-13", "26-07", "2026-7"])(
    "rejects an invalid shardMonth: %s",
    (shardMonth) => {
      expectIssue(
        parseJson(withManifest({ shardMonth })),
        "invalid-shard-month",
        "shardMonth",
      );
    },
  );

  it.each([
    "",
    "/payloads/01.txt",
    "C:/payloads/01.txt",
    "payloads\\01.txt",
    "payloads//01.txt",
    "payloads/",
    "payloads/./01.txt",
    "payloads/../01.txt",
    "../01.txt",
    "payloads/\u000001.txt",
  ])("rejects an unsafe package-relative payload path: %s", (path) => {
    const payload = {
      payloadId: "payload-1",
      inputIndex: 1,
      observedType: "Text",
      previewKind: "text",
      path,
    };

    expectIssue(
      parseJson(withManifest({ payloads: [payload] })),
      "unsafe-payload-path",
      "payloads[0].path",
    );
  });

  it.each([
    ["payloadId", "duplicate-payload-id"],
    ["path", "duplicate-payload-path"],
    ["inputIndex", "duplicate-input-index"],
  ] as const)("rejects duplicate %s values", (field, code) => {
    const payloads = createSpikeFiles().manifest.payloads as readonly Record<
      string,
      unknown
    >[];
    const duplicate = { ...payloads[1], [field]: payloads[0]![field] };

    expectIssue(
      parseJson(withManifest({ payloads: [payloads[0], duplicate] })),
      code,
      "payloads[1]." + field,
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid one-based inputIndex: %s",
    (inputIndex) => {
      const payload = {
        payloadId: "payload-1",
        inputIndex,
        observedType: "Text",
        previewKind: "text",
        path: "payloads/01.txt",
      };

      expectIssue(
        parseJson(withManifest({ payloads: [payload] })),
        "invalid-payload",
        "payloads[0].inputIndex",
      );
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid sourceByteLength: %s",
    (sourceByteLength) => {
      const payload = {
        payloadId: "payload-1",
        inputIndex: 1,
        observedType: "Text",
        previewKind: "text",
        path: "payloads/01.txt",
        sourceByteLength,
      };

      expectIssue(
        parseJson(withManifest({ payloads: [payload] })),
        "invalid-source-length",
        "payloads[0].sourceByteLength",
      );
    },
  );

  it("rejects source digest fields when hashMode is none", () => {
    const payloads = createSpikeFiles().manifest.payloads as readonly Record<
      string,
      unknown
    >[];
    const payload = {
      ...payloads[0],
      sourceSha256: SPIKE_SHA256,
      sourceHashDurationMs: 1,
    };

    expectIssue(
      parseJson(withManifest({ payloads: [payload] })),
      "invalid-source-digest",
      "payloads[0].sourceSha256",
    );
  });

  it.each([
    [{ sourceHashDurationMs: 1 }, "sourceSha256"],
    [{ sourceSha256: SPIKE_SHA256 }, "sourceHashDurationMs"],
    [{ sourceSha256: "A".repeat(64), sourceHashDurationMs: 1 }, "sourceSha256"],
    [{ sourceSha256: "a".repeat(63), sourceHashDurationMs: 1 }, "sourceSha256"],
    [{ sourceSha256: SPIKE_SHA256, sourceHashDurationMs: -1 }, "sourceHashDurationMs"],
  ] as const)(
    "rejects incomplete or malformed sha256 fields",
    (digestFields, invalidField) => {
      const payloads = createSpikeFiles().manifest.payloads as readonly Record<
        string,
        unknown
      >[];
      const first = { ...payloads[0], ...digestFields };
      const second = {
        ...payloads[1],
        sourceSha256: "b".repeat(64),
        sourceHashDurationMs: 2,
      };

      expectIssue(
        parseJson(
          withManifest({
            hashMode: "sha256",
            payloads: [first, second],
          }),
        ),
        "invalid-source-digest",
        `payloads[0].${invalidField}`,
      );
    },
  );

  it("rejects a media type incompatible with its preview kind", () => {
    const payload = {
      payloadId: "payload-image-1",
      inputIndex: 1,
      observedType: "Photo Media",
      previewKind: "image",
      path: "payloads/01.png",
      mediaType: "text/plain",
    };

    expectIssue(
      parseJson(withManifest({ payloads: [payload] })),
      "invalid-payload",
      "payloads[0].mediaType",
    );
  });

  it.each([
    ["image/*", "image"],
    ["image/", "image"],
    ["imageish/png", "image"],
    ["text/plainish", "text"],
    ["text/plain; charset", "text"],
    ["text/plain; boundary=utf-8", "text"],
    ["text/plain; charset=utf-8; charset=shift_jis", "text"],
  ])("rejects malformed or misleading mediaType %s", (mediaType, previewKind) => {
    const payload = {
      payloadId: "payload-1",
      inputIndex: 1,
      observedType: "Observed",
      previewKind,
      path: "payloads/01.bin",
      mediaType,
    };

    expectIssue(
      parseJson(withManifest({ payloads: [payload] })),
      "invalid-payload",
      "payloads[0].mediaType",
    );
  });

  it("accepts a quoted legal charset parameter", () => {
    const payload = {
      payloadId: "payload-text-1",
      inputIndex: 1,
      observedType: "Text",
      previewKind: "text",
      path: "payloads/01.txt",
      mediaType: 'text/plain; charset="utf-8"',
    };

    expect(parseJson(withManifest({ payloads: [payload] }))).toMatchObject({
      ok: true,
    });
  });

  it.each(["mediaType", "originalName", "sourceByteLength"])(
    "rejects optional payload field %s when explicitly null",
    (field) => {
      const payloads = createSpikeFiles().manifest.payloads as readonly Record<
        string,
        unknown
      >[];
      const payload = { ...payloads[0], [field]: null };

      expect(parseJson(withManifest({ payloads: [payload] }))).toMatchObject({
        ok: false,
      });
    },
  );

  it("rejects sourceApp when explicitly null", () => {
    expect(parseJson(withManifest({ sourceApp: null }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects UTF-8 BOM before parsing JSON", () => {
    const json = new Uint8Array(encodeSpikeManifest(createSpikeFiles().manifest));
    const bytes = new Uint8Array(json.byteLength + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(json, 3);

    expectIssue(
      parseCaptureSpikeManifestV0(bytes.buffer),
      "unexpected-utf8-bom",
    );
  });

  it("rejects malformed UTF-8", () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28]);

    expectIssue(
      parseCaptureSpikeManifestV0(bytes.buffer),
      "manifest-invalid-utf8",
    );
  });

  it.each(["not json", "[]", "null", "{}{}"])(
    "rejects content that is not a single JSON object: %s",
    (content) => {
      const bytes = new TextEncoder().encode(content);

      expectIssue(
        parseCaptureSpikeManifestV0(bytes.buffer),
        "manifest-invalid-json",
      );
    },
  );

  it("rejects capture.json larger than 256 KB", () => {
    const bytes = new Uint8Array(256 * 1024 + 1);

    expectIssue(
      parseCaptureSpikeManifestV0(bytes.buffer),
      "manifest-too-large",
    );
  });

  it("accepts capture.json at exactly 256 KB", () => {
    const emptySourceApp = encodeSpikeManifest(withManifest({ sourceApp: "" }));
    const sourceApp = "a".repeat(256 * 1024 - emptySourceApp.byteLength);
    const bytes = encodeSpikeManifest(withManifest({ sourceApp }));

    expect(bytes.byteLength).toBe(256 * 1024);
    expect(parseCaptureSpikeManifestV0(bytes)).toMatchObject({ ok: true });
  });
});
