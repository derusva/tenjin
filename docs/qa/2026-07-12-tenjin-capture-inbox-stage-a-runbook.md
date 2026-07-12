# Tenjin Capture Inbox Stage A — device QA runbook

## Goal and evidence rule

This runbook tests whether an iOS 26 Share Sheet shortcut can write a complete disposable package to iCloud Drive and whether the Tenjin diagnostic PWA can read it back without touching production learning data.

Only an observation from the target Apple device and the actual iCloud/PWA path can pass a device gate. Unit tests, jsdom, desktop browsers, hand-built folders, screenshots of editor actions, and synthetic missing-file errors can validate code defenses, but they cannot pass Share Sheet Content Graph, iCloud placeholder, permission persistence, restart, offline, or source-app gates. Record those results as synthetic support or `UNVERIFIED`, never as device `PASS`.

Use these companion documents:

- [Task 0 feasibility probe](capture-inbox-stage-a/feasibility-probe.md)
- [iOS 26 shortcut build sheet](../ios-shortcuts/tenjin-capture-spike-v0-build.md)
- public fixture after deployment: `https://derusva.github.io/tenjin/capture-spike/japanese-unicode.html`
- repository fixture: `fixtures/capture-spike/unicode/japanese-unicode.txt`
- scalar oracle: `fixtures/capture-spike/unicode/japanese-unicode.codepoints.json`

### Prior evidence versus this run

| Evidence | What is already known | What it does **not** pass |
| --- | --- | --- |
| Task 0 target-iPhone probe | `Text`, `Get Type`, `Show Content`, and `Save File` were found under their current English names. The `Shortcuts` root plus a complete `/Tenjin/CaptureLogSpike/.../probe.txt` Subpath saved exact text and auto-created the tested static and local timestamp directories. Safari selection/page/image-link, one/two Photos items, Files text, and Apple Books absence were observed as recorded in the probe. | The complete shortcut, explicit UTC, random suffix and same-second collision, restart persistence, failure behavior, iCloud placeholder, upload completion, iPhone PWA readback, or the Task 6 device gate. |
| Desktop/unit/browser evidence from Tasks 1–5 | Parser, reader, diagnostic UI, synthetic missing payload, and synthetic read-error defenses. | Any Share Sheet, Shortcuts, Files permission, iCloud provider, source-app, restart, offline, or target-device claim. |
| This Task 6/7 run | Only new rows observed through the target iPhone and actual iCloud/PWA path may advance a device gate. | An unrun case remains `UNVERIFIED`; it cannot inherit `PASS` from Task 0 or simulation. |

Task 0 deliberately stopped after the narrow feasibility probe. Reconfirming its observations is a regression check, not permission to prefill Task 6 evidence rows.

## Safety and privacy

- Use only the public fixture, generated test images, and other non-sensitive test data.
- Do not record Apple ID, company identity, device serial number, private directory names, or real learning material.
- Write only under `iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/`.
- Do not rename, delete, or inspect the production `CaptureLog` as part of this run.
- A `Show Notification` success means the local `Save File` sequence returned successfully. It does not mean iCloud upload has completed; PWA readback is separate evidence.
- An incomplete run may leave orphan payloads. That is acceptable only when `capture.json` is absent and no success notification was shown.

## Required conditions

Record the following in `docs/qa/capture-inbox-stage-a/environment.md` before measurement:

| Item | Required record |
| --- | --- |
| device | iPhone model only; no serial or Apple ID |
| system | exact iOS 26 version and system build |
| Shortcuts | displayed app/system version if available |
| PWA | deployed Tenjin commit SHA and diagnostic URL |
| date | local test date and device time zone |
| network | Wi-Fi/cellular/offline state per case; no SSID |
| iCloud Drive | enabled/disabled state and whether the file is downloaded |
| shortcut | `none` or `sha256`, build-sheet revision/commit, local authoring status |

Before starting:

1. Confirm the production Tenjin page and `/tenjin/capture-spike.html` load from the deployed commit.
2. Fully close old PWA clients, then reopen so a waiting service worker cannot supply the previous bundle.
3. Confirm the diagnostic page states that it does not import data into Tenjin.
4. Confirm the shortcut root is `Shortcuts` and every `Save File` uses a complete Subpath beginning `/Tenjin/CaptureLogSpike/` and ending with the final filename.
5. Confirm `Ask Where to Save` and `Overwrite If File Exists` are off.
6. Do not begin roundtrips until every build-sheet action marked **R** has an exact target-editor search result or a recorded blocking difference.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `PASS` | The exact required behavior was observed on the target device and has a direct evidence row. |
| `FAIL` | The target behavior contradicted the requirement. Keep the row even after a fix. |
| `UNVERIFIED` | The case was not run, could not be induced safely, or has only synthetic evidence. |
| `BLOCKED` | A prerequisite such as a required action, Apple device, or stable representation is unavailable. |

Do not use “mostly pass” or convert `UNVERIFIED` to `PASS` from inference.

## Evidence files and fixed columns

Create the following only when real measurements exist. UTF-8 CSV, one header row, one physical row per observation; quote fields containing commas or newlines.

### `content-graph.csv`

```text
attemptId,captureId,sourceApp,sourceVersion,shareGesture,topLevelInputCount,inputIndex,representationIndex,reportedType,selectedForV0,previewKind,mediaType,fileExtension,byteLength,sourceAppIdentityAvailable,notes
```

`reportedType` is the raw localized output of `Get Type`; never translate it to an English enum. `sourceApp` and `sourceVersion` stay empty unless Shortcuts provides stable identity directly. `sourceAppIdentityAvailable` is `false` when it does not. Do not infer the source from the test case name. `mediaType` and `byteLength` stay empty unless the device proves actual MIME and integer byte values. A displayed file size is not automatically a byte count.

Each available Content Graph representation may have a separate `representationIndex`, but only one row per top-level input may have `selectedForV0=true`. The v0 package saves one round-trip representation per top-level input.

### `roundtrip.csv`

```text
attemptId,captureId,case,hashMode,shortcutReportedSuccess,manifestPresent,payloadCountExpected,payloadCountEnumerated,pwaStatus,orderPreserved,unicodePreserved,sourceDigestMatches,totalSeconds,notes
```

`shortcutReportedSuccess=true` only when the success `Show Notification` appeared after the manifest save. `unicodePreserved=true` requires code point comparison, not visual similarity. Leave `sourceDigestMatches` empty for `none`.

### `sha256-ab.csv`

```text
pairId,captureId,case,bytes,orderInPair,hashMode,sourceHashDurationMsSum,totalSeconds,pwaHashDurationMsSum,sourceDigestMatches,notes
```

If source hashing or sub-second timing is unsupported, leave the duration empty and record `unsupported`; never write a guessed zero.

### `manual-matrix.md`

For each reliability case record: environment reference, exact steps, expected result, actual result, `PASS`/`FAIL`/`UNVERIFIED`, and direct evidence location. A screenshot or screen recording may support a row but does not replace the row and package inspection.

## Attempt IDs and retries

- Use monotonically increasing IDs such as `A-20260712-001`; do not reuse an ID.
- Let every shortcut run create a new random-suffixed `captureId`; never retry into the previous directory.
- Write the failed row before making a fix.
- A retry gets a new attempt ID and `captureId`; put `retry-of=A-...` in `notes`.
- Never delete a failure because a later retry passes.
- If an editor action or schema must change, stop, update the build sheet in Git, deploy the new commit, and record that commit for later attempts.

## Fixed execution order

Run the sections in this order. A failure may stop later dependent sections, but must remain recorded.

### 1. Calibrate iOS 26 actions and serialization

1. Search the target editor in English for every build-sheet **R** label. Record exact results and any rendered differences.
2. Confirm `Text`, `Get Type`, `Show Content`, and `Save File` still match the Task 0 target observations.
3. Confirm the documented `Stop and Respond` choice appears only in the top `Shortcut Input` no-input setting. It is not an action.
4. Confirm ordinary branches can use `Stop and Output` with output mode `Respond`. Run one harmless rejection from the Share Sheet and record whether its response is visible.
5. If `Respond` is not visible, record `FAIL` for that UX path before trying the documented visible fallback: `Show Alert` then `Stop Shortcut`, or failure `Show Notification` then `Stop Shortcut`. The fallback must not reach a manifest save or success notification.
6. Run `Get Type` + `Show Content` calibration inputs and record localized strings. Do not branch on hard-coded English strings. Demonstrate a non-string, content-type-aware route before building the package shortcut; otherwise mark routing `BLOCKED`.
7. Use the same `Current Date` value to derive explicit-UTC `capturedAt`, local `shardMonth`, and local ID timestamp. Test once near a UTC/local month boundary using a safely controlled date input; confirm the local shard and UTC timestamp can be in different months without either being falsified.
8. Prove dictionary-to-JSON behavior before saving a package: numeric `schemaVersion`/`spikeBuild`, ordered payload array, localized strings, booleans if used, omitted optional keys absent rather than `null`, no UTF-8 BOM, and parser-acceptable line endings. Record the exact executable action chain.
9. The first `none` build omits `sourceApp`, `mediaType`, `originalName`, and `sourceByteLength`. Separately probe `Save File` return/error behavior and file details; do not add an optional field until its meaning is proven.
10. For the sha256 copy only, hash UTF-8 `abc` and require the exact lowercase 64-hex known answer from the build sheet. Confirm file input and sub-second timing. No sub-second measurement means source timing is unsupported, not zero.

### 2. Build and permission smoke test

1. Build `Tenjin Capture Spike v0` exactly from the committed sheet. This local authoring run is not import/install evidence.
2. Run a one-item public text capture. The first run may request Files permission, but must not ask for a daily save location.
3. Run it again. A repeated permission or location prompt is `FAIL`.
4. Inspect the package under the device-local month. Confirm the directory name matches `spike-YYYYMMDD-HHmmss-SSS-NNNNNN`.
5. Trigger two captures within the same second. Confirm two different six-digit suffixes and two directories with no overwrite.
6. Confirm the full Subpath, including the final filename, created every intermediate folder. Do not replace it with a different root or folder action.

### 3. Collect Content Graph observations

Run the cases below in order. Record every real attempt, including absence of the shortcut from a source Share Sheet.

| Case | Source and gesture | Required observation |
| --- | --- | --- |
| `CG-01` | Safari, selected plain fixture text | top-level count, raw `Get Type`, selected v0 representation |
| `CG-02` | rich-text section, selected/shared content | whether rich formatting or text is actually delivered |
| `CG-03` | Safari, share whole fixture page | actual Safari page/URL representation |
| `CG-04` | long-press the percent-encoded fixture link | actual URL representation and exact URL string |
| `CG-05` | Photos, one generated non-sensitive image | actual saved Shortcuts representation and extension |
| `CG-06` | Photos, 2 images, then 10 images | top-level count and stable order |
| `CG-07` | Files preview of `japanese-unicode.txt` | actual representation; Task 0 observed localized text type |
| `CG-08` | one reading app actually used by the target user | useful representation or explicit absence/failure |
| `CG-09` | PDF, video, and unknown file, if safely available | explicit rejection, no manifest, no success notification |

Task 0 already observed that Apple Books did not expose this shortcut for selected text. Keep that as a real reader sample and put direct Apple Books capture in the v1 rejection list. The reader workflow can pass only if a Books screenshot is then captured through Photos and read back end to end; that proves the documented fallback, not direct Books support. Do not install an unrelated reader merely to manufacture a pass.

For images, report only the final representation Shortcuts saved. Do not claim byte identity with the source Photos asset unless independently proven.

### 4. Unicode and package roundtrips

For each row, start the timer when the shortcut is selected in the Share Sheet and stop it at the success notification. Then wait separately for iCloud availability and perform PWA readback.

| Case | Input | Required comparison |
| --- | --- | --- |
| `RT-01` | public plain-text fixture | leading spaces, trailing spaces, blank line, LF, all named scalar sequences |
| `RT-02` | public rich-text section | actual selected v0 representation and no unrecorded conversion claim |
| `RT-03` | Safari selection sentence | exact text and Japanese punctuation |
| `RT-04` | percent-encoded URL | exact `%` escapes and query string; no decode/re-encode drift |
| `RT-05` | one Photos image | PWA reads the saved image representation |
| `RT-06` | 2–10 Photos images | payload count and `Repeat Index` order preserved |
| `RT-07` | Files text preview | same byte/codepoint checks as its actual saved representation allows |
| `RT-08` | device-created CRLF copy of the LF fixture | record the tool used; confirm observed line-ending behavior |

The Git fixture remains LF-only. Create `RT-08` on the device or in the shortcut during QA and do not commit a CRLF duplicate. Compare the following named segments to `japanese-unicode.codepoints.json`: mixed scripts, `𠮷`, `👩‍💻`, precomposed `が`, decomposed `か + U+3099`, Japanese punctuation, Japanese path, and percent-encoded URL. Normalizing the strings before comparison is not allowed.

For every package:

1. capture success appears only after all payload saves and the final manifest save;
2. `capture.json` enumerates every payload exactly once in `Repeat Results` order;
3. the PWA selects the matching month directory and reports the package `ready`;
4. source-declared optional fields are either proven and correct or absent;
5. the diagnostic flow creates no production Tenjin event or learning context.

### 5. Manifest-last failure injection

1. Duplicate the working `none` shortcut into a temporary QA-only copy.
2. With at least two inputs, insert `Stop and Output` (`Respond`) immediately after the first payload `Save File` and before the payload dictionary completes.
3. Run once and keep its evidence row.
4. Confirm an orphan payload may exist, but `capture.json` does not.
5. Confirm the success notification does not appear.
6. Select the month in the PWA and confirm the incomplete directory is not reported as a ready package.
7. Delete the temporary shortcut copy after evidence capture; keep the orphan directory until the evidence row has been reconciled.

This proves only the tested action path. The completion marker is not a transaction and cannot prevent orphan payloads.

### 6. Permission, restart, offline, and placeholder matrix

Run in the `manual-matrix.md` order:

1. first Files permission and one-time root configuration;
2. second run without prompt;
3. force-quit Shortcuts, then run;
4. restart iPhone, then run;
5. online warm write and PWA readback;
6. airplane-mode local write, requiring either a complete local package with no false upload claim or an explicit failure with no manifest/success notification;
7. restore network, observe sync, then read again;
8. rename or delete only `CaptureLogSpike`, then require safe recreation or explicit failure—never a false completed package;
9. cancel a directory/permission flow that iOS safely exposes, requiring no success result;
10. induce a real iCloud placeholder with Files `Remove Download` or a second-device sync if the platform permits, requiring the whole package to be temporarily unavailable until all files download;
11. run the failure-injection copy from the previous section.

Do not fill real iCloud storage to simulate low space. Mark that capacity case `UNVERIFIED`. A synthetic missing file and a synthetic `NotReadableError` can pass only the browser-defense tests; they do not pass the real provider case. If the platform cannot induce a placeholder, write “real provider scenario not observed” and leave the provider gate `UNVERIFIED`.

### 7. `none` versus `sha256`

Do not begin until the sha256 calibration succeeds. The two shortcut copies may differ only as stated in the build sheet.

Use these workloads:

- about 100 KB Japanese UTF-8 text;
- one ordinary HTTP/HTTPS URL;
- about 10 MB non-sensitive single image;
- about 50 MB in 2–10 images as a stress observation only.

Warm each standard case once. For text, URL, and single image, run four pairs each in order `AB`, `BA`, `BA`, `AB`, where A=`none` and B=`sha256`: 12 standard pairs total. Run one 50 MB stress pair. Preserve every failed/retried row.

For the 12 standard pairs:

- every provided source SHA must match the PWA local SHA;
- nearest-rank P90 total sha256 time is the 11th value after sorting and must be at most 8 seconds;
- calculate each pair’s `sha256 - none` increment, sort the 12 increments, and require the 11th to be at most 1 second;
- report median and max per input class, but do not report a pseudo-precise per-class P90 from four pairs;
- any obvious class anomaly or value within ±0.25 seconds of a threshold requires a conservative v1 decision to remove source SHA.

The 50 MB pair is not subject to the 8-second standard-load threshold.

## Per-attempt success and failure

A roundtrip attempt is `PASS` only when all applicable statements are true:

- the shortcut accepted or explicitly rejected the observed representation as designed;
- a success notification appeared only for a complete package;
- `capture.json` is present for success and absent for injected/real pre-manifest failure;
- payload count and order match the top-level inputs;
- the PWA reports `ready`, not a partial preview;
- Unicode/codepoints, URL, or saved image representation match the case expectation;
- source digest fields, if present, match the PWA local digest;
- no production Tenjin data was created;
- the row cites the actual `attemptId` and `captureId`.

Any contradiction is `FAIL`, even if a later retry passes. A case that could not be run or has only simulated evidence is `UNVERIFIED`.

## Cleanup

After all rows and screenshots have been reconciled:

1. Confirm every retained evidence row has its final `captureId` and notes.
2. Copy no private payload into the repository; only CSV facts and redacted screenshots belong in Git.
3. In Files, navigate explicitly to `iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/`.
4. Verify the folder name is exactly `CaptureLogSpike`, not `CaptureLog`.
5. Delete only the disposable `CaptureLogSpike` directory, including orphan payload directories.
6. Leave the shortcut itself until the Stage A decision is reviewed; then delete QA-only failure copies.
7. Do not report cleanup as proof that sync completed.

## Stage A decision boundary

Stage A cannot pass unless direct evidence covers Safari, Photos, Files preview, and one real reading workflow; stable fixed-directory behavior after force-quit/restart; complete iPhone PWA readback; failure without false manifest/success; and explicit support/rejection decisions by type. A reading workflow may be either a useful direct reader representation or a documented reader screenshot → Photos fallback. A fallback PASS never counts as direct reader support. If a required item is `FAIL` or `UNVERIFIED`, the final decision is `NO-GO` or `BLOCKED`, not an automatic transition to Stage B.
