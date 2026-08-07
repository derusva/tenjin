# A1 账本恢复器与等价验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `.tenjin` 完整备份包能被严格校验并原子恢复到**空账本**，并交付一套能失败的独立等价验证器 + 11 条负样本 + 3 条 must-not-fail，补齐 `HANDOFF.md` 阶段 A1 Gate 的后端部分。

**Architecture:** 三层，边界即责任。`@tenjin/exchange` 保持纯函数、无 DOM、无 IndexedDB、无 Node 依赖，负责**解包与全部校验**，产出已验证的 `LedgerRestorePlan`；`@tenjin/storage-indexeddb` 定义自己的输入类型并负责**原子写入**与**原始读取**；等价验证器住在 storage 层，复习队列构造函数由调用方注入。**exchange 与 storage 互不依赖**；两者的集成、结构兼容断言与真实摘要接线**全部落在 `apps/web` 的集成测试**里——那是唯一同时依赖两者的地方。

**Tech Stack:** TypeScript（NodeNext、strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）、Vitest、idb、fake-indexeddb；ZIP **写用 fflate、读用精确锁定的 `@zip.js/zip.js@2.8.34`**（见 §3.3，owner 已冻结为 B-reader-only）。

**基线：** `fa4e048`。切片总定义见 [`docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`](../../decisions/2026-08-05-a1-ledger-recovery-slice.md)（**v1.6**）。

**状态：计划已完成修订；待用户批准 T0，批准前不得开工。** CRC 路线已冻结（§3.3）。**T0 必须独占 Phase 0；T0 全绿后才可启动 T1/T2，T2 完成后才可进入 T3，T3a 浏览器 Gate 全绿后才可进入 T4。**

**交付口径（不可含糊）：** 本计划完成后只能声称 **BACKEND_READY / LIMITS_PROVISIONAL**——恢复能力在后端可用并已验证，限额仍是临时安全上限。**不得**声称"端到端恢复已交付"或"A1 完成"：§3.10 的激活状态机要到 UI 切片才落地，在那之前用户无法完成一次真实恢复。

---

## 0. 本计划明确不做

- Web 数据页按钮或任何 UI 实现；真机 runbook 的执行；
- Coach JSON 导入；`focus` 字段；DB 升到 v3；`importReceipts`；
- **非空账本恢复或任何形式的 merge / 去重 / 覆盖**（切片 §5.2.1 第 4 条）；
- `abstract-exchange` 模式的任何部分；
- 复习时间预算改造；教学或引导 UI；
- `newDeviceId` 的生成与 localStorage 写入（属 UI 切片，见 §3.8、§3.10）。

`packages/exchange` **新增且仅新增一个运行时依赖 `@zip.js/zip.js`，精确锁定 `2.8.34`（不得用 `^` / `~`）**，只从包根入口 import，只用于 restore 读包（见 §3.3；此前"不得新增运行时依赖"的说法随该冻结作废）。仍不得整包引入 DOM lib 或 `@types/node`，**其测试也不得 `import "node:crypto"`**（见 §3.2）——这条类型边界正是 T0 必须先验证的项目之一。

---

## 1. 文件写集

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/core/src/contextHash.ts` + `.test.ts` | 新建 | T1 |
| `packages/core/src/index.ts` | 追加 export | T1 |
| `apps/web/src/features/ledger/ledgerRuntime.ts` | 复用 core 序列化（**仅此**） | T1 |
| `apps/web/src/features/capture/createCapture.ts` | 复用 core 类型（**仅此**） | T1 |
| **`packages/exchange/package.json`** | 加 `@zip.js/zip.js` 运行时依赖 | **T0** |
| **`pnpm-lock.yaml`** | 随依赖变更更新（同一文件会在 T0、T3a 依次修改） | **T0**、T3a |
| `packages/exchange/src/zipRuntime.ts` + `.test.ts` | 新建 vendor 隔离层与 T0 能力探针；T3 复用 | **T0** |
| `packages/exchange/src/zipProbeFixtures.ts` | 新建 Node/browser 共用的 byte fixtures | **T0**、T3a |
| `packages/exchange/tsconfig.public-api.json` | 新建 ES2023-only、`skipLibCheck: false` 的消费侧 Gate | **T0** |
| `packages/exchange/type-tests/public-api.ts` | 新建最小公共声明消费者 | **T0** |
| `packages/exchange/src/limits.ts` + `.test.ts` | 新建 | T2 |
| `packages/exchange/src/exportPackage.ts` | 追加导出前限额预检 | T2 |
| `packages/exchange/src/manifest.ts` + `.test.ts` | 提供 writer/reader 共用的完整 v1 shape validator | **T4** |
| `packages/exchange/src/watermark.ts` + `.test.ts` | 改为 prototype-safe 累积并覆盖特殊 deviceId | **T4**、T7 |
| `packages/exchange/src/decodeUtf8.ts` + `.test.ts` | 新建 | T3 |
| `packages/exchange/src/readPackage.ts` + `.test.ts` | 新建 | T3 |
| `packages/exchange/src/validateManifest.ts` + `.test.ts` | 新建 | T4 |
| `packages/exchange/src/validateEvents.ts` + `.test.ts` | 新建 | T5 |
| `packages/exchange/src/validateContexts.ts` + `.test.ts` | 新建 | T6 |
| `packages/exchange/src/restorePlan.ts` + `.test.ts` | 新建 | T7 |
| `packages/exchange/src/index.ts` | T0 导出冻结 adapter/QA probe API；T2–T7 追加正式 API | **T0**、T2–T7 |
| `packages/exchange/src/negativeMatrix.test.ts` | 新建 | T12 |
| `packages/storage-indexeddb/src/restore.ts` + `.test.ts` | 新建 | T8 |
| `packages/storage-indexeddb/src/restoreCommit.ts` + `.test.ts` | 新建封闭 marker 类型、validator 与只读 accessor | T8、T10 |
| `packages/storage-indexeddb/src/repository.ts` | clock union 纳入 marker；开放只读 marker accessor 与 `structurallyEqual`（package-internal）；`openLedgerRepository` 返回类型加交集 | T8、T9、T10 |
| `packages/storage-indexeddb/src/repository.test.ts` | 追加 | T9 |
| `packages/storage-indexeddb/src/verifyEquivalence.ts` + `.test.ts` | 新建 | T10 |
| `packages/storage-indexeddb/src/index.ts` | 追加 export（**不含** `structurallyEqual`） | T8、T10 |
| **`apps/web/package.json`** | T3a 加 `@tenjin/exchange` devDependency、浏览器探针脚本，并让 `pretest` / `pretypecheck` / `prebuild` 构建 exchange；T11 只复核 | **T3a** |
| `apps/web/zip-reader-probe.html` | 新建独立 QA 探针入口，不进入生产 PWA input | T3a |
| `apps/web/src/zip-reader-probe-main.ts` | 新建 READY 后一次性手动触发的浏览器探针 | T3a |
| `apps/web/vite.zip-reader-probe.config.ts` | 新建独立 Vite build 配置 | T3a |
| `docs/qa/a1-zip-reader-browser-probe.md` | 新建 G5a/G5b 命令、环境与证据模板 | T3a |
| `apps/web/src/features/ledger/restoreIntegration.test.ts` | 新建（**仅测试**） | T11 |

**绝对不得触碰：** `CROSS-REVIEW.md`（见 §5 的 Gate 定义）。

## 2. 任务依赖

```text
Phase 0（独占）: T0

Phase 1（T0 全绿后）:
  Lane A: T1 -> T6 ----------------------------┐
  Lane B: T2 -> T3 -> T3a -> T4 -> T5 --------┴-> T7 -> T8 -> T9 -> T10 -> T11 -> T12
```

**T0 不得与 T1/T2 并行。** 任一 Gate 失败即停止并上报——不得让 T1/T2 先留下半套实现，不得自动改走路线 A，不得放宽任何安全边界。T12 必须在 T11 之后：must-not-fail 第 3 条的真实 undo 往返明确落在 T11，依赖图不得把它们画成并行分支。

---

## 3. 关键设计决定（不得自行更改）

### 3.1 context hash 序列化必须先提取到 core

恢复器要**重新计算** context hash，而唯一决定该 hash 的序列化在 `apps/web/src/features/ledger/ledgerRuntime.ts` 的 `hashContext` 里：**固定字面量顺序**的四字段对象（`original` → `corrected?` → `answer?` → `imageSha256?`），缺省字段整键省略。它与 `canonicalJson`（递归排序键）**完全不是一回事**。

exchange 不能依赖 apps/web；照抄一份会静默漂移，漂移的表现是恢复期 hash 误判。所以 T1 把**序列化**（不含摘要计算）提取到 core。

**owner 已批准触碰 `ledgerRuntime.ts` 与 `createCapture.ts`，严格限于纯序列化提取。** `ledgerRuntime.test.ts` 里三条钉死精确序列化串的断言**一行不许改**——它们就是守卫；任一变红说明历史 hash 被改变，立即回退。

### 3.2 摘要函数注入；exchange 测试禁用 `node:crypto`

```ts
export type Sha256Hex = (input: Uint8Array) => Promise<string>;
```

返回**小写十六进制、无前缀**。

**exchange 的测试不得 `import "node:crypto"`**——本包刻意不引入 `@types/node`，引入即破坏 §3.5 要守的边界，而 §5 的 exchange 独立 typecheck Gate 会立刻失败。测试两条路，任选其一并写明选了哪条：

- **注入式确定性假摘要**：一个纯 TS、无任何平台依赖的函数，产出稳定的 64 位小写 hex。它**不是 SHA-256**，注释必须写死这一点；它存在的目的是验证**比对逻辑**（匹配放行、不匹配拒绝），fixture 用同一个假摘要生成以保持自洽。
- **预计算 fixture**：把真实 SHA-256 的期望值作为常量写死在测试里。

**真实摘要的接线正确性由 `apps/web` 集成测试证明**（T11），那里可以合法使用平台 crypto。这个分工要写进测试注释，否则后人会以为 exchange 的测试已经验过真实摘要。

### 3.3 ZIP 完整性：路线已冻结为 **B-reader-only**

**问题**：fflate 的流式 `Unzip` 不自动验证 CRC-32。于是一个压缩数据被篡改、CRC 未更新的包，只要解压产物碰巧仍是合法 UTF-8 / JSON / schema，就会**一路通过**其余全部校验。备份路径上不可接受——恢复出来的账本静默地不是原来那份。

**owner 已冻结：B-reader-only。**

| | 库 | 职责 | 影响 |
|---|---|---|---|
| **写** | `fflate`（不变） | `exportLedgerPackage` | **导出字节合同一个字节都不改**。已交付的确定性、`mtime` 处理与两条 byte-identical 断言全部原样保留 |
| **读** | **`@zip.js/zip.js`**（新增） | 仅 restore 侧解包 | 提供 CRC 校验与基于 Web Streams 的流式解压 |

读写分库是刻意的：换掉写侧会让已合入并过审的导出器重新变成待验证状态，而我们要的只是"读的时候能发现被篡改"。**此前写在本节的"路线 B 必须替换 exporter"以及 §0 的"exchange 不得新增运行时依赖"两条说法，随本冻结一并作废。**

依赖与运行配置同样冻结，不留给实现者猜默认值：

```ts
// package.json: exact version, no caret
"@zip.js/zip.js": "2.8.34"

export const ZIP_WORKER_OPTIONS = {
  useWebWorkers: true,
  useCompressionStream: true,
  transferStreams: true,
} as const;

export const ZIP_READER_OPTIONS = {
  ...ZIP_WORKER_OPTIONS,
  strictness: "strict",
  checkOverlappingEntry: true,
} as const;

export const ZIP_ENTRY_OPTIONS = {
  ...ZIP_WORKER_OPTIONS,
  strictness: "strict",
  checkOverlappingEntry: true,
  checkSignature: true,
} as const;
```

adapter 必须把 `ZIP_READER_OPTIONS` **逐次显式传给 `new ZipReader(...)`**，把 `ZIP_ENTRY_OPTIONS` 与该次新建的 `signal` **逐次显式传给每个 `entry.getData(...)`**；不得只导出常量却依赖 vendor 默认值。也不得把这三项 worker 选项只交给全局 `configure()`：zip.js 2.8.34 的 `Configuration` 类型虽然继承 `transferStreams`，但其运行时全局 configurable-property 列表不处理该键；走全局配置会让 `transferStreams: true` 成为静默无效的摆设（以精确版本包内 `index.d.ts` 与 `lib/core/configuration.js` 为核对证据）。T0 用可观测 factory/entry double 精确断言两处实际收到的 option object，删掉任一字段都必须变红。

只从 `@zip.js/zip.js` 根入口 import；不得另行配置或引入独立 `workerURI` / `wasmURI`。T3a 必须证明实际 Vite browser build 能运行且处理 fixture 时没有外部 worker/WASM 请求：**页面加载完成后、第一次调用 ZIP adapter 之前切为离线，再执行完整探针**；同时由早于 module script 安装的 Worker constructor spy 与浏览器 Network log 证明没有 `http(s):` worker URL 或外部 WASM/worker 请求。只看主页面的 `performance` entries 不够，它可能看不到 worker 内部发起的请求。若 inline worker/WASM、CSP 或 Safari 路径失败，**停下上报**，不得在本计划内静默切到 `?url` asset 路线。生产 `readPackage` 与 QA 探针必须调用同一个 `zipRuntime` adapter。

**必须加一条负样本**（矩阵第 11 条）：篡改 `events.jsonl` 或 `manifest.json` 的压缩数据、**不更新 CRC**，且构造成解压后仍是合法 UTF-8 / JSON / 通过 schema 的形态。T0-G4 先证明 zip.js 原始错误为 `ERR_INVALID_SIGNATURE`；adapter 只在启用 `checkSignature: true` 的 entry `getData` 阶段把该错误映射为项目错误 `CRC_MISMATCH` 并保留 `cause`。矩阵断言项目错误；不得把其它解析错误误映射为 CRC。

### 3.4 ZIP 防护：严格读取器 + 按**实际产出**计量

体积上限**必须按实际解压产出计量**，不能只信中央目录声明的 `uncompressedSize`（旧 fflate 草案中的字段名是 `originalSize`）——那是**攻击者可控的值**，伪造成“很小”的条目完全可以展开出几百 MB。

用 `@zip.js/zip.js` 的流式读取，把每个 entry 的输出接进一个**计数 `WritableStream`**：每收到一个 chunk 就累加单 entry 与总量，**任一越界立即通过 `AbortSignal` 终止**并抛错。计数发生在 chunk 层，因此终止点与实际写出的字节严格对应，不依赖任何声明值。

限额必须分三层，测试也必须分别证明失败发生在正确阶段：

1. **`PACKAGE_COMPRESSED_LIMIT`**：`bytes.byteLength` 超限时，在构造 `ZipReader` 前拒绝；reader factory 调用次数必须为 0；
2. **`PACKAGE_DECLARED_LIMIT`**：通过 `getEntriesGenerator()` 单遍枚举 metadata，在逐条 yield 时累计 entry 数、单 entry `uncompressedSize` 与声明总量；超限时所有 entry 的 `getData` 调用次数必须为 0。这只是便宜早拒，不能替代安全计量；
3. **`PACKAGE_OUTPUT_LIMIT`**：真实 vendor fixture 至少分两条，且每个 entry 的 local/central `uncompressedSize` 两处始终一致、CRC 始终按实际 payload 正确填写：① 单 entry 的声明值恰好等于其类型 cap，实际 deflate 输出为 `cap + 1`；② 多 entry 各自声明值都不超过单条 cap、声明总和恰好等于 package total cap，但最后一条的实际输出多 1 byte，使**累计实际输出**越过 total cap。counting writer 在 crossing chunk 到达时先置 sticky `limitExceeded`、abort 且不保留该 chunk，断言 `signal.aborted === true`、reader 在 `finally` 关闭、未消费后续 chunk。zip.js 2.8.34 自己也会拿声明的 `uncompressedSize` 校验实际输出并可能抛 `ERR_INVALID_UNCOMPRESSED_SIZE`（核对精确版本包内 `lib/core/zip-reader.js` 与 `lib/core/streams/codec-stream.js`）；因此 adapter 的 catch/finally 在 `limitExceeded === true` 时必须优先重抛稳定的 `PACKAGE_OUTPUT_LIMIT`，不得被 vendor size error、`AbortError` 或 close error 覆盖。若 flag 未置位，则不得把 vendor 错误误映射成项目限额错误。

T0/T3 可以通过 package-internal helper 注入较小的测试 cap，生产公开 `readPackage` 必须硬接 `PACKAGE_LIMITS`；但这条 Gate 必须走真实 zip.js `entry.getData` 与真实压缩 fixture。只用 fake writer/double 证明计数逻辑不构成 vendor 集成证据。

严格读取器的配置与拒绝清单见 §T0，它们是硬 Gate 的验收项。

### 3.5 UTF-8 解码必须 fatal，且不为此扩大 exchange 的类型面

默认的非 fatal 解码器把非法字节静默替换成 U+FFFD，"非法 UTF-8"这条校验**永不触发**。必须 `fatal: true`。

但 `TextDecoder` 的类型来自 DOM 或 `@types/node`，而 exchange 刻意保持 `lib: ["ES2023"]`、既无 DOM 也无 Node 依赖。因此新建极窄封装 `packages/exchange/src/decodeUtf8.ts`：

```ts
/**
 * TextDecoder is a runtime global in both browsers and Node, but its type comes
 * from DOM or @types/node. This package ships with neither - pulling in either
 * would weaken the boundary that keeps it usable from both sides - so the one
 * global we need is declared as narrowly as it can be, right where it is used.
 */
declare const TextDecoder: {
  new (
    label: "utf-8",
    options: { readonly fatal: true },
  ): { decode(input: Uint8Array): string };
};

export function decodeUtf8Strict(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${what} is not valid UTF-8`);
  }
}
```

**`pnpm --filter @tenjin/exchange typecheck` 是独立 Gate**（§5），必须单独退出 0，证明没有 DOM/Node 类型泄进包里。

### 3.6 事务纪律与「空库」的精确语义

- 全部摘要计算、`Uint8Array → Blob` 转换、全部校验，**必须在开启写事务之前完成**。
- 写事务内**不得 `await` 任何非 IndexedDB 的 Promise**。事务在微任务队列排空且无未决请求时自动提交，一次 `await crypto.subtle.digest(...)` 就够让它提前提交，产出"报告成功的半批数据"。既有代码已在绕这个坑。
- **「目标库为空」= `events`、`contexts`、`clock` 三个 store 的 `count()` 全部为 0**，且**必须在最终 readwrite 事务内确认**。

  只查 `events` 是不够的，而且会真实出错：`reserveEventCoordinates` 会在**没有任何事件**的情况下写 `clock`。一个"打开过应用但从没采集"的库，`events` 为空而 `clock` 非空——按只查 events 的写法会被判为空库，恢复后 clock 里混着旧分配器记录，新身份的 seq 起点就不可信了。
- 事务外预检是 check-then-act，双标签页或双击就能穿过去，而本仓明确处理多标签场景。
- 任何错误必须让事务 `abort`，零部分写入。

### 3.7 不放宽既有写入路径

`appendCapture` 的"恰好 1 条 `capture_created` 且其 `contextHash` 等于传入 context 的 hash"是核心不变量，**签名与断言强度一律不动**。恢复走全新方法，可抽私有 helper 共用幂等 put，但共用不得降低单条路径的强度。

### 3.8 身份：调用方生成，storage 只校验

| 存储 | 内容 | 谁负责 |
|---|---|---|
| localStorage `tenjin.deviceId`（`apps/web/src/main.tsx:18`） | 本安装当前使用的 `deviceId` | **调用方**（UI 切片） |
| IndexedDB `clock` store | `global-hlc` + 每设备 `device-sequence:<id>` 水位 | `restoreLedger` |

**owner 已定：`newDeviceId` 由调用方生成并传入，storage 层永不自己生成。** storage 若自己 `randomUUID()`，就凭空多出一个隐式身份来源，而真正的身份归属在 localStorage，两边各生成一次必然分叉。

**canonical 校验（`newDeviceId` 与 `manifest.exportedByDeviceId` 同一套，三条缺一不可）：**

1. 是**非空字符串**；
2. `value.trim().length > 0`（排除全空白）；
3. **`value === value.trim()`**（排除首尾空白）。

**一律拒绝，不做 trim。** 静默 trim 会让"调用方存进 localStorage 的字符串"与"写进账本的字符串"不是同一个值——之后每一次比对都会失败，而且失败点离病因很远。

**禁用集合** = 包内**全部事件的 `deviceId`** ∪ **`manifest.exportedByDeviceId`**。后者必须在内：导出设备可能一条事件都没有（导出后立刻恢复到同一台机器），此时它不在事件集里，却仍是真实用过的身份。

理由不是形式主义：`highWaterFromEvents` 在 clock 记录缺失时会从事件重建高水位；复用包内已有的 `deviceId`，新设备的 `seq` 会从历史高水位续发，而那些号可能已被别的副本用过——同 `eventId` 不同内容，交换时中毒且延迟触发。

### 3.9 类型边界：storage 定义输入，exchange 结构兼容，两边互不依赖

**storage 侧**（`packages/storage-indexeddb/src/restore.ts`）定义自己的输入类型，不 import exchange：

```ts
export interface RestoreContextInput {
  readonly hash: string;
  readonly original: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly image?: {
    readonly mediaType: ContextImageMediaType;
    readonly name: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly bytes: Uint8Array;
  };
  readonly createdAt: string;
}

export interface RestoreLedgerInput {
  readonly events: readonly Event[];
  readonly contexts: readonly RestoreContextInput[];
  readonly globalHlc: HybridLogicalClock;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly forbiddenDeviceIds: readonly string[];
}

/** Separate from LedgerRepository on purpose - see below. */
export interface LedgerRestorer {
  restoreLedger(input: RestoreLedgerInput, newDeviceId: string): Promise<void>;
}
```

**`LedgerRestorer` 必须是独立接口，不得把 `restoreLedger` 加进 `LedgerRepository`。** `apps/web` 的测试里有多个手写的 `LedgerRepository` mock（如 `App.test.tsx`），往接口加方法会让它们全部编译失败，而那与恢复功能毫无关系。

`openLedgerRepository` 返回 `Promise<LedgerRepository & LedgerRestorer>`。只依赖 `LedgerRepository` 的既有调用点与 mock 不受影响。

exchange 的 `LedgerRestorePlan` 与 `RestoreLedgerInput` **结构兼容**但独立定义，靠 T11 的编译期断言绑定。

**`structurallyEqual` 只作 package-internal named export**：从 `repository.ts` 导出供同包内 `verifyEquivalence.ts` 使用，**不进 `index.ts`**，也**不建 `/testing` 子入口**。

### 3.10 UI 激活状态机（本轮不实现，但必须可执行）

UI 切片按此实现，不得自行发挥。**Bootstrap 的锁内状态判定必须早于身份与 runtime 创建。** 锁外读取 `pendingRestoreDeviceId` 只能作为“是否可能需要恢复”的 hint，绝不能授权身份、判定状态或缓存 `deviceId`：另一标签页可能在本标签页等待锁期间完成恢复并切换身份。

在支持恢复的环境里，启动顺序只有两条合法分支：

- **shared 锁内重读为无 pending**：取得 shared lock → **在该锁内重读 pending** → 此时才可读取或生成正式 `deviceId` → 打开 repository → 创建可写 runtime，并让该 runtime 在整个生命周期持有这把 shared lock；
- **shared 锁内重读为有 pending**：不得调用 `loadDeviceId()` 或 `crypto.randomUUID()`，不得创建可写 runtime；释放 shared，转入禁写恢复分支并取得 exclusive lock；**在 exclusive callback 内再次同时读取 pending、marker 与三 store 状态**，只按这次读到的值执行 §3.10.5。若 pending 在换锁期间已被另一标签页删除或改变，不得沿用旧 hint：释放 exclusive 并从 bootstrap 起点重试。

未来 UI 切片的冻结写集（**本轮不实施**）：`apps/web/src/main.tsx`、`apps/web/src/app/repositoryLifecycle.ts` + `.test.ts`、新建 `apps/web/src/app/runtimeWriteLock.ts` + `.test.ts`、新建 `apps/web/src/app/restoreActivation.ts` + `.test.ts`、`apps/web/package.json`、`pnpm-lock.yaml`。届时 `restoreActivation` 会在生产代码 import `@tenjin/exchange`，所以必须把它从 devDependency 移到 dependencies，并让 `predev` 同时 build exchange 与 storage；clean checkout 的 `pnpm --filter @tenjin/web dev` 与 `build` 都必须作为 Gate，禁止依赖残留 `dist/`。

#### 3.10.1 前一版的缺陷：从「任一 store 非空」推断「已提交」

前一版的状态表写着「pending 存在 + 任一 store 非空 → `RESTORE_PENDING_COMMITTED` → 提升该 id」。**这是错的，会毁掉一个完好的账本。**

反例：用户有一个**正常使用中的非空账本**，某次误点进恢复流程，pending 已经写下，随后 restore 因"目标库非空"被拒（正确行为）。此时磁盘上是「pending 存在 + 三 store 非空」——按旧表，下次启动会判定为"已提交"，把一个**从未被使用过的新 `deviceId`** 提升为正式身份，扣到那本**原封未动的旧账本**上。那个账本的 clock 里没有这个新身份的分配器记录，于是它从 `seq = 1` 开始发号，而账本里早已有旧身份发到很高的号——身份与账本从此对不上，且**没有任何报错**。

根因是把**推断**当**事实**：「非空」有两种成因（本来就有 / 我们刚写的），旧表只考虑了后一种。

#### 3.10.2 锁协议

- **所有可写 runtime 在其整个生命周期内持有一个 shared lock**（命名锁，如 Web Locks API 的 `shared` 模式）。不是"恢复时才加锁"——平时不持有，恢复方就无从知道还有谁在写。
- **Web Lock 不支持原地升级。** 发起恢复的 runtime 自己也是 shared holder；若不先释放自己的 shared lock就申请 exclusive，会在单标签页下自锁。
- **恢复方的顺序**：① 本 runtime 保持禁写，关闭 repository 并显式释放自己的 shared lock；② 通知其它 runtime 转入只读、关闭连接并释放各自 shared lock；③ 用可取消的有界等待申请 exclusive lock；④ 拿不到 → **拒绝进入恢复流程**（fail-closed），且不得写 pending；⑤ 运行环境不提供该能力 → 同样拒绝，不得"假装安全地继续"。
- **三 store 全空的检查必须在拿到 exclusive lock 之后、在该锁内进行**。锁外检查是 check-then-act。
- exclusive callback 内重新打开**仅供恢复**的 repository；验空、pending 之后的 restore 与 marker 验证必须全部发生在该 callback 生命周期内。成功后直接 close + reload，**不得恢复旧 runtime**。
- 选包取消、exclusive 获取失败、或非空拒绝等**尚未写 pending**的出口，只有在确认 localStorage/DB 未变、重新取得 shared lock并重建 repository/runtime 后才能恢复写入。pending 一旦写下，失败后保持禁写并交给 bootstrap 状态机处理。

#### 3.10.3 顺序被改了：先验空，再写 pending

```text
1. 禁写          停止本 runtime 的一切写入路径（采集、复习、撤销）
2. 自身让位      关闭本 repository，释放本 runtime 自己持有的 shared lock
3. 其它端让位    通知其它 runtime 转只读、关闭连接并释放 shared lock
4. exclusive     有界申请 exclusive lock；拿不到即拒绝且不写 pending
5. 验空          在 exclusive callback 内打开 restore-only repository，检查三 store 全为 count === 0
   5a. 非空      →【拒绝】在此终止。**不写 pending**；localStorage 与原 deviceId 一字不动；
                   用户看到的是"当前账本非空，无法恢复"，而不是任何中间态
   5b. 全空      → 继续
6. 写并读回      生成 newDeviceId → 写 localStorage 的 pendingRestoreDeviceId → 立即读回校验一致
7. restore       调用 restoreLedger(input, pendingRestoreDeviceId)，数据与 marker 同事务提交
8. 绑定验证      close/reopen 后读取 marker，完整校验并确认 marker.newDeviceId === pendingRestoreDeviceId
9. 提升          把同一个 pendingRestoreDeviceId 提升为 tenjin.deviceId
10. 删 pending / close repository / reload
```

**第 5 步必须在第 6 步之前**，这是与前一版最重要的差别。这样 pending 只会为"当时确实为空的库"写下，`RESTORE_ABORTED_DIRTY` 这种状态在磁盘上不可能出现。

#### 3.10.4 `COMMITTED` 必须是事实，不是推断：durable commit marker

即便有了上面的顺序，「pending + 非空 = 已提交」仍然依赖一个前提：**在 pending 写下之后、除了我们的 restore 之外没有任何东西写过这个库**。要让这个前提成立，就得证明**每一条写路径**都参与了同一把锁——而那是一个需要穷举、且必须永远保持为真的审计义务，在一个还会继续长的代码库里没人能真正担保。

因此本计划要求：**恢复必须写一个 durable commit marker，与恢复数据在同一个 readwrite 事务内提交。** `COMMITTED` 的判据是**一个结构合法且绑定当前 pending id 的 marker 存在**，而不是"某个 store 非空"或"某个 marker 恰好存在"。

```ts
export interface RestoreCommitRecord {
  readonly key: "restore-commit";
  readonly type: "restore-commit";
  readonly newDeviceId: string;
  readonly committedAt: string;
}
```

这是封闭键集：额外字段一律拒绝；`newDeviceId` 走 §3.8 的 canonical 校验；`committedAt` 必须是毫秒精度 canonical UTC ISO-8601，满足 `new Date(Date.parse(value)).toISOString() === value`。UI 只有在 `record.newDeviceId === pendingRestoreDeviceId` 时才能判为 committed。malformed 或 id mismatch 一律进入 `RESTORE_STATE_CORRUPT`：保持禁写，禁止再次 restore、提升、铸新 id、恢复写入或修改 localStorage。

两处连带后果，已一并纳入本计划，不得遗漏：

- **T8**：`restoreLedger` 在同一事务内写入精确 `RestoreCommitRecord`（本轮 DB 保持 v2，marker 落在既有 `clock` store），并提供只读 accessor；
- **T10 L3**：clock 的精确键集合相应变为 `{"global-hlc", "restore-commit"} ∪ {"device-sequence:<id>" | id ∈ maxSeqByDevice}`，同时验证 marker 的完整值与 expected new device id，而不只检查键存在。

> **与 owner 指令的差异（须知悉）**：owner 把 marker 写成了条件项（"若无法保证所有写路径参与同一锁，则必须改用"）。本计划**无条件采用** marker，因为条件的成立需要一份永远有效的穷举证明，而 marker 只需一条记录就把推断变成事实。若你坚持条件化，需回改 T8 与 T10 两处。

#### 3.10.5 状态表（据上）

| pending | commit marker | 状态 | 动作 |
|---|---|---|---|
| 无 | 任意 | `NORMAL` | 正常启动 |
| 有 | **无，且三 store 全空** | `RESTORE_PENDING_EMPTY` | **保持禁写**。两条出路：用**同一个** pending id 重新选包继续；或**显式取消**（删 pending → `NORMAL`）。不得静默丢弃 pending，不得自动铸新 id，**不得提升该 id** |
| 有 | **无，但任一 store 非空** | `RESTORE_STATE_CORRUPT` | 原子恢复不可能合法产生“数据存在但 marker 缺失”；保持禁写，不允许把它当作可重试空库 |
| 有 | **合法且 `marker.newDeviceId === pending`** | `RESTORE_PENDING_COMMITTED` | **绝不再次 restore**。跑健全性检查 → 提升同一个 pending id → 删 pending → close → reload |
| 有 | **malformed 或 id mismatch** | `RESTORE_STATE_CORRUPT` | 保持禁写并显示可诊断错误；禁止 restore、提升、铸新 id、恢复写入或改 localStorage |

**失败清理规则：**

- 第 5a 步被拒（非空）→ 因为**根本没写 pending**，下次启动就是 `NORMAL`；释放 exclusive 后重新取得 shared lock并重建 runtime 才能恢复写入；
- `restore` 抛错（零写入，marker 也未写）→ pending 保留、marker 不存在且三 store 仍空 → `RESTORE_PENDING_EMPTY`，可用同一 id 重试或显式取消；
- `restore` 成功但提升前崩溃 → 合法 marker 已随数据原子提交且 id 与 pending 相同 → `RESTORE_PENDING_COMMITTED`，用同一 id 完成提升；
- **任何情况下都不得在未提升时铸新 id。**

#### 3.10.6 UI Gate（UI 切片必须通过）

- **U1a「DB 已提交但提升前崩溃」**：在第 7 步之后、第 9 步之前强杀应用；重启时先处理 pending/marker，且在此之前 `loadDeviceId`、`crypto.randomUUID`、runtime factory 与所有写方法调用次数均为 0。合法且 id 相同 → `RESTORE_PENDING_COMMITTED`，完成提升且**不得再次调用 restore**。
- **U1b/U1c「marker 不授权错误身份」**：分别构造 marker id 与 pending 不同、marker malformed；两者都进入 `RESTORE_STATE_CORRUPT` 并满足全部禁写条件。
- **U1d「数据存在但 marker 缺失」**：pending 存在、任一 store 非空、marker 缺失时必须进入 `RESTORE_STATE_CORRUPT`，不得误判为可重试空库。
- **U1e「等待 shared 期间另一标签页完成恢复」**：本标签页先看到锁外“无 pending”hint 后阻塞；另一标签页完成 restore、提升身份并删除 pending；本标签页取得 shared 后必须重读 pending，随后调用 `loadDeviceId()` 只能得到已提升的新 id。断言旧 id 从未被读取、缓存或用于创建 runtime。
- **U1f「pending hint 在换锁期间失效」**：本标签页在 shared 锁内读到 pending，释放 shared 准备 exclusive；另一标签页先完成并删除 pending。本标签页取得 exclusive 后重读为无 pending时，必须不处理旧 pending/marker、不调用 restore/提升/铸 id，释放 exclusive 后从 bootstrap 起点重试。
- **U2a「单标签页升级」**：本标签页已持有 shared，进入恢复后必须先释放自己的 shared，随后 exclusive 能成功取得；禁止依赖宿主超时碰巧结束。
- **U2b「另一标签页拒绝让位」**：exclusive 有界失败；无 pending、无 DB/localStorage 改动。若要继续正常使用，必须重新取得 shared lock并重建 runtime。
- **U2c「另一标签页已让位」**：其旧 runtime 的全部写调用继续被拒绝；绝不允许一个标签页恢复完成、另一个拿旧 `deviceId` 继续写。
- **U3a/U3b/U3c「单 store 非空」**：分别构造仅 `events`、仅 `contexts`、仅 `clock` 非空（clock-only 优先用真实 `reserveEventCoordinates` 制造）。每个变体都必须在写 pending 前拒绝，并断言 `localStorage.setItem(pendingKey, ...)` 调用次数为 0、正式 deviceId 与 marker 不变、三 store 逐条/逐字节不变、未调用 restore、未提升或铸造 id、重启进入 `NORMAL`。完整正常非空账本可保留为 U3d 控制组，但不能替代三种单-store 用例。

T8 的测试 6–8 保护 storage 的最终事务入口；U3a–c 独立保护 UI 的 pre-pending 检查，两者不能互相替代。

---

## 4. 任务

### T0: `@zip.js/zip.js` 能力硬 Gate（阻塞全部实现任务）

**Files:** `packages/exchange/package.json`、`pnpm-lock.yaml`、`packages/exchange/src/index.ts`、新建 `packages/exchange/src/zipRuntime.ts` + `.test.ts`、`packages/exchange/src/zipProbeFixtures.ts`、`packages/exchange/tsconfig.public-api.json`、`packages/exchange/type-tests/public-api.ts`

T0 是**独占 Phase 0**。只允许写可复用的最小 vendor adapter、共享 byte fixtures 与类型消费 Gate；不得提前实现 `readPackage` 的 manifest/schema/context 逻辑。结论只有 `PASS` / `FAIL`：任一项失败即停止，只保留日志与证据，不启动 T1/T2/T3，不自动改走路线 A，也不放宽边界。

`index.ts` 在 T0 只导出 T3/T3a 会复用的窄 API：冻结的 worker/reader/entry options、`runZipRuntimeProbe` 与只读 `ZIP_PROBE_FIXTURES`；不得 export 任何 zip.js 原生类型。T3 完成后 `readPackage` 复用 adapter，T3a 从包根调用同一 probe API。

先从仓根精确安装依赖并审 lock diff，再写 probe：

```bash
pnpm --filter @tenjin/exchange add '@zip.js/zip.js@2.8.34' --save-exact
```

`packages/exchange/package.json` 必须得到无 `^` / `~` 的精确版本；`pnpm-lock.yaml` 只允许出现 exchange importer 与该依赖的必要解析变化。若命令带来无关升级，停止并先收窄 lock diff。

- [ ] **G0 配置不是死常量** — 可观测 reader factory 必须收到与 `ZIP_READER_OPTIONS` 深度全等的对象；每次 `getData` 必须收到 `ZIP_ENTRY_OPTIONS` 全部字段与该次非复用的 `AbortSignal`。删掉 `useWebWorkers` / `useCompressionStream` / `transferStreams` / `strictness` / `checkOverlappingEntry` / `checkSignature` 任一字段，对应断言必须变红；不得用“当前 vendor 默认值碰巧相同”代替。
- [ ] **G1 三项严格性各自有牙**
  - strictness：固定为 **filename-only mismatch**（其余 header、CRC 与数据完全合法）；`strictness: "strict"` 必须报 `ERR_AMBIGUOUS_ARCHIVE`。同一 fixture 的 `balanced` 控制组不能只断言“不报这个错误”——必须带 `checkSignature: true` 成功 `getData`，并逐字节等于 expected payload；
  - CRC/signature：损坏压缩数据且不更新 CRC，原始错误必须是 `ERR_INVALID_SIGNATURE`；adapter 映射后才是 `CRC_MISMATCH`，并保留 `cause`；
  - overlap：先对 entry A 调 `getData`，再对重叠 entry B 调 `getData`，必须报 `ERR_OVERLAPPING_ENTRY`。只枚举 entries 不构成 overlap 证据。
- [ ] **G2 明确拒绝清单** — 加密、不支持的 compression method（只允许 store/deflate）分别产出 `ZIP_ENCRYPTED_UNSUPPORTED`、`ZIP_COMPRESSION_UNSUPPORTED`，且在第一次 `getData` 前拒绝。multi-disk 必须拆开两条：① EOCD / ZIP64 locator 的 archive-level disk 元数据非零；② central entry 的 `diskNumberStart !== 0`、而 archive-level 元数据仍为单盘。两者都产出 `ZIP_MULTI_DISK_UNSUPPORTED` 且所有 `getData` 调用次数为 0；不能只靠 zip.js 对 archive-level split 的自动报错覆盖 entry 路径。ZIP64 也必须拆成两个 fixture：
  - `ZIP64_ENTRY_UNSUPPORTED`：普通 EOCD，但某 entry 使用 ZIP64 extra field，先断言 `entry.zip64 === true` 再拒绝；
  - `ZIP64_ARCHIVE_UNSUPPORTED`：存在 ZIP64 EOCD record/locator、普通 entries 的 `entry.zip64 === false`，由原始 envelope guard 拒绝。该 guard 必须从**最后一个合法 EOCD 的固定相对位置**解析 locator，验证 locator 紧邻 EOCD、locator 指向的 offset 在界内且确实是 ZIP64 EOCD signature；禁止对整包做 magic-byte scan。不得用“所有 `entry.zip64` 均为 false”证明 archive 非 ZIP64；
  - **raw guard 负控制**：普通 ZIP 的 payload 与 EOCD comment 分别含 `0x06064b50` / `0x07064b50` 字节序列时仍须接受，证明实现没有把任意 magic bytes 误判成 ZIP64；
  - **非 ZIP64 上界控制组**：用现有 fflate writer 产出恰好 `65_535` 个最小唯一条目，zip.js 必须能完整枚举 `65_535` 个且 archive/entry 均未被判为 ZIP64；这个控制组不跑 manifest/schema。它守的是 `0xFFFF` 边界的读写互操作，不能只靠常量算式自证。
- [ ] **G3 三层限额** — 逐一证明 §3.4 的 compressed / declared / actual-output 三层；每条断言 reader factory、`getData`、AbortSignal 与 close 调用次数，确保红灯来自目标阶段。actual-output 必须使用“local/central 声明值 = 测试 cap、实际输出 = cap + 1、CRC = 实际 payload”的真实 zip.js fixture，分别咬住单 entry cap 与 package total cap，并钉住 `limitExceeded` 优先级；writer double 只能作辅助单测。
- [ ] **G4 CRC raw + mapping** — 对同一个“解压后仍是合法 UTF-8 / JSON / schema”的 fixture，同时钉住 zip.js 原始 `ERR_INVALID_SIGNATURE` 与项目 `CRC_MISMATCH`。删除任一断言都必须让对应突变漏过；其它错误不得被映射。
- [ ] **G6 双层类型边界**
  1. 保留 `pnpm --filter @tenjin/exchange typecheck`，确认 source 包仍为 `lib: ["ES2023"]`、无 DOM、无 `@types/node`；
  2. 先 build，再用 `tsconfig.public-api.json` 编译 `type-tests/public-api.ts`：`lib: ["ES2023"]`、`types: []`、`skipLibCheck: false`、`noEmit: true`。T0 的 consumer 必须实际调用公开的 ZIP runtime/probe API；T7 增加正式 restore API 后，同一 Gate 必须扩展为同时调用 restore API，并在 T11 再跑。每一阶段生成的 `dist/*.d.ts` 都不得泄漏 `WritableStream`、`AbortSignal`、zip.js 或 Node 类型。只跑继承了 `skipLibCheck: true` 的现有 typecheck 不构成 G6 证据。

```bash
pnpm --filter @tenjin/exchange test
pnpm --filter @tenjin/exchange typecheck
pnpm --filter @tenjin/exchange build
pnpm --filter @tenjin/exchange exec tsc -p tsconfig.public-api.json
```

> **G5 不再伪装成 T0 内不可执行的真机 Gate。** 浏览器 bundle/runtime 是 T3a-G5a，真实 iPhone PWA 离线往返是切片最终 G5b；二者都必须通过才能声称 A1 完成，但具体 iPhone 不阻塞本后端计划达到 `BACKEND_READY / LIMITS_PROVISIONAL`。

**Gate 产出：** 测试与原始输出随 T0 checkpoint 一起审阅；不得在执行期改写本计划来“记录成功”。探针与 fixtures 保留为回归测试。

---

### T1: 把 context hash 序列化提取到 core

**Files:** 新建 `packages/core/src/contextHash.ts` + `.test.ts`；改 `packages/core/src/index.ts`、`ledgerRuntime.ts`、`createCapture.ts`

- [ ] **Step 1: 先跑既有守卫并记录基线** — `pnpm --filter @tenjin/web test ledgerRuntime`，记录通过数。这些测试**一行不许改**。
- [ ] **Step 2: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { serializeContextHashInput } from "./contextHash.js";

describe("serializeContextHashInput", () => {
  it("emits only the original when nothing else is present", () => {
    expect(serializeContextHashInput({ original: "a" })).toBe(
      JSON.stringify({ original: "a" }),
    );
  });

  it("keeps the fixed field order: original, corrected, answer, imageSha256", () => {
    expect(
      serializeContextHashInput({
        imageSha256: "d".repeat(64),
        answer: "c",
        corrected: "b",
        original: "a",
      }),
    ).toBe(
      JSON.stringify({
        original: "a",
        corrected: "b",
        answer: "c",
        imageSha256: "d".repeat(64),
      }),
    );
  });

  it("omits absent fields entirely rather than emitting null or an empty string", () => {
    expect(serializeContextHashInput({ original: "a", answer: "c" })).toBe(
      JSON.stringify({ original: "a", answer: "c" }),
    );
    expect(serializeContextHashInput({ original: "a" })).not.toContain("null");
  });

  it("is not the canonical serialiser: it must not sort keys", () => {
    // canonicalJson sorts keys. Sorting here would put answer before original
    // and silently change every hash ever computed.
    const serialized = serializeContextHashInput({ original: "z", answer: "a" });
    expect(serialized.indexOf('"original"')).toBeLessThan(
      serialized.indexOf('"answer"'),
    );
  });
});
```

- [ ] **Step 3: 运行确认失败** — `pnpm --filter @tenjin/core test contextHash`
- [ ] **Step 4: 实现**

```ts
/**
 * The exact input serialisation behind a context hash.
 *
 * This is content identity, not a formatting choice: the field order is a fixed
 * literal and absent fields are omitted whole. Reordering, sorting, or emitting
 * `null` for an absent field would change every hash ever computed and orphan
 * the existing ledger.
 *
 * Deliberately NOT `canonicalJson`, which recursively sorts keys and exists only
 * to make exported package bytes stable. Never substitute one for the other.
 */
export interface ContextHashInput {
  readonly original: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly imageSha256?: string;
}

export function serializeContextHashInput(input: ContextHashInput): string {
  return JSON.stringify({
    original: input.original,
    ...(input.corrected === undefined ? {} : { corrected: input.corrected }),
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.imageSha256 === undefined
      ? {}
      : { imageSha256: input.imageSha256 }),
  });
}
```

- [ ] **Step 5: apps/web 复用** — `hashContext` 改为调用 `serializeContextHashInput(context)` 再 `options.digest(...)`；`createCapture.ts` 的 `CaptureContextHashInput` 复用 core 的 `ContextHashInput`。**不改** `options.digest` 签名与 `sha256:` 前缀拼接位置。
- [ ] **Step 6: 双侧验证** — core 新测试全绿；`ledgerRuntime` 通过数与 Step 1 **完全一致**。任一精确序列化断言变红 → 立即回退。
- [ ] **Step 7: 提交** — `refactor(core): share the context hash serialisation`

---

### T2: 限额常量与导出前预检

**owner 已定的口径，必须逐字体现在注释里：**

```ts
export const PACKAGE_LIMITS = {
  /**
   * PRODUCT CONSTRAINT, not a security ceiling: the storage layer caps a single
   * capture image at 20 MiB (MAX_CONTEXT_IMAGE_BYTES).
   */
  imageEntryBytes: 20 * 1024 * 1024,

  /**
   * STRUCTURAL, not provisional: without ZIP64 a central directory holds at
   * most 65,535 entries. Three fixed entries plus two per context gives
   * 2 * 32_766 + 3 = 65_535 exactly.
   */
  entries: 65_535,
  contexts: 32_766,

  /**
   * PROVISIONAL SECURITY CEILINGS. Refusal thresholds, nothing more - never
   * quote them as supported capacity. They may only be frozen after boundary
   * validation at 80% and 100% of each, with both a text-heavy and an
   * image-heavy package, on the user's actual iPhone.
   */
  compressedBytes: 100 * 1024 * 1024,
  decompressedBytes: 250 * 1024 * 1024,
  textEntryBytes: 64 * 1024 * 1024,
  metadataEntryBytes: 1 * 1024 * 1024,
  events: 200_000,
} as const;
```

**导出器必须共享同一份限额并在导出前预检**：`exportLedgerPackage` 压缩前校验条目数 / context 数 / 每条目声明大小 / 解压总量，压缩后再校验压缩体积。测试必须同时证明：`entries = 65_535` / `contexts = 32_766` 的结构边界被接受；任一加 1 都在调用 fflate 前拒绝；超限账本不会产出一个自家恢复器拒收的包。T0-G2 的真实 fflate→zip.js 上界控制组另行证明 `0xFFFF` 读写互操作，不能由纯函数边界测试替代。

---

### T3: 严格读包（zip.js）、UTF-8 严格解码、条目白名单

> **T0 未全绿之前不得开工。** 读取器复用 T0 已验证的 `zipRuntime` adapter 与冻结配置；不得在 `readPackage.ts` 里直接再包一层 zip.js。拒绝清单沿用 G1/G2，限额沿用 G3，CRC raw/mapping 沿用 G4。

条目名白名单与重复条目检测仍是本任务的职责，但 **zip.js 2.8.34 在 `strictness: "strict"` 下调用 `getEntries()` 会在返回数组之前自行对重复 filename 抛 `ERR_AMBIGUOUS_ARCHIVE`**，因此不能先调用 `getEntries()` 再假装执行项目自己的 duplicate Gate。adapter 必须改用 `getEntriesGenerator()` 单遍枚举：每次 yield 先按白名单校验，再查 `seenNames`，只在通过后收集 metadata；第二个同名条目一出现就由项目报稳定的 duplicate-entry 错误，绝不能先塞进 name-keyed map。所有正常路径必须把 generator **完整 exhaust**，不能在“已经拿够 manifest/events”时提前结束，否则 vendor strict 模式的尾部检查可能永远不执行；所有拒绝路径仍在 `finally` 关闭 reader。

必须包含的测试（每条注释写清守什么）：

```ts
it("rejects a path traversal entry name", () => {
  // Whitelist, not blacklist: anything that is not exactly one of the five
  // legal shapes is rejected, so `../` never needs a special case.
});

it("rejects a duplicate entry name", () => {
  // Feed through getEntriesGenerator(). The project duplicate error must be
  // raised on the second yield, before anything keys it by name; getEntries()
  // is not an allowed implementation because strict mode throws first.
});

it("exhausts the entry generator before accepting an archive", () => {
  // Use an instrumented async generator whose code after the final yield marks
  // natural completion. `return()`/early break must not satisfy this assertion.
  // This keeps zip.js strict post-enumeration checks reachable.
});

it("rejects invalid UTF-8 in a text entry", () => {
  // A non-fatal TextDecoder turns these bytes into U+FFFD and this check would
  // never fire.
});

it("accepts a missing or empty redactions.jsonl but rejects a non-empty one", () => {});

it("rejects compressed input before constructing a reader", () => {
  // PACKAGE_COMPRESSED_LIMIT: readerFactory must stay at 0 calls.
});

it("rejects declared expansion before extracting an entry", () => {
  // PACKAGE_DECLARED_LIMIT: every entry.getData must stay at 0 calls.
});

it("prioritises PACKAGE_OUTPUT_LIMIT when actual output crosses the declared cap", () => {
  // PACKAGE_OUTPUT_LIMIT: reject the chunk that crosses the line, abort the
  // signal, close in finally, consume no later chunk, and preserve the stable
  // project error rather than letting ERR_INVALID_UNCOMPRESSED_SIZE,
  // AbortError, or a close error replace it. The real ZIP declares exactly the
  // injected cap in both headers, expands to cap + 1, and has a correct CRC.
  // This remains a T3 unit test; numbered matrix slot 11 belongs to CRC.
});

it("enforces the package total against cumulative actual output", () => {
  // Every individual entry stays below its own cap. The final entry crosses
  // only the aggregate cap; PACKAGE_OUTPUT_LIMIT must still win over the
  // vendor size error and no later entry may be consumed.
});
```

限额按 §3.4 三层实现；只有第三层使用计数 `WritableStream` 按 chunk 累计**实际产出**字节并经 `AbortSignal` 终止。`limitExceeded` 是 sticky 项目状态：一旦置位，catch/finally 必须保留 `PACKAGE_OUTPUT_LIMIT`；未置位时 `ERR_INVALID_UNCOMPRESSED_SIZE` 原样分类，不能一概吞掉。另有独立 CRC 映射测试：只有 `entry.getData(..., { checkSignature: true })` 抛出的 `ERR_INVALID_SIGNATURE` 映射为 `CRC_MISMATCH`；解析期的其它异常原样分类。

---

### T3a: G5a 浏览器 bundle/runtime Gate（阻塞 T4）

**Files:** `apps/web/package.json`、`pnpm-lock.yaml`、新建 `apps/web/zip-reader-probe.html`、`apps/web/src/zip-reader-probe-main.ts`、`apps/web/vite.zip-reader-probe.config.ts`、`docs/qa/a1-zip-reader-browser-probe.md`

这是**独立 QA build**，不加入 `apps/web/vite.config.ts` 的生产 PWA input，也不制造产品入口：

```json
{
  "devDependencies": {
    "@tenjin/exchange": "workspace:*"
  },
  "scripts": {
    "pretest": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
    "pretypecheck": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
    "prebuild": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
    "prebuild:zip-reader-probe": "pnpm --filter @tenjin/exchange build",
    "build:zip-reader-probe": "vite build --config vite.zip-reader-probe.config.ts"
  }
}
```

编辑后从仓根运行一次 `pnpm install`，审计 `pnpm-lock.yaml` 只新增 apps/web importer 对该 workspace devDependency 的必要变化；T11 不再重复安装。`prebuild:zip-reader-probe` 是干净 checkout 可执行性的硬要求：`@tenjin/exchange` 的 workspace exports 指向 `dist/`，不能依赖开发机恰好残留旧构建。probe 必须从 `@tenjin/exchange` 调生产 `readPackage` / `zipRuntime` adapter，并复用 `zipProbeFixtures.ts` 的同一组 byte fixtures；不得在 web 侧复制 zip.js 配置、fixture 构造或错误映射。

probe **不得自动执行**。`zip-reader-probe.html` 必须在 module script 之前安装一个极窄 Worker constructor spy，记录每次构造的 URL；随后页面只进入 `READY` 并提供一次性“运行离线探针”按钮。这样操作者能在任何 ZIP 调用发生前切断网络。点击后才运行 T0-G0–G4，显示并允许复制一份机器可读结果：commit SHA、browser UA、冻结配置、各 fixture 的预期/实际错误、Worker URL 列表、resource entries、离线状态与总 PASS/FAIL。spy 只记录，不改写 Worker 行为；若浏览器不允许安全包裹原 constructor，T3a 失败并停止，不能删掉观测点继续。

执行步骤与 Gate：

```bash
pnpm --filter @tenjin/web test
pnpm --filter @tenjin/web typecheck
pnpm --filter @tenjin/web build
pnpm --filter @tenjin/web build:zip-reader-probe
pnpm --filter @tenjin/web exec vite preview --config vite.zip-reader-probe.config.ts
```

1. build 必须退出 0，产物中不得出现独立 worker/WASM 文件；
2. 使用全新浏览器 profile / context，打开 DevTools Network、启用 Preserve log 与 Disable cache；页面达到 `READY` 前 probe 调用次数必须为 0；
3. 页面加载完成后切到 Offline，**第一次**点击运行；G0–G4 必须仍全 PASS，且 `navigator.onLine === false` 被写入结果。jsdom 或“先在线跑一次再离线复跑”都不能替代此步，后者可能命中缓存；
4. Worker spy 记录到的 URL 只能是 `blob:` / `data:`；从导航开始保存的 Network log 与页面 `performance` resource entries 都不得出现外部 worker/WASM 请求。仅检查主页面 performance entries 不能单独构成证据；
5. 命令、commit、浏览器版本、产物文件清单、Worker URL、Network log 摘要与原始 JSON 结果写入 `docs/qa/a1-zip-reader-browser-probe.md`；
6. 任一项失败即停在 T3a，不进入 T4，也不得在本计划内静默改为 `?url` worker/WASM 资产路线。

**G5b 不在本后端切片伪装完成：**真实 iPhone 的在线打开、Service Worker controlled、飞行模式关闭网络、从主屏重启并完成真实备份恢复，仍按切片 §6 最终 runbook 执行；未过只能称 `BACKEND_READY / LIMITS_PROVISIONAL`。

---

### T4: manifest 全字段严格校验

**每一行至少一条负例**，未列出的顶层键一律拒绝（封闭键集）。

| 字段 | 约束 | 负例示范 |
|---|---|---|
| `packageKind` | `=== "tenjin-ledger"` | 其它字符串 |
| `schemaVersion` | `=== 1`（数字，非字符串） | `2` / `"1"` |
| `mode` | `=== "full-backup"` | `"abstract-exchange"` |
| `generation` | 整数且 `=== 0` | `1` / `0.5` / `"0"` |
| `exportedByDeviceId` | 非空字符串、`trim()` 后非空、**`value === value.trim()`** | `""` / `"   "` / `" a"` / `"a "` |
| `exportedAt` | 匹配 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` **且 `new Date(Date.parse(value)).toISOString() === value`** | `"2026-08-05 12:00:00"` / **`"2026-02-30T00:00:00.000Z"`** / `"2026-13-45T00:00:00.000Z"` |
| `eventCount` | 非负安全整数，且**精确等于**实际事件行数 | 少 1 / 多 1 / `-1` / `1.5` |
| `contextCount` | 非负安全整数，且**精确等于**实际 context 条目数 | 少 1 / 多 1 / `-1` / `1.5` |
| `maxHlc` | `{ wallTime, counter }` 均为非负安全整数；**等于**事件集派生值；无多余键 | 数值不符 / 缺 `counter` / 多一个键 |
| `maxSeqByDevice` | 键为 canonical 非空 deviceId；值为**正**安全整数；键集与值**都**等于事件集派生结果 | 多一个设备 / 少一个设备 / 值偏大 / 值为 0 / 键含空白 |
| `foldExternalState` | 数组且**必须为空** | `["importReceipts"]` |

`foldExternalState` 非空的错误消息必须点明"本版不认识该状态，**拒绝整包**而非丢弃"；测试注释写清理由：静默丢弃 = 恢复看似成功但幂等信息已丢。

#### T4.1 消除 exporter ↔ reader 漂移（必须同批改 `manifest.ts`）

**现状是漂移的**：已交付的 `buildManifest` 对 `exportedByDeviceId` 只查 `trim().length === 0`，所以 `" device-a "` **能导出**；而上表的 reader 要求 `value === value.trim()`，会**拒绝**它。也就是说导出器能产出一个自家恢复器拒收的包——这类缺陷只有在真要恢复的那天才会暴露，正是备份路径上最不能有的。

`exportedAt` 同理：现有正则接受 `"2026-02-30T00:00:00.000Z"`（形状合法、日期不存在），而 `Date.parse` 会把它规范成 3 月 2 日，往返比对即可识破。

因此 `packages/exchange/src/manifest.ts` 提供唯一的 `assertManifestV1Shape`，覆盖上表**全部 shape 规则**，而不是只同步两个已经暴露的字段：

- `buildManifest` 先构造 candidate，再调用共享 validator；writer 必须拒绝 reader 会因 shape 拒绝的所有 manifest；
- `validateManifest.ts` 先调用同一个 validator，再做依赖实际包内容的交叉校验：实际 event/context 数量、事件集派生 `maxHlc`、事件集派生 `maxSeqByDevice`；
- 禁止在 reader 中复制第二份 shape validator。两套手工同步的规则迟早再次漂移。

必须补三层测试：

1. **共享 shape validator 表驱动**：覆盖 T4 表中的每一行，包括非法闰日、非 canonical ID、负数/小数 count、非法 `maxHlc`、非法 `maxSeqByDevice`；
2. **writer 负例**：上述 shape 错误必须在 `buildManifest` / 导出侧即被拒；
3. **完整包自兼容**：`exportLedgerPackage → readPackage → validateManifest` 全绿，不能只把任意 `buildManifest` 输出直接喂给同一 validator 自证。

---

### T5: events.jsonl 解析与逐事件校验

**解析顺序：先解析全部行成 `unknown[]` → 每条先过 `validateEvent` 的单记录 shape/closed-schema 校验 → 仅把已验证的 `Event[]` 按规范全序排序 → 再做全部跨记录、时序与引用校验。** 不得把未经验证的 JSON 强转成 `Event` 后交给 comparator：缺失 `hlc` 等字段会让排序器在 schema Gate 之前抛出无关异常。所有会受输入行序影响的检查都必须发生在排序之后，因此 must-not-fail 的“行序打乱”仍是结构性成立而非碰巧成立。

校验项：

- 每行一个 JSON 对象；空行只允许出现在文件末尾；任何解析失败拒绝；
- 每条过 `validateEvent`（core 已导出，`packages/core/src/events.ts:531`），通过后才允许收窄为 `Event` 并进入 canonical sort；
- **`eventId` 精确等于 `` `${deviceId}:${seq}` ``**（`ledgerRuntime` 铸 id 的方式）；
- **`(deviceId, seq)` 组合唯一**；
- `eventId` 全局唯一；
- 每设备 `seq` 严格递增，**允许空洞**（规格只要求单调，见 `HANDOFF.md` §5.2 与 §13.1）；
- `occurredAt <= recordedAt`；
- context 引用按 T5.1。

#### T5.1 active-capture 引用规则

原先"凡带 `contextHash` 必须有 context"是错的：真实撤销流程里 `appendDiscard` 会在没有其它活跃引用时**删除 context**，于是一个含"已撤销 capture"的**合法**账本会被误判为损坏。正确规则四条：

1. 先算出被有效 `capture_discarded` 撤销的 `captureId` 集合；
2. **未被撤销的 `capture_created` 必须能解析到 context**——缺失即拒绝；
3. **已撤销 capture 的 context 允许缺失**——正常 GC 结果，不是损坏；
4. 同一 hash 仍被**任一未撤销 capture** 引用时该 context 必须存在（第 2 条的推论，但要单独测：这正是 GC 的保留分支）。

**没有任何活跃引用的 context 一律接受，不得拒绝**——它可能来自 GC 的合法竞态。这条要写成注释，防止后人"顺手收紧"。

`item_created` 的 `captureId` 必须能找到对应的 `capture_created`。

#### T5.2 负例

`eventId` 与 `${deviceId}:${seq}` 不符；`deviceId` / `eventId` 首尾含空白；同一 `deviceId` 重复 `seq`；`occurredAt > recordedAt`；未撤销 capture 的 context 缺失；events.jsonl 中间出现空行。另加一条缺失/畸形 `hlc` 的输入，断言错误来自 `validateEvent` 且 canonical comparator 调用次数为 0，守住“先验证单记录 shape、后排序”的边界。

---

### T6: contexts 校验与摘要重算

必须逐项测试**现行 `ContextRecord` 的全部生产约束**（以 `packages/storage-indexeddb/src/repository.ts` 的 `assertValidContext` 为准）：

| 字段 | 约束 |
|---|---|
| `hash` | `sha256:` + 恰好 64 位小写 hex；且**等于条目名的 `<hex>`** |
| `original` | 字符串，**`trim()` 后非空** |
| `corrected` | 存在时为字符串且 **`trim()` 后非空** |
| `answer` | 存在时为字符串且 **`trim()` 后非空** |
| `createdAt` | 规范 UTC ISO-8601 |
| `image.mediaType` | 落在 `CONTEXT_IMAGE_MEDIA_TYPES` 白名单内 |
| `image.name` | 字符串，`trim()` 后非空 |
| `image.byteLength` | **`1 <= byteLength <= 20 MiB`**（下界不可省：0 字节图片不是合法图片，且会让摘要与"有图"语义脱节），且等于 `.image` 条目的**实际字节数** |
| `image.sha256` | 裸 64 位小写 hex（**无前缀**），等于对实际字节重算的摘要 |
| 未知字段 | context 层与 image 层**都**拒绝 |

**Blob 创建后的 `type` 必须等于 `mediaType`**：`new Blob([bytes], { type: mediaType })` 之后断言 `blob.type === mediaType`。浏览器会对非法或大小写异常的 MIME 串做规范化甚至清空，届时存进库的 `blob.type` 与 `mediaType` 字段不一致，而 `structurallyEqual` 恰好比较 `blob.type`——等价验证会在一个与内容无关的地方失败，病因极难定位。这条断言把它挡在写入之前。

**图片 metadata 与 `.image` 条目双向一一对应：** 声明了 `image` 却无对应条目 → 拒绝（缺失）；有条目而对应 context 无 `image` → 拒绝（孤儿）。各一个测试。

**重算而不是只查形状：** 用注入的 `Sha256Hex`（§3.2：exchange 测试用假摘要或预计算 fixture）对 `serializeContextHashInput(...)` 的 UTF-8 字节求摘要，拼 `sha256:` 后与声明的 `hash` 比对。

必须有一条专打"只比摘要"假绿的测试：**改一个图片字节，同时把 `image.sha256` 改成新字节的正确摘要**。此时形状与图片自洽校验都通过，只有"重算 context hash"（`imageSha256` 参与其中）或"条目名 = hash"能抓住。

---

### T7: 组装 `LedgerRestorePlan`

```ts
export interface LedgerRestorePlan {
  readonly events: readonly Event[];                 // 已按规范全序排序
  readonly contexts: readonly RestoreContextShape[]; // 图片为 Uint8Array
  readonly globalHlc: HybridLogicalClock;            // 包内最大 HLC
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly forbiddenDeviceIds: readonly string[];    // 事件 deviceId ∪ exportedByDeviceId
}
```

`maxSeqByDevice` 确定性派生自事件集（复用 `deriveWatermark`），与 manifest 声明值交叉校验（不符即拒，属 T4）。字段名与 storage 的 `RestoreLedgerInput` 一致，以便 T11 的编译期断言成立。

`deriveWatermark` 必须用 `Map<string, number>` 累积，再经 `Object.fromEntries` 生成可序列化记录；不得把任意 deviceId 直接赋给普通 `{}`。`__proto__`、`constructor`、`toString` 都属于当前合法 deviceId 域，必须作为 own enumerable keys 保留，不能为了绕过容器缺陷临时禁止这些名称。

`watermark.test.ts` 加特殊名称与普通 ID 混合样本，断言 `Object.keys` 精确、`Object.hasOwn` 为 true、最大 seq 正确、canonical JSON 后键仍存在；T4 加 exporter→reader 正例，T8 加对应 `device-sequence:__proto__` / `:constructor` / `:toString` clock key 用例。这些是普通回归，不改变冻结的 11 + 3 数量。

---

### T8: `restoreLedger` 原子写入

按 §3.9 定义类型；`openLedgerRepository` 返回 `Promise<LedgerRepository & LedgerRestorer>`。

必须的测试：

1. `newDeviceId` 为空串 → 抛错、零写入；
2. `newDeviceId` 全空白 → 抛错、零写入；
3. `newDeviceId` 首尾含空白 → 抛错、零写入（**不 trim**，§3.8）；
4. `newDeviceId` 落在 `forbiddenDeviceIds` 内 → 抛错、零写入；
5. `newDeviceId` 恰好等于 `manifest.exportedByDeviceId`（但不在任何事件里）→ 仍须抛错——单独一条，这正是"只查事件集"会漏掉的情形；
6. **目标库 `events` 非空** → 抛错、零写入；
7. **目标库 `contexts` 非空**（events 空）→ 抛错、零写入；
8. **目标库 `clock` 非空**（events 与 contexts 均空）→ 抛错、零写入。这条不是凑数：`reserveEventCoordinates` 会在没有任何事件时写 clock，"打开过但没采集"的库正是这个形态；
9. 上述 6–8 的错误消息必须说明是**"目标库非空"**，不是"内容相同所以跳过"（切片 §5.2.1 第 2 条）；
10. 成功后三个 store 内容正确，图片 Blob 逐字节等于输入字节，且 `blob.type === mediaType`；
11. **clock 写入精确**：`global-hlc` 严格大于 `input.globalHlc`；`input.maxSeqByDevice` 每个历史设备都有 `device-sequence:<id>` 记录且值正确；**`newDeviceId` 没有 `device-sequence` 记录**；**clock 的键集合恰好是** `{"global-hlc", "restore-commit"} ∪ {"device-sequence:<id>" | id ∈ maxSeqByDevice}`，多一个键即失败；
11a. **durable commit marker**（§3.10.4）：`committedAt` 在开事务前生成并通过 canonical UTC 校验；同一事务写入精确 `RestoreCommitRecord`。close/reopen 后只读 accessor 必须读出完全相同的 record；事务失败时 marker 必须不存在；marker reader 对缺字段、错误 `type`、非法时间、额外字段或非 canonical id 抛专属错误；
11b. **prototype-name 水位**：输入含 `__proto__`、`constructor`、`toString` 历史设备时，clock 必须分别存在正确的 `device-sequence:<id>` 记录，不能被对象原型吞掉；
12. 写入中途失败（注入会抛的 put）→ 事务 abort、目标库逐条不变；
13. **同一输入连续恢复两次**：首次成功；第二次因非空被拒；拒后逐条不变（切片 §5.2.1 四条）；
14. 既有 `appendCapture` 全部测试无回归（§3.7）；
15. 既有只实现 `LedgerRepository` 的 mock 仍然编译（§3.9）。

实现红线：Blob 转换在开事务前；事务 scope 恰好 `["events", "contexts", "clock"]`；事务内零非 IDB `await`；三 store 空库检查在事务内复检。

---

### T9: 开放 `structurallyEqual`（package-internal）

`repository.ts:642` 加 `export`，函数体不动，**不进 `index.ts`**。注释写明"供同包内恢复等价验证使用，不是通用工具，也不是公共 API"。测试：Blob 逐字节、仅媒体类型不同判不等、嵌套记录。

---

### T10: 等价验证器（分层 failure code，不首错短路）

```ts
export type EquivalenceFailureCode =
  | "L1_STORE_UNCLASSIFIED"
  | "L1_STORE_KEYSET"
  | "L1_EVENTS_MISMATCH"
  | "L1_CONTEXTS_MISMATCH"
  | "L2_ITEM_VIEW"
  | "L2_REVIEW_QUEUE"
  | "L3_IDENTITY"
  | "L3_CLOCK"
  | "L3_RESTORE_COMMIT";

export interface EquivalenceFailure {
  readonly code: EquivalenceFailureCode;
  readonly detail: string;
}

export interface EquivalenceReport {
  readonly ok: boolean;
  readonly failures: readonly EquivalenceFailure[];
}
```

**必须跑完全部层再返回，不得首错短路。** 否则一个 L1 差异会掩盖 L2/L3 是否真的执行过，而"某层从未运行"与"某层通过"在只看 `ok` 时无法区分。必须有一条测试：制造同时触发 L1 与 L2 的差异，断言 `failures` 里**两个 code 都在**。

**L1**：按 `db.objectStoreNames` **动态枚举**。`events` / `contexts` 属精确相等类（`structurallyEqual`，Blob 逐字节）；`clock` 属具名语义类（交给 L3）；**任何未分类 store 产出 `L1_STORE_UNCLASSIFIED` 并判失败**。必须有一条测试：在现有 `events` / `contexts` / `clock` 之外临时加**第四个未知 store**，断言验证器失败。

**L2**：`deriveLedger` 的完整 `ItemView` 逐字段相等 → `L2_ITEM_VIEW`；复习队列序列 → `L2_REVIEW_QUEUE`（探针注入）。

**L3（全部只读，不得改动被验证的库）**：验证器输入显式携带 `expectedNewDeviceId`，不得从 marker 反推期望身份。

- `global-hlc` 已持久化且**严格大于**包内最大 HLC；
- 每个历史设备的 `device-sequence:<id>` 水位已持久化且值正确；
- **`newDeviceId` 不存在 `device-sequence` 记录**；
- **clock 的键集合精确等于** `{"global-hlc", "restore-commit"} ∪ {"device-sequence:<id>" | id ∈ maxSeqByDevice}`——新身份的 `device-sequence` 键、任何多余的旧身份键都不得存在；
- `restore-commit` 必须通过 §3.10.4 的封闭 shape/canonical 校验，且 `record.newDeviceId === expectedNewDeviceId`。marker 缺失、错误 id、缺 `committedAt`、非法时间、错误 `type`、额外字段均产出专属 **`L3_RESTORE_COMMIT`**，不能混入泛化 `L3_CLOCK`；
- `clock` store 被清空 → 专属 **`L3_CLOCK`**，不得只表现为泛化的"某处不等"。

**"首次 reserve 返回 seq === 1" 必须在一次性克隆库上测**，绝不能在正式恢复库上调 `reserveEventCoordinates`——那会写 clock、污染刚恢复的账本，让验证行为本身改变被验证对象。提供 `cloneLedgerDatabase(sourceName, targetName)` 助手，reserve 只在克隆上跑。

```ts
export type ReviewQueueProbe = (
  view: LedgerView,
  snapshot: LedgerSnapshot,
  budget: number,
) => readonly {
  readonly itemId: string;
  readonly channel: string;
  readonly prompt: string;
  readonly reveal: unknown;
}[];
```

---

### T11: apps/web 集成测试（复核依赖边界）

**Files:** 新建 `apps/web/src/features/ledger/restoreIntegration.test.ts`

exchange 与 storage **互不依赖**，所以两者的集成只能在同时依赖它们的地方验证。T3a 已把 `@tenjin/exchange` 作为 devDependency 加入 `apps/web`、更新 lockfile，并让 web 的 `pretest` / `pretypecheck` / `prebuild` 构建 exchange。T11 不得重复安装、改 scripts 或改 lockfile，只复核这些前置仍成立：

- [ ] **Step 1: 验证 T3a 已留下 devDependency**

```json
"devDependencies": {
  "@tenjin/exchange": "workspace:*",
  ...
}
```

必须仍是 devDependency 而非 dependency：生产代码不引用它，只有 QA probe 与集成测试引用。若缺失，说明 T3a checkpoint 不完整，应回到 T3a 修复；不得在 T11 静默补装并掩盖前一 Gate 的缺口。

- [ ] **Step 2: 复核三个 pre 脚本仍同时构建 exchange 与 storage**

```json
"pretest": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
"pretypecheck": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
"prebuild": "pnpm --workspace-concurrency=1 --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build"
```

用多个 `--filter` 而不是 `&&`：避免依赖 shell 的链式语法。**必须保留 `--workspace-concurrency=1`**，因为两个 sibling 包各自的 `prebuild` 都会构建 core；并行运行会让两个 `tsc` 同时写 `packages/core/dist` 与同一个 `tsconfig.tsbuildinfo`。这里要求单写者串行执行，而不是依赖本机时序碰巧不冲突。

从清理掉所有 workspace `dist/` 的干净 checkout 至少完整跑一次 web 的 `test` / `typecheck` / `build`，三条都必须退出 0；不得用已有 `dist/` 证明脚本正确。

- [ ] **Step 3: 集成测试六块内容**

1. **结构兼容编译期断言**：把 exchange 产出的 `LedgerRestorePlan` 赋给 storage 的 `RestoreLedgerInput`。两个包互不依赖，这是唯一能证明它们没漂移的地方。

```ts
// A compile-time bridge, not a runtime assertion: neither package may import
// the other, so this is the only place that can prove their shapes line up.
// If it stops compiling, one side drifted.
const _restoreInputIsStructurallyCompatible: RestoreLedgerInput = plan;
```

2. **真实摘要 + 真实往返**。这个文件必须**指定 Node 环境**——`apps/web` 默认跑 jsdom，而 jsdom 的 `crypto.subtle` 支持不可依赖：

```ts
// @vitest-environment node
```

并且在跑往返之前，先按顺序做两条**前置断言**：

```ts
it("has a usable WebCrypto digest before any of this means anything", async () => {
  // Guard the guard. If crypto.subtle were missing or wired wrong, a round-trip
  // test could still pass by comparing two equally-wrong digests. These two
  // assertions are what make the real-digest claim below worth anything.
  expect(globalThis.crypto?.subtle).toBeDefined();

  // NIST FIPS 180-2 vector for "abc".
  const digest = await sha256Hex(new TextEncoder().encode("abc"));
  expect(digest).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
```

只有这两条通过，才跑完整链路 export → 校验 → restore → 等价验证。**exchange 单测用的是假摘要（§3.2），真实摘要的接线正确性只在这里被证明**——注释必须写明这个分工，否则后人会以为 exchange 已经验过真实 SHA-256。
3. **真实 undo 往返**（must-not-fail 第 3 条）：用真实采集路径造 capture，再用真实 `appendDiscard` 撤销（它会 GC 掉 context），然后 export → restore → 等价验证全绿。
4. **真实 `buildReviewQueue` 探针**：断言源库与恢复库产出相同的 `(itemId, channel, prompt, reveal)` 序列，并**断言探针确实被调用了两次**（源库一次、恢复库一次）——一个从不调用探针的实现同样会报"序列相同"。
5. **专属 failure 正向对照**：制造会改变复习队列的差异，断言 `failures` 里**出现 `L2_REVIEW_QUEUE`**，而不是只出现 `L1_CONTEXTS_MISMATCH` 就算数。
6. **marker 关闭重开对照**：真实 restore 后 close/reopen，用公开只读 accessor 读取 marker，核对封闭 shape、canonical `committedAt` 与 `newDeviceId`；再分别注入 mismatch/malformed，断言 `L3_RESTORE_COMMIT` 而非仅键集合失败。

---

### T12: 负样本矩阵（11 条）与 must-not-fail（3 条）

**Files:** `packages/exchange/src/negativeMatrix.test.ts`（包级）；写事务 / DB 级变异放 `packages/storage-indexeddb/src/restore.test.ts`

每条必须写清：**突变在哪一层 / 预期由哪条不变量拒绝 / 预期错误类型或 failure code / 红灯来自目标断言的证据**。

| # | 变异 | 层 | 预期拒绝者 | 预期错误 |
|---|---|---|---|---|
| 1 | 删掉某 context 的 `answer` 键 | package | T6 重算 context hash 不匹配 | `TypeError` / `hash` |
| 2 | 改某事件 `recordedAt` 1 毫秒 | 恢复后 DB | T10 L1 events 精确相等 | `L1_EVENTS_MISMATCH` |
| 3 | 图片少一字节 + 重算 `sha256` 自洽 | package | T6 重算 context hash / 条目名≠hash | `TypeError` / `hash` |
| 4 | 200 条事件删 1 条 | package | T4 `eventCount` 与实际不符 | `TypeError` / `eventCount` |
| 5 | 包被截断 | package | 解包抛错，且**旧库逐字未变**（L0） | 抛错 + 库不变 |
| 6 | manifest 写未知 `schemaVersion` | package | T4 | `TypeError` / `schemaVersion` |
| 7 | 重复 `eventId` 但内容不同 | package | T5 唯一性 | `TypeError` / `eventId` |
| 8 | 清空 `clock` store | 恢复后 DB | T10 L3 | **`L3_CLOCK`**（专属） |
| 9 | 篡改 manifest 的 `maxSeqByDevice` | package | T4 水位与事件不符 | `TypeError` / `maxSeq` |
| 10 | **恢复后 `clock` 的 `global-hlc` 低于包内最大 HLC** | clock | T10 L3 | `L3_CLOCK` |
| 11 | **篡改 `events.jsonl` / `manifest.json` 的压缩数据、不更新 CRC，且解压后仍是合法 UTF-8 / JSON / 通过 schema** | package | T3 生产读包器（T0-G4 先证 raw + mapping） | **`CRC_MISMATCH`**，且 `cause` 为 zip.js `ERR_INVALID_SIGNATURE` |

第 11 条是唯一能证明"CRC 校验真的在跑"的测试——其余全部校验对它无感，因为它构造成处处合法。

**伪造 central `uncompressedSize` 的 zip bomb 保留为 T3 单测**（旧 fflate 草案称 `originalSize`；不占矩阵编号），但**必须存在**；它与第 11 条守的是两件不同的事：前者是体积，后者是完整性。

**三条 must-not-fail（必须仍然 PASS）：**

1. `events.jsonl` 行序打乱 → 恢复成功且等价验证全绿；
2. events 各行内 JSON **对象键序**打乱 → 恢复成功且等价验证全绿；
3. **真实 undo 正例**（落在 T11 集成测试）：真实 `appendDiscard` 撤销并 GC 掉 context 之后，export → restore → 等价验证全绿。守的是 T5.1：含"已撤销 capture 且 context 已 GC"的**合法**账本绝不能被误判为损坏。

前两条同时说明了为什么 round-trip 字节比对**不能**作为唯一 oracle：它们都改变了包的字节，却都是合法输入。

**变异操作的硬纪律**（本仓已两次踩坑）：

- 还原用**文件字节副本**或安全临时目录，**绝不对未提交改动用 `git checkout`**——那会把尚未提交的修复一起还原，之后的"全绿"是在未修复代码上跑的；
- **不得**用 PowerShell 5.1 的 `Get-Content -Raw` / `Set-Content` 改写含日文的 UTF-8 文件——它按 ANSI(cp936) 读，写回即乱码，突变体会死在**语法错误**上而不是目标断言上；含非 ASCII 的文件用 Edit 工具，或 `[System.IO.File]::ReadAllBytes` + `UTF8.GetString`；
- **红灯必须来自目标断言**。每次变异后确认失败原因是预期那条，而不是语法错误、fixture 被更早的校验先拦下、编码损坏或跑错命令。

**跨时区测试卫生**：切时区的测试必须在测试内**显式建立"初始无 `TZ`"的已知起点**（先记录并 `delete process.env.TZ`），不依赖 CI 宿主；`finally` 里先写回解析出的系统时区（这一步才刷新 Node 缓存），再把环境变量恢复原样，**双轴断言**：有效时区回来了 + `process.env.TZ` 与原值全等。已知事实：`delete process.env.TZ` 单独使用**不能**恢复系统时区。

---

## 5. Gate

**exchange 类型边界是独立 Gate**（§3.5），必须单独跑并退出 0：

```bash
pnpm --filter @tenjin/exchange typecheck
pnpm --filter @tenjin/exchange build
pnpm --filter @tenjin/exchange exec tsc -p tsconfig.public-api.json
```

第三条必须使用 `lib: ["ES2023"]`、`types: []`、`skipLibCheck: false`；否则不能声称公共声明没有泄漏 DOM/Node/vendor 类型。

全仓四条，全部退出 0：

```bash
pnpm --workspace-concurrency=1 --recursive --if-present typecheck
```

```bash
pnpm lint
```

```bash
pnpm --workspace-concurrency=1 --recursive --if-present build
```

```bash
pnpm --workspace-concurrency=1 --recursive --if-present test
```

这里刻意绕过根 `typecheck` / `build` / `test` wrapper：根脚本目前使用默认并发的 `pnpm --recursive`，会让 exchange/storage 两个 sibling 的 pre 脚本同时构建 core。`--workspace-concurrency=1` 是全仓 Gate 的单写者约束，不能省略。另加 `git diff --check` 干净。

**`CROSS-REVIEW.md` Gate（定义已更正）**：它是用户自有的**未跟踪**文件，因此它**本来就会**出现在 `git status` 里（`?? CROSS-REVIEW.md`）——要求"不出现在任何 git status 输出里"是错的。正确判据是**三项与工作开始时一致**：

1. **存在状态**一致（存在 / 不存在）；
2. **git 状态**一致（仍为未跟踪 `??`，未被 stage、未被提交、未被删除）；
3. **内容指纹**一致（SHA-256 相同）。

且全程**不得 edit / stage / delete**。用 `Get-FileHash` 取指纹即可，无需读取内容。

**本机注意**：裸 `pnpm` 可能不在 PATH（只有 `corepack`），而仓库的 pre 脚本会调用裸 `pnpm`。用临时目录 shim 转发，**每次 PowerShell 调用都要重新前置 PATH**：

```powershell
$shim = Join-Path $env:TEMP "tenjin-pnpm-shim"
New-Item -ItemType Directory -Force $shim | Out-Null
Set-Content -Path (Join-Path $shim "pnpm.cmd") -Value "@echo off`r`ncorepack pnpm %*" -Encoding ascii
$env:PATH = "$shim;$env:PATH"
```

不要往 `AppData\Roaming\npm` 写东西，也不要硬编码 Corepack 缓存路径。

---

## 6. owner 已决事项（不得再自行更改）

| # | 事项 | 决定 |
|---|---|---|
| 1 | T1 触碰 `ledgerRuntime.ts` / `createCapture.ts` | **批准**，限纯序列化提取 |
| 2 | T3a/T11 新增 apps/web QA probe 与集成测试；T3a 加 devDependency、改三个 pre scripts 与 lockfile，T11 只复核并加测试 | **批准**，仅 QA/测试入口与依赖声明，不加入生产 PWA input；`apps/web/package.json` 归 T3a，`pnpm-lock.yaml` 只归 T0/T3a，T11 均不触碰 |
| 3 | `structurallyEqual` 导出面 | **package-internal named export**；不进 root `index.ts`，不建 `/testing` |
| 4 | `newDeviceId` 来源 | **调用方生成并传入**；storage 永不生成；必须 canonical（非空 / trim 后非空 / `value === value.trim()`） |
| 5 | 禁用集合 | 事件全部 `deviceId` ∪ `manifest.exportedByDeviceId` |
| 6 | localStorage 与 IndexedDB 一致性 | 由 §3.10 的 bootstrap/锁/marker 绑定状态机保证；本轮只交付后端 |
| 7 | 单图 20 MiB | **正式产品约束** |
| 8 | 其余限额 | **provisional security ceilings**，是拒绝阈值不是支持容量 |
| 9 | ZIP64 | 本轮不引入；`entries <= 65_535`、`contexts <= 32_766` |
| 10 | 最低支持设备 | **用户实际在用的 iPhone**。T3a 先守 browser bundle/runtime；具体 iPhone 属最终 G5b 与限额冻结输入，**不阻塞后端达到 BACKEND_READY / LIMITS_PROVISIONAL，但阻塞 A1 完成** |
| 11 | exchange 测试用 crypto | **禁用 `node:crypto`**；用注入式确定性假摘要或预计算 fixture；真实摘要由 T11 集成测试证明 |
| 12 | `TextDecoder` 窄声明 | **按 §3.5 当前写法执行**；若将来别处引入 `@types/node` 导致冲突，届时由 exchange 独立 typecheck 暴露并收敛 |
| 13 | `events` 上限 200,000 | 保持 **provisional ceiling**，等真机数据再校准，不作为待决问题 |
| 14 | 交付口径 | **BACKEND_READY / LIMITS_PROVISIONAL**；不得声称 A1 完成 |
| 15 | **CRC 路线** | **已冻结为 B-reader-only**：写侧保留 fflate、导出字节合同一字不改；读侧精确锁 `@zip.js/zip.js@2.8.34` 根入口与 §3.3 配置。exchange 新增且仅新增这一个运行时依赖 |
| 16 | **恢复提交判据** | **durable commit marker**（§3.10.4），与恢复数据同事务提交；只有“合法 marker 存在且 `marker.newDeviceId === pendingRestoreDeviceId`”才能判 `COMMITTED` |
| 17 | **G5 分层** | T0 只做 Node/vendor/type Gate；T3a 做独立 browser bundle/runtime；真实 iPhone PWA 离线往返留在切片最终 G5b。不得把未执行的真机步骤写成 T0 PASS |

## 7. 仍需 owner 决定的问题

**无。** 上一版唯一的阻塞项（CRC 路线）已冻结为 B-reader-only。

余下的**不是决定而是 Gate**：T0 的 G0–G4 + G6 必须全绿，才可启动 T1/T2；T2 完成后才可进入 T3；T3a-G5a 全绿才可进入 T4。任一项失败即停止并上报，**不得自动改走路线 A，不得放宽任何安全边界**。最终 G5b 未过时只能保持 `BACKEND_READY / LIMITS_PROVISIONAL`。

---

## 8. 自检结果

**规格矛盾**：对照切片 v1.6 逐条核。抽象模式只出现在"必须拒绝"语境（T4）；恢复语义按切片 §5.2.1 四条写进 T8 测试 13；"零写入风险"的错误措辞已在切片 §7.2 作废；交付口径统一为 BACKEND_READY / LIMITS_PROVISIONAL；负样本数量均为 11 + 3；CRC 路线、T0 独占、G5a/G5b 分层与 marker/pending 绑定已机械同步。

**永远 PASS 的断言**：① 压缩输入超限必须在 reader factory 前拒绝；② 声明展开量超限必须保持 `getData` 零调用；③ 伪造 `uncompressedSize` 由实际输出计数 + abort 抓住；④ CRC 同时钉住原生 `ERR_INVALID_SIGNATURE` 与项目映射；⑤ G6 用 `skipLibCheck: false` 的 dist consumer，不能只看 source typecheck；⑥ UTF-8 必须 fatal；⑦ 摘要自洽用“改字节同时改摘要”反例；⑧ 真实摘要先核 NIST 向量；⑨ 复习队列探针调用两次并有专属 failure；⑩ 不首错短路；⑪ storage 空库与 UI pre-pending 各有三种单-store 用例；⑫ marker 必须封闭校验并绑定 pending；⑬ manifest 只允许一个共享 shape validator，并用完整 `exportLedgerPackage → readPackage → validateManifest` 自兼容测试守住；⑭ prototype-name deviceId 必须穿过 watermark/export/restore/clock 全链路。

**错误 fixture**：T6 负样本必须用**生产形状**摘要（context hash 为 `sha256:` + 64 位小写 hex，image sha256 为裸 64 位 hex）。导出器那轮的教训是短摘要 fixture 会被更早的格式校验先拦下，目标断言从未执行。

**事务自动提交**：§3.6 写死"事务内不得 await 非 IndexedDB Promise"并给出既有代码先例；T8 实现红线重复一遍。

**未知 store 漏检**：T10 要求动态枚举 + 分类穷尽 + 未分类即 `L1_STORE_UNCLASSIFIED`，并强制在现有三个 store 之外"临时加第四个未知 store 必须失败"的测试。

**验证器污染被验证对象**：T10 的 L3 全只读；"首次 reserve seq === 1"只在一次性克隆库上跑。

**依赖边界**：exchange 与 storage 互不依赖，集成只在 `apps/web`；T3a 同批加入 exchange devDependency、独立 QA probe，并把 `pretest` / `pretypecheck` / `prebuild` 改为用 `--workspace-concurrency=1` 串行构建两个包；T11 只复核并加集成测试。否则 T3a 自己就会在 clean checkout 的 web/root typecheck 或 build 中因缺失 `dist/` 失败，而并发构建又会让两个包的 `prebuild` 同时写 core 产物。

## 9. 变更记录

| 版本 | 变更类型 | 变更内容 | 经办人 | 时间 |
|---|---|---|---|---|
| v1.0 | 初稿 | 冻结恢复器 + 等价验证器 + 负样本矩阵的 12 个 TDD 任务、文件写集、依赖图、关键设计决定与待决问题 | Fable 5 | 2026-08-07 |
| v1.1 | 收口 | active-capture 引用规则、`ContextRecord` 全约束、`eventId` 形状与排序、Clock Gate 只读化、类型边界、`TextDecoder` 窄声明、ZIP 流式实际产出、分层 failure code、限额分类、身份与激活协议 | Fable 5（据 Codex 复审） | 2026-08-07 |
| v1.2 | 收口 | T11 纳入 `apps/web/package.json` 与 `pnpm-lock.yaml` 写集并改三个 pre 脚本；exchange 测试禁用 `node:crypto`；新增 §3.3 CRC 完整性（两条路线、阻塞 T3、矩阵第 11 条）；恢复 clock 负样本并把 forged size 降为 T3 单测，矩阵定为 11 + 3；身份收紧为三条 canonical 校验；空库改为三 store `count === 0` 并加三方向负例；L3 加 clock 键集合精确断言；T6 补 `byteLength` 下界、`blob.type === mediaType`、trim 非空；T4 展开 manifest 全字段表；新增 §3.10 UI 激活状态机与 U1/U2 Gate；机械同步（切片 v1.3、CROSS-REVIEW Gate 定义、状态改"计划待审"、最低支持设备、`TextDecoder` 与 `events` 上限移出待决） | Fable 5（据 Codex 复审） | 2026-08-07 |
| v1.3 | 收口 | **CRC 路线冻结为 B-reader-only**（写侧保留 fflate、导出字节合同不动；读侧新增 `@zip.js/zip.js`），并新增 **T0 硬 Gate**（G1 严格模式 / G2 加密·multi-disk·ZIP64·不支持压缩法的拒绝清单 / G3 计数 WritableStream + AbortSignal 按实际产出限额 / G4 CRC_MISMATCH / G5 Node 与目标 Safari 双路径 / G6 ES2023 无 DOM 类型边界），失败即停不得改走 A；同步清理"不得新增运行时依赖"与"B 要替换 exporter"两处旧说法。**修 UI 激活状态机**：可写 runtime 全程持 shared lock、恢复方先让位再取 exclusive lock、验空移到写 pending 之前、`COMMITTED` 改由 durable commit marker 判定（连带 T8 写 marker、T10 键集合含 `restore-commit`），新增 U3。T4.1 消除 exporter↔reader 漂移（`exportedByDeviceId` canonical、`exportedAt` 往返比对、非法闰日与自兼容测试），`manifest.ts` 纳入写集。T11 指定 Node 环境并先验 `crypto.subtle` 与 NIST 向量 | Fable 5（据 Codex 复审） | 2026-08-07 |
| v1.4 | 收口 | T0 改为独占 Phase 0；精确锁 zip.js 版本/根入口/运行配置，worker/reader/entry options 逐次显式传入并以 G0 防死常量（含 `transferStreams` 不能只走全局 `configure()`），补 filename-only strict/balanced 完整控制、archive/entry 两类 multi-disk、entry/archive 两类 ZIP64、EOCD 相对定位与 magic-byte 负控制、CRC raw+mapping、三层限额与 `skipLibCheck:false` dist consumer；actual-output Gate 使用 header 声明恰等 cap、真实输出 cap+1 的 vendor fixture，并以 sticky `limitExceeded` 保证 `PACKAGE_OUTPUT_LIMIT` 不被 vendor size/abort/close 错误覆盖。将原不可执行 G5 拆成 T3a browser Gate 与最终 iPhone G5b，T3a 用 pre-module Worker spy + 全新 profile 的首次离线执行 + Network log 守住 worker 内部请求盲区。条目枚举冻结为 `getEntriesGenerator()`，逐 yield 执行项目 whitelist/duplicate Gate并在正常路径完整 exhaust，避开 strict `getEntries()` 在返回前抢先抛错。修复自身 shared→exclusive 自锁、锁内重读 bootstrap 状态、marker/pending 绑定与 U3 单-store 矩阵；writer/reader 共用完整 manifest shape validator；watermark 改为 prototype-safe 并补特殊 deviceId 全链路；events 改为先逐条验证再排序；T3a 前移 web 依赖与 pre 脚本，并用单并发串行构建消除 clean-checkout 与 core 产物竞态；机械同步依赖图、第四个未知 store与变更顺序 | Codex | 2026-08-07 |
