import { describe, expect, it, vi } from "vitest";

import type { Event } from "@tenjin/core";
import {
  readPackage,
  type ExportLedgerPackageInput,
} from "@tenjin/exchange";
import type {
  ContextRecord,
  LedgerBackupReader,
} from "@tenjin/storage-indexeddb";

import {
  buildLedgerBackup,
  downloadLedgerBackup,
  LEDGER_BACKUP_FILENAME,
  type LedgerBackupDownloadDependencies,
} from "./ledgerBackup.js";

const EXPORTED_AT = "2026-08-11T12:34:56.789Z";
const CONTEXT_HASH = `sha256:${"a".repeat(64)}`;
const IMAGE_SHA256 = "b".repeat(64);

function reader(
  snapshot: Awaited<ReturnType<LedgerBackupReader["readBackupSnapshot"]>>,
): LedgerBackupReader {
  return { readBackupSnapshot: vi.fn(async () => snapshot) };
}

function captureEvent(): Event {
  return {
    schemaVersion: 1,
    eventId: "device-source:1",
    deviceId: "device-source",
    seq: 1,
    hlc: { wallTime: 1, counter: 0 },
    occurredAt: "2026-08-11T12:00:00.000Z",
    recordedAt: "2026-08-11T12:00:00.000Z",
    actor: "user",
    kind: "capture_created",
    captureId: "capture-1",
    contextHash: CONTEXT_HASH,
    payload: { captureType: "lookup" },
  };
}

function context(overrides: Partial<ContextRecord> = {}): ContextRecord {
  return {
    hash: CONTEXT_HASH,
    original: "original text",
    createdAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  };
}

function blobWithBytes(bytes: Uint8Array): Blob {
  return {
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as Blob;
}

describe("ledger backup", () => {
  it("passes the complete empty-backup export parameters and stable filename", async () => {
    const exportPackage = vi.fn<
      (input: ExportLedgerPackageInput) => Uint8Array
    >(() => new Uint8Array([1, 2, 3]));
    const source = reader({ events: [], contexts: [], importReceipts: [] });

    await expect(
      buildLedgerBackup({
        reader: source,
        deviceId: "device-source",
        exportedAt: EXPORTED_AT,
        exportPackage,
      }),
    ).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      filename: LEDGER_BACKUP_FILENAME,
    });
    expect(exportPackage).toHaveBeenCalledWith({
      events: [],
      contexts: [],
      importReceipts: [],
      mode: "full-backup",
      exportedByDeviceId: "device-source",
      exportedAt: EXPORTED_AT,
    });
  });

  it("uses the default schema-v2 exporter for an empty full backup", async () => {
    const backup = await buildLedgerBackup({
      reader: reader({ events: [], contexts: [], importReceipts: [] }),
      deviceId: "device-source",
      exportedAt: EXPORTED_AT,
    });

    const source = await readPackage(backup.bytes);
    expect(JSON.parse(source.manifestJson)).toMatchObject({
      schemaVersion: 2,
      mode: "full-backup",
      exportedByDeviceId: "device-source",
      exportedAt: EXPORTED_AT,
      importReceiptCount: 0,
      foldExternalState: ["importReceipts"],
    });
  });

  it("preserves focus, every image byte, and Coach import receipts", async () => {
    const imageBytes = new Uint8Array([0, 255, 4, 128]);
    const exportPackage = vi.fn<
      (input: ExportLedgerPackageInput) => Uint8Array
    >(() => new Uint8Array());
    const source = reader({
      events: [captureEvent()],
      contexts: [
        context({
          focus: "focus text",
          image: {
            blob: blobWithBytes(imageBytes),
            mediaType: "image/png",
            name: "evidence.png",
            byteLength: imageBytes.byteLength,
            sha256: IMAGE_SHA256,
          },
        }),
      ],
      importReceipts: [
        {
          digest: `sha256:${"c".repeat(64)}`,
          importedAt: "2026-08-11T12:01:00.000Z",
          captureIds: ["capture-1"],
        },
      ],
    });

    await buildLedgerBackup({
      reader: source,
      deviceId: "device-source",
      exportedAt: EXPORTED_AT,
      exportPackage,
    });

    const input = exportPackage.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      events: [captureEvent()],
      importReceipts: [
        {
          digest: `sha256:${"c".repeat(64)}`,
          captureIds: ["capture-1"],
        },
      ],
      contexts: [
        {
          hash: CONTEXT_HASH,
          original: "original text",
          focus: "focus text",
          image: {
            mediaType: "image/png",
            name: "evidence.png",
            byteLength: 4,
            sha256: IMAGE_SHA256,
          },
        },
      ],
    });
    expect(input?.contexts[0]?.image?.bytes).toEqual(imageBytes);
  });

  it("fails before reading when export parameters are non-canonical", async () => {
    const source = reader({ events: [], contexts: [], importReceipts: [] });

    await expect(
      buildLedgerBackup({
        reader: source,
        deviceId: " device-source ",
        exportedAt: EXPORTED_AT,
      }),
    ).rejects.toThrow("deviceId");
    await expect(
      buildLedgerBackup({
        reader: source,
        deviceId: "device-source",
        exportedAt: "2026-08-11 12:34:56",
      }),
    ).rejects.toThrow("exportedAt");
    expect(source.readBackupSnapshot).not.toHaveBeenCalled();
  });

  it("does not export or mutate the reader snapshot when Blob reading fails", async () => {
    const exportPackage = vi.fn<
      (input: ExportLedgerPackageInput) => Uint8Array
    >(() => new Uint8Array());
    const image = {
      blob: {
        arrayBuffer: vi.fn(() => Promise.reject(new Error("blob failed"))),
      } as unknown as Blob,
      mediaType: "image/png" as const,
      name: "broken.png",
      byteLength: 1,
      sha256: IMAGE_SHA256,
    };
    const snapshot = {
      events: [] as readonly Event[],
      contexts: [context({ image })],
      importReceipts: [],
    };
    const source = reader(snapshot);

    await expect(
      buildLedgerBackup({
        reader: source,
        deviceId: "device-source",
        exportedAt: EXPORTED_AT,
        exportPackage,
      }),
    ).rejects.toThrow("blob failed");
    expect(exportPackage).not.toHaveBeenCalled();
    expect(await source.readBackupSnapshot()).toBe(snapshot);
  });

  it("clicks the downloaded backup and always revokes and removes it", async () => {
    const calls: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click() {
        calls.push("click");
      },
      remove() {
        calls.push("remove");
      },
    };
    const dependencies: LedgerBackupDownloadDependencies = {
      createObjectURL: (blob) => {
        calls.push(`create:${blob.size}`);
        return "blob:backup";
      },
      createAnchor: () => anchor,
      revokeObjectURL: (url) => {
        calls.push(`revoke:${url}`);
      },
    };

    downloadLedgerBackup(
      { bytes: new Uint8Array([1, 2, 3]), filename: LEDGER_BACKUP_FILENAME },
      dependencies,
    );

    expect(anchor.href).toBe("blob:backup");
    expect(anchor.download).toBe(LEDGER_BACKUP_FILENAME);
    expect(calls).toEqual(["create:3", "click", "revoke:blob:backup", "remove"]);
  });

  it("releases the object URL and anchor even when click fails", () => {
    const calls: string[] = [];
    const dependencies: LedgerBackupDownloadDependencies = {
      createObjectURL: () => "blob:backup",
      createAnchor: () => ({
        href: "",
        download: "",
        click() {
          calls.push("click");
          throw new Error("download blocked");
        },
        remove() {
          calls.push("remove");
        },
      }),
      revokeObjectURL: () => {
        calls.push("revoke");
      },
    };

    expect(() =>
      downloadLedgerBackup(
        { bytes: new Uint8Array(), filename: LEDGER_BACKUP_FILENAME },
        dependencies,
      ),
    ).toThrow("download blocked");
    expect(calls).toEqual(["click", "revoke", "remove"]);
  });
});
