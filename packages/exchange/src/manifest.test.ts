import { describe, expect, it } from "vitest";
import {
  assertLedgerPackageManifestShape,
  assertManifestV1Shape,
  assertManifestV2Shape,
  buildManifest,
  UnsupportedSchemaVersionError,
  type BuildManifestInput,
} from "./manifest.js";

const baseInput = {
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
  eventCount: 3,
  contextCount: 2,
  importReceiptCount: 0,
  watermark: {
    maxSeqByDevice: { "device-a": 3 },
    maxHlc: { wallTime: 42, counter: 1 },
  },
};

const validManifest = {
  packageKind: "tenjin-ledger",
  schemaVersion: 1,
  mode: "full-backup",
  generation: 0,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
  eventCount: 3,
  contextCount: 2,
  maxSeqByDevice: { "device-a": 3 },
  maxHlc: { wallTime: 42, counter: 1 },
  foldExternalState: [],
};

const validManifestV2 = {
  ...validManifest,
  schemaVersion: 2,
  importReceiptCount: 1,
  foldExternalState: ["importReceipts"],
};

describe("assertManifestV1Shape", () => {
  it("accepts the complete closed v1 shape", () => {
    expect(() => assertManifestV1Shape(validManifest)).not.toThrow();
  });

  it.each([
    ["unknown top-level field", { ...validManifest, future: true }, /unknown.*future/i],
    ["packageKind", { ...validManifest, packageKind: "other" }, /packageKind/i],
    ["schemaVersion 2", { ...validManifest, schemaVersion: 2 }, /schemaVersion/i],
    ["string schemaVersion", { ...validManifest, schemaVersion: "1" }, /schemaVersion/i],
    ["mode", { ...validManifest, mode: "abstract-exchange" }, /mode/i],
    ["generation 1", { ...validManifest, generation: 1 }, /generation/i],
    ["fractional generation", { ...validManifest, generation: 0.5 }, /generation/i],
    ["string generation", { ...validManifest, generation: "0" }, /generation/i],
    ["empty deviceId", { ...validManifest, exportedByDeviceId: "" }, /exportedByDeviceId/i],
    ["blank deviceId", { ...validManifest, exportedByDeviceId: "   " }, /exportedByDeviceId/i],
    ["leading-space deviceId", { ...validManifest, exportedByDeviceId: " device-a" }, /exportedByDeviceId/i],
    ["trailing-space deviceId", { ...validManifest, exportedByDeviceId: "device-a " }, /exportedByDeviceId/i],
    ["non-string deviceId", { ...validManifest, exportedByDeviceId: 1 }, /exportedByDeviceId/i],
    ["timestamp shape", { ...validManifest, exportedAt: "2026-08-05 12:00:00" }, /exportedAt/i],
    ["impossible date", { ...validManifest, exportedAt: "2026-02-30T00:00:00.000Z" }, /exportedAt/i],
    ["impossible month", { ...validManifest, exportedAt: "2026-13-45T00:00:00.000Z" }, /exportedAt/i],
    ["negative eventCount", { ...validManifest, eventCount: -1 }, /eventCount/i],
    ["fractional eventCount", { ...validManifest, eventCount: 1.5 }, /eventCount/i],
    ["unsafe eventCount", { ...validManifest, eventCount: Number.MAX_SAFE_INTEGER + 1 }, /eventCount/i],
    ["negative contextCount", { ...validManifest, contextCount: -1 }, /contextCount/i],
    ["fractional contextCount", { ...validManifest, contextCount: 1.5 }, /contextCount/i],
    ["unsafe contextCount", { ...validManifest, contextCount: Number.MAX_SAFE_INTEGER + 1 }, /contextCount/i],
    ["maxHlc array", { ...validManifest, maxHlc: [] }, /maxHlc.*object/i],
    ["maxHlc missing counter", { ...validManifest, maxHlc: { wallTime: 42 } }, /maxHlc.*counter/i],
    ["maxHlc extra field", { ...validManifest, maxHlc: { wallTime: 42, counter: 1, extra: 0 } }, /maxHlc.*unknown.*extra/i],
    ["negative maxHlc wallTime", { ...validManifest, maxHlc: { wallTime: -1, counter: 1 } }, /maxHlc.*wallTime/i],
    ["fractional maxHlc counter", { ...validManifest, maxHlc: { wallTime: 42, counter: 0.5 } }, /maxHlc.*counter/i],
    ["unsafe maxHlc counter", { ...validManifest, maxHlc: { wallTime: 42, counter: Number.MAX_SAFE_INTEGER + 1 } }, /maxHlc.*counter/i],
    ["maxSeq array", { ...validManifest, maxSeqByDevice: [] }, /maxSeqByDevice.*object/i],
    ["maxSeq zero", { ...validManifest, maxSeqByDevice: { "device-a": 0 } }, /maxSeqByDevice.*positive/i],
    ["maxSeq fractional", { ...validManifest, maxSeqByDevice: { "device-a": 1.5 } }, /maxSeqByDevice.*positive/i],
    ["maxSeq unsafe", { ...validManifest, maxSeqByDevice: { "device-a": Number.MAX_SAFE_INTEGER + 1 } }, /maxSeqByDevice.*positive/i],
    ["blank maxSeq key", { ...validManifest, maxSeqByDevice: { " ": 1 } }, /maxSeqByDevice.*deviceId/i],
    ["non-canonical maxSeq key", { ...validManifest, maxSeqByDevice: { " device-a": 1 } }, /maxSeqByDevice.*deviceId/i],
    ["fold state not an array", { ...validManifest, foldExternalState: {} }, /foldExternalState/i],
  ])("rejects %s", (_name, candidate, message) => {
    expect(() => assertManifestV1Shape(candidate)).toThrow(message as RegExp);
  });

  it("rejects non-empty foldExternalState rather than silently dropping it", () => {
    // Unknown fold-external state may carry idempotency information. Dropping
    // it would make restore look successful while its receipts were lost.
    expect(() =>
      assertManifestV1Shape({
        ...validManifest,
        foldExternalState: ["importReceipts"],
      }),
    ).toThrow(/does not understand.*reject the whole package.*not discard/i);
  });
});

describe("manifest version dispatch", () => {
  it("accepts the closed v2 shape and exact receipt fold descriptor", () => {
    expect(() => assertManifestV2Shape(validManifestV2)).not.toThrow();
    expect(() => assertLedgerPackageManifestShape(validManifest)).not.toThrow();
    expect(() =>
      assertLedgerPackageManifestShape(validManifestV2),
    ).not.toThrow();
  });

  it.each([
    ["missing receipt count", { ...validManifestV2, importReceiptCount: undefined }, /importReceiptCount/i],
    ["negative receipt count", { ...validManifestV2, importReceiptCount: -1 }, /importReceiptCount/i],
    ["v1 fold descriptor", { ...validManifestV2, foldExternalState: [] }, /foldExternalState/i],
    ["extra fold descriptor", { ...validManifestV2, foldExternalState: ["importReceipts", "future"] }, /foldExternalState/i],
    ["unknown field", { ...validManifestV2, future: true }, /unknown.*future/i],
  ])("rejects a v2 manifest with %s", (_name, candidate, message) => {
    expect(() => assertManifestV2Shape(candidate)).toThrow(message as RegExp);
  });

  it("rejects v3+ with a dedicated TypeError subclass and stable code", () => {
    const candidate = {
      ...validManifestV2,
      schemaVersion: 3,
      futureField: true,
    };
    const error = (() => {
      try {
        assertLedgerPackageManifestShape(candidate);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_SCHEMA_VERSION" });
  });
});

describe("buildManifest", () => {
  it("stamps the package kind, schema version and generation", () => {
    const manifest = buildManifest(baseInput);
    expect(manifest.packageKind).toBe("tenjin-ledger");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.generation).toBe(0);
  });

  it("always emits the v2 receipt count and fold-external descriptor", () => {
    expect(buildManifest(baseInput).importReceiptCount).toBe(0);
    expect(buildManifest(baseInput).foldExternalState).toEqual([
      "importReceipts",
    ]);
  });

  it("stamps the only mode this version can produce", () => {
    expect(() => buildManifest(baseInput)).not.toThrow();
    expect(buildManifest(baseInput).mode).toBe("full-backup");
  });

  it("rejects a mode this version cannot honour, naming it", () => {
    // `LedgerPackageMode` is a compile-time literal and evaporates at runtime,
    // so nothing stopped a JavaScript caller - or a `JSON.parse`d config - from
    // asking for the deferred abstract mode. The result was a package whose
    // manifest claimed `mode: "abstract-exchange"` while `contexts/*.json` sat
    // right beside it carrying the source text: exactly the artefact the
    // deferral exists to prevent a restorer from ever trusting.
    //
    // buildManifest runs before any entry is assembled, so it is the single
    // choke point where an unhonourable mode can still be refused for free.
    const rejected = { ...baseInput, mode: "abstract-exchange" };
    expect(() => buildManifest(rejected as BuildManifestInput)).toThrow(
      TypeError,
    );
    expect(() => buildManifest(rejected as BuildManifestInput)).toThrow(
      /abstract-exchange/,
    );
  });

  it("carries the derived watermark through unchanged", () => {
    const manifest = buildManifest(baseInput);
    expect(manifest.maxSeqByDevice).toEqual({ "device-a": 3 });
    expect(manifest.maxHlc).toEqual({ wallTime: 42, counter: 1 });
  });

  it("rejects a non-canonical exportedAt timestamp", () => {
    expect(() =>
      buildManifest({ ...baseInput, exportedAt: "2026-08-05 12:00:00" }),
    ).toThrow(TypeError);
  });

  it("rejects an impossible calendar date even when its shape is canonical", () => {
    expect(() =>
      buildManifest({
        ...baseInput,
        exportedAt: "2026-02-30T00:00:00.000Z",
      }),
    ).toThrow(/exportedAt/i);
  });

  it("rejects an empty exporting device id", () => {
    expect(() => buildManifest({ ...baseInput, exportedByDeviceId: "  " })).toThrow(
      TypeError,
    );
  });

  it.each([" device-a", "device-a "])(
    "rejects a non-canonical exporting device id %j",
    (exportedByDeviceId) => {
      expect(() =>
        buildManifest({ ...baseInput, exportedByDeviceId }),
      ).toThrow(/exportedByDeviceId/i);
    },
  );

  it("rejects invalid counts and watermark fields on the writer side", () => {
    expect(() =>
      buildManifest({ ...baseInput, eventCount: -1 }),
    ).toThrow(/eventCount/i);
    expect(() =>
      buildManifest({ ...baseInput, contextCount: 0.5 }),
    ).toThrow(/contextCount/i);
    expect(() =>
      buildManifest({ ...baseInput, importReceiptCount: -1 }),
    ).toThrow(/importReceiptCount/i);
    expect(() =>
      buildManifest({
        ...baseInput,
        watermark: {
          ...baseInput.watermark,
          maxHlc: { wallTime: -1, counter: 1 },
        },
      }),
    ).toThrow(/maxHlc.*wallTime/i);
    expect(() =>
      buildManifest({
        ...baseInput,
        watermark: {
          ...baseInput.watermark,
          maxSeqByDevice: { "device-a": 0 },
        },
      }),
    ).toThrow(/maxSeqByDevice.*positive/i);
  });
});
