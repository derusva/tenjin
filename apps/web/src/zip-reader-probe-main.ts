import {
  exportLedgerPackage,
  readPackage,
  runZipRuntimeProbe,
  ZIP_ENTRY_OPTIONS,
  ZIP_READER_OPTIONS,
  ZIP_WORKER_OPTIONS,
} from "@tenjin/exchange";

declare const __TENJIN_COMMIT_SHA__: string;

interface ProbeSpyState {
  readonly workerUrls: string[];
  probeCalls: number;
  readonly spyInstalled: boolean;
  readonly spyError: string | null;
}

declare global {
  interface Window {
    __TENJIN_ZIP_PROBE_SPY__: ProbeSpyState;
  }
}

interface BrowserProbeResult {
  readonly commitSha: string;
  readonly userAgent: string;
  readonly offline: boolean;
  readonly probeCalls: number;
  readonly workerUrls: readonly string[];
  readonly resourceEntries: readonly string[];
  readonly externalWorkerOrWasmResources: readonly string[];
  readonly frozenConfiguration: {
    readonly worker: typeof ZIP_WORKER_OPTIONS;
    readonly reader: typeof ZIP_READER_OPTIONS;
    readonly entry: typeof ZIP_ENTRY_OPTIONS;
  };
  readonly runtime: Awaited<ReturnType<typeof runZipRuntimeProbe>>;
  readonly productionReadPackage: boolean;
  readonly pass: boolean;
  readonly error?: string;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

const runButton = requiredElement<HTMLButtonElement>("run");
const copyButton = requiredElement<HTMLButtonElement>("copy");
const status = requiredElement<HTMLParagraphElement>("status");
const output = requiredElement<HTMLPreElement>("result");

function resourceEntries(): string[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .sort();
}

function workerUrlsAreInline(urls: readonly string[]): boolean {
  return urls.every((url) => url.startsWith("blob:") || url.startsWith("data:"));
}

function externalWorkerOrWasmResources(
  resources: readonly string[],
): string[] {
  return resources.filter((resource) => {
    try {
      const pathname = new URL(resource, window.location.href).pathname;
      return /(?:^|\/)(?:[^/]*worker[^/]*\.js|[^/]+\.wasm)$/i.test(pathname);
    } catch {
      return /(?:worker[^/]*\.js|\.wasm)(?:[?#]|$)/i.test(resource);
    }
  });
}

function buildEmptyPackage(): Uint8Array {
  return exportLedgerPackage({
    events: [],
    contexts: [],
    importReceipts: [],
    mode: "full-backup",
    exportedByDeviceId: "browser-probe",
    exportedAt: "2026-08-10T00:00:00.000Z",
  });
}

async function run(): Promise<BrowserProbeResult> {
  const spy = window.__TENJIN_ZIP_PROBE_SPY__;
  spy.probeCalls += 1;
  const offline = navigator.onLine === false;
  try {
    const runtime = await runZipRuntimeProbe();
    const parsed = await readPackage(buildEmptyPackage());
    const resources = resourceEntries();
    const externalResources = externalWorkerOrWasmResources(resources);
    const productionReadPackage =
      parsed.eventsJsonl === "" &&
      parsed.importReceiptsJson === "[]" &&
      parsed.contextJsonByHash.size === 0;
    const pass =
      offline &&
      spy.probeCalls === 1 &&
      spy.spyInstalled &&
      spy.spyError === null &&
      workerUrlsAreInline(spy.workerUrls) &&
      externalResources.length === 0 &&
      runtime.pass &&
      productionReadPackage;
    return {
      commitSha: __TENJIN_COMMIT_SHA__,
      userAgent: navigator.userAgent,
      offline,
      probeCalls: spy.probeCalls,
      workerUrls: [...spy.workerUrls],
      resourceEntries: resources,
      externalWorkerOrWasmResources: externalResources,
      frozenConfiguration: {
        worker: ZIP_WORKER_OPTIONS,
        reader: ZIP_READER_OPTIONS,
        entry: ZIP_ENTRY_OPTIONS,
      },
      runtime,
      productionReadPackage,
      pass,
    };
  } catch (error) {
    const resources = resourceEntries();
    return {
      commitSha: __TENJIN_COMMIT_SHA__,
      userAgent: navigator.userAgent,
      offline,
      probeCalls: spy.probeCalls,
      workerUrls: [...spy.workerUrls],
      resourceEntries: resources,
      externalWorkerOrWasmResources:
        externalWorkerOrWasmResources(resources),
      frozenConfiguration: {
        worker: ZIP_WORKER_OPTIONS,
        reader: ZIP_READER_OPTIONS,
        entry: ZIP_ENTRY_OPTIONS,
      },
      runtime: { pass: false, cases: [] },
      productionReadPackage: false,
      pass: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

let resultText = "";
runButton.addEventListener("click", () => {
  runButton.disabled = true;
  status.textContent = "RUNNING";
  void run().then((result) => {
    resultText = JSON.stringify(result, null, 2);
    output.textContent = resultText;
    status.textContent = result.pass ? "PASS" : "FAIL";
    status.dataset.state = status.textContent;
    copyButton.disabled = false;
  });
});

copyButton.addEventListener("click", () => {
  void navigator.clipboard.writeText(resultText);
});

status.textContent = "READY";
runButton.disabled = false;
