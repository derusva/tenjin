# Capture Inbox Stage A feasibility probe

## Outcome

**Decision: GO for browser-side Tasks 1–5 with the observed constraints below.** This is not a PASS for Stage A overall and is not a PASS for the Task 6 device gate.

The user asked to accelerate after the observations recorded here, so the manual probe stops at this point. Deferred checks are explicitly listed as **NOT YET VERIFIED** rather than treated as passing.

## 2026-07-14 usability correction

The attempted full manifest shortcut required enough manual actions that the user wanted to abandon the flow. This is a failed product-usability result even though the individual Shortcuts actions may be technically viable.

The Stage A path is therefore split:

- keep the target-device-proven `Text(Shortcut Input) → Save File` timestamp-directory probe;
- let the Tenjin browser reader recognise `YYYY-MM/YYYYMMdd-HHmmss-SSS/probe` as a raw capture and generate diagnostic metadata locally;
- retain strict `capture.json` parsing for old structured spike packages;
- do not ask the user to build the variables, repeat loop, dictionaries, hashes, or manifest by hand;
- calibrate the smallest URL/image path separately before claiming those input classes.

This correction solves the proven text-capture pain point without claiming that raw folders have the completion-marker guarantees of a manifest package or that a persistent Inbox import already exists.

## Operator, device, and action vocabulary

| Check | Observed result |
| --- | --- |
| Operator/device availability | An operator and the target iPhone running iOS 26 were available. No personal or device identifiers were recorded. |
| Action discovery | Shortcuts action search used the current English action names. Rendered action labels and results could be localized. |
| Current action names | `Text`, `Get Type`, `Show Content`, and `Save File` were verified. On iOS 26, `Show Content` replaces the old `Show Result` name. |
| Share Sheet | Enabled. |
| Type/result display | `Get Type of Shortcut Input` worked, and `Show Content` displayed its results. |

## Observed Share Sheet input types

These are the types reported by the probe; they should not be generalized beyond the specific source and interaction tested.

| Source and interaction | Observed result |
| --- | --- |
| Safari selected text | `Text` (displayed as `テキスト`). |
| Safari whole page | `Safari Web Page` (displayed as `SafariのWebページ`). |
| Safari webpage image via long press | `URL`, not image bytes. This also occurred for an image whose menu offered Save to Photos. |
| Photos, one local image | `Photo Media` (displayed as `写真メディア`). |
| Photos, two selected images | Two separate `Photo Media` results, separated by a divider, preserving item count and order. |
| Files, `.txt` file | `Text`. |
| Apple Books selected text | The share sheet did not expose the shortcut. Direct Books capture is unsupported; the fallback is screenshot to Photos, then capture from Photos. |

## Save File and dynamic-directory observations

The static-path probe used `Save File` with **Ask Where to Save off**, **Overwrite off**, and path `/Tenjin/CaptureLogSpike/probe.txt`. It created:

`iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/probe.txt`

The file contents were exactly `Tenjin probe`. Because the nested path was created without a separate Create Folder step, this proves that intermediary directories auto-create in the tested flow.

The dynamic-path probe used the `Current Date` special variable with custom format `yyyy-MM/yyyyMMdd-HHmmss-SSS`. It successfully created the month/timestamp capture directory. This is the viable directory-creation flow for the later shortcut build; no explicit Create Folder fallback was needed in this probe.

## Directory decision

- Retain a device-local month shard plus an independent directory for each capture. Multiple payloads and their manifest must remain atomic at the capture-directory boundary.
- Do not add a day directory.
- A timestamp directory is acceptable for v0, but the final build needs a short random suffix because the displayed millisecond component can be `000`.

## Deferred device verification

The following items remain for the later shortcut build and device QA:

| Item | Status |
| --- | --- |
| `capturedAt` UTC formatting, including explicit UTC semantics and the local-month/UTC-boundary case | **NOT YET VERIFIED** |
| Persistence across a Shortcuts/device restart | **NOT YET VERIFIED** |
| Placeholder and failure behavior | **NOT YET VERIFIED** |
| Collision-resistant short suffix | **NOT YET VERIFIED** |

These deferred items prevent this probe from being reported as an overall Stage A PASS or as satisfaction of the Task 6 device gate.
