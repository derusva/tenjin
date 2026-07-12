# Tenjin Capture Inbox Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 用可废弃的 schemaVersion: 0 证明目标 iPhone（iOS 26）分享菜单能够把文字、URL、单图和多图完整写入独立 iCloud 目录，并由同一设备上的主屏 Tenjin PWA 重新选择目录、整包读回和安全预览；本阶段不声称旧版 iOS 兼容。

**Architecture:** 阶段 A 使用独立的 CaptureLogSpike 目录、独立 Vite HTML 入口和只读文件解析模块。诊断入口的依赖树不导入 Tenjin repository、ledger runtime 或 storage persistence；它只接收用户当次选择的 FileList，在内存中验证 1–3 个 v0 包、计算本地 SHA-256 并渲染结果。iOS 快捷指令是一次性真机 spike，不是正式 Capture Package 生产者；所有真机事实记录到 QA 证据文件，不能由 jsdom 或桌面模拟替代。

**Tech Stack:** TypeScript 5、React 19、Vite 7、Vitest、Testing Library、Web Crypto、iOS 26 Shortcuts、iCloud Drive、GitHub Pages。

## Global Constraints

- 只实施 PRD 的阶段 A；不得创建正式 Inbox、v1 导入器、ImportLedger、IndexedDB schema、OCR、GPT、原生 App、CloudKit 或阶段 B/C 功能。
- v0 是可废弃诊断协议，只写 iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike/<本地 YYYY-MM>/<captureId>/；不得读取或污染正式 CaptureLog。
- 月份语义严格沿用冻结 PRD §8.1：capturedAt 是 UTC 事实时间，shardMonth/目录是捕获设备本地日历月份；跨 UTC 月界时二者月份可以不同，这不是 v0 特例。
- capture-spike.html 的模块依赖树不得导入 @tenjin/storage-indexeddb、openLedgerRepository、requestStoragePersistence、ledger runtime 或调用 IndexedDB。
- 诊断页只在内存中读取用户当次选择的目录；刷新或离开页面即丢弃结果。
- 任一 manifest 引用的 payload 缺失或不可读时，整包显示“暂不可用”，不得展示部分 payload，也不得生成任何正式记录。
- 文字和 URL 必须按 UTF-8 原字节解码；不得 trim、规范化 Unicode、统一换行或解码百分号。
- 页面只用 React 文本节点、pre 和 img 渲染；不得使用 innerHTML，不把捕获到的 URL 自动变成可点击链接。
- 生产行为必须先写失败测试，再做最小实现；每个任务只提交列出的文件。
- 真机测试只用无敏感、可公开、可删除的材料；QA 不记录 Apple ID、公司名、私有路径或真实学习资料。
- jsdom、桌面 Safari/Chrome 和人工构造缺文件只能验证代码防线，不能冒充 iCloud placeholder、分享菜单 Content Graph、目录授权或重启后的真机证据。
- HANDOFF.md 的现有修改与未跟踪的 CROSS-REVIEW.md 属于用户，不得编辑、清理或加入任何提交。
- 本计划文件必须在开始 Task 0 前已单独提交。用户已要求本项目直接走 main；每次 push 前仍须验证当前分支确为 main、HEAD 含本轮提交且 origin 指向预期 tenjin 仓库，不能从其他分支误推本地 main。
- 阶段 A 通过只允许形成“是否建议进入 B”的证据；不得自动开始阶段 B。

---

### Task 0: 先做 Apple 设备最小可行性关卡

**Files:**

- Create after real probe: docs/qa/capture-inbox-stage-a/feasibility-probe.md

**Operator boundary:**

- 执行实现的人负责在 Shortcuts 编辑器中搭建动作；终端用户只负责分享测试材料、点运行和确认结果。
- 若当前执行者无法操作任何 iPhone/Mac Shortcuts 编辑器，不得把 20 多个编辑动作临时转嫁给用户；先说明依赖并取得一次引导式设备会话的明确同意。无人承担编辑器操作时，Stage A 在写 Web 代码前即为 blocked。
- 本任务只做 10–15 分钟、约 7 个动作的 probe，不创建完整 manifest，不做 SHA，不做 60 次性能运行。

**Minimal probe:**

1. 新建 Tenjin Capture Spike Probe，显示在 Share Sheet，输入先设为 Any。
2. Save File 保持系统显示的 Shortcuts 根目录；这不是 Import Question 安装测试。
3. Current Date 使用自定义格式 yyyy-MM/yyyyMMdd-HHmmss-SSS，生成本地动态路径片段。
4. Get Type of Shortcut Input，并用 iOS 26 当前动作 Show Content 显示系统报告类型。
5. 把一次无敏感纯文本输入转成 UTF-8 文本，Save File 的 Ask Where to Save 与 Overwrite If File Exists 都关闭；先验证固定 Subpath /Tenjin/CaptureLogSpike/probe.txt，再验证动态 Subpath /Tenjin/CaptureLogSpike/<month>/<timestamp>/probe.txt。

- [ ] **Step 1: 确认 Apple 设备操作者**

  在 feasibility-probe.md 记录“操作者可用 / 不可用”和设备大类，不记录姓名、Apple ID、公司或序列号。不可用则停止，结论为 BLOCKED。

- [ ] **Step 2: 验证动态中间目录行为**

  先测试 Save File 是否会从 Shortcuts 根目录创建 /Tenjin/CaptureLogSpike/<month>/<timestamp> 中间目录；若不会，再显式加入 Create Folder 创建所需目录后重试。把真实可行动作流写入 feasibility-probe.md，后续 build sheet 必须采用该流。随机后缀不在本 probe 冒充已验证，留到 Task 6。

- [ ] **Step 3: 快速查看真实输入类型**

  各运行一次 Safari 选区、Safari URL、Photos 单图、目标阅读器的一项分享和 Files preview；只记录 Get Type 并由 Show Content 显示的真实结果，不尝试在 probe 内泛化保存所有表示。

- [ ] **Step 4: 记录 UTC/本地月界状态**

  若本次 probe 继续进行，则用临时固定 Date 动作构造本地月初 00:30 的样本；确认 capturedAt 对应前一个 UTC 日/月，而 shardMonth 仍是设备本地月份。若用户选择先结束手机验证，则在 feasibility-probe.md 标为 NOT YET VERIFIED，并把它保留为 Task 6 前的硬门；任何时候都不得把本地时间直接追加 Z。

- [ ] **Step 5: 记录 GO/BLOCKED**

  动态目录可写、至少一种输入类型可观察且操作者愿意完成一次后续 build 会话时，可给出 GO-BROWSER，只允许继续不写 iCloud 的浏览器侧 Tasks 1–5。UTC、重启、placeholder、失败反馈或随机后缀任一未验证时，不得把 Task 0 写成整体 PASS，也不得通过 Task 6 或 Stage A。

- [ ] **Step 6: 仅提交真实 probe 结论**

    git add docs/qa/capture-inbox-stage-a/feasibility-probe.md
    git commit -m "docs(qa): record capture spike feasibility probe"

---

### Task 1: 冻结可废弃的 v0 诊断契约

**Files:**

- Create: apps/web/src/features/capture-spike/captureSpikeV0.ts
- Create: apps/web/src/features/capture-spike/captureSpikeV0.test.ts
- Create: apps/web/src/features/capture-spike/test/createSpikeFiles.ts

**Interfaces:**

    export type SpikePreviewKind = "text" | "url" | "image";
    export type SpikeHashMode = "none" | "sha256";

    export interface CaptureSpikePayloadV0 {
      readonly payloadId: string;
      readonly inputIndex: number;
      readonly observedType: string;
      readonly previewKind: SpikePreviewKind;
      readonly path: string;
      readonly mediaType?: string;
      readonly originalName?: string;
      readonly sourceByteLength?: number;
      readonly sourceSha256?: string;
      readonly sourceHashDurationMs?: number;
    }

    export interface CaptureSpikeManifestV0 {
      readonly schemaVersion: 0;
      readonly spikeBuild: 1;
      readonly captureId: string;
      readonly capturedAt: string;
      readonly shardMonth: string;
      readonly transport: "ios-shortcut-spike";
      readonly hashMode: SpikeHashMode;
      readonly sourceApp?: string;
      readonly payloads: readonly CaptureSpikePayloadV0[];
    }

    export type SpikeManifestIssueCode =
      | "manifest-too-large"
      | "manifest-invalid-utf8"
      | "unexpected-utf8-bom"
      | "manifest-invalid-json"
      | "manifest-unknown-field"
      | "unsupported-schema-version"
      | "unsupported-spike-build"
      | "invalid-capture-id"
      | "invalid-captured-at"
      | "invalid-shard-month"
      | "invalid-payload"
      | "payload-unknown-field"
      | "duplicate-payload-id"
      | "duplicate-payload-path"
      | "duplicate-input-index"
      | "unsafe-payload-path"
      | "invalid-source-length"
      | "invalid-source-digest";

    export interface SpikeManifestIssue {
      readonly code: SpikeManifestIssueCode;
      readonly fieldPath?: string;
    }

    export type ParseCaptureSpikeManifestResult =
      | { readonly ok: true; readonly value: CaptureSpikeManifestV0 }
      | { readonly ok: false; readonly issues: readonly SpikeManifestIssue[] };

    export function parseCaptureSpikeManifestV0(
      bytes: ArrayBuffer,
    ): ParseCaptureSpikeManifestResult;

**v0 validation boundary:**

- capture.json 最大 256 KB；必须是 fatal UTF-8 和单个 JSON object。
- manifest、text 和 URL 都拒绝 UTF-8 BOM；解码后重新编码的字节必须与输入完全相同。
- 只接受 schemaVersion 0、spikeBuild 1 和 transport ios-shortcut-spike。
- captureId 必须匹配 v0 专用格式 spike-YYYYMMDD-HHmmss-SSS-NNNNNN；capturedAt 必须是带 Z 的真实 RFC 3339 UTC 日历时间；shardMonth 必须是 01–12 月的 YYYY-MM。该格式只服务可废弃 spike，不替代 v1 UUID。
- v0 每个顶层 Share Sheet 输入只保存一个用于往返的表示；payloads 为 1–20 项，payloadId、path 和 inputIndex 各自唯一，inputIndex 是从 1 开始的安全整数。Content Graph 中的其他表示只写 QA，不伪装成已保存 payload。
- path 必须是包内相对路径；拒绝绝对路径、反斜杠、NUL、空段、点段和 ..。
- 顶层和每个 payload 都使用严格字段白名单；未知字段一律拒绝，等价于 additionalProperties: false。
- mediaType 是可选观测字段；Shortcuts 真机取不到就省略，不能猜测。字段存在时 previewKind 兼容表固定为：text 只接受 text/plain；url 接受 text/plain 或 text/uri-list；image 接受 image/*。比较 MIME 基础类型时忽略合法 charset 参数。
- parser 只校验 sourceByteLength 是非负安全整数；PWA reader 实读后若发现不一致，整包无效。
- sourceSha256 存在时必须是 64 位小写十六进制且 hashMode 为 sha256；hashMode 为 none 时不得伪造 sourceSha256 或 sourceHashDurationMs。
- sourceHashDurationMs 存在时必须是非负有限数，并且 sourceSha256 同时存在。
- hashMode 为 sha256 时，每个 payload 都必须同时提供 sourceSha256 和 sourceHashDurationMs；不能产生完整字段就不生成 sha256 包。
- sourceApp 只有真机能稳定取得时才写；不得把“快捷指令”或手填 App 名称冒充来源身份。
- 这是 v0 防御性解析，不得抽象成候选 v1 schema 或加入 kind、role、ImportLedger 等正式概念。

- [ ] **Step 1: 写 manifest 成功解析的失败测试**

  用 createSpikeFiles.ts 构造一个日文 text payload 和一个 PNG payload；断言 manifest 的 payload 数组顺序完整保留，且未知顶层字段、错误 schemaVersion 和空 payloads 被拒绝。

- [ ] **Step 2: 写日期、v0 captureId、路径和摘要约束的失败测试**

  覆盖非 UTC capturedAt、2 月 30 日、13 月 shardMonth、UUID 或缺位数等非法 v0 captureId、路径穿越、重复 payloadId、重复 path、重复 inputIndex、hashMode none 搭配 sourceSha256、sha256 缺 hash/duration、非 64 位 SHA、UTF-8 BOM。mediaType 缺失必须合法；URL 的 text/plain/text/uri-list 都合法；image 搭配 text/plain 必须拒绝。

- [ ] **Step 3: 运行定点测试，确认因实现缺失而失败**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike/captureSpikeV0.test.ts

  Expected: exit code 1；失败原因是 captureSpikeV0 模块或目标导出尚不存在，而不是测试语法错误。

- [ ] **Step 4: 实现最小解析器和测试工厂**

  parseCaptureSpikeManifestV0 只做 v0 结构校验并返回稳定 issue code；至少定义：

    manifest-too-large
    manifest-invalid-utf8
    unexpected-utf8-bom
    manifest-invalid-json
    manifest-unknown-field
    unsupported-schema-version
    unsupported-spike-build
    invalid-capture-id
    invalid-captured-at
    invalid-shard-month
    invalid-payload
    duplicate-payload-id
    duplicate-payload-path
    duplicate-input-index
    unsafe-payload-path
    invalid-source-length
    invalid-source-digest

- [ ] **Step 5: 运行测试与 typecheck**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike/captureSpikeV0.test.ts
    pnpm --filter @tenjin/web typecheck

  Expected: 两条命令 exit code 0。

- [ ] **Step 6: 仅提交本任务文件**

    git add apps/web/src/features/capture-spike/captureSpikeV0.ts apps/web/src/features/capture-spike/captureSpikeV0.test.ts apps/web/src/features/capture-spike/test/createSpikeFiles.ts
    git commit -m "test(spike): define disposable capture v0 contract"

---

### Task 2: 实现整包目录读取、错误分类和本地摘要

**Files:**

- Create: apps/web/src/features/capture-spike/captureSpikeReader.ts
- Create: apps/web/src/features/capture-spike/captureSpikeReader.test.ts
- Modify: apps/web/src/features/capture-spike/test/createSpikeFiles.ts

**Interfaces:**

    export interface SelectedSpikeFile {
      readonly file: File;
      readonly relativePath: string;
    }

    export interface CaptureSpikeReaderDependencies {
      readonly readArrayBuffer: (file: File) => Promise<ArrayBuffer>;
      readonly sha256: (bytes: ArrayBuffer) => Promise<string>;
      readonly now: () => number;
    }

    export type SpikeReadIssueDisposition =
      | "invalid-selection"
      | "temporarily-unavailable"
      | "invalid-package";

    export type SpikeReadIssueCode =
      | SpikeManifestIssueCode
      | "relative-path-unavailable"
      | "duplicate-selected-relative-path"
      | "manifest-read-unavailable"
      | "shard-month-path-mismatch"
      | "payload-missing"
      | "payload-read-unavailable"
      | "payload-invalid-utf8"
      | "source-byte-length-mismatch"
      | "source-digest-mismatch"
      | "local-digest-unavailable";

    export interface SpikeReadIssue {
      readonly disposition: SpikeReadIssueDisposition;
      readonly code: SpikeReadIssueCode;
      readonly relativePath?: string;
      readonly errorName?: string;
      readonly retryable: boolean;
    }

    export type SpikePayloadPreview =
      | {
          readonly kind: "text";
          readonly payloadId: string;
          readonly inputIndex: number;
          readonly observedType: string;
          readonly sourceMediaType?: string;
          readonly browserMediaType?: string;
          readonly text: string;
          readonly actualByteLength: number;
          readonly localSha256: string;
          readonly localHashDurationMs: number;
          readonly sourceDigestMatches?: boolean;
        }
      | {
          readonly kind: "url";
          readonly payloadId: string;
          readonly inputIndex: number;
          readonly observedType: string;
          readonly sourceMediaType?: string;
          readonly browserMediaType?: string;
          readonly rawUrl: string;
          readonly actualByteLength: number;
          readonly localSha256: string;
          readonly localHashDurationMs: number;
          readonly sourceDigestMatches?: boolean;
        }
      | {
          readonly kind: "image";
          readonly payloadId: string;
          readonly inputIndex: number;
          readonly observedType: string;
          readonly file: File;
          readonly sourceMediaType?: string;
          readonly browserMediaType?: string;
          readonly actualByteLength: number;
          readonly localSha256: string;
          readonly localHashDurationMs: number;
          readonly sourceDigestMatches?: boolean;
        };

    export type SpikePackageResult =
      | {
          readonly status: "ready";
          readonly packagePath: string;
          readonly manifest: CaptureSpikeManifestV0;
          readonly payloads: readonly SpikePayloadPreview[];
        }
      | {
          readonly status: "temporarily-unavailable";
          readonly packagePath: string;
          readonly manifest?: CaptureSpikeManifestV0;
          readonly issues: readonly SpikeReadIssue[];
        }
      | {
          readonly status: "invalid";
          readonly packagePath: string;
          readonly issues: readonly SpikeReadIssue[];
        };

    export interface SpikeDirectoryResult {
      readonly packages: readonly SpikePackageResult[];
      readonly ignoredWithoutManifest: readonly string[];
      readonly truncatedPackageCount: number;
      readonly selectionIssues: readonly SpikeReadIssue[];
    }

    export function snapshotSelectedFiles(
      files: FileList,
    ): readonly SelectedSpikeFile[];

    export async function readCaptureLogSpikeDirectory(
      files: readonly SelectedSpikeFile[],
      dependencies: CaptureSpikeReaderDependencies,
      options?: { readonly maxPackages?: 1 | 2 | 3 },
    ): Promise<SpikeDirectoryResult>;

**Reader rules:**

- change 事件发生时立即快照 File 和 webkitRelativePath；空 relativePath 不得退化成 file.name。
- 相同 webkitRelativePath 出现两次时返回 duplicate-selected-relative-path，不用 FileList 后项静默覆盖前项。
- 以每个 capture.json 的父目录作为包边界；按相对路径排序，默认最多读 3 个包并报告截断数量。
- 只按 manifest.payloads 顺序输出，不信任 FileList 顺序。
- manifest 的 shardMonth 必须与其月份父目录一致。
- 无 manifest 的半成品目录列入 ignoredWithoutManifest，不当作成功包。
- manifest 可读但引用文件未枚举，或 File.arrayBuffer 抛出 NotReadableError、NotFoundError、AbortError、SecurityError、NotAllowedError 时，整包为 temporarily-unavailable。
- 未知文件读取异常也保持可重试 unavailable；不能把可能的 iCloud 文件提供器问题误判为内容损坏。
- JSON、schema、路径、fatal UTF-8、摘要不符属于 invalid。
- text 和 url 用 new TextDecoder("utf-8", { fatal: true })，保留首尾空白、CRLF/LF、组合字符和百分号编码。
- text 和 url 解码后必须用 TextEncoder 重新编码并逐字节等于输入；UTF-8 BOM 或任何不可逆表示返回 unexpected-utf8-bom / payload-invalid-utf8。
- 每个 payload 顺序读取、顺序计算 SHA，避免并行复制多个 10–50 MB buffer。
- sourceByteLength 或 sourceSha256 存在时分别与实读字节数和本地 SHA 比较；任一不一致则整包 invalid，不能只在 UI 上警告后继续。
- Web Crypto/本地 SHA 失败返回可重试的 local-digest-unavailable，不把来源包判为损坏。
- image 返回原 File；对象 URL 不在 reader 中创建。

- [ ] **Step 1: 写分包和顺序的失败测试**

  覆盖选择月份目录、乱序 FileList、1–3 个包、4 个包截断、多个无 manifest 半成品目录，以及 manifest 顺序覆盖文件枚举顺序。加入跨 UTC/本地月界 fixture：capturedAt 为 2026-06-30T16:30:00.000Z，shardMonth/目录为设备本地 2026-07，必须合法读回。

- [ ] **Step 2: 写日文与 Unicode 原样往返的失败测试**

  精确字节覆盖：

    漢字・ひらがな・カタカナ　全角空格
    𠮷 / ｶﾀｶﾅ / Ｔｅｎｊｉｎ / 👩‍💻
    が 与 か + U+3099
    首尾空白、LF、CRLF、多段落
    https://example.com/日本語?q=%E5%AD%A6%E7%BF%92&x=100%25

  CRLF 用 Uint8Array 构造，不依赖 Git 工作树换行。断言 text/rawUrl 逐字符相同，而且重新 UTF-8 编码后的 bytes 与输入逐字节相同；另测 UTF-8 BOM 被明确拒绝。

- [ ] **Step 3: 写不可用、非法和摘要的失败测试**

  覆盖 relativePath 缺失/重复、manifest 引用文件缺失、manifest 自身读取失败、payload 读取 reject、坏 JSON、路径穿越、源字节数不符、摘要不符和本地 SHA 失败。断言任一 payload 不可用时不返回任何 ready payload，并断言读取问题、包内容问题和本地诊断能力问题的 disposition/code 不混淆。

- [ ] **Step 4: 写 SHA 和计时依赖的确定性测试**

  注入固定 sha256 和 now 序列；断言 actualByteLength、localSha256、localHashDurationMs 以及 sourceDigestMatches。

- [ ] **Step 5: 运行定点测试，确认失败**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike/captureSpikeReader.test.ts

  Expected: exit code 1，目标 reader 导出缺失。

- [ ] **Step 6: 实现最小 reader**

  不导入 @tenjin/core 或 @tenjin/storage-indexeddb；只依赖 captureSpikeV0.ts 和浏览器 File/Web Crypto 兼容接口。

- [ ] **Step 7: 运行 capture spike 测试和 typecheck**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike/captureSpikeV0.test.ts src/features/capture-spike/captureSpikeReader.test.ts
    pnpm --filter @tenjin/web typecheck

  Expected: exit code 0。

- [ ] **Step 8: 仅提交本任务文件**

    git add apps/web/src/features/capture-spike/captureSpikeReader.ts apps/web/src/features/capture-spike/captureSpikeReader.test.ts apps/web/src/features/capture-spike/test/createSpikeFiles.ts
    git commit -m "feat(spike): read capture log packages without persistence"

---

### Task 3: 构建不持久化的诊断读取页

**Files:**

- Create: apps/web/src/features/capture-spike/captureSpikeBrowser.ts
- Create: apps/web/src/features/capture-spike/captureSpikeBrowser.test.ts
- Create: apps/web/src/features/capture-spike/CaptureSpikeDiagnostic.tsx
- Create: apps/web/src/features/capture-spike/CaptureSpikeDiagnostic.test.tsx
- Modify: apps/web/src/styles/app.css

**UI contract:**

- 页面标题：捕获链路诊断
- 显著说明：仅用于阶段 A；不会导入，也不会保存到 Tenjin。
- 主动作：选择 CaptureLogSpike 月份目录
- 状态：未选择、正在读取、ready、暂不可用、无效、已截断。
- ready 包显示 captureId、capturedAt、sourceApp 或“来源身份未提供”、hashMode、payload 顺序、observedType、源端/浏览器 mediaType（缺失时明确显示“未提供”）、字节数、本地 SHA、源端摘要比较和预览。
- unavailable 包不得显示已成功读取的 sibling payload。payload-missing/payload-read-unavailable 可提示“文件暂不可读，可能仍在 iCloud 下载”；local-digest-unavailable 只能提示“本机摘要计算暂不可用，请重试”，权限/选择问题使用各自文案，不能都归因于 iCloud。
- invalid 包显示稳定错误码和安全中文解释；不得渲染原始 HTML。
- 页面提供“返回 Tenjin”相对链接。

**Component boundary:**

    export interface CaptureSpikeDiagnosticProps {
      readonly ledgerHref: string;
      readonly readerDependencies: CaptureSpikeReaderDependencies;
      readonly inspect?: typeof readCaptureLogSpikeDirectory;
    }

    export function createBrowserCaptureSpikeReaderDependencies(): CaptureSpikeReaderDependencies;

captureSpikeBrowser.ts 负责 File.arrayBuffer、crypto.subtle.digest("SHA-256") 到 64 位小写十六进制的转换，以及 performance.now；组件不隐式猜测依赖，测试注入确定性 adapter。

- [ ] **Step 1: 写浏览器 adapter 的失败测试**

  用 UTF-8 abc 已知向量断言 Web Crypto 输出 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad，并断言 adapter 使用 File.arrayBuffer 和单调时钟。

- [ ] **Step 2: 写目录 input 和状态流的失败测试**

  断言 input 为 type=file、multiple，并通过 callback ref 设置 webkitdirectory 属性；选择目录后先显示“正在读取”，再显示包级结果。

- [ ] **Step 3: 写整包不可用和安全文本渲染的失败测试**

  inspect 返回 temporarily-unavailable 时，页面不得出现任何 payload preview。分别断言 payload-read-unavailable 提示可能的 iCloud 下载，local-digest-unavailable 不提 iCloud。使用包含 script 标签的文本 fixture，断言它只显示为文字且 DOM 中没有注入 script。

- [ ] **Step 4: 写图片对象 URL 生命周期的失败测试**

  spy URL.createObjectURL 和 URL.revokeObjectURL；断言重新选择目录会撤销旧 URL，组件卸载会撤销剩余 URL。

- [ ] **Step 5: 写重新选择和空选择的失败测试**

  第二次选择必须替换第一次结果而非合并；取消选择保持可恢复状态且不抛异常。

- [ ] **Step 6: 运行组件测试，确认失败**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike/CaptureSpikeDiagnostic.test.tsx

  Expected: exit code 1，组件尚不存在。

- [ ] **Step 7: 实现 browser adapter、最小组件和局部样式**

  使用现有 app-shell、app-main、utility-view、state-view、secondary-action 和 design tokens。新增类名必须以 capture-spike- 开头；390px 宽无横向滚动，长路径和 SHA 使用 overflow-wrap:anywhere。

- [ ] **Step 8: 运行组件、reader、typecheck 和 lint**

    pnpm --filter @tenjin/web exec vitest run src/features/capture-spike
    pnpm --filter @tenjin/web typecheck
    pnpm lint

  Expected: 全部 exit code 0。

- [ ] **Step 9: 仅提交本任务文件**

    git add apps/web/src/features/capture-spike/captureSpikeBrowser.ts apps/web/src/features/capture-spike/captureSpikeBrowser.test.ts apps/web/src/features/capture-spike/CaptureSpikeDiagnostic.tsx apps/web/src/features/capture-spike/CaptureSpikeDiagnostic.test.tsx apps/web/src/styles/app.css
    git commit -m "feat(spike): add capture log diagnostic page"

---

### Task 4: 增加与正式账本隔离的 Vite 入口

**Files:**

- Create: apps/web/capture-spike.html
- Create: apps/web/src/capture-spike-main.tsx
- Modify: apps/web/vite.config.ts
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/App.test.tsx

**Entry architecture:**

    capture-spike.html
      -> capture-spike-main.tsx
      -> CaptureSpikeDiagnostic.tsx
      -> captureSpikeReader.ts
      -> captureSpikeV0.ts

该依赖树不经过 main.tsx、App.tsx、repository、ledger runtime 或 storage persistence。capture-spike-main.tsx 只注册现有 service worker、载入 tokens/app.css、创建 React root、调用 createBrowserCaptureSpikeReaderDependencies()，并把 adapter 显式传给诊断页。

- [ ] **Step 1: 在 App.test.tsx 写数据页入口失败测试**

  保持底部导航仍严格为“记录 / 复习 / 搜索 / 数据”；进入数据页后存在“打开阶段 A 捕获诊断”链接，href 以 /tenjin/capture-spike.html 结尾。

- [ ] **Step 2: 运行目标 App 测试并确认失败**

    pnpm --filter @tenjin/web exec vitest run src/App.test.tsx

  Expected: exit code 1，只因诊断链接不存在。

- [ ] **Step 3: 创建独立 HTML 和入口**

  capture-spike.html 复制 index.html 的 viewport、theme、PWA meta 和图标设置，title 改为“Tenjin 捕获链路诊断”，module script 指向 /src/capture-spike-main.tsx。

- [ ] **Step 4: 把两个 HTML 声明为 Vite build 输入**

  在 vite.config.ts 增加：

    build: {
      rollupOptions: {
        input: {
          main: "index.html",
          captureSpike: "capture-spike.html",
        },
      },
    },

  不新增依赖，不引入路由库。

- [ ] **Step 5: 在数据页加入测试入口**

  使用 import.meta.env.BASE_URL + "capture-spike.html"；链接文案明确“阶段 A”，不加入 AppView、NAVIGATION 或底部导航。

- [ ] **Step 6: 运行测试、构建和静态隔离检查**

    pnpm --filter @tenjin/web exec vitest run src/App.test.tsx src/features/capture-spike
    pnpm --filter @tenjin/web typecheck
    pnpm --filter @tenjin/web build
    pnpm lint
    rg -n "storage-indexeddb|openLedgerRepository|requestStoragePersistence|ledgerRuntime|indexedDB" apps/web/src/capture-spike-main.tsx apps/web/src/features/capture-spike

  Expected: 前四条命令 exit code 0；最后一条无匹配并以 rg 的“未找到”状态结束。apps/web/dist 同时包含 index.html 和 capture-spike.html。

- [ ] **Step 7: 本地 preview 验证两个入口**

    pnpm --filter @tenjin/web preview

  打开：

    http://localhost:4173/tenjin/
    http://localhost:4173/tenjin/capture-spike.html

  Expected: 正式账本照常启动；诊断页未请求持久化、未出现账本 loading，并能选择本地合成 v0 月份目录。

- [ ] **Step 8: 仅提交本任务文件**

    git add apps/web/capture-spike.html apps/web/src/capture-spike-main.tsx apps/web/vite.config.ts apps/web/src/App.tsx apps/web/src/App.test.tsx
    git commit -m "feat(spike): add isolated capture diagnostic entry"

---

### Task 5: 交付 Unicode 测试材料和快捷指令 build sheet

**Files:**

- Create: fixtures/capture-spike/unicode/japanese-unicode.txt
- Create: fixtures/capture-spike/unicode/japanese-unicode.codepoints.json
- Create: apps/web/public/capture-spike/japanese-unicode.html
- Create: docs/ios-shortcuts/tenjin-capture-spike-v0-build.md
- Create: docs/qa/2026-07-12-tenjin-capture-inbox-stage-a-runbook.md
- Modify: apps/web/src/features/capture-spike/captureSpikeV0.test.ts
- Modify: apps/web/src/features/capture-spike/captureSpikeReader.test.ts

**Fixture content:**

- 混合汉字、平假名、片假名、半角片假名、全角 ASCII 和全角空格。
- 补充平面字符 𠮷、emoji ZWJ 序列 👩‍💻。
- 预组合“が”和分解序列“か + U+3099”同时存在。
- 日文括号、引号、省略号、顿号、句号、问号和感叹号。
- 明确的首尾空白、多行、空行和 LF；CRLF 版本由测试/快捷指令在设备上另存，不交给 Git 自动换行。
- 日文路径和百分号编码 URL。
- codepoints JSON 记录每个命名片段的 Unicode scalar 十六进制序列，使“看起来一样”不能替代 code point 对比。
- public HTML 同时提供 plain text、rich text、Safari selection 和 URL 四个可分享区域，所有内容均为无敏感测试数据。

**Build sheet must define this package:**

    iCloud Drive/
      Shortcuts/
        Tenjin/
          CaptureLogSpike/
            2026-07/
              <captureId>/
                payload-001.*
                payload-002.*
                capture.json

capture.json 必须最后写入，示例：

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
          "observedType": "Text",
          "previewKind": "text",
          "path": "payload-001.txt",
          "mediaType": "text/plain",
          "sourceByteLength": 128
        }
      ]
    }

**Shortcut editor settings:**

- 名称：Tenjin Capture Spike v0。
- 显示在分享菜单。
- 接收：Text、Rich Text、URLs、Safari Web Pages、Images、Files；其他类型在阶段 A 明确拒绝。
- 无输入：Stop and Respond“没有收到可测试的内容”。
- 阶段 A 沿用 Task 0 实测配置：Save File 保持 Shortcuts 根目录，Subpath 从 /Tenjin/CaptureLogSpike/ 开始；本地作者运行不冒充 Import Question 安装证据。可用 Setup → Customise Shortcut 单独自检未来 Import Question 文案，但共享/重新导入安装验证属于阶段 B。
- sourceApp 默认省略；只有 Task 0/Content Graph 证明系统直接提供一个稳定来源身份变量时才接入，不能从测试清单反推。
- 普通 If/失败分支使用 Stop and Output，并把输出方式设为 Respond；只有全部 payload 和 capture.json 保存成功后才显示“已写入测试包 <短 captureId>”。Stop and Respond 只用于 Shortcut Input 的“无输入”设置。
- 不要求开发者账号，不使用 Xcode，不签原生 App。

**Shortcut action sequence:**

1. Current Date；一个 Format Date 明确把时区设为 UTC 后生成 capturedAt，另一个保留设备本地时区生成 shardMonth；禁止把本地格式化结果直接加 Z。
2. 另一个 Format Date 以设备本地时区生成 yyyyMMdd-HHmmss-SSS；Random Number 使用 100000–999999；用 Text 组成 spike-<timestamp>-<random>，同时作为 v0 captureId 和包目录名。该方案只用于 spike，v1 仍使用 PRD 冻结的 UUID。
3. 按 Task 0 真机验证结果，Save File 保持 Shortcuts 根目录，使用动态 Subpath /Tenjin/CaptureLogSpike/<shardMonth>/<captureId>/...，并关闭 Ask Where to Save 与 Overwrite If File Exists；测试设备只对这种完整 Subpath 证明会自动创建中间目录。若正式 build 会话行为不同，停止并记录差异，不得静默换协议。
4. Repeat with Each Shortcut Input，Repeat Index 作为 inputIndex；v0 每个顶层输入只保存一个往返表示。
5. Get Type of Repeat Item，原样记录 observedType。
6. 对 Text/Rich Text 使用 Get Text from Input 得到 UTF-8 文本；对 URL/Safari Web Page 先显式取得 URL，再用 Get Text from Input 保存 URL 字符串；对 Image 保留设备交付文件。Files 只接受能明确归为上述文字、URL 或 image/* 的实际表示，PDF/视频/未知文件走 Stop and Output（Respond）并写 QA 拒绝记录。
7. Set Name 为 payload-NNN 加实际扩展名；Save File 到已取得的 capture 目录，关闭 Ask Where to Save 和覆盖现有文件。
8. 对 Save File 返回的最终文件运行 Get Details of Files，记录实际名称、扩展名和 byteLength；MIME 取得到才写 mediaType，取不到就省略，不猜测。
9. none 版本不运行 Hash；sha256 副本在 Hash 前后各取一次 Current Date，用 Get Time Between Dates 后换算为毫秒，只对 Save File 返回的最终文件运行 SHA-256，并同时写 sourceSha256/sourceHashDurationMs。先用 UTF-8 字符串 abc 验证输出可转换为 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad 的 64 位小写十六进制。
10. 把当前 payload Dictionary 追加到有序 List。Content Graph 的其他可用表示只记录到 content-graph.csv，不在 v0 动作中做不存在的通用枚举。
11. Repeat 全部成功后才构造 manifest Dictionary，转换为 JSON 文本，Set Name 为 capture.json 并 Save File。
12. capture.json 保存成功后才 Show Notification；通知包含短 captureId，任何取消、权限、类型或保存错误都不得走成功通知。

在 Apple 设备上若动作名称或 Content Graph 行为与 build sheet 不同，先把真实差异写入 QA，不得悄悄改 schema 或伪造字段。官方参考必须链接：

- Apple Shortcuts 26 current action names: https://support.apple.com/125148
- Apple Format Date: https://support.apple.com/guide/shortcuts/apd71b0ac246/ios
- Apple Shortcuts input types: https://support.apple.com/guide/shortcuts/apd7644168e1/ios
- Apple Add Import Questions: https://support.apple.com/guide/shortcuts/apdf330fd3a0/ios
- Apple Repeat with Each: https://support.apple.com/guide/shortcuts/apdc11deb2c1/ios
- Apple Share Shortcuts: https://support.apple.com/guide/shortcuts/apdf01f8c054/ios
- Apple Stop and Output: https://support.apple.com/guide/shortcuts/apda9578f70f/ios

- [ ] **Step 1: 先写 fixture code point 断言测试**

  在 captureSpikeV0.test.ts 或 reader test 中读取/内嵌同一命名片段，断言预组合与分解形式不同、补充平面字符和 emoji ZWJ 未丢失。

- [ ] **Step 2: 创建三个公开测试材料**

  japanese-unicode.txt、codepoints JSON 和 public HTML 不包含账户、公司或真实学习记录。

- [ ] **Step 3: 编写 build sheet**

  必须包含字段到 Shortcuts 变量的逐项映射、动作顺序、none/sha256 唯一差异、manifest-last 规则、失败分支和不伪造 sourceApp 的规则；不得用“自行配置”代替具体动作。

- [ ] **Step 4: 编写 Stage A runbook**

  runbook 固定测试顺序、设备条件、CSV 列、成功/失败定义、如何重试、如何清理 CaptureLogSpike，以及“模拟证据不能判 PASS”。

- [ ] **Step 5: 运行测试和构建**

    pnpm --filter @tenjin/web test
    pnpm --filter @tenjin/web typecheck
    pnpm --filter @tenjin/web build
    pnpm lint

  Expected: 全部 exit code 0；dist/capture-spike/japanese-unicode.html 存在。

- [ ] **Step 6: 仅提交本任务文件**

    git add fixtures/capture-spike/unicode/japanese-unicode.txt fixtures/capture-spike/unicode/japanese-unicode.codepoints.json apps/web/public/capture-spike/japanese-unicode.html docs/ios-shortcuts/tenjin-capture-spike-v0-build.md docs/qa/2026-07-12-tenjin-capture-inbox-stage-a-runbook.md apps/web/src/features/capture-spike/captureSpikeV0.test.ts apps/web/src/features/capture-spike/captureSpikeReader.test.ts
    git commit -m "docs(spike): add iOS shortcut build kit"

---

### Task 6: 部署诊断候选并完成 Apple 设备人工关卡

**Files:**

- Create after real measurement: docs/qa/capture-inbox-stage-a/environment.md
- Create after real measurement: docs/qa/capture-inbox-stage-a/content-graph.csv
- Create after real measurement: docs/qa/capture-inbox-stage-a/roundtrip.csv

**Hard checkpoint:**

Windows 不能生成或验证 iCloud Shortcut 分享链接，也不能证明 iOS Content Graph、目录授权、webkitdirectory 或 iCloud 文件提供器行为。Task 0 已确认的 Apple 设备操作者必须按 build sheet 创建本地诊断快捷指令，再由目标用户在 iPhone 上运行；不得临时要求用户自己理解和搭建动作。阶段 A 不要求发布 iCloud 分享链接；正式安装链接与 Import Question 收件人安装验证属于阶段 B。不得提交含个人签名或设备信息的 .shortcut 文件。

- [ ] **Step 1: 推送已完成的代码和文档到 main**

  先确认工作树只剩用户原有 HANDOFF.md/CROSS-REVIEW.md 变化：

    git branch --show-current
    git remote get-url origin
    git status --short
    git log -1 --oneline
    git push origin main

  Expected: 分支为 main，origin 是预期 tenjin 仓库，最新提交是本计划刚完成的 Task 5 提交，push 成功；GitHub Pages workflow 对 main 新提交启动。任一不符就停止，不推送。

- [ ] **Step 2: 验证公开诊断 URL**

    https://derusva.github.io/tenjin/capture-spike.html

  完全关闭旧 PWA 客户端后重新打开，避免等待激活的 service worker 继续提供旧 bundle。确认正式 Tenjin 和诊断页均可打开。

- [ ] **Step 3: 在 Apple 设备创建 none 诊断快捷指令**

  完整照 build sheet 创建一次；沿用 Task 0 已验证的 Shortcuts 根目录和完整动态 Subpath；不用开发者账号。首次正式运行可出现系统 Files 权限，第二次运行不得再要求日常选目录。还要在同一秒内连续触发至少两次，确认 Random Number 产生六位后缀、captureId 符合 v0 格式、两个目录互不覆盖；这一步通过前随机后缀仍是 UNVERIFIED。若单独测试 Setup → Customise Shortcut，只能标为编辑器自检，不能写成真实共享安装通过。

- [ ] **Step 4: 复制出 sha256 变体**

  两个快捷指令除 hashMode、Hash action、sourceSha256 和 sourceHashDurationMs 外逐项一致；none 版同时省略后两字段，sha256 版每个 payload 同时提供两字段。若目标系统没有可用 SHA-256 Hash action，记录为真实不支持，不用网络服务替代。

- [ ] **Step 5: 建立 environment.md**

  只记录 iPhone 型号、iOS 版本、Shortcuts 版本/系统 build、PWA build commit、测试日期、网络类型和 iCloud Drive 开关状态；不记录 Apple ID、公司、序列号或私有目录。

- [ ] **Step 6: 采集 Content Graph 样本**

  至少覆盖 Safari、Photos、一个实际阅读器和 Files preview。content-graph.csv 固定列：

    attemptId,captureId,sourceApp,sourceVersion,shareGesture,topLevelInputCount,inputIndex,representationIndex,reportedType,selectedForV0,previewKind,mediaType,fileExtension,byteLength,sourceAppIdentityAvailable,notes

  记录文字、Rich Text、HTTP/HTTPS URL、Safari 页面、单图和 2–10 张多图的实际类型与顺序。Content Graph 的每种观察表示可有自己的 representationIndex，但每个 input 只有 selectedForV0=true 的一行实际进入 v0 payload。sourceApp 取不到就填 false，不根据测试步骤反推后写入 manifest。

- [ ] **Step 7: 做 Unicode 与往返测试**

  从 public fixture 分享 plain text、rich text、Safari selection、日文/百分号 URL；从 Photos 分享单图和多图。每次检查：

  1. 快捷指令只有完整保存才通知成功。
  2. 动作顺序和“保存 payload 后 Stop and Output”的故障注入证明 manifest-last；完成后查看 Files 只能证明最终包完整，不能假装观察到了写入先后。
  3. iPhone 主屏 PWA 打开诊断页并选择对应月份目录。
  4. 包为 ready，顺序、字节、Unicode/code point、URL 和图片可读。
  5. 诊断过程没有新增正式 Tenjin 事件或上下文。

- [ ] **Step 8: 建立 roundtrip.csv**

  固定列：

    attemptId,captureId,case,hashMode,shortcutReportedSuccess,manifestPresent,payloadCountExpected,payloadCountEnumerated,pwaStatus,orderPreserved,unicodePreserved,sourceDigestMatches,totalSeconds,notes

  所有行必须来自真实尝试；失败保留为失败，不删除重跑前的行。

- [ ] **Step 9: 提交第一批真机证据**

    git add docs/qa/capture-inbox-stage-a/environment.md docs/qa/capture-inbox-stage-a/content-graph.csv docs/qa/capture-inbox-stage-a/roundtrip.csv
    git commit -m "docs(qa): record stage A device roundtrips"

  若没有可操作 Apple 设备或无法构建快捷指令，停止并把阶段 A 报告为 blocked；不得继续写 PASS 文档。

---

### Task 7: 执行 iCloud 可靠性矩阵与 SHA A/B

**Files:**

- Create after real measurement: docs/qa/capture-inbox-stage-a/manual-matrix.md
- Create after real measurement: docs/qa/capture-inbox-stage-a/sha256-ab.csv
- Modify with additional real rows: docs/qa/capture-inbox-stage-a/roundtrip.csv

**Manual matrix cases:**

1. 编辑器中一次性根目录配置、首次 Files 系统权限；另行记录 Customise Shortcut 自检但不冒充共享安装。
2. 第二次运行不再询问。
3. 强退 Shortcuts 后仍引用原目录。
4. iPhone 重启后仍引用原目录。
5. 在线热启动写入与 PWA 读回。
6. 飞行模式下本地写入成功，或明确失败且无成功通知/manifest。
7. 恢复网络后的同步与再次读回。
8. CaptureLogSpike 测试目录被改名或删除后，无论系统选择安全重建还是明确失败，都不得误报成功或留下带 manifest 的半包。
9. PWA 取消目录选择、Shortcuts 可安全撤销的权限/选择场景，不得产生成功结果。
10. manifest 可见但 payload 是 iCloud placeholder 或读取抛错时，PWA 整包暂不可用且不显示部分内容；下载完成后重新选择可变为 ready。
11. 用临时 fail-before-manifest 副本在第一个 payload 保存后执行 Stop and Output（Respond）；确认没有 capture.json 和成功通知。若真实 I/O 失败自然发生，另保留原始失败行。

不得为了模拟空间不足填满真实 iCloud。无法安全复现的容量场景写 UNVERIFIED，不是 PASS。真实 placeholder 必须尽力通过 Files 的“移除下载”或另一设备同步观察；若平台不给可控故障注入，decision.md 写“未观察到真实 provider 场景”，但可以用 File 缺失和 File.arrayBuffer 抛出 NotReadableError 两种可控注入证明整包防线，不能声称真实 provider 已通过。

**SHA A/B workloads:**

- 约 100 KB 日文 UTF-8 文本。
- 一个普通 HTTP/HTTPS URL。
- 约 10 MB 的无敏感单图。
- 约 50 MB 的 2–10 图压力包；只做压力观察，不套 8 秒标准负载 SLA。

标准文字、URL 和单图先各热身一次，再各做 4 对 none/sha256 配对，共 12 对标准负载；每类四对的先后顺序为 AB、BA、BA、AB，A=none、B=sha256。50 MB 压力包只做 1 对。总耗时从分享菜单点下快捷指令到成功通知；用同一屏幕录制按帧计时方法，保留失败/重试行。这个小样本只为阶段 A 做保守取舍，不宣称稳定的生产性能分布。

sha256-ab.csv 固定列：

    pairId,captureId,case,bytes,orderInPair,hashMode,sourceHashDurationMsSum,totalSeconds,pwaHashDurationMsSum,sourceDigestMatches,notes

  多 payload 行中的 sourceHashDurationMsSum 和 pwaHashDurationMsSum 都是该次 capture 所有 payload 时长之和；单 payload 也是同一口径。

**Decision rule for source SHA:**

- 所有有 sourceSha256 的 payload 都必须与 PWA 本地 SHA 一致。
- 合并 12 对标准文字、URL、单图后，sha256 变体总耗时 nearest-rank P90 不超过 8 秒。
- 同一 12 对标准负载的逐对增量“sha256 - none”nearest-rank P90 不超过 1 秒。
- 每类另外报告 median 和 max；若任何一类明显异常，或测量值落在阈值 ±0.25 秒内无法稳定复现，保守结论都是 v1 移除源端 SHA。
- 任一条件不满足，v1 快捷指令不做源端 SHA；这不自动否决整个捕获闭环，但必须在阶段结论中明确。

- [ ] **Step 1: 先用合成错误验证 UI 防线**

  在桌面和 iPhone 诊断页选择“manifest 存在、payload 缺失”的无敏感合成包；确认整包 unavailable 且无部分预览。此结果只证明 UI 防线，不算真实 placeholder 证据。

- [ ] **Step 2: 完成真机 manual matrix**

  manual-matrix.md 每项记录环境、操作、预期、实际、PASS/FAIL/UNVERIFIED 和证据位置。失败后修复代码或快捷指令时保留原结果，并用新 attemptId 追加复测。

- [ ] **Step 3: 完成 SHA 配对运行**

  原始每次运行都写入 CSV；不得只保留汇总数字。

- [ ] **Step 4: 计算 median、P90 和配对增量**

  在 manual-matrix.md 末尾记录计算方法和结果。12 个标准样本的 nearest-rank P90 取排序后的第 11 个；配对增量逐对先相减再排序。每类只有 4 对，不计算伪精确的分类型 P90。

- [ ] **Step 5: 运行回归**

    pnpm test
    pnpm typecheck
    pnpm lint
    pnpm build

  Expected: 全部 exit code 0。

- [ ] **Step 6: 仅提交真实可靠性证据**

    git add docs/qa/capture-inbox-stage-a/manual-matrix.md docs/qa/capture-inbox-stage-a/sha256-ab.csv docs/qa/capture-inbox-stage-a/roundtrip.csv
    git commit -m "docs(qa): record stage A reliability evidence"

---

### Task 8: 做阶段门判定，不自动进入 B

**Files:**

- Create: docs/qa/capture-inbox-stage-a/decision.md
- Modify only if factual setup instructions changed: README.md

**decision.md required sections:**

1. 测试设备与 build commit。
2. 每个阶段 A 门的 PASS/FAIL/UNVERIFIED 与直接证据。
3. 按来源列出的实际 Content Graph 表示。
4. 候选 v1 白名单：只列真机稳定成功的类型。
5. 候选 v1 明确拒绝清单：列出无表示、顺序不稳、格式不可控或无法整包读回的类型。
6. sourceApp 结论：可稳定取得或 v1 省略。
7. source SHA 结论：保留或移除，并引用 P90/增量。
8. 固定目录、重启、离线、失败通知、placeholder 和 PWA 读回结论。
9. 已知限制与未验证项。
10. 阶段 B 建议：GO、NO-GO 或 BLOCKED；即使 GO 也必须等待用户再次授权。

**Stage A may be PASS only when:**

- Safari、Photos 和 Files preview 都至少稳定交付一种有用表示；至少一个用户实际使用的阅读器必须留下真实样本。若该阅读器不暴露快捷指令入口，必须把“直接捕获”列入 v1 拒绝清单，并用“截图 → Photos → Tenjin”完成同一阅读场景的端到端回退验证；不要求安装用户不会使用的阅读器来制造通过。
- 固定目录首次授权后不成为日常询问，强退和重启后仍成立。
- 目标 iOS 26 主屏 PWA 能从月份目录读回完整 v0 包。
- manifest 已到而 payload 缺失或 File.arrayBuffer 抛 NotReadableError 时，两种可控注入都显示整包暂不可用且可重试；真实 iCloud placeholder 若平台允许诱发则结果一致，若无法诱发必须明确写“未观察到”，不能伪报 provider PASS。
- 保存失败不显示成功，且无 capture.json 伪完成标记。
- decision.md 能明确列出 v1 支持与拒绝类型。

- [ ] **Step 1: 对照 PRD 逐项审计证据**

  每个结论必须引用 feasibility-probe.md 或 CSV/manual matrix 的 attemptId、captureId、case；没有证据就标 UNVERIFIED。

- [ ] **Step 2: 写 decision.md**

  不淡化失败，不用“基本可行”代替门槛。若任一必需门为 FAIL/UNVERIFIED，总结必须是 BLOCKED 或 NO-GO。

- [ ] **Step 3: 最终验证仓库和构建**

    git status --short
    pnpm test
    pnpm typecheck
    pnpm lint
    pnpm build
    git diff --check

  Expected: 测试、类型、lint、build 和 diff check 全部通过；git status 只显示本任务 decision/README 变化及用户原有 HANDOFF.md/CROSS-REVIEW.md。

- [ ] **Step 4: 提交和推送阶段结论**

    git add docs/qa/capture-inbox-stage-a/decision.md
    git commit -m "docs(qa): decide capture inbox stage A gate"
    git branch --show-current
    git remote get-url origin
    git status --short
    git log -1 --oneline
    git push origin main

  只有 README.md 确实因事实变化而被修改时，才在 commit 前单独执行 git add README.md。push 前必须再次确认分支为 main、origin 正确、最新 HEAD 是阶段结论提交；任一不符即停止。不得加入 HANDOFF.md 或 CROSS-REVIEW.md。

- [ ] **Step 5: 向用户交付证据结论**

  只报告实际 PASS/FAIL/UNVERIFIED、公开诊断 URL、source SHA 决定、v1 白名单/拒绝清单和 B 的建议。若建议 GO，停在请求用户决定是否授权阶段 B，不创建 B 分支、不写 B 代码。
