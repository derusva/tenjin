# Tenjin Capture Spike v0 — iOS 26 build sheet

> **2026-07-14 设计纠正：停止手工搭建下面的 manifest 版本。**
>
> 真机使用已经证明，让用户在快捷指令里配置变量、循环、类型分支和 JSON 会直接破坏“轻量捕获”的产品目标。下面的完整 manifest 配方只保留为工程参考，不再是用户安装步骤。

## Stage A 测试操作者的最小探针（非用户安装步骤）

这段只供能操作目标 iPhone 的测试操作者复现。仓库当前没有可直接安装、已签名的 `.shortcut` 或 iCloud 分享链接；在成品安装资产和真机 Gate 同时通过前，不得把本页交给普通用户作为配置指南。

测试操作者只保留已经验证成功的两个动作：

1. `Text`，内容只放蓝色的 `Shortcut Input`；
2. `Save File`，输入使用上一步 `Text`，根目录为 `Shortcuts`，`Ask Where to Save` 与 `Overwrite If File Exists` 都关闭。

`Save File` 的 Subpath 沿用真机已经成功创建的格式：

```text
/Tenjin/CaptureLogSpike/[Current Date]/probe
```

其中 `Current Date` 直接放在 Subpath 字段内，Custom 格式为：

```text
yyyy-MM/yyyyMMdd-HHmmss-SSS
```

系统生成的目录示例：

```text
iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/
  2026-07/
    20260714-001800-000/
      probe
```

Tenjin 的诊断读取器会把这种时间戳目录识别成 raw capture，在浏览器内生成临时元数据，并继续执行 UTF-8 解码、本地 SHA-256 与预览。手机端不再生成 `capture.json`，也不需要 `Get Type`、`Set Variable`、`Repeat with Each`、`Dictionary` 或手写 JSON。

当前已由真机和网页共同证明的是**选中文字捕获**。URL 与图片仍需分别做最短动作链的真机校准；在校准完成前，不得为了覆盖它们把下面的 manifest 配方重新交给用户手工搭建。

---

## 已停用的完整 manifest 方案（仅工程参考）

## Purpose and evidence boundary

This sheet is the authoring recipe for the disposable Stage A shortcut. It is not evidence that the full shortcut has already been built, imported, or passed on an iPhone. Task 0 proved only the target-device items explicitly marked **D** below. Task 6 must record every remaining device-dependent result before the shortcut can count as a tested build.

The shortcut writes diagnostic packages only under `iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/`. It never writes to the production `CaptureLog`, never creates a Tenjin learning event, and requires no developer account, Xcode project, signing, or native app.

## Current iOS 26 vocabulary

Use the English action search on the target iPhone. The labels in this table have three evidence levels:

- **D — target-device verified:** observed during the Task 0 iOS 26 probe.
- **A — Apple-guide confirmed:** named by the current iOS 26 Shortcuts guide. The target editor must still be checked during Task 6.
- **R — recheck before build:** a concrete search label for the build, but not yet proven on the target iOS 26 editor. Do not silently substitute a different action.

| Name | Kind | Evidence | Required use |
| --- | --- | --- | --- |
| `Text` | action | D | Compose fixed strings, IDs, filenames, and diagnostic responses. |
| `Get Type` | action | D | Record the type of `Repeat Item` exactly as returned. |
| `Show Content` | action | D; also named on the iOS 26 current-actions page | Probe-only inspection. Remove it from the production diagnostic copy. |
| `Save File` | action | D + A | Save payloads and, last, `capture.json`. |
| `Current Date` | special variable, not an action | D | Supply one run-start instant to date formatting. |
| Date formatting UI (`Date Format` → `Custom`) | variable detail UI, not an action | D | Task 0 proved a local custom path format. UTC behavior is still unverified. |
| `Format Date` | action | A | Derive UTC `capturedAt`, local `shardMonth`, and local ID timestamp. |
| `Repeat with Each` | action | A | Process `Shortcut Input` in top-level order. |
| `Repeat Item` | special variable | A | Current top-level input. |
| `Repeat Index` | special variable | A | One-based `inputIndex`. |
| `Repeat Results` | magic variable | A | Ordered list gathered from the final output of every repeat iteration. |
| `Show Notification` | action | A | Announce success only after the manifest save succeeds. |
| `Show Alert` | action | A | Task 6 fallback if a Share Sheet run does not visibly render a `Respond` output. |
| `Stop and Output` | action | A | End ordinary rejection/failure branches with output mode `Respond`. |
| `Stop Shortcut` | action | A | Task 6 fallback termination after a visible failure alert/notification. |

`Stop and Respond` is not an action. It is an option in the top `Shortcut Input` configuration under `If There’s No Input`; Apple documents the option, but its exact target-device presentation must be checked in Task 6. Set its response to `没有收到可测试的内容` if the option is present. Ordinary branches always use `Stop and Output` with `Respond`.

The following exact English search labels are **R** until the Task 6 author finds them on the target editor and records the rendered action name and behavior: `Random Number`, `If`, `Set Variable`, `Get Text from Input`, `Get URLs from Input`, `Set Name`, `Get Details of Files`, `Format Number`, `Dictionary`, `Hash`, and `Get Time Between Dates`. If any label is absent or behaves differently, stop the build and add the difference to QA before editing this recipe.

## Shortcut configuration

| Setting | Value |
| --- | --- |
| Name | `Tenjin Capture Spike v0` |
| Share Sheet | on |
| Accepted input | `Text`, `Rich Text`, `URLs`, `Safari Web Pages`, `Images`, `Files` |
| Other types | reject for Stage A |
| `If There’s No Input` | choose the documented `Stop and Respond` option; Response `没有收到可测试的内容`; verify on target |
| Files root | `Shortcuts` |
| Subpath prefix | `/Tenjin/CaptureLogSpike/` |
| `Ask Where to Save` | off for every `Save File` |
| `Overwrite If File Exists` | off for every `Save File` |

The Task 0 target-device probe proved that `Save File` with root `Shortcuts` and a complete Subpath beginning `/Tenjin/CaptureLogSpike/` creates intermediate folders. Keep that exact root-and-Subpath model. Do not add a separate day directory or a folder-creation workaround. If the formal build behaves differently, stop and record the difference.

Local authoring is not import evidence. `Setup` → `Customise Shortcut` may be used only to inspect future import-question copy; a shared/re-imported installation test belongs to Stage B.

## Package contract

```text
iCloud Drive/
  Shortcuts/
    Tenjin/
      CaptureLogSpike/
        2026-07/
          spike-20260712-123000-000-482731/
            payload-001.txt
            payload-002.png
            capture.json
```

`shardMonth` is the device-local month. The package directory is the v0 `captureId`. A day directory is deliberately omitted. `capture.json` is the completion marker and must be the final file-save action for the package.

The minimal `none` manifest should omit device-dependent optional observations until they are actually obtainable:

```json
{
  "schemaVersion": 0,
  "spikeBuild": 1,
  "captureId": "spike-20260712-123000-000-482731",
  "capturedAt": "2026-07-12T04:30:00.000Z",
  "shardMonth": "2026-07",
  "transport": "ios-shortcut-spike",
  "hashMode": "none",
  "payloads": [
    {
      "payloadId": "payload-001",
      "inputIndex": 1,
      "observedType": "テキスト",
      "previewKind": "text",
      "path": "payload-001.txt"
    }
  ]
}
```

The localized `observedType` above is illustrative of the Task 0 device observation, not a required constant.

## Variables and manifest mapping

| Manifest field | Shortcut source | Inclusion rule |
| --- | --- | --- |
| `schemaVersion` | numeric literal `0` in the final `Dictionary` | required; verify JSON keeps it numeric |
| `spikeBuild` | numeric literal `1` | required; verify JSON keeps it numeric |
| `captureId` | `Text`: `spike-` + local ID timestamp + `-` + six-digit random value | required; v0 only |
| `capturedAt` | `Format Date(runStartedAt)` in explicit UTC using `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` | required; never append `Z` to a local value |
| `shardMonth` | `Format Date(runStartedAt)` in device local time using `yyyy-MM` | required |
| `transport` | fixed text `ios-shortcut-spike` | required |
| `hashMode` | fixed text `none` or `sha256` | required |
| `payloads` | ordered `Repeat Results`, with one payload dictionary as each iteration's final output | required; 1–20 entries |
| `sourceApp` | no proven stable variable | omit by default; never infer from the test case or app under test |
| `payloadId` | `payload-` + `Repeat Index` formatted as three digits | required; confirm `Format Number` search and output in Task 6 |
| `inputIndex` | numeric `Repeat Index` | required; verify JSON keeps it numeric and one-based |
| `observedType` | raw output of `Get Type` on `Repeat Item` | required; preserve the localized string exactly |
| `previewKind` | chosen representation category: `text`, `url`, or `image` | required; routing remains a Task 6 calibration |
| `path` | actual package-relative name passed to `Save File` | required |
| `originalName` | final saved-file detail | omit from the first `none` build; a later evidence build may add it only after target proof |
| `mediaType` | final saved-file MIME observation | omit from the first `none` build; never infer from extension |
| `sourceByteLength` | integer byte count of the final saved representation | omit from the first `none` build; never copy a formatted size |
| `sourceSha256` | lowercase 64-hex digest of final saved file | sha256 variant only; Task 6 calibration required |
| `sourceHashDurationMs` | finite non-negative milliseconds around that hash | sha256 variant only; Task 6 calibration required |

### Locale-sensitive type rule

`Get Type` display strings are localized. Task 0 observed Japanese values such as `テキスト`, `SafariのWebページ`, and `写真メディア`. Save the raw result as `observedType`, but do **not** route by hard-coded English strings.

Before authoring the representation branches, Task 6 must find and demonstrate a non-string, content-type-aware `If` predicate on `Repeat Item`. If the target editor exposes only string comparison, record the exact localized values and the portability limitation; do not call the build complete until the routing decision is reviewed. `Get Type` is an observation, not a locale-stable enum.

## Build sequence — `none`

The following is the exact data flow. Every item marked **R** must be search-verified on the target before continuing.

1. Insert the `Current Date` special variable once and, after confirming the **R** `Set Variable` label on the target, immediately freeze that value as `runStartedAt`. Do not reference a newly evaluated `Current Date` for `capturedAt`, `shardMonth`, or ID creation.
2. Add `Format Date` three times, with all three inputs referencing the same frozen `runStartedAt` variable:
   - explicit time zone UTC; Custom `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`; save output as `capturedAt`;
   - input `runStartedAt`; device local time; Custom `yyyy-MM`; save as `shardMonth`;
   - input `runStartedAt`; device local time; Custom `yyyyMMdd-HHmmss-SSS`; save as `idTimestamp`.
3. Add **R** `Random Number` with minimum `100000` and maximum `999999`. Use `Text` to form `spike-[idTimestamp]-[random]`; save as `captureId`. This random suffix is not verified until Task 6 runs two same-second captures and sees separate six-digit directories. It is only the disposable spike ID; v1 retains the PRD UUID decision.
4. Add `Repeat with Each` over `Shortcut Input`. Inside the loop, use `Repeat Item` and numeric `Repeat Index`.
5. Format `Repeat Index` as three digits after confirming **R** `Format Number`; use `Text` to form `payload-NNN`.
6. Add `Get Type` with input `Repeat Item`. Store its unmodified output as `observedType`. Do not translate or use an English literal for routing.
7. Route `Repeat Item` with the non-string type method proved during Task 6:
   - text or rich text: after confirming **R** `Get Text from Input`, save its exact output as `payload-NNN.txt`; `previewKind = text`;
   - URL or Safari web page: after confirming **R** `Get URLs from Input`, select the one URL belonging to that top-level item, then confirm **R** `Get Text from Input` preserves the URL string; save as `payload-NNN.url`; `previewKind = url`;
   - image: preserve the representation that Shortcuts ultimately passes to `Save File` and derive its actual extension without guessing; use **R** `Set Name` to set `payload-NNN.<actual extension>`; `previewKind = image`. Do not call it the source app's original bytes;
   - `Files`: accept only when the real representation can be routed into one of the three paths above. PDF, video, unknown, or extensionless image data is rejected.
8. Every rejection branch uses `Text` for a specific response followed by `Stop and Output` with output mode `Respond`. Example: `不支持此输入类型；未写入 capture.json`.
9. Use `Save File` on the selected representation. Root stays `Shortcuts`; Subpath is `/Tenjin/CaptureLogSpike/[shardMonth]/[captureId]/[payload filename]`; both prompts remain off. The return value and error behavior of `Save File` are **not yet verified** and must be recorded in Task 6.
10. The first `none` build omits `sourceApp`, `mediaType`, `originalName`, and `sourceByteLength`. Separately search-verify **R** `Get Details of Files` on the value returned by `Save File`; only a later evidence build may add fields whose meanings the target proves. A filename extension is not MIME evidence; a human-readable `12 KB` value is not an integer byte count.
11. Build the payload `Dictionary` with required fields and make that dictionary the **final output of the repeat iteration**. Do not place another action after it inside the loop. Do not add unavailable optional keys with `null` or empty placeholders.
12. End the repeat. Use the Apple-defined `Repeat Results` magic variable as the ordered payload list. Confirm that 2–10 Photos inputs produce the same order as `Repeat Index` before proceeding.
13. Build the manifest `Dictionary` only after all payload saves finish. Put `Repeat Results` into `payloads` as the JSON array.
14. Convert the manifest dictionary to JSON with the target-verified dictionary-to-text chain. The provisional candidate is **R** `Get Text from Input` on the manifest `Dictionary`; Task 6 must prove it emits valid JSON with numeric `0`, numeric `1`, an array in order, localized Unicode preserved, omitted optional keys truly absent, no inserted `null`, UTF-8 without BOM, and a parser-acceptable line-ending form. If any property fails, stop and revise the documented chain before saving.
15. Use **R** `Set Name` to name the JSON text `capture.json`, then `Save File` to `/Tenjin/CaptureLogSpike/[shardMonth]/[captureId]/capture.json`, with both prompts off.
16. Only after the manifest `Save File` returns without error, add `Show Notification` with `已写入测试包 [short captureId]`. Confirm the actual `Save File` success/error behavior in Task 6; action adjacency alone is not proof. This notification means only that the local Files action returned successfully. It does not prove that iCloud upload has completed.

## `sha256` copy: the only allowed differences

Duplicate the working `none` shortcut. Apart from its visible diagnostic name, only these data-flow differences are allowed:

1. top-level `hashMode` changes from `none` to `sha256`;
2. after each payload `Save File`, hash the final saved file, not the pre-save input;
3. each payload dictionary adds both `sourceSha256` and `sourceHashDurationMs`;
4. the timing and hash actions exist only in this copy.

The exact target actions are **R**. Search for `Hash` and `Get Time Between Dates`, and record the actual English labels, SHA-256 option, file-input behavior, output representation, and time unit. Surround only the hash with two date instants, convert the difference to non-negative milliseconds, and normalise the digest only if the target proves a deterministic lowercase 64-hex conversion. If the target cannot measure sub-second duration, the source timing path is unsupported; never write a guessed `0`.

Before any package run, hash the UTF-8 bytes of `abc`. The sha256 copy is invalid unless the result is exactly:

```text
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
```

If the target has no working file SHA-256 path, record it as unsupported. Do not add a network hash service or fabricate digest/timing fields.

## Manifest-last and failure branches

The action order is payload `Save File` → payload `Dictionary` as the iteration's final output → `Repeat Results` after all repeats complete → manifest JSON conversion → manifest `Save File` → `Show Notification`.

That order is necessary but not sufficient evidence. `capture.json` is a non-transactional completion marker: an interrupted run may leave orphan payload files, but it must not leave a manifest. In Task 6, duplicate the `none` shortcut into a temporary failure-injection copy, place `Stop and Output` (`Respond`) immediately after the first payload save, and run it with at least two inputs. PASS requires:

- the first payload may exist in an incomplete directory;
- `capture.json` does not exist;
- the success notification does not appear;
- the PWA never reports the incomplete directory as ready.

Keep the failed attempt in QA. Do not reuse or overwrite its `captureId`.

| Condition | Required branch |
| --- | --- |
| no input | top `Shortcut Input` setting uses the documented `Stop and Respond` option; this is not an action |
| unsupported or ambiguous type | `Text` explanation → `Stop and Output` with `Respond`; no manifest or success notification |
| unable to derive a real image extension | same rejection path; do not guess |
| payload save, permission, or cancellation error | no success notification; confirm actual system propagation in Task 6 |
| JSON conversion mismatch | `Stop and Output` with `Respond`; do not save `capture.json` |
| manifest save error | no success notification |
| complete package | manifest saved last, then `Show Notification` |

Task 6 must also verify whether `Stop and Output` with `Respond` is actually visible when invoked from the Share Sheet. If it is not visible, record that result before changing UX. The allowed visible fallback is `Show Alert` followed by `Stop Shortcut`, or a failure `Show Notification` followed by `Stop Shortcut`; never allow either fallback to reach the success notification or manifest save.

## Task 6 authoring gate

Before calling either shortcut built, attach an evidence row or QA note for each item:

- exact English search result for every **R** label;
- explicit UTC formatting and a local-month/UTC-boundary case;
- six-digit random suffix and two same-second non-colliding directories;
- non-string type routing, or an explicit reviewed block if unavailable;
- `Save File` return/error behavior;
- actual file extension discovery;
- dictionary-to-JSON numeric/array/Unicode/omission/BOM/line-ending behavior;
- ordered multi-image payload list;
- manifest-last failure injection and absent success notification;
- optional file details only if their meaning is proven;
- `abc` digest and file hash/timing behavior for the sha256 copy.

## Official references

- [What’s new in Shortcuts for iOS, iPadOS, macOS, watchOS, and visionOS 26](https://support.apple.com/125148)
- [About date and time formatting in Shortcuts](https://support.apple.com/guide/shortcuts/apd71b0ac246/ios)
- [Understanding input types in Shortcuts](https://support.apple.com/guide/shortcuts/apd7644168e1/ios)
- [Configure the Shortcut Input action](https://support.apple.com/en-euro/guide/shortcuts/apd8195f96d6/ios)
- [Add import questions to shared shortcuts](https://support.apple.com/guide/shortcuts/apdf330fd3a0/ios)
- [Use Repeat actions](https://support.apple.com/guide/shortcuts/apdc11deb2c1/ios)
- [Share shortcuts](https://support.apple.com/guide/shortcuts/apdf01f8c054/ios)
- [Shortcut completion: Stop and Output](https://support.apple.com/guide/shortcuts/apda9578f70f/ios)
