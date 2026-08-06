import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.js";

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
    expect(buildManifest(baseInput).mode).toBe("full-backup");
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
