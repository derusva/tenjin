import { describe, expect, it } from "vitest";

import {
  assertRestoreCommitRecord,
  RestoreCommitRecordError,
} from "./restoreCommit.js";

const validRecord = {
  key: "restore-commit",
  type: "restore-commit",
  newDeviceId: "device-restored",
  committedAt: "2026-08-10T12:34:56.789Z",
} as const;
const missingKey = {
  type: validRecord.type,
  newDeviceId: validRecord.newDeviceId,
  committedAt: validRecord.committedAt,
};
const symbolField = Symbol("future");

describe("assertRestoreCommitRecord", () => {
  it("accepts the exact closed, canonical marker shape", () => {
    expect(() => assertRestoreCommitRecord(validRecord)).not.toThrow();
  });

  it.each([
    ["non-object", null],
    ["missing key", missingKey],
    ["wrong key", { ...validRecord, key: "other" }],
    ["wrong type", { ...validRecord, type: "global-hlc" }],
    ["empty device id", { ...validRecord, newDeviceId: "" }],
    ["blank device id", { ...validRecord, newDeviceId: "   " }],
    ["trimmed device id", { ...validRecord, newDeviceId: " device " }],
    ["non-canonical timestamp", { ...validRecord, committedAt: "2026-08-10T12:34:56Z" }],
    ["impossible timestamp", { ...validRecord, committedAt: "2026-02-30T12:34:56.789Z" }],
    ["extra field", { ...validRecord, future: true }],
    ["symbol field", { ...validRecord, [symbolField]: true }],
  ])("rejects %s with the dedicated marker error", (_name, candidate) => {
    expect(() => assertRestoreCommitRecord(candidate)).toThrow(
      RestoreCommitRecordError,
    );
  });
});
