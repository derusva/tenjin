import {
  readPackage,
  runZipRuntimeProbe,
  ZIP_ENTRY_OPTIONS,
  ZIP_PROBE_FIXTURES,
  ZIP_READER_OPTIONS,
  ZIP_WORKER_OPTIONS,
  type ReadLedgerPackage,
  type ZipRuntimeProbeResult,
} from "@tenjin/exchange";

const fixtureBytes: Uint8Array = ZIP_PROBE_FIXTURES.valid;
const workerEnabled: true = ZIP_WORKER_OPTIONS.useWebWorkers;
const strictReader: "strict" = ZIP_READER_OPTIONS.strictness;
const checksSignature: true = ZIP_ENTRY_OPTIONS.checkSignature;

const resultPromise: Promise<ZipRuntimeProbeResult> = runZipRuntimeProbe();
const packagePromise: Promise<ReadLedgerPackage> = readPackage(fixtureBytes);

void fixtureBytes;
void workerEnabled;
void strictReader;
void checksSignature;
void resultPromise;
void packagePromise;
