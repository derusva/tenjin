import {
  buildLedgerRestorePlan,
  readPackage,
  runZipRuntimeProbe,
  ZIP_ENTRY_OPTIONS,
  ZIP_PROBE_FIXTURES,
  ZIP_READER_OPTIONS,
  ZIP_WORKER_OPTIONS,
  type LedgerRestorePlan,
  type ReadLedgerPackage,
  type Sha256Hex,
  type ZipRuntimeProbeResult,
} from "@tenjin/exchange";

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

void fixtureBytes;
void workerEnabled;
void strictReader;
void checksSignature;
void resultPromise;
void packagePromise;
void restorePlanPromise;
