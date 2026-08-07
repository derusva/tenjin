# A1 账本恢复器与等价验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `.tenjin` 完整备份包能被严格校验并原子恢复到**空账本**，并交付一套能失败的独立等价验证器 + 10 条负样本 + 3 条 must-not-fail，补齐 `HANDOFF.md` 阶段 A1 Gate 的后端部分。

**Architecture:** 三层，边界即责任。`@tenjin/exchange` 保持纯函数、无 DOM、无 IndexedDB、无 Node 依赖，负责**解包与全部校验**，产出已验证的 `LedgerRestorePlan`（普通数据，图片为 `Uint8Array`）；`@tenjin/storage-indexeddb` 定义自己的输入类型并负责**原子写入**与**原始读取**，`Uint8Array → Blob` 转换与全部摘要计算都在**开启事务之前**完成；等价验证器住在 storage 层（它需要 idb 原始读取与 `structurallyEqual`），复习队列构造函数由调用方注入，避免 storage 反向依赖 `apps/web`。**两个包互不依赖**，靠结构兼容 + 一条编译期断言绑定。

**Tech Stack:** TypeScript（NodeNext、strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）、Vitest、fflate、idb、fake-indexeddb。

**基线：** `fa4e048`。切片总定义见 [`docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`](../../decisions/2026-08-05-a1-ledger-recovery-slice.md)（v1.2）。

**交付口径（不可含糊）：** 本计划完成后只能声称 **BACKEND_READY**——恢复能力在后端可用并已验证。**不得**声称"端到端恢复已交付"或"A1 Gate 已过"，因为 §3.8 的激活协议要到 UI 切片才落地，在那之前用户无法完成一次真实恢复。

---

## 0. 本计划明确不做

以下每一项都**不得**在任何任务中出现，即使"顺手就能加"：

- Web 数据页按钮或任何 UI；真机 runbook 的执行；
- Coach JSON 导入；`focus` 字段；DB 升到 v3；`importReceipts`；
- **非空账本恢复或任何形式的 merge / 去重 / 覆盖**（切片 §5.2.1 第 4 条）；
- `abstract-exchange` 模式的任何部分；
- 复习时间预算改造；教学或引导 UI；
- `newDeviceId` 的生成与 localStorage 写入（属 UI 切片，见 §3.8）。

`packages/exchange` 不得新增运行时依赖，也不得整包引入 DOM lib 或 `@types/node`。

---

## 1. 文件写集

任务只能改动下表列出的文件。任何越界都必须停下并上报，不得自行扩大。

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/core/src/contextHash.ts` + `.test.ts` | 新建 | T1 |
| `packages/core/src/index.ts` | 追加 export | T1 |
| `apps/web/src/features/ledger/ledgerRuntime.ts` | 复用 core 序列化（**仅此**） | T1 |
| `apps/web/src/features/capture/createCapture.ts` | 复用 core 类型（**仅此**） | T1 |
| `packages/exchange/src/limits.ts` + `.test.ts` | 新建 | T2 |
| `packages/exchange/src/exportPackage.ts` | 追加导出前限额预检 | T2 |
| `packages/exchange/src/decodeUtf8.ts` + `.test.ts` | 新建 | T3 |
| `packages/exchange/src/readPackage.ts` + `.test.ts` | 新建 | T3 |
| `packages/exchange/src/validateManifest.ts` + `.test.ts` | 新建 | T4 |
| `packages/exchange/src/validateEvents.ts` + `.test.ts` | 新建 | T5 |
| `packages/exchange/src/validateContexts.ts` + `.test.ts` | 新建 | T6 |
| `packages/exchange/src/restorePlan.ts` + `.test.ts` | 新建 | T7 |
| `packages/exchange/src/index.ts` | 追加 export | T2–T7 |
| `packages/exchange/src/negativeMatrix.test.ts` | 新建 | T12 |
| `packages/storage-indexeddb/src/restore.ts` + `.test.ts` | 新建 | T8 |
| `packages/storage-indexeddb/src/repository.ts` | 开放 `structurallyEqual`（package-internal）；`openLedgerRepository` 返回类型加交集 | T8、T9 |
| `packages/storage-indexeddb/src/repository.test.ts` | 追加 | T9 |
| `packages/storage-indexeddb/src/verifyEquivalence.ts` + `.test.ts` | 新建 | T10 |
| `packages/storage-indexeddb/src/index.ts` | 追加 export（**不含** `structurallyEqual`） | T8、T10 |
| `apps/web/src/features/ledger/restoreEquivalence.test.ts` | 新建（**仅测试**） | T11 |

**绝对不得触碰：** `CROSS-REVIEW.md`。

## 2. 任务依赖

```text
T1 ─> T6
T2 ─> T3 ─> T4 ─┐
          T5 ───┼─> T7 ─> T8 ─> T9 ─> T10 ─┬─> T11
          T6 ───┘                          └─> T12
```

T1 与 T2 可并行；其余严格串行。

---

## 3. 关键设计决定（不得自行更改）

### 3.1 context hash 序列化必须先提取到 core

恢复器要**重新计算** context hash，而唯一决定该 hash 的序列化在 `apps/web/src/features/ledger/ledgerRuntime.ts` 的 `hashContext` 里：**固定字面量顺序**的四字段对象（`original` → `corrected?` → `answer?` → `imageSha256?`），缺省字段整键省略。它与 `canonicalJson`（递归排序键）**完全不是一回事**，绝不可互相替代。

exchange 不能依赖 apps/web；照抄一份会静默漂移，而漂移的表现是恢复期 hash 误判。所以 T1 把**序列化**（不含摘要计算）提取到 core。

**owner 已批准触碰 `ledgerRuntime.ts` 与 `createCapture.ts`，且严格限于纯序列化提取。** 这是零行为变化的重构：`ledgerRuntime.test.ts` 里三条钉死精确序列化串的断言**一行不许改**，它们就是守卫；任何一条变红说明历史 hash 被改变，立即回退重做。

### 3.2 摘要函数注入，不内置

core 与 exchange 都不得引入 crypto 依赖：

```ts
export type Sha256Hex = (input: Uint8Array) => Promise<string>;
```

返回**小写十六进制、无前缀**。测试用 `node:crypto`，浏览器侧由调用方用 `crypto.subtle` 提供。`hashContext` 摘要的是**序列化字符串的 UTF-8 字节**，必须与现行行为逐字节一致（T1 守卫覆盖）。

### 3.3 ZIP 防护：中央目录预检 + 流式二次解压，按**实际产出**计量

**第一遍（不解压）**：`unzipSync(bytes, { filter })`。已从 `fflate@0.8.3` 类型定义确认 `UnzipFileFilter = (file: UnzipFileInfo) => boolean`，`UnzipFileInfo` 含 `name` / `size` / `originalSize`，返回 `false` 即跳过解压。此遍记录全部条目用于**条目名白名单、重复条目检测、声明体积上限**。

**第二遍（流式）**：**不得**再用 `unzipSync` 一次性解压。必须用流式 API（`new Unzip()` + `register(UnzipInflate)` + `onfile` + `file.ondata(err, chunk, final)` + `push(chunk, true)`），**按实际产出的字节累计**单条目与总量，**一旦超限立即 `terminate()` 并抛错**。

为什么必须这样：中央目录里的 `originalSize` 是**攻击者可控的声明值**，不是事实。一个伪造成"很小"的条目完全可以在解压时展开出几百 MB——只信第一遍就等于没有防护。第一遍挡的是"诚实声明的大包"，第二遍挡的是"撒谎的包"，两者都必须有。

实现者必须先核对 `UnzipFile.start()` / `terminate` 与 `UnzipInflate` 在本仓装的 fflate 版本里的确切名字；**若与此处描述不符，停下上报**，不得退回一次性解压。

### 3.4 条目名用白名单，不用黑名单

合法条目**恰好**是：

```text
manifest.json
events.jsonl
redactions.jsonl
contexts/<64位小写hex>.json
contexts/<64位小写hex>.image
```

正则 `^(manifest\.json|events\.jsonl|redactions\.jsonl|contexts\/[0-9a-f]{64}\.(json|image))$`。白名单天然挡住路径穿越、绝对路径、反斜杠与任何未知条目。**不要**改成"检测 `..` 再放行其余"——那是黑名单，永远漏。

### 3.5 UTF-8 解码必须 fatal，且不为此扩大 exchange 的类型面

默认的非 fatal 解码器把非法字节静默替换成 U+FFFD，于是"非法 UTF-8"这条校验**永不触发**。必须 `fatal: true`。

但 `TextDecoder` 的类型来自 DOM 或 `@types/node`，而 exchange 刻意保持 `lib: ["ES2023"]`、既无 DOM 也无 Node 依赖。因此新建一个极窄封装 `packages/exchange/src/decodeUtf8.ts`，只声明用到的那一点点：

```ts
/**
 * TextDecoder is a runtime global in both browsers and Node, but its type
 * comes from DOM or @types/node. This package deliberately ships with
 * neither - pulling in either would weaken the boundary that keeps it usable
 * from both sides - so the one global we need is declared as narrowly as it
 * can be, right where it is used.
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

**`pnpm --filter @tenjin/exchange typecheck` 是本任务的独立 Gate**：它必须单独退出 0，证明这个声明没有把 DOM/Node 类型泄进包里。

### 3.6 事务纪律

- 全部摘要计算、`Uint8Array → Blob` 转换、全部校验，**必须在开启写事务之前完成**。
- 写事务内**不得 `await` 任何非 IndexedDB 的 Promise**。事务在微任务队列排空且无未决请求时自动提交，一次 `await crypto.subtle.digest(...)` 就足以让它提前提交，产出"报告成功的半批数据"——长得和成功一模一样。既有代码已在绕这个坑（`assertValidContextImageDigest` 刻意放在开事务前；事务内读 Blob 靠 keep-alive 循环）。
- **"目标库为空"必须在最终写事务内再查一次**。事务外预检是 check-then-act，双标签页或双击就能穿过去，而本仓明确处理多标签场景。
- 任何错误必须让事务 `abort`，零部分写入。

### 3.7 不放宽既有写入路径

`appendCapture` 的"恰好 1 条 `capture_created` 且其 `contextHash` 等于传入 context 的 hash"是承载 events↔contexts 引用一致性的核心不变量，**签名与断言强度一律不动**。恢复走全新方法，可抽私有 helper 共用幂等 put，但共用不得降低单条路径的强度。

### 3.8 身份：调用方生成，storage 只校验；激活协议已冻结

两个**互相独立**的存储，必须同时正确否则中毒：

| 存储 | 内容 | 谁负责 |
|---|---|---|
| localStorage `tenjin.deviceId`（`apps/web/src/main.tsx:18`） | 本安装当前使用的 `deviceId` | **调用方**（UI 切片） |
| IndexedDB `clock` store | `global-hlc` + 每设备 `device-sequence` 水位 | `restoreLedger` |

**owner 已定：`newDeviceId` 由调用方生成并传入，storage 层永不自己生成。** 理由：storage 若自己 `randomUUID()`，就凭空多出一个隐式身份来源，而真正的身份归属在 localStorage，两边各生成一次必然分叉。

`restoreLedger` 对 `newDeviceId` 的校验：

1. **必须已是 canonical 形式**——首尾有空白**直接拒绝**，不做 trim。静默 trim 会让"调用方存进 localStorage 的字符串"与"写进账本的字符串"不是同一个值。
2. **不得落在禁用集合内**。禁用集合 = 包内**全部事件的 `deviceId`** ∪ **`manifest.exportedByDeviceId`**。后者必须包含在内：导出设备可能一条事件都没有（例如导出后立刻恢复到同一台机器），此时它不在事件集里，却仍是一个真实用过的身份。
3. 命中任一条即抛错、零写入。

理由不是形式主义：`highWaterFromEvents` 在 clock 记录缺失时会从事件重建高水位；复用包内已有的 `deviceId`，新设备的 `seq` 会从历史高水位续发，而那些号可能已被别的副本用过——同 `eventId` 不同内容，交换时中毒且延迟触发。

**激活协议（冻结，UI 切片按此实现）：**

```text
1. 禁写      进入恢复流程后停止一切写入路径（采集、复习、撤销）
2. 写并读回   生成 newDeviceId → 写 localStorage 的 pendingRestoreDeviceId → 立即读回校验一致
3. restore   调用 restoreLedger(input, pendingRestoreDeviceId)
4. 提升      成功后把 pendingRestoreDeviceId 提升为 tenjin.deviceId
5. close     关闭 repository 连接
6. reload    重新加载应用
```

第 2 步的"写并读回"不是多余：若进程在第 3 与第 4 步之间死掉，`pendingRestoreDeviceId` 仍在，恢复流程可以用**同一个** id 续做，而不会对着一个已恢复的账本再铸一个新身份。第 5、6 步是因为运行中的 repository 持有旧连接与旧 `deviceId` 闭包，不重载就会用旧身份继续写。

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

**`LedgerRestorer` 必须是独立接口，不得把 `restoreLedger` 加进 `LedgerRepository`。** 原因是现实的：`apps/web` 的测试里有多个手写的 `LedgerRepository` mock（如 `App.test.tsx`），往接口上加方法会让它们全部编译失败，而那与恢复功能毫无关系。

`openLedgerRepository` 的返回类型改为 `Promise<LedgerRepository & LedgerRestorer>`，实现类同时满足两者。只依赖 `LedgerRepository` 的既有调用点与 mock 一律不受影响。

**exchange 侧** 的 `LedgerRestorePlan` 与 `RestoreLedgerInput` **结构兼容**但独立定义。绑定靠一条**编译期断言**，放在唯一同时依赖两个包的地方（`apps/web`，见 T11）：

```ts
// A compile-time bridge, not a runtime test: neither package may import the
// other, so this is the only place that can prove their shapes still line up.
// If it stops compiling, one side drifted.
const _restoreInputIsStructurallyCompatible: RestoreLedgerInput = plan;
```

**`structurallyEqual` 只作 package-internal named export**：从 `repository.ts` 导出供同包内的 `verifyEquivalence.ts` 使用，**不进 `packages/storage-indexeddb/src/index.ts`**，也**不新建 `/testing` 子入口**（那要动 `package.json` 的 `exports`，收益不抵成本）。

---

## 4. 任务

### T1: 把 context hash 序列化提取到 core

**Files:** 新建 `packages/core/src/contextHash.ts` + `.test.ts`；改 `packages/core/src/index.ts`、`apps/web/src/features/ledger/ledgerRuntime.ts`、`apps/web/src/features/capture/createCapture.ts`

- [ ] **Step 1: 先跑既有守卫并记录基线**

```bash
pnpm --filter @tenjin/web test ledgerRuntime
```

记录通过数。这些测试接下来**一行不许改**。

- [ ] **Step 2: 写失败测试**

`packages/core/src/contextHash.test.ts`：

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
    const serialized = serializeContextHashInput({
      imageSha256: "d".repeat(64),
      answer: "c",
      corrected: "b",
      original: "a",
    });
    expect(serialized).toBe(
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

- [ ] **Step 3: 运行确认失败**

```bash
pnpm --filter @tenjin/core test contextHash
```

- [ ] **Step 4: 实现**

`packages/core/src/contextHash.ts`：

```ts
/**
 * The exact input serialisation behind a context hash.
 *
 * This is content identity, not a formatting choice: the field order is a
 * fixed literal and absent fields are omitted whole. Reordering, sorting, or
 * emitting `null` for an absent field would change every hash ever computed
 * and orphan the existing ledger.
 *
 * Deliberately NOT `canonicalJson`, which recursively sorts keys and exists
 * only to make exported package bytes stable. Never substitute one for the
 * other.
 *
 * Lives in core so the capture path and the restore validator compute the same
 * bytes from one implementation instead of two that can drift.
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

`packages/core/src/index.ts` 追加 `export * from "./contextHash.js";`

- [ ] **Step 5: apps/web 复用**

`ledgerRuntime.ts` 的 `hashContext` 改为调用 `serializeContextHashInput(context)` 再 `options.digest(...)`；`createCapture.ts` 的本地 `CaptureContextHashInput` 改为复用 core 的 `ContextHashInput`（保留原名以免波及调用点）。**不改** `options.digest` 签名，**不改** `sha256:` 前缀拼接的位置。

- [ ] **Step 6: 双侧验证**

```bash
pnpm --filter @tenjin/core test
```

```bash
pnpm --filter @tenjin/web test ledgerRuntime
```

`ledgerRuntime` 的通过数必须与 Step 1 **完全一致**且全绿。任一精确序列化断言变红 → 立即回退。

- [ ] **Step 7: 提交**

```bash
git commit -m "refactor(core): share the context hash serialisation"
```

---

### T2: 限额常量与导出前预检

**Files:** 新建 `packages/exchange/src/limits.ts` + `.test.ts`；改 `exportPackage.ts`

**owner 已定的口径，必须逐字体现在注释里：**

- **20 MiB 单图是正式产品约束**（`MAX_CONTEXT_IMAGE_BYTES`），不是安全上限。
- **其余全部是 provisional security ceilings（临时安全上限）**——它们是**拒绝阈值**，**不得**在任何文档、注释或 UI 里被写成"Tenjin 支持 N 条 / N MB"。
- **不引入 ZIP64 时**：`entries <= 65_535`，`contexts <= 32_766`。这是**结构约束不是临时值**：不带 ZIP64 的中央目录最多 65,535 条；3 条固定条目 + 每个 context 最多 2 条，`2 × 32_766 + 3 = 65_535` 正好占满。
- **最终数值只有在最低支持的 iPhone 上、用文本重包与图片重包分别跑过每个上限的 80% 与 100% 边界验证之后，才可以冻结。** 在那之前它们是可改的。

```ts
export const PACKAGE_LIMITS = {
  /**
   * PRODUCT CONSTRAINT, not a security ceiling: the storage layer caps a
   * single capture image at 20 MiB (MAX_CONTEXT_IMAGE_BYTES).
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
   * PROVISIONAL SECURITY CEILINGS. These are refusal thresholds, nothing more.
   * Never quote them as supported capacity. They may only be frozen after
   * boundary validation at 80% and 100% of each, with both a text-heavy and an
   * image-heavy package, on the lowest supported iPhone.
   */
  compressedBytes: 100 * 1024 * 1024,
  decompressedBytes: 250 * 1024 * 1024,
  textEntryBytes: 64 * 1024 * 1024,
  metadataEntryBytes: 1 * 1024 * 1024,
  events: 200_000,
} as const;
```

**导出器必须共享同一份限额并在导出前预检**：`exportLedgerPackage` 在压缩前校验条目数 / context 数 / 每条目声明大小 / 解压总量，压缩后再校验压缩体积。否则会产出一个自家恢复器拒收的包。必须有一条测试证明"超限的账本导出即抛错，而不是产出一个不可恢复的包"。

---

### T3: UTF-8 严格解码、条目白名单、两遍读包

**Files:** 新建 `decodeUtf8.ts` + `.test.ts`、`readPackage.ts` + `.test.ts`

必须包含的测试（每条注释写清守什么）：

```ts
it("rejects a path traversal entry name", () => {
  // Whitelist, not blacklist: anything that is not exactly one of the five
  // legal shapes is rejected, so `../` never needs a special case.
});

it("rejects a duplicate entry name", () => {
  // unzipSync returns an object, so duplicates would silently collapse to the
  // last one. They must be caught in the first pass, where every central
  // directory record is still individually visible.
});

it("rejects invalid UTF-8 in a text entry", () => {
  // A non-fatal TextDecoder turns these bytes into U+FFFD and this check would
  // never fire.
});

it("accepts a missing or empty redactions.jsonl but rejects a non-empty one", () => {
  // redaction is not implemented; a non-empty tombstone file means the package
  // came from a version this one cannot faithfully restore.
});

it("rejects an entry whose declared originalSize exceeds its cap, without decompressing it", () => {
  // Must also assert decompression did not happen - a filter call counter, or
  // that the throw happened before any ondata fired. Otherwise an
  // implementation that decompresses first and checks after passes too.
});

it("rejects an entry that lies about originalSize and expands past the cap", () => {
  // The forged-size bomb: the central directory claims a small size, the
  // stream produces far more. Only the second pass, counting ACTUAL output,
  // can catch this. The failure must come from the output-size guard - assert
  // on the error message - and not from some earlier format check that would
  // have rejected the fixture anyway.
});
```

第二遍按 §3.3 流式实现，累计**实际产出**字节，超限立即 `terminate()` 并抛错。

---

### T4: manifest 严格校验

每条一个测试，全部拒绝：`packageKind !== "tenjin-ledger"`；`schemaVersion !== 1`；`mode !== "full-backup"`；`generation` 非 0 或非整数；`foldExternalState` 非空数组；`maxSeqByDevice` 与事件实际水位不符；`maxHlc` 与事件实际最大 HLC 不符；`eventCount` / `contextCount` 与实际条目数不符；未知顶层键。

`foldExternalState` 非空的错误消息必须点明"本版不认识该状态，拒绝整包而非丢弃"，测试注释写清理由：静默丢弃 = 恢复看似成功但幂等信息已丢。

---

### T5: events.jsonl 解析与逐事件校验

**解析顺序（重要）：先解析全部行 → 按规范全序排序 → 再做全部校验。** 这样行序不影响任何校验结果，也不影响 `RestorePlan` 的产出；must-not-fail 的"行序打乱"因此是结构性成立而不是碰巧成立。

校验项：

- 每行一个 JSON 对象；空行只允许出现在文件末尾；任何解析失败拒绝；
- 每条过 `validateEvent`（core 已导出，`packages/core/src/events.ts:531`）；
- **`eventId` 必须精确等于 `` `${deviceId}:${seq}` ``**。这是 `ledgerRuntime` 铸 id 的方式（`nextId("event")`），所以任何不符的事件要么被篡改过、要么来自别的实现；
- **`(deviceId, seq)` 组合唯一**；
- `eventId` 全局唯一；
- 每设备 `seq` 严格递增，**允许空洞**（规格只要求单调不要求连续，见 `HANDOFF.md` §5.2 与 §13.1）；
- `occurredAt <= recordedAt`；
- **context 引用按 active-capture 规则**，见下。

#### T5.1 active-capture 引用规则（替代原先的"凡带 contextHash 必须有 context"）

原先的写法是错的：真实撤销流程里 `appendDiscard` 会在没有其它活跃引用时**删除 context**，于是一个包含"已撤销 capture"的合法账本会被误判为损坏。正确规则四条：

1. 先算出**被有效 `capture_discarded` 撤销**的 `captureId` 集合；
2. **未被撤销的 `capture_created` 必须能解析到 context**——缺失即拒绝；
3. **已撤销 capture 的 context 允许缺失**——这是正常 GC 结果，不是损坏；
4. 若同一 hash 仍被**任一未撤销 capture** 引用，则该 context 必须存在（第 2 条的自然推论，但要单独测，因为"一个 capture 被撤销、另一个仍引用同 hash"正是 GC 保留分支）。

另外：**没有任何活跃引用的 context 一律接受，不得拒绝。** 它可能来自 GC 的合法竞态。把它改成拒绝会在真实数据上炸——这条要写成注释，防止后人"顺手收紧"。

`item_created` 的 `captureId` 必须能在事件集里找到对应的 `capture_created`。

#### T5.2 负例（每条一个测试）

- `eventId` 与 `${deviceId}:${seq}` 不符；
- `deviceId` 或 `eventId` 首尾含空白；
- 同一 `deviceId` 出现重复 `seq`；
- `occurredAt > recordedAt`；
- 未撤销 capture 的 context 缺失；
- events.jsonl 中间出现空行。

---

### T6: contexts 校验与摘要重算

必须逐项测试**现行 `ContextRecord` 的全部生产约束**（以 `packages/storage-indexeddb/src/repository.ts` 的 `assertValidContext` 为准，不得只测其中几条）：

| 字段 | 约束 |
|---|---|
| `hash` | `sha256:` + 恰好 64 位小写 hex；且**等于条目名的 `<hex>` 部分** |
| `original` | 非空字符串 |
| `corrected` | 存在时必须为非空字符串 |
| `answer` | 存在时必须为非空字符串 |
| `createdAt` | 规范 UTC ISO-8601 |
| `image.mediaType` | 必须落在 `CONTEXT_IMAGE_MEDIA_TYPES` 白名单内 |
| `image.name` | 非空字符串 |
| `image.byteLength` | 与 `.image` 条目的**实际字节数**相等，且 ≤ `MAX_CONTEXT_IMAGE_BYTES` |
| `image.sha256` | 裸 64 位小写 hex（**无前缀**），且等于对实际字节重算的摘要 |
| 未知字段 | context 层与 image 层**都**拒绝（沿用导出器的封闭字段表口径） |

**图片 metadata 与 `.image` 条目必须双向一一对应：**

- context 声明了 `image` 但没有对应 `.image` 条目 → 拒绝（缺失）；
- 存在 `.image` 条目但对应 context 没有 `image` 字段 → 拒绝（孤儿）；
- 两条各一个测试。

**重算而不是只查形状：** 用注入的 `Sha256Hex` 对 `serializeContextHashInput(...)` 的 UTF-8 字节求摘要，拼 `sha256:` 后与声明的 `hash` 比对。

必须有一条专打"只比摘要"假绿的测试：**改一个图片字节，同时把 `image.sha256` 改成新字节的正确摘要**。此时形状校验与图片自洽校验都会通过，只有"重算 context hash"（因为 `imageSha256` 参与其中）或"条目名 = hash"能抓住。测试名要写明它守的是这一条。

---

### T7: 组装 `LedgerRestorePlan`

```ts
export interface LedgerRestorePlan {
  readonly events: readonly Event[];              // 已按规范全序排序
  readonly contexts: readonly RestoreContextShape[]; // 图片为 Uint8Array
  readonly globalHlc: HybridLogicalClock;         // 包内最大 HLC
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly forbiddenDeviceIds: readonly string[]; // 事件 deviceId ∪ exportedByDeviceId
}
```

`maxSeqByDevice` **确定性派生自事件集**（复用既有 `deriveWatermark`），并与 manifest 声明值交叉校验（不符即拒，属 T4）。`forbiddenDeviceIds` 必须**包含 `manifest.exportedByDeviceId`**，理由见 §3.8 第 2 条。

字段名与 storage 的 `RestoreLedgerInput` 保持一致，以便 §3.9 的编译期断言成立。

---

### T8: `restoreLedger` 原子写入

**Files:** 新建 `packages/storage-indexeddb/src/restore.ts` + `.test.ts`；改 `repository.ts`（实现 + `openLedgerRepository` 返回类型）、`index.ts`

按 §3.9 定义 `RestoreContextInput` / `RestoreLedgerInput` / `LedgerRestorer`，`openLedgerRepository` 返回 `Promise<LedgerRepository & LedgerRestorer>`。

必须的测试（每条注释写清守什么）：

1. `newDeviceId` 首尾含空白 → 抛错、零写入（**不 trim**，理由见 §3.8）；
2. `newDeviceId` 落在 `forbiddenDeviceIds` 内 → 抛错、零写入；
3. `newDeviceId` 恰好等于 `manifest.exportedByDeviceId`（但不在任何事件里）→ 仍须抛错——单独一条，因为这正是"只查事件集"会漏掉的情形；
4. 目标库非空 → 抛错、零写入，且**错误消息说明是"目标库非空"**，不是"内容相同所以跳过"（切片 §5.2.1 第 2 条）；
5. 成功后三个 store 内容正确，图片 Blob 逐字节等于输入字节；
6. **clock 写入正确**：`global-hlc` 严格大于 `input.globalHlc`；`input.maxSeqByDevice` 里每个历史设备都有对应的 `device-sequence` 记录且值正确；**`newDeviceId` 没有 `device-sequence` 记录**；
7. 写入中途失败（注入会抛的 put）→ 事务 abort、目标库逐条不变；
8. **同一输入连续恢复两次**：首次成功；第二次因非空被拒；拒后逐条不变（切片 §5.2.1 四条）；
9. 既有 `appendCapture` 全部测试无回归（证明 §3.7 未被放宽）；
10. 既有只实现 `LedgerRepository` 的 mock 仍然编译（证明 §3.9 的接口拆分有效）。

实现红线：Blob 转换在开事务前；事务 scope 恰好 `["events", "contexts", "clock"]`；事务内零非 IDB `await`；空库检查在事务内复检。

---

### T9: 开放 `structurallyEqual`（package-internal）

`repository.ts:642` 的 `structurallyEqual` 加 `export`，函数体不动，**不进 `index.ts`**。文档注释写明"供同包内的恢复等价验证使用，不是通用工具，也不是公共 API"。测试：Blob 逐字节、仅媒体类型不同判不等、嵌套记录。

---

### T10: 等价验证器（分层 failure code，不首错短路）

**Files:** 新建 `packages/storage-indexeddb/src/verifyEquivalence.ts` + `.test.ts`

```ts
export type EquivalenceFailureCode =
  | "L1_STORE_UNCLASSIFIED"
  | "L1_STORE_KEYSET"
  | "L1_EVENTS_MISMATCH"
  | "L1_CONTEXTS_MISMATCH"
  | "L2_ITEM_VIEW"
  | "L2_REVIEW_QUEUE"
  | "L3_IDENTITY"
  | "L3_CLOCK";

export interface EquivalenceFailure {
  readonly code: EquivalenceFailureCode;
  readonly detail: string;
}

export interface EquivalenceReport {
  readonly ok: boolean;
  readonly failures: readonly EquivalenceFailure[];
}
```

**必须跑完全部层再返回，不得首错短路。** 否则一个 L1 差异会掩盖 L2/L3 是否真的执行过——而"某一层从未运行"和"某一层通过"在只看 `ok` 时无法区分。必须有一条测试：制造一个同时触发 L1 与 L2 的差异，断言 `failures` 里**两个 code 都在**。

**L1**：按 `db.objectStoreNames` **动态枚举**。`events` / `contexts` 属精确相等类（用 `structurallyEqual`，Blob 逐字节）；`clock` 属具名语义类（不做逐条相等，交给 L3）；**任何未分类 store 产出 `L1_STORE_UNCLASSIFIED` 并判失败**。必须有一条测试：给测试库临时加第三个 store，断言验证器失败——这条守的是"将来新增 store 不会因为没人想起它而静默逃过比对"。

**L2**：`deriveLedger` 的完整 `ItemView` 逐字段相等（含 `channels` / `validPassDates` / `lastVerifiedAt` / `lastEvidenceAt` / `atRiskSince` / `lastFailureAt` / `evidenceCount` / `lastOccurredAt`）→ `L2_ITEM_VIEW`；复习队列序列 → `L2_REVIEW_QUEUE`（探针注入，见 T11）。

**L3（全部只读，不得改动被验证的库）**：

- `global-hlc` 已持久化且**严格大于**包内最大 HLC；
- `input.maxSeqByDevice` 里每个历史设备的 `device-sequence` 水位**已持久化**且值正确；
- **`newDeviceId` 在首次 reserve 之前不存在 `device-sequence` 记录**；
- 上述任一不满足 → `L3_IDENTITY` 或 `L3_CLOCK`；
- **`clock` store 被清空必须产生专属的 `L3_CLOCK` failure**，不得只表现为泛化的"某处不等"。

**"首次 reserve 返回 seq === 1" 必须在一次性克隆库上测**，绝不能在正式恢复库上调用 `reserveEventCoordinates`——那会写 clock、污染刚刚恢复的账本，让验证行为本身改变被验证对象。测试提供一个 `cloneLedgerDatabase(sourceName, targetName)` 助手（原始读取全部 store → 写入新库），reserve 只在克隆上跑。

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

### T11: 在 apps/web 接真实 `buildReviewQueue`（仅测试）

**Files:** 新建 `apps/web/src/features/ledger/restoreEquivalence.test.ts`

**owner 已批准新增此测试文件**（不含生产代码、不碰 UI）。内容三块：

1. **结构兼容编译期断言**（§3.9）：把 exchange 产出的 `LedgerRestorePlan` 赋给 `RestoreLedgerInput`。两个包互不依赖，这是唯一能证明它们没漂移的地方。
2. **真实探针接线**：用真实 `buildReviewQueue` 作 `ReviewQueueProbe`，断言源库与恢复库在同预算下产出相同的 `(itemId, channel, prompt, reveal)` 序列。**必须断言探针确实被调用了两次**（源库一次、恢复库一次）——一个从不调用探针的实现同样会报"序列相同"。
3. **专属 failure 的正向对照**：制造一个会改变复习队列的差异，断言 `failures` 里**出现 `L2_REVIEW_QUEUE`**，而不是只出现 `L1_CONTEXTS_MISMATCH` 就算数。L1 的差异**不得代打** L2 的结论——这正是"不首错短路"要保证的事。

---

### T12: 负样本矩阵（10 条）与 must-not-fail（3 条）

**Files:** `packages/exchange/src/negativeMatrix.test.ts`（包级变异）；写事务 / DB 级变异放 `packages/storage-indexeddb/src/restore.test.ts`

每条必须写清四件事：**突变在哪一层 / 预期由哪条不变量拒绝 / 预期错误类型或 failure code / 红灯来自目标断言的证据**。

| # | 变异 | 层 | 预期拒绝者 | 预期错误 |
|---|---|---|---|---|
| 1 | 删掉某 context 的 `answer` 键 | package | T6 重算 context hash 不匹配 | `TypeError` / `hash` |
| 2 | 改某事件 `recordedAt` 1 毫秒 | 恢复后 DB | T10 L1 events 精确相等 | `L1_EVENTS_MISMATCH` |
| 3 | 图片少一字节 + 重算 `sha256` 自洽 | package | T6 重算 context hash / 条目名≠hash | `TypeError` / `hash` |
| 4 | 200 条事件删 1 条 | package | T4 `eventCount` 与实际不符 | `TypeError` / `eventCount` |
| 5 | 包被截断 | package | 解包抛错，且**旧库逐字未变**（L0） | 抛错 + 库不变 |
| 6 | manifest 写未知 `schemaVersion` | package | T4 | `TypeError` / `schemaVersion` |
| 7 | 重复 `eventId` 但内容不同 | package | T5 唯一性 | `TypeError` / `eventId` |
| 8 | 清空 `clock` store | 恢复后 DB | T10 L3 | **`L3_CLOCK`**（专属，不得是泛化不等） |
| 9 | 篡改 manifest 的 `maxSeqByDevice` | package | T4 水位与事件不符 | `TypeError` / `maxSeq` |
| 10 | 伪造较小 `originalSize`、实际展开更大 | 流式解压 | T3 第二遍**实际产出**限额 | `TypeError` / 输出限额消息；**必须确认不是被更早的格式校验拦下** |

**三条 must-not-fail（必须仍然 PASS）：**

1. `events.jsonl` 行序打乱 → 恢复成功且等价验证全绿（T5 先排序后校验，结构性成立）；
2. events 各行内 JSON **对象键序**打乱 → 恢复成功且等价验证全绿；
3. **真实 undo 正例**：用真实采集路径造一条 capture，再用真实 `appendDiscard` 撤销（它会 GC 掉 context），然后 export → restore → 等价验证全绿。这条守的是 T5.1：一个包含"已撤销 capture 且 context 已被 GC"的**合法**账本，绝不能被误判为损坏。

前两条同时说明了为什么 round-trip 字节比对**不能**作为唯一 oracle：它们都改变了包的字节，却都是合法输入。

**变异操作的硬纪律**（本仓已两次踩坑）：

- 还原用**文件字节副本**或安全临时目录，**绝不对未提交改动用 `git checkout`**——那会把尚未提交的修复一起还原，之后的"全绿"是在未修复代码上跑的；
- **不得**用 PowerShell 5.1 的 `Get-Content -Raw` / `Set-Content` 改写含日文的 UTF-8 文件——它按 ANSI(cp936) 读，写回即乱码，突变体会死在**语法错误**上而不是目标断言上，检验完全无效却看起来"红了"。含非 ASCII 的文件用 Edit 工具，或 `[System.IO.File]::ReadAllBytes` + `UTF8.GetString`；
- **红灯必须来自目标断言**。每次变异后确认失败原因是预期那条，而不是语法错误、fixture 被更早的校验先拦下、编码损坏或跑错命令。

**跨时区测试卫生**：任何切时区的测试必须在测试内**显式建立"初始无 `TZ`"的已知起点**（先记录并 `delete process.env.TZ`），不得依赖 CI 宿主恰好没设 `TZ`；`finally` 里先写回解析出的系统时区（这一步才真正刷新 Node 缓存），再把环境变量恢复原样，并**双轴断言**：有效时区回来了 + `process.env.TZ` 与原值全等。已知事实：`delete process.env.TZ` 单独使用**不能**恢复系统时区。

---

## 5. Gate

**exchange 类型边界是独立 Gate**（§3.5），必须单独跑并退出 0：

```bash
pnpm --filter @tenjin/exchange typecheck
```

全仓四条：

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm build
```

```bash
pnpm test
```

全部退出 0，`git diff --check` 干净，且 `CROSS-REVIEW.md` 不出现在 `git status` 任何输出里。

**本机注意**：裸 `pnpm` 可能不在 PATH（只有 `corepack`），而仓库的 `pretest` / `prebuild` / `pretypecheck` 会调用裸 `pnpm`。用临时目录 shim 转发，**每次 PowerShell 调用都要重新前置 PATH**（shell 状态不跨调用保留）：

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
| 2 | T11 新增 apps/web 测试文件 | **批准**，仅测试、无生产代码 |
| 3 | `structurallyEqual` 导出面 | **package-internal named export**；不进 root `index.ts`，不建 `/testing` 子入口 |
| 4 | `newDeviceId` 来源 | **调用方生成并传入**；storage 永不生成；输入必须 canonical，首尾空白直接拒绝 |
| 5 | 禁用集合 | 事件全部 `deviceId` ∪ `manifest.exportedByDeviceId` |
| 6 | localStorage 与 IndexedDB 一致性 | 由 §3.8 的六步激活协议保证；本轮只交付后端，口径为 **BACKEND_READY** |
| 7 | 单图 20 MiB | **正式产品约束** |
| 8 | 其余限额 | **provisional security ceilings**，是拒绝阈值不是支持容量；须在最低支持 iPhone 做 80% / 100% 边界验证后才可冻结 |
| 9 | ZIP64 | 本轮不引入；因此 `entries <= 65_535`、`contexts <= 32_766` |

## 7. 仍需 owner 决定的问题

1. **最低支持的 iPhone 机型是哪一台？** §T2 的边界验证需要一个具体机型才能执行，本计划无法自行指定。
2. **`decodeUtf8.ts` 的窄声明若与未来引入的 `@types/node` 冲突**（例如别的包为其它原因引入后类型泄漏到 exchange），是接受重复声明报错并届时收敛，还是现在就改用 `globalThis` 取值 + 运行时检测？本计划选前者（更简单，且 exchange 独立 typecheck 会立刻暴露冲突）。
3. **`events` 上限 200,000 是否与真实使用量级相符？**其余临时上限都有结构或产品锚点，只有这条纯属我按数量级取的。

---

## 8. 自检结果

**规格矛盾**：对照切片 v1.2 逐条核。抽象模式只出现在"必须拒绝"语境（T4）；恢复语义按 §5.2.1 四条写进 T8 测试 8；"零写入风险"的错误措辞已在切片 §7.1 作废，本计划 §3.6 用事务纪律取代；交付口径统一为 BACKEND_READY。**未发现残留矛盾。**

**永远 PASS 的断言**：逐条排查并各自加了强制断言。① 声明体积上限——若实现改成"先解压再判断"，超限测试仍会通过，故 T3 强制一条"证明第一遍未解压"的断言；② 伪造 `originalSize`——只信中央目录等于没有防护，故 §3.3 强制第二遍按实际产出计量，且 T12 第 10 条要求确认红灯来自输出限额而非更早的格式错误；③ UTF-8——非 fatal 解码器让该校验永不触发，§3.5 写死 fatal 并把 exchange typecheck 列为独立 Gate；④ 摘要自洽——"改字节同时改摘要"能骗过形状与自洽校验，T6 强制一条专打此假绿的测试；⑤ 复习队列——只断言"相同"无法区分"没在比"，T11 强制断言探针被调用两次 + 专属 `L2_REVIEW_QUEUE`；⑥ 首错短路——一个 L1 差异会掩盖 L2/L3 是否执行过，T10 强制"两个 code 同时出现"的测试。

**错误 fixture**：T6 负样本必须用**生产形状**摘要（context hash 为 `sha256:` + 64 位小写 hex，image sha256 为裸 64 位 hex）。导出器那轮的教训是短摘要 fixture 会被更早的格式校验先拦下，目标断言从未执行。

**事务自动提交**：§3.6 写死"事务内不得 await 非 IndexedDB Promise"并给出既有代码的两处先例；T8 实现红线重复一遍。

**未知 store 漏检**：T10 要求动态枚举 + 分类穷尽 + 未分类即 `L1_STORE_UNCLASSIFIED`，并强制"临时加第三个 store 必须失败"的测试。

**验证器污染被验证对象**：T10 的 L3 全部只读；"首次 reserve seq === 1"只在一次性克隆库上跑。这一条是本轮新增的自检维度——之前的写法会让验证行为本身改变恢复库的 clock。

## 9. 变更记录

| 版本 | 变更类型 | 变更内容 | 经办人 | 时间 |
|---|---|---|---|---|
| v1.0 | 初稿 | 冻结恢复器 + 等价验证器 + 负样本矩阵的 12 个 TDD 任务、文件写集、依赖图、关键设计决定与 6 个待决问题 | Fable 5 | 2026-08-07 |
| v1.1 | 收口 | T5 改 active-capture 引用规则并加真实 undo 正例；T6 补齐全部 `ContextRecord` 生产约束与图片双向对应；T5 加 `eventId === deviceId:seq`、`(deviceId,seq)` 唯一、先排序后校验及负例；Clock Gate 改为只读检查 + 克隆库跑 reserve + 专属 `L3_CLOCK`；类型边界改为 storage 定义输入、`LedgerRestorer` 独立接口、`openLedgerRepository` 返回交集；`TextDecoder` 改极窄本地声明并把 exchange typecheck 列为独立 Gate；ZIP 第二遍改流式按实际产出计量并加伪造 `originalSize` 负例；T11 加分层 failure code、禁首错短路、探针调用两次、专属 `L2_REVIEW_QUEUE`；限额区分产品约束与临时安全上限并加 ZIP64 结构约束与冻结前置条件；身份决定为调用方生成 + canonical + 禁用集合含 `exportedByDeviceId` + 六步激活协议 + BACKEND_READY 口径 | Fable 5（据 Codex 复审） | 2026-08-07 |
