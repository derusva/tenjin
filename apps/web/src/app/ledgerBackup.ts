import {
  exportLedgerPackage,
  type ExportContext,
  type ExportLedgerPackageInput,
} from "@tenjin/exchange";
import type {
  ContextRecord,
  LedgerBackupReader,
} from "@tenjin/storage-indexeddb";

/** A deliberately timestamp-free name: repeated exports replace predictably. */
export const LEDGER_BACKUP_FILENAME = "tenjin-ledger-backup.tenjin";

const LEDGER_BACKUP_MEDIA_TYPE = "application/octet-stream";

export interface LedgerBackup {
  readonly bytes: Uint8Array;
  readonly filename: typeof LEDGER_BACKUP_FILENAME;
}

export interface BuildLedgerBackupOptions {
  /** Read-only capability: backup construction never receives a write API. */
  readonly reader: LedgerBackupReader;
  readonly deviceId: string;
  readonly exportedAt: string;
  /** Test seam; production uses the schema-v2 exchange exporter. */
  readonly exportPackage?: (input: ExportLedgerPackageInput) => Uint8Array;
}

export interface LedgerBackupDownloadAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

export interface LedgerBackupDownloadDependencies {
  readonly createObjectURL: (blob: Blob) => string;
  readonly createAnchor: () => LedgerBackupDownloadAnchor;
  readonly revokeObjectURL: (url: string) => void;
}

function assertCanonicalDeviceId(deviceId: string): void {
  if (deviceId.length === 0 || deviceId !== deviceId.trim()) {
    throw new TypeError("backup deviceId must be canonical and non-empty");
  }
}

function assertCanonicalExportedAt(exportedAt: string): void {
  const milliseconds = Date.parse(exportedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(exportedAt) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== exportedAt
  ) {
    throw new TypeError("backup exportedAt must be a canonical UTC ISO-8601 timestamp");
  }
}

async function toExportContext(context: ContextRecord): Promise<ExportContext> {
  const image = context.image;
  return {
    hash: context.hash,
    original: context.original,
    ...(context.focus === undefined ? {} : { focus: context.focus }),
    ...(context.corrected === undefined
      ? {}
      : { corrected: context.corrected }),
    ...(context.answer === undefined ? {} : { answer: context.answer }),
    ...(image === undefined
      ? {}
      : {
          image: {
            mediaType: image.mediaType,
            name: image.name,
            byteLength: image.byteLength,
            sha256: image.sha256,
            bytes: new Uint8Array(await image.blob.arrayBuffer()),
          },
        }),
    createdAt: context.createdAt,
  };
}

/**
 * Builds the only supported full backup package. All source interaction is
 * through `LedgerBackupReader`, so a failed read/export cannot alter the ledger.
 */
export async function buildLedgerBackup(
  options: BuildLedgerBackupOptions,
): Promise<LedgerBackup> {
  assertCanonicalDeviceId(options.deviceId);
  assertCanonicalExportedAt(options.exportedAt);

  const snapshot = await options.reader.readBackupSnapshot();
  const contexts = await Promise.all(snapshot.contexts.map(toExportContext));
  const exportPackage = options.exportPackage ?? exportLedgerPackage;
  const bytes = exportPackage({
    events: snapshot.events,
    contexts,
    importReceipts: snapshot.importReceipts,
    mode: "full-backup",
    exportedByDeviceId: options.deviceId,
    exportedAt: options.exportedAt,
  });

  return { bytes, filename: LEDGER_BACKUP_FILENAME };
}

function browserDownloadDependencies(): LedgerBackupDownloadDependencies {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    createAnchor: () => document.createElement("a"),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * Uses a short-lived object URL and always releases the DOM and URL resources,
 * including when the browser refuses the synthetic click.
 */
export function downloadLedgerBackup(
  backup: LedgerBackup,
  dependencies: LedgerBackupDownloadDependencies = browserDownloadDependencies(),
): void {
  // Copy into an ArrayBuffer-backed view: a public Uint8Array may be backed by
  // SharedArrayBuffer, which Blob deliberately does not accept.
  const payload = new Uint8Array(backup.bytes);
  const blob = new Blob([payload.buffer], { type: LEDGER_BACKUP_MEDIA_TYPE });
  const objectUrl = dependencies.createObjectURL(blob);
  let anchor: LedgerBackupDownloadAnchor | undefined;

  try {
    anchor = dependencies.createAnchor();
    anchor.href = objectUrl;
    anchor.download = backup.filename;
    anchor.click();
  } finally {
    try {
      dependencies.revokeObjectURL(objectUrl);
    } finally {
      anchor?.remove();
    }
  }
}
