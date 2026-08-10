import { describe, expect, it } from "vitest";

import {
  parseImportReceiptsJson,
  validateImportReceipts,
  type PackageImportReceipt,
} from "./importReceipts.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const IMPORTED_AT = "2026-08-11T00:00:00.000Z";

function receipt(
  digest = DIGEST_A,
  captureIds: readonly string[] = ["capture-1"],
): PackageImportReceipt {
  return { digest, importedAt: IMPORTED_AT, captureIds };
}

describe("validateImportReceipts", () => {
  it("sorts receipts by digest while preserving captureIds order", () => {
    expect(
      validateImportReceipts(
        [receipt(DIGEST_B), receipt(DIGEST_A, ["capture-2", "capture-1"])],
        new Set(["capture-1", "capture-2"]),
      ),
    ).toEqual([
      receipt(DIGEST_A, ["capture-2", "capture-1"]),
      receipt(DIGEST_B),
    ]);
  });

  it.each([
    ["non-array root", {}, /JSON array/i],
    ["non-object receipt", [null], /must be an object/i],
    ["unknown field", [{ ...receipt(), future: true }], /contain exactly/i],
    ["missing field", [{ digest: DIGEST_A, importedAt: IMPORTED_AT }], /contain exactly/i],
    ["bare digest", [{ ...receipt(), digest: "a".repeat(64) }], /digest.*sha256/i],
    ["short prefixed digest", [{ ...receipt(), digest: "sha256:aa" }], /digest.*sha256/i],
    ["uppercase digest", [{ ...receipt(), digest: `sha256:${"A".repeat(64)}` }], /digest.*lowercase/i],
    ["non-canonical time", [{ ...receipt(), importedAt: "2026-08-11T00:00:00Z" }], /canonical UTC/i],
    ["impossible time", [{ ...receipt(), importedAt: "2026-02-30T00:00:00.000Z" }], /real date/i],
    ["empty captureIds", [{ ...receipt(), captureIds: [] }], /non-empty array/i],
    ["non-array captureIds", [{ ...receipt(), captureIds: "capture-1" }], /non-empty array/i],
    ["blank captureId", [{ ...receipt(), captureIds: [" "] }], /non-empty strings/i],
    ["duplicate captureId", [{ ...receipt(), captureIds: ["capture-1", "capture-1"] }], /unique strings/i],
  ])("rejects %s", (_name, candidate, message) => {
    expect(() => validateImportReceipts(candidate)).toThrow(message as RegExp);
  });

  it("rejects duplicate receipt digests", () => {
    expect(() =>
      validateImportReceipts([receipt(), receipt()]),
    ).toThrow(/duplicate import receipt digest/i);
  });

  it("rejects a receipt reference absent from capture_created events", () => {
    expect(() =>
      validateImportReceipts([receipt()], new Set(["capture-other"])),
    ).toThrow(/unknown captureId capture-1/i);
  });

  it("parses strict JSON and rejects malformed JSON", () => {
    expect(parseImportReceiptsJson(JSON.stringify([receipt()]))).toEqual([
      receipt(),
    ]);
    expect(() => parseImportReceiptsJson("{")).toThrow(/valid JSON/i);
  });
});
