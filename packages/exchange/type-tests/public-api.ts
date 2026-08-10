import {
  buildLedgerRestorePlan,
  exportLedgerPackage,
  readPackage,
  runZipRuntimeProbe,
  ZIP_ENTRY_OPTIONS,
  ZIP_PROBE_FIXTURES,
  ZIP_READER_OPTIONS,
  ZIP_WORKER_OPTIONS,
  type LedgerRestorePlan,
  type ExportContext,
  type ExportLedgerPackageInput,
  type LedgerPackageManifest,
  type PackageImportReceipt,
  type ReadLedgerPackage,
  type Sha256Hex,
  type ZipRuntimeProbeResult,
} from "@tenjin/exchange";

const receipt: PackageImportReceipt = {
  digest: `sha256:${"a".repeat(64)}`,
  importedAt: "2026-08-11T00:00:00.000Z",
  captureIds: ["capture-1"],
};
const context: ExportContext = {
  hash: `sha256:${"b".repeat(64)}`,
  original: "full source",
  focus: "focus",
  createdAt: "2026-08-11T00:00:00.000Z",
};
const exportInput: ExportLedgerPackageInput = {
  events: [],
  contexts: [context],
  importReceipts: [receipt],
  mode: "full-backup",
  exportedByDeviceId: "type-test",
  exportedAt: "2026-08-11T00:00:00.000Z",
};
const exportedBytes: Uint8Array = exportLedgerPackage(exportInput);
// @ts-expect-error Full backups must never default away durable receipt state.
const missingReceiptState: ExportLedgerPackageInput = {
  events: [],
  contexts: [],
  mode: "full-backup",
  exportedByDeviceId: "type-test",
  exportedAt: "2026-08-11T00:00:00.000Z",
};

declare const manifest: LedgerPackageManifest;
if (manifest.schemaVersion === 1) {
  const legacyFold: readonly [] = manifest.foldExternalState;
  void legacyFold;
} else {
  const receiptCount: number = manifest.importReceiptCount;
  const receiptFold: readonly ["importReceipts"] = manifest.foldExternalState;
  void receiptCount;
  void receiptFold;
}

const fixtureBytes: Uint8Array = ZIP_PROBE_FIXTURES.valid;
const workerEnabled: true = ZIP_WORKER_OPTIONS.useWebWorkers;
const strictReader: "strict" = ZIP_READER_OPTIONS.strictness;
const checksSignature: true = ZIP_ENTRY_OPTIONS.checkSignature;

const resultPromise: Promise<ZipRuntimeProbeResult> = runZipRuntimeProbe();
const packagePromise: Promise<ReadLedgerPackage> = readPackage(fixtureBytes);
const deterministicDigest: Sha256Hex = async () => "00".repeat(32);
const restorePlanPromise: Promise<LedgerRestorePlan> = packagePromise.then(
  (ledgerPackage) =>
    buildLedgerRestorePlan(ledgerPackage, deterministicDigest),
);
const restoredReceiptsPromise: Promise<readonly PackageImportReceipt[]> =
  restorePlanPromise.then((plan) => plan.importReceipts);

void fixtureBytes;
void workerEnabled;
void strictReader;
void checksSignature;
void resultPromise;
void packagePromise;
void restorePlanPromise;
void restoredReceiptsPromise;
void exportedBytes;
void missingReceiptState;
