import { describe, expect, it } from "vitest";
import { buildManifest, type BuildManifestInput } from "./manifest.js";

const baseInput = {
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
  eventCount: 3,
  contextCount: 2,
  watermark: {
    maxSeqByDevice: { "device-a": 3 },
    maxHlc: { wallTime: 42, counter: 1 },
  },
};

describe("buildManifest", () => {
  it("stamps the package kind, schema version and generation", () => {
    const manifest = buildManifest(baseInput);
    expect(manifest.packageKind).toBe("tenjin-ledger");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generation).toBe(0);
  });

  it("never emits fold-external state in v1", () => {
    expect(buildManifest(baseInput).foldExternalState).toEqual([]);
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

  it("rejects an empty exporting device id", () => {
    expect(() => buildManifest({ ...baseInput, exportedByDeviceId: "  " })).toThrow(
      TypeError,
    );
  });
});
