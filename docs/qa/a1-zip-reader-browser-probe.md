# A1 ZIP Reader Browser Probe

Status: **G5a PASS** on the committed browser bundle below.

This is a QA-only build. It is not a production PWA entry point. The run used a
fresh Playwright browser context, enabled the CDP Network domain with cache
disabled before navigation, waited for `READY`, switched the context offline,
and then invoked the probe exactly once.

## Evidence

- Commit: `297bd47541ca1f0daa16d6674c8cda5a0c7149ec`
- Browser: Microsoft Edge `151.0.4129.72`, headless, fresh context
- Before offline invocation: `READY`, `probeCalls = 0`, no Worker constructed,
  Worker spy installed with no error
- Offline invocation: `navigator.onLine === false`, `probeCalls = 1`
- Worker URL: `blob:http://127.0.0.1:4174/e0fef927-045d-44b4-8546-1f4e23765759`
- CDP Network log: document, committed probe bundle, favicon request, and the
  inline `blob:` Worker script only; no HTTP(S) Worker or WASM request
- Page resource scan: no Worker/WASM resource
- Verdict: **PASS**

The Gate first failed on committed control `3acdb0988bd8075bf81f9caeeeca9b91e3a9515a`:
the real Edge Worker returned vendor `Invalid uncompressed size` before the
host counting writer saw the crossing chunk. Both actual-output cases were red
with `signal.aborted === false`. Commit `297bd47` uses the worker-reported actual
`outputSize` only when it proves a project cap was exceeded; an explicit
non-exceeding counterexample prevents broad error remapping. The same
first-offline run then passed.

## Command transcript

```powershell
$env:TENJIN_COMMIT_SHA = git rev-parse HEAD
pnpm --filter @tenjin/web build:zip-reader-probe
pnpm --filter @tenjin/web exec vite preview --config vite.zip-reader-probe.config.ts --host 127.0.0.1 --port 4174
```

The browser automation used bundled Playwright, Edge, a fresh browser context,
`Network.setCacheDisabled({ cacheDisabled: true })`, and
`browserContext.setOffline(true)` only after the page reported `READY`.

## Built-file inventory

| File | Bytes |
|---|---:|
| `zip-reader-probe.html` | 2,023 |
| `assets/zip-reader-probe-xoQuHyHL.js` | 125,266 |
| `apple-touch-icon.png` | 5,200 |
| `capture-spike/japanese-unicode.html` | 2,702 |
| `tenjin-192.png` | 5,579 |
| `tenjin-512.png` | 8,498 |
| `tenjin-mark.svg` | 457 |
| `tenjin-maskable.svg` | 450 |
| `tenjin-maskable-512.png` | 6,216 |

There is no independent Worker or WASM file. The extra static files come from
the existing web `public/` directory and are not referenced by the QA probe.

## CDP Network log

```json
[
  {"url":"http://127.0.0.1:4174/zip-reader-probe.html","type":"Document"},
  {"url":"http://127.0.0.1:4174/assets/zip-reader-probe-xoQuHyHL.js","type":"Script"},
  {"url":"http://127.0.0.1:4174/favicon.ico","type":"Other"},
  {"url":"blob:http://127.0.0.1:4174/e0fef927-045d-44b4-8546-1f4e23765759","type":"Script"}
]
```

`networkWorkerOrWasm` was `[]`.

## Raw page JSON result

```json
{
  "commitSha": "297bd47541ca1f0daa16d6674c8cda5a0c7149ec",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  "offline": true,
  "probeCalls": 1,
  "workerUrls": [
    "blob:http://127.0.0.1:4174/e0fef927-045d-44b4-8546-1f4e23765759"
  ],
  "resourceEntries": [
    "http://127.0.0.1:4174/assets/zip-reader-probe-xoQuHyHL.js",
    "http://127.0.0.1:4174/favicon.ico"
  ],
  "externalWorkerOrWasmResources": [],
  "frozenConfiguration": {
    "worker": {
      "useWebWorkers": true,
      "useCompressionStream": true,
      "transferStreams": true
    },
    "reader": {
      "useWebWorkers": true,
      "useCompressionStream": true,
      "transferStreams": true,
      "strictness": "strict",
      "checkOverlappingEntry": true
    },
    "entry": {
      "useWebWorkers": true,
      "useCompressionStream": true,
      "transferStreams": true,
      "strictness": "strict",
      "checkOverlappingEntry": true,
      "checkSignature": true
    }
  },
  "runtime": {
    "pass": true,
    "cases": [
      {"name":"configuration forwarding","expected":"true:true:true","actual":"true:true:true","pass":true},
      {"name":"strict filename mismatch","expected":"Ambiguous archive","actual":"Ambiguous archive","pass":true},
      {"name":"balanced filename mismatch control","expected":"OK:payload","actual":"OK:payload","pass":true},
      {"name":"CRC raw","expected":"Invalid signature","actual":"Invalid signature","pass":true},
      {"name":"CRC mapping","expected":"CRC_MISMATCH","actual":"CRC_MISMATCH","pass":true},
      {"name":"overlap","expected":"Overlapping entry found","actual":"Overlapping entry found","pass":true},
      {"name":"encrypted","expected":"ZIP_ENCRYPTED_UNSUPPORTED:0","actual":"ZIP_ENCRYPTED_UNSUPPORTED:0","pass":true},
      {"name":"compression","expected":"ZIP_COMPRESSION_UNSUPPORTED:0","actual":"ZIP_COMPRESSION_UNSUPPORTED:0","pass":true},
      {"name":"archive multi-disk","expected":"ZIP_MULTI_DISK_UNSUPPORTED:0","actual":"ZIP_MULTI_DISK_UNSUPPORTED:0","pass":true},
      {"name":"entry multi-disk","expected":"ZIP_MULTI_DISK_UNSUPPORTED:0","actual":"ZIP_MULTI_DISK_UNSUPPORTED:0","pass":true},
      {"name":"entry ZIP64","expected":"ZIP64_ENTRY_UNSUPPORTED:0","actual":"ZIP64_ENTRY_UNSUPPORTED:0","pass":true},
      {"name":"archive ZIP64","expected":"ZIP64_ARCHIVE_UNSUPPORTED:0","actual":"ZIP64_ARCHIVE_UNSUPPORTED:0","pass":true},
      {"name":"archive ZIP64 sentinels","expected":"ZIP64_ARCHIVE_UNSUPPORTED:0","actual":"ZIP64_ARCHIVE_UNSUPPORTED:0","pass":true},
      {"name":"magic-byte negative control","expected":"OK","actual":"OK","pass":true},
      {"name":"compressed input limit","expected":"PACKAGE_COMPRESSED_LIMIT:0","actual":"PACKAGE_COMPRESSED_LIMIT:0","pass":true},
      {"name":"declared output limit","expected":"PACKAGE_DECLARED_LIMIT:0:1","actual":"PACKAGE_DECLARED_LIMIT:0:1","pass":true},
      {"name":"actual entry output limit","expected":"PACKAGE_OUTPUT_LIMIT:1:true:1","actual":"PACKAGE_OUTPUT_LIMIT:1:true:1","pass":true},
      {"name":"actual package output limit","expected":"PACKAGE_OUTPUT_LIMIT:2:true:1","actual":"PACKAGE_OUTPUT_LIMIT:2:true:1","pass":true},
      {"name":"non-ZIP64 65535-entry control","expected":"65535:false","actual":"65535:false","pass":true}
    ]
  },
  "productionReadPackage": true,
  "pass": true
}
```

G5b remains a separate iPhone/Safari acceptance Gate. This desktop browser
evidence must not be presented as that result.
