# A1 账本恢复器与等价验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `.tenjin` 完整备份包能被严格校验并原子恢复到**空账本**，并交付一套能失败的独立等价验证器 + 10 条负样本 + 2 条 must-not-fail，补齐 `HANDOFF.md` 阶段 A1 Gate。

**Architecture:** 三层，边界即责任。`@tenjin/exchange` 保持纯函数、无 DOM、无 IndexedDB、无 Node 依赖，负责**解包与全部校验**，产出一个已验证的 `LedgerRestorePlan`（普通数据，图片为 `Uint8Array`）；`@tenjin/storage-indexeddb` 负责**原子写入**与**原始读取**，把 `Uint8Array → Blob` 的转换和全部摘要计算放在**开启事务之前**；等价验证器住在 storage 层（它需要 idb 原始读取与 `structurallyEqual`），复习队列构造函数由调用方注入，避免 storage 反向依赖 `apps/web`。

**Tech Stack:** TypeScript（NodeNext、strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）、Vitest、fflate、idb、fake-indexeddb。

**基线：** `fa4e048`（导出器已合入并过审）。切片总定义见 [`docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`](../../decisions/2026-08-05-a1-ledger-recovery-slice.md)（v1.2）。

---

## 0. 本计划明确不做

以下每一项都**不得**在本计划任何任务中出现，即使"顺手就能加"：

- Web 数据页按钮或任何 UI；真机 runbook 的执行；
- Coach JSON 导入；`focus` 字段；DB 升到 v3；`importReceipts`；
- **非空账本恢复或任何形式的 merge / 去重 / 覆盖**（见切片 §5.2.1 第 4 条）；
- `abstract-exchange` 模式的任何部分；
- 复习时间预算改造；教学或引导 UI。

`packages/exchange` 不得新增运行时依赖；`@types/node` 本轮不引入（沿用导出器里那条极窄的 `declare` 写法）。

---

## 1. 文件写集

任务只能改动下表列出的文件。任何越界都必须停下并上报，不得自行扩大。

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/core/src/contextHash.ts` | 新建 | T1 |
| `packages/core/src/contextHash.test.ts` | 新建 | T1 |
| `packages/core/src/index.ts` | 追加 export | T1 |
| `apps/web/src/features/ledger/ledgerRuntime.ts` | 改为复用 core 的序列化 | T1 |
| `apps/web/src/features/capture/createCapture.ts` | 复用 core 的类型 | T1 |
| `packages/exchange/src/limits.ts` + `.test.ts` | 新建 | T2 |
| `packages/exchange/src/readPackage.ts` + `.test.ts` | 新建 | T2、T3 |
| `packages/exchange/src/validateManifest.ts` + `.test.ts` | 新建 | T4 |
| `packages/exchange/src/validateEvents.ts` + `.test.ts` | 新建 | T5 |
| `packages/exchange/src/validateContexts.ts` + `.test.ts` | 新建 | T6 |
| `packages/exchange/src/restorePlan.ts` + `.test.ts` | 新建 | T7 |
| `packages/exchange/src/index.ts` | 追加 export | T2–T7 |
| `packages/storage-indexeddb/src/repository.ts` | 开放 `structurallyEqual`；新增 `restoreLedger` | T8、T9 |
| `packages/storage-indexeddb/src/repository.test.ts` | 追加 | T8、T9 |
| `packages/storage-indexeddb/src/verifyEquivalence.ts` + `.test.ts` | 新建 | T10 |
| `packages/storage-indexeddb/src/index.ts` | 追加 export | T9、T10 |
| `apps/web/src/features/ledger/reviewQueueEquivalence.test.ts` | 新建（**仅测试**，无生产代码） | T11 |
| `packages/exchange/src/negativeMatrix.test.ts` | 新建 | T12 |

**绝对不得触碰：** `CROSS-REVIEW.md`（它只存在于主 worktree、未跟踪）。

## 2. 任务依赖

```text
T1 (context hash 提取)
  └─> T6 (contexts 校验，需要重算 hash)
T2 (限额 + 两遍读包) ─> T3 (条目白名单) ─> T4 (manifest) ─┐
                                          T5 (events) ────┼─> T7 (RestorePlan)
                                          T6 (contexts) ──┘
T7 ─> T8 (restoreLedger 原子写)
T8 ─> T9 (开放 structurallyEqual) ─> T10 (等价验证器 L1/L2-ItemView/L3)
T10 ─> T11 (apps/web 里接真实 buildReviewQueue 的 L2 队列断言)
T10 ─> T12 (负样本矩阵 10 + must-not-fail 2)
```

T1 与 T2 可并行开始；其余严格串行。

---

## 3. 关键设计决定（实现者必须遵守，不得自行改）

### 3.1 为什么 context hash 的序列化必须先提取到 core

恢复器要求"**重新计算** context hash，不只检查 64 位形状"。而当前唯一决定该 hash 的代码在 `apps/web/src/features/ledger/ledgerRuntime.ts` 的 `hashContext` 里，用的是**固定字面量顺序**的四字段对象（`original` → `corrected?` → `answer?` → `imageSha256?`），且缺省字段整键省略。这与 `canonicalJson`（递归排序键）**完全不是一回事**，绝不能互相替代。

`@tenjin/exchange` 不能依赖 `apps/web`。若在 exchange 里照抄一份，两份实现会静默漂移，而漂移的表现是"恢复时判定 hash 不匹配"或更糟的"错误地判定匹配"。因此 T1 把**序列化**（不含摘要计算）提取到 `@tenjin/core`，两边共用。

**这是一次纯重构，零行为变化。** 既有测试 `ledgerRuntime.test.ts` 已经把精确序列化串钉死（对 `{original}`、`{original,corrected}`、`{original,answer,imageSha256}` 三种组合断言了 `JSON.stringify` 的确切结果），它们**一行都不许改**——它们就是这次重构的守卫。若它们变红，说明重构改变了历史 hash，必须回退重做。

### 3.2 摘要函数注入，不内置

`@tenjin/core` 与 `@tenjin/exchange` 都不得引入 crypto 依赖。校验器接收一个注入的摘要函数：

```ts
export type Sha256Hex = (input: Uint8Array) => Promise<string>;
```

约定：返回**小写十六进制、无前缀**。测试用 `node:crypto` 提供；浏览器侧由调用方用 `crypto.subtle` 提供。注意 `hashContext` 摘要的是 **UTF-8 编码后的序列化字符串**，实现者必须与 `ledgerRuntime` 现行行为逐字节一致（T1 的守卫测试覆盖这一点）。

### 3.3 zip bomb 防护必须两遍读，且第一遍不解压

`fflate` 的 `unzipSync(bytes, { filter })` 接受一个 `UnzipFileFilter`，回调收到的 `UnzipFileInfo` 含 `name`、`size`（压缩后）、`originalSize`（解压后），**返回 `false` 即跳过该条目的解压**。已从 `fflate@0.8.3` 的类型定义确认。

因此：

- **第一遍**：`filter` 记录每个条目的 `name` / `size` / `originalSize` 并一律返回 `false`。此遍**不解压任何字节**，用于条目白名单、重复条目检测、以及全部体积上限判定。
- **第二遍**：上述校验全部通过后，才真正 `unzipSync(bytes)` 解压。

只有这样，声明了巨大 `originalSize` 的炸弹包才会在**解压之前**被拒。若实现时发现 `filter` 的语义与此处描述不符，**停下上报**，不要改成"先解压再判断大小"——那等于没有防护。

### 3.4 条目名用白名单，不用黑名单

合法条目**恰好**是下列形态，其余一律拒绝：

```text
manifest.json
events.jsonl
redactions.jsonl
contexts/<64位小写hex>.json
contexts/<64位小写hex>.image
```

正则：`^(manifest\.json|events\.jsonl|redactions\.jsonl|contexts\/[0-9a-f]{64}\.(json|image))$`

白名单天然挡住路径穿越（`../`）、绝对路径、反斜杠、隐藏条目与任何未知条目——**不要**改成"检测 `..` 再放行其余"，那是黑名单，永远漏。

### 3.5 UTF-8 解码必须 fatal

所有文本条目用 `new TextDecoder("utf-8", { fatal: true })` 解码。默认的非 fatal 解码器会把非法字节静默替换成 U+FFFD，于是"非法 UTF-8"这条校验永远不会触发——又一个无条件通过的检查。

### 3.6 事务纪律

- 全部摘要计算、`Uint8Array → Blob` 转换、全部校验，**必须在开启 IndexedDB 写事务之前完成**。
- 写事务内**不得 `await` 任何非 IndexedDB 的 Promise**。IndexedDB 事务在微任务队列排空且无未决请求时会自动提交，一次 `await crypto.subtle.digest(...)` 就足以让事务提前提交，产出一个"报告成功的半批数据"——长得和成功一模一样。既有代码已经在绕这个坑（`assertValidContextImageDigest` 刻意放在开事务之前；事务内读 Blob 要靠 keep-alive 循环）。
- "目标库为空"必须**在最终写事务内再查一次**。事务外预检是 check-then-act，双标签页或双击就能穿过去，而本仓明确处理多标签场景。
- 任何错误必须让事务 `abort`，零部分写入。

### 3.7 不放宽既有写入路径

`appendCapture` 的"恰好 1 条 `capture_created` 且其 `contextHash` 等于传入 context 的 hash"是承载 events↔contexts 引用一致性的核心不变量，**签名与断言强度一律不动**。`restoreLedger` 是新增的独立方法，可以抽私有 helper 与既有方法共用幂等 put 逻辑，但共用不得降低单条路径的校验强度。

### 3.8 身份与时钟的责任边界

两个**互相独立**的存储，必须同时正确，否则中毒：

| 存储 | 内容 | 谁负责 |
|---|---|---|
| localStorage `tenjin.deviceId`（`apps/web/src/main.tsx:18`） | 本安装当前使用的 `deviceId` | **调用方**（本轮不实现，属 UI 切片） |
| IndexedDB `clock` store | `global-hlc` + 每设备 `device-sequence` 分配器 | `restoreLedger` |

`restoreLedger` 接收调用方提供的 `newDeviceId`，并**必须校验它不在包内任何事件的 `deviceId` 集合中**，命中即拒。理由：`highWaterFromEvents` 在 clock 记录缺失时会从事件重建高水位，若复用了包内已有的 `deviceId`，新设备的 `seq` 会从那个历史高水位续发，而那些号可能已被别的副本用过——同 `eventId` 不同内容，交换时中毒且延迟触发。

`restoreLedger` 只写 `global-hlc`（严格大于包内最大 HLC），**不为 `newDeviceId` 写 `device-sequence` 记录**——记录缺失时该设备从 0 起算，首次 `reserveEventCoordinates` 自然返回 `seq === 1`。

本轮**不实现**跨设备 merge。

---

## 4. 任务

### T1: 把 context hash 序列化提取到 core

**Files:** 新建 `packages/core/src/contextHash.ts`、`contextHash.test.ts`；改 `packages/core/src/index.ts`、`apps/web/src/features/ledger/ledgerRuntime.ts`、`apps/web/src/features/capture/createCapture.ts`

- [ ] **Step 1: 先跑既有守卫，确认它们现在是绿的**

```bash
pnpm --filter @tenjin/web test ledgerRuntime
```

记录通过的测试数。这些测试**接下来一行都不许改**。

- [ ] **Step 2: 写新测试（会失败）**

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

  it("omits absent fields entirely rather than emitting null or empty string", () => {
    expect(serializeContextHashInput({ original: "a", answer: "c" })).toBe(
      JSON.stringify({ original: "a", answer: "c" }),
    );
    expect(serializeContextHashInput({ original: "a" })).not.toContain("null");
  });

  it("is not the canonical serialiser: it does not sort keys", () => {
    // canonicalJson sorts keys; this one must not, because its output is part
    // of historical content identity. Sorting would put answer before original
    // and silently change every hash ever computed.
    const serialized = serializeContextHashInput({
      original: "z",
      answer: "a",
    });
    expect(serialized.indexOf('"original"')).toBeLessThan(
      serialized.indexOf('"answer"'),
    );
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @tenjin/core test contextHash
```

预期：FAIL，找不到 `./contextHash.js`。

- [ ] **Step 4: 实现**

`packages/core/src/contextHash.ts`：

```ts
/**
 * The exact input serialisation behind a context hash.
 *
 * This is content identity, not a formatting choice: the field order is a
 * fixed literal and absent fields are omitted whole. Reordering the fields,
 * sorting them, or emitting `null` for an absent one would change every hash
 * ever computed and orphan the existing ledger.
 *
 * It is deliberately NOT `canonicalJson`, which recursively sorts keys and
 * exists only to make exported package bytes stable. The two must never be
 * substituted for each other.
 *
 * Lives in core so that the capture path and the restore validator compute the
 * same bytes from one implementation instead of two that can drift apart.
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

`packages/core/src/index.ts` 追加：

```ts
export * from "./contextHash.js";
```

- [ ] **Step 5: 让 apps/web 复用它**

把 `ledgerRuntime.ts` 的 `hashContext` 改为：

```ts
      async hashContext(context) {
        const hexadecimal = await options.digest(
          serializeContextHashInput(context),
        );
        return `sha256:${hexadecimal.toLowerCase()}`;
      },
```

并把 `createCapture.ts` 里本地声明的 `CaptureContextHashInput` 改为 re-export core 的 `ContextHashInput`（保留原名以免波及调用点）。**不要**改 `options.digest` 的签名，也不要改 `sha256:` 前缀拼接的位置。

- [ ] **Step 6: 两侧都跑，守卫必须仍然绿**

```bash
pnpm --filter @tenjin/core test
```

```bash
pnpm --filter @tenjin/web test ledgerRuntime
```

预期：core 新增 4 个测试通过；`ledgerRuntime` 的既有测试数与 Step 1 记录**完全一致**且全绿。若任何一条精确序列化断言变红，**立即回退**——那意味着历史 hash 被改变了。

- [ ] **Step 7: 提交**

```bash
git add packages/core apps/web/src/features/ledger/ledgerRuntime.ts apps/web/src/features/capture/createCapture.ts
git commit -m "refactor(core): share the context hash serialisation" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### T2: 体积上限与两遍读包

**Files:** 新建 `packages/exchange/src/limits.ts` + `.test.ts`、`readPackage.ts` + `.test.ts`；改 `index.ts`

- [ ] **Step 1: 写失败测试**

`packages/exchange/src/limits.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_LIMITS, assertWithinLimits } from "./limits.js";

const entry = (name: string, originalSize: number, size = 64) => ({
  name,
  size,
  originalSize,
});

describe("assertWithinLimits", () => {
  it("accepts a modest package", () => {
    expect(() =>
      assertWithinLimits(1_000, [entry("manifest.json", 400)]),
    ).not.toThrow();
  });

  it("rejects a compressed package over the cap", () => {
    expect(() =>
      assertWithinLimits(PACKAGE_LIMITS.compressedBytes + 1, []),
    ).toThrow(/compressed/i);
  });

  it("rejects a single entry that declares more than its per-kind cap", () => {
    expect(() =>
      assertWithinLimits(1_000, [
        entry("contexts/" + "a".repeat(64) + ".image", PACKAGE_LIMITS.imageEntryBytes + 1),
      ]),
    ).toThrow(/entry/i);
  });

  it("rejects a declared total that exceeds the decompressed cap even when every entry is legal", () => {
    // The zip bomb shape: many individually-legal entries.
    const many = Array.from({ length: 40 }, (_, index) =>
      entry(`contexts/${String(index).padStart(64, "0")}.image`, PACKAGE_LIMITS.imageEntryBytes),
    );
    expect(() => assertWithinLimits(1_000, many)).toThrow(/decompressed/i);
  });

  it("rejects more events or contexts than the cap allows", () => {
    expect(() =>
      assertWithinLimits(1_000, [entry("events.jsonl", 1)], {
        eventCount: PACKAGE_LIMITS.events + 1,
        contextCount: 0,
      }),
    ).toThrow(/events/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --filter @tenjin/exchange test limits
```

- [ ] **Step 3: 实现**

`packages/exchange/src/limits.ts`：

```ts
export interface PackageEntryInfo {
  readonly name: string;
  readonly size: number;
  readonly originalSize: number;
}

/**
 * Hard ceilings, enforced from the central directory BEFORE anything is
 * decompressed. Anchored on real product limits rather than round numbers:
 * a single capture image is capped at 20 MB by the storage layer
 * (MAX_CONTEXT_IMAGE_BYTES), so an image entry gets that plus no slack.
 */
export const PACKAGE_LIMITS = {
  compressedBytes: 100 * 1024 * 1024,
  decompressedBytes: 250 * 1024 * 1024,
  imageEntryBytes: 20 * 1024 * 1024,
  textEntryBytes: 64 * 1024 * 1024,
  metadataEntryBytes: 1 * 1024 * 1024,
  entries: 100_001,
  events: 200_000,
  contexts: 50_000,
} as const;

export function assertWithinLimits(
  compressedBytes: number,
  entries: readonly PackageEntryInfo[],
  counts?: { readonly eventCount: number; readonly contextCount: number },
): void {
  if (compressedBytes > PACKAGE_LIMITS.compressedBytes) {
    throw new TypeError(
      `compressed package is ${compressedBytes} bytes, over the ${PACKAGE_LIMITS.compressedBytes} cap`,
    );
  }
  if (entries.length > PACKAGE_LIMITS.entries) {
    throw new TypeError(
      `package declares ${entries.length} entries, over the ${PACKAGE_LIMITS.entries} cap`,
    );
  }
  let total = 0;
  for (const entry of entries) {
    const cap = entry.name.endsWith(".image")
      ? PACKAGE_LIMITS.imageEntryBytes
      : entry.name === "events.jsonl"
        ? PACKAGE_LIMITS.textEntryBytes
        : PACKAGE_LIMITS.metadataEntryBytes;
    if (entry.originalSize > cap) {
      throw new TypeError(
        `entry ${entry.name} declares ${entry.originalSize} bytes, over its ${cap} cap`,
      );
    }
    total += entry.originalSize;
  }
  if (total > PACKAGE_LIMITS.decompressedBytes) {
    throw new TypeError(
      `package declares ${total} decompressed bytes, over the ${PACKAGE_LIMITS.decompressedBytes} cap`,
    );
  }
  if (counts !== undefined) {
    if (counts.eventCount > PACKAGE_LIMITS.events) {
      throw new TypeError(
        `package declares ${counts.eventCount} events, over the ${PACKAGE_LIMITS.events} cap`,
      );
    }
    if (counts.contextCount > PACKAGE_LIMITS.contexts) {
      throw new TypeError(
        `package declares ${counts.contextCount} contexts, over the ${PACKAGE_LIMITS.contexts} cap`,
      );
    }
  }
}
```

- [ ] **Step 4: 运行确认通过，然后提交**

```bash
pnpm --filter @tenjin/exchange test
```

```bash
git add packages/exchange
git commit -m "feat(exchange): cap package size before decompressing" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### T3: 条目白名单与重复条目检测（两遍读包）

**Files:** `packages/exchange/src/readPackage.ts` + `.test.ts`

关键测试（必须包含，注释说明它守什么）：

```ts
it("rejects a path traversal entry name", () => {
  // Whitelist, not blacklist: anything that is not exactly one of the five
  // legal shapes is rejected, so `../` never needs its own special case.
  expect(() => readValidatedPackage(zipWith({ "../evil.json": bytes }))).toThrow(
    /entry name/i,
  );
});

it("rejects a duplicate entry name", () => {
  // unzipSync returns an object, so duplicates would silently collapse to the
  // last one. Duplicates must be caught during the first (non-decompressing)
  // pass, where every central-directory record is still visible.
  expect(() => readValidatedPackage(zipWithDuplicate("manifest.json"))).toThrow(
    /duplicate/i,
  );
});

it("rejects an oversized entry without decompressing it", () => {
  // 30 MB of zeros compresses to a few KB. If the implementation decompresses
  // first and checks after, this test still passes - so it must also assert
  // that decompression never happened; see the spy below.
  const bomb = zipWith({ "contexts/" + "a".repeat(64) + ".image": new Uint8Array(30 * 1024 * 1024) });
  expect(() => readValidatedPackage(bomb)).toThrow(/cap/i);
});

it("rejects invalid UTF-8 in a text entry", () => {
  // A non-fatal TextDecoder would turn these bytes into U+FFFD and this check
  // would never fire.
  expect(() =>
    readValidatedPackage(zipWith({ "events.jsonl": new Uint8Array([0xff, 0xfe]) })),
  ).toThrow(/utf-8/i);
});

it("accepts a missing redactions.jsonl and an empty one, but rejects a non-empty one", () => {
  expect(() => readValidatedPackage(withoutRedactions)).not.toThrow();
  expect(() => readValidatedPackage(withEmptyRedactions)).not.toThrow();
  expect(() => readValidatedPackage(withNonEmptyRedactions)).toThrow(/redaction/i);
});
```

实现要点：第一遍 `unzipSync(bytes, { filter })` 记录并全部返回 `false`；校验通过后第二遍才真正解压。**必须有一条测试证明第一遍确实没解压**——用一个 `filter` 计数器或对超限包断言抛出时机，实现者选一种并写明它证明了什么。

---

### T4: manifest 严格校验

拒绝清单（每条一个测试）：`packageKind !== "tenjin-ledger"`；`schemaVersion !== 1`；`mode !== "full-backup"`；`generation` 非 0 或非整数；`foldExternalState` 非空数组；`maxSeqByDevice` 与事件实际水位不符；`maxHlc` 与事件实际最大 HLC 不符；`eventCount` / `contextCount` 与实际条目数不符；未知顶层键。

`foldExternalState` 非空的错误消息必须点明"本版不认识该状态，拒绝整包而非丢弃"，并在测试注释里写清理由（静默丢弃 = 恢复看似成功但幂等信息已丢）。

---

### T5: events.jsonl 解析与逐事件校验

- 每行一个 JSON 对象；空行只允许出现在末尾；任何解析失败拒绝；
- 每条过 `validateEvent`（core 已导出，`packages/core/src/events.ts:531`）；
- `eventId` 全局唯一；
- 每设备 `seq` 严格递增（**允许空洞**——规格只要求单调，不要求连续；见 `HANDOFF.md` §5.2 与 §13.1）；
- `occurredAt <= recordedAt`；
- 引用关系：带 `contextHash` 的事件其 hash 必须在 contexts 里存在（本切片是完整备份，contexts 必然齐全）；`item_created` 的 `captureId` 必须能在事件集里找到对应 `capture_created`。

**must-not-fail 提前覆盖**：行序打乱后必须仍然接受并产出相同的 `RestorePlan`（读取时按规范全序排序）。

---

### T6: contexts 校验与摘要重算

- 条目名 `<hex>` 必须**等于** context 内部 `hash` 去掉 `sha256:` 前缀；
- 用注入的 `Sha256Hex` **重算** context hash：对 `serializeContextHashInput(...)` 的 UTF-8 字节求摘要，拼 `sha256:` 前缀后与声明值比对；
- 图片：对 `.image` 条目的原始字节重算 SHA-256，与 `image.sha256` 比对；`byteLength` 与实际字节数比对；
- 未知 context 字段与未知 image 字段一律拒绝（沿用导出器的封闭字段表口径）。

必须有一条测试专打"只比摘要"的假绿：**改一个字节同时把 `sha256` 改成新字节的正确摘要**——这时形状校验和自洽性校验都会通过，只有"条目名 = hash"或"重算 context hash"能抓住它。写明这条测试守的是哪一条。

---

### T7: 组装 `LedgerRestorePlan`

产出（普通数据，无 Blob、无 IndexedDB）：

```ts
export interface LedgerRestorePlan {
  readonly events: readonly Event[];          // 已按规范全序排序
  readonly contexts: readonly RestoreContext[]; // 图片为 Uint8Array
  readonly clockSeed: { readonly globalHlc: HybridLogicalClock };
  readonly deviceIdsInPackage: readonly string[];
}
```

`clockSeed.globalHlc` 取包内最大 HLC（`restoreLedger` 负责写入严格更大的基线）。`deviceIdsInPackage` 供 T8 校验新身份不冲突。

---

### T8: `restoreLedger` 原子写入

**Files:** `packages/storage-indexeddb/src/repository.ts` + `.test.ts`

签名：

```ts
restoreLedger(plan: LedgerRestorePlan, newDeviceId: string): Promise<void>;
```

必须的测试（每条注释写清守什么）：

1. `newDeviceId` 出现在 `plan.deviceIdsInPackage` 里 → 抛错，零写入；
2. 目标库非空 → 抛错，零写入，且**错误消息说明是"目标库非空"**而不是"内容相同所以跳过"（切片 §5.2.1 第 2 条）；
3. 成功后 `events` / `contexts` / `clock` 三个 store 内容正确，图片 Blob 逐字节等于包内字节；
4. 写入中途失败（注入一个会抛的 put）→ 事务 abort，目标库逐条不变；
5. 首次 `reserveEventCoordinates(newDeviceId, ...)` 返回 `seq === 1`，`hlc` 严格大于 `plan.clockSeed.globalHlc`；
6. **同一 plan 连续恢复两次**：第一次成功；第二次因非空被拒；拒后按 L1 口径比对，数据库逐条不变（切片 §5.2.1 四条）；
7. 既有 `appendCapture` 的全部测试无回归（证明 §3.7 未被放宽）。

实现红线：Blob 转换在开事务前完成；事务 scope 恰好 `["events", "contexts", "clock"]`；事务内零非 IDB `await`；空库检查在事务内复检。

---

### T9: 开放 `structurallyEqual`（仅供验证器）

把 `repository.ts:642` 的 `structurallyEqual` 加 `export`，函数体不动。测试：Blob 逐字节比较、仅媒体类型不同要判不等、嵌套记录。文档注释写明"供恢复等价验证使用，不是通用工具"。

---

### T10: 等价验证器 L1 / L2(ItemView) / L3

**Files:** 新建 `packages/storage-indexeddb/src/verifyEquivalence.ts` + `.test.ts`

```ts
export const EXACT_EQUALITY_STORES = ["events", "contexts"] as const;
export const SEMANTIC_STORES = ["clock"] as const;

export interface EquivalenceReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
}
```

L1 必须**按 `db.objectStoreNames` 动态枚举**，每个 store 归入上面两类之一；**未分类 store 直接判失败**并在消息里点名。必须有一条测试：给测试库临时加一个第三个 store，断言验证器失败——这条守的是"将来新增 store 不会因为没人想起它而静默逃过比对"。

L2 比较 `deriveLedger` 的完整 `ItemView`（含 `channels` / `validPassDates` / `lastVerifiedAt` / `lastEvidenceAt` / `atRiskSince` / `lastFailureAt` / `evidenceCount` / `lastOccurredAt`）。

L3 断言新身份、`seq === 1`、HLC 严格递增。

复习队列比较通过注入实现，避免 storage 依赖 apps/web：

```ts
export type ReviewQueueProbe = (
  view: LedgerView,
  snapshot: LedgerSnapshot,
  budget: number,
) => readonly { itemId: string; channel: string; prompt: string; reveal: unknown }[];
```

---

### T11: 在 apps/web 里接真实 `buildReviewQueue`（仅测试）

**Files:** 新建 `apps/web/src/features/ledger/reviewQueueEquivalence.test.ts`

把 T10 的验证器与真实 `buildReviewQueue` 接起来，断言源库与恢复库在同预算下产出**相同的 `(itemId, channel, prompt, reveal)` 序列**。不新增任何生产代码、不碰 UI。

必须包含一个**正向对照**：故意让恢复库少一条 context，断言队列序列不同因而验证器失败——否则无法区分"序列相同"与"验证器根本没在比"。

---

### T12: 负样本矩阵（10 条）与 must-not-fail（2 条）

**Files:** 新建 `packages/exchange/src/negativeMatrix.test.ts`（跨层的写事务/DB 级变异放 `packages/storage-indexeddb/src/repository.test.ts`）

每条负样本必须在测试名或注释里写清四件事：**突变发生在哪一层 / 预期由哪条不变量拒绝 / 预期错误类型或消息片段 / 红灯来自目标断言的证据**。

| # | 变异 | 层 | 预期拒绝者 | 预期错误 |
|---|---|---|---|---|
| 1 | 删掉某 context 的 `answer` 键 | package | T6 重算 context hash 不匹配 | `TypeError` / `context hash` |
| 2 | 改某事件 `recordedAt` 1 毫秒 | package | T10 L1 `events` 精确相等失败 | 验证器 `failures` 非空 |
| 3 | 图片少一字节 + 重算 `sha256` 使其自洽 | package | T6 条目名≠hash / context hash 重算失败 | `TypeError` / `hash` |
| 4 | 200 条事件删 1 条 | package | T4 `eventCount` 与实际不符 | `TypeError` / `eventCount` |
| 5 | 包被截断 | package | fflate 解包抛错，且**旧库逐字未变**（L0） | 抛错 + 库不变 |
| 6 | manifest 写未知 `schemaVersion` | package | T4 | `TypeError` / `schemaVersion` |
| 7 | 重复 `eventId` 但内容不同 | package | T5 唯一性 | `TypeError` / `eventId` |
| 8 | 清空 `clock` store | 恢复后 DB | T10 L3 语义连续性 | 验证器 `failures` 非空 |
| 9 | 篡改 manifest 的 `maxSeqByDevice` | package | T4 水位与事件不符 | `TypeError` / `maxSeq` |
| 10 | 恢复后 `clock` 的 global-hlc 低于包内最大 HLC | clock | T10 L3 | 验证器 `failures` 非空 |

**两条 must-not-fail（必须仍然 PASS）：**

- `events.jsonl` 行序打乱 → 恢复成功且等价验证全绿；
- events 各行内 JSON **对象键序**打乱 → 恢复成功且等价验证全绿。

这两条同时说明了为什么 round-trip 字节比对**不能**作为唯一 oracle：它们都改变了包的字节，却都是合法输入。

**变异操作的硬纪律**（本仓已两次踩坑）：

- 还原用**文件字节副本**（`Copy-Item`）或安全临时目录，**绝不对未提交改动用 `git checkout`**——那会把尚未提交的修复一起还原掉，之后的"全绿"是在未修复的代码上跑的；
- **不得**用 PowerShell 5.1 的 `Get-Content -Raw` / `Set-Content` 改写含日文的 UTF-8 文件——它按 ANSI(cp936) 读，写回即乱码，于是突变体死在**语法错误**上而不是目标断言上，那次检验完全无效却看起来"红了"。含非 ASCII 的文件用 Edit 工具改，或 `[System.IO.File]::ReadAllBytes` + `UTF8.GetString`；
- **红灯必须来自目标断言**。每次变异后要确认失败原因是预期的那一条，而不是语法错误、fixture 被更早的校验先拦下、编码损坏或跑错命令。

**跨时区测试卫生**：任何切时区的测试必须在测试内**显式建立"初始无 `TZ`"的已知起点**（先记录并 `delete process.env.TZ`），不得依赖 CI 宿主恰好没设 `TZ`；`finally` 里必须先写回解析出的系统时区（这一步才真正刷新 Node 缓存），再把环境变量恢复成原样，并**双轴断言**：有效时区回来了 + `process.env.TZ` 与原值全等。已知事实：`delete process.env.TZ` 单独使用**不能**恢复系统时区。

---

## 5. 最终全仓 Gate

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

四条全部退出 0，且 `git diff --check` 干净。另需人工确认：`CROSS-REVIEW.md` 不在 `git status` 的任何输出里。

**本机注意**：裸 `pnpm` 可能不在 PATH（只有 `corepack`），而仓库的 `pretest` / `prebuild` / `pretypecheck` 会调用裸 `pnpm`。用临时目录 shim 转发，且**每次 PowerShell 调用都要重新前置 PATH**（shell 状态不跨调用保留）：

```powershell
$shim = Join-Path $env:TEMP "tenjin-pnpm-shim"
New-Item -ItemType Directory -Force $shim | Out-Null
Set-Content -Path (Join-Path $shim "pnpm.cmd") -Value "@echo off`r`ncorepack pnpm %*" -Encoding ascii
$env:PATH = "$shim;$env:PATH"
```

不要往 `AppData\Roaming\npm` 写东西，也不要硬编码 Corepack 缓存路径。

---

## 6. 仍需 owner 决定的问题（不得自行扩大范围解决）

1. **T1 触碰 `apps/web` 生产代码**（`ledgerRuntime.ts`、`createCapture.ts`）。它是纯重构、零行为变化、由既有精确序列化测试守卫，但严格说超出了"只动 exchange / storage"的直觉边界。**若不批准**，替代方案是在 exchange 里复制一份序列化 + 一条跨包一致性测试——代价是两份实现可能漂移，而漂移的表现是恢复期 hash 误判。**推荐批准提取。**
2. **T11 新建 `apps/web` 测试文件**。这是把 L2 的复习队列断言接到真实 `buildReviewQueue` 的唯一方式（storage 不能反向依赖 apps/web）。它不含生产代码也不碰 UI。**若不批准**，L2 的队列部分只能用桩函数验证，等于没验真实构造器。
3. **上限具体数值**（§T2）：压缩包 100 MB / 解压总量 250 MB / 单图 20 MB / events.jsonl 64 MB / 事件 20 万 / context 5 万。图片那条锚定既有 `MAX_CONTEXT_IMAGE_BYTES`，其余是我按数量级取的。**需要你按真实数据量确认或改数。**
4. **`structurallyEqual` 的导出面**：直接从 `@tenjin/storage-indexeddb` 的公共 index 导出（apps/web 也能看见），还是另开一个 `/testing` 子入口限制可见性？后者更干净但要动 package.json 的 `exports`。
5. **`newDeviceId` 由谁生成**：本计划要求调用方传入并校验不在包内。生成与写入 localStorage 属 UI 切片。**确认这个分工，还是希望恢复器自己 `crypto.randomUUID()`？**（后者会让 storage 层产生一个隐式的身份来源，我倾向前者。）
6. **恢复后 localStorage 与 IndexedDB 的一致性由谁保证**：两者是独立存储，本轮只保证 IndexedDB 侧正确。若 UI 切片之前有人手工调用恢复器而忘了更新 localStorage，会出现"新账本 + 旧 deviceId"。是否需要在本轮加一个显式的返回值提示调用方必须持久化新身份？

---

## 7. 自检结果

**规格矛盾**：已对照切片 v1.2 逐条核。抽象模式在本计划中只出现在"必须拒绝"的语境（T4）；恢复语义按 §5.2.1 四条写进 T8 测试 6；"零写入风险"的错误措辞已在切片 §7.1 作废，本计划 §3.6 用事务纪律取代。**未发现残留矛盾。**

**永远 PASS 的断言**：逐条排查了四类。① 体积上限——若实现改成"先解压再判断"，超限测试仍会通过，因此 T3 强制要求一条证明"第一遍未解压"的断言；② UTF-8 校验——非 fatal 解码器会让它永不触发，§3.5 写死 fatal；③ 摘要自洽——"改字节同时改摘要"能骗过形状与自洽校验，T6 强制一条专打此假绿的测试；④ 复习队列比较——只断言"相同"无法区分"没在比"，T11 强制一条正向对照。

**错误 fixture**：T6 的负样本必须用**生产形状**的摘要（context hash 为 `sha256:` + 64 位小写 hex，image sha256 为裸 64 位 hex）。导出器那轮的教训是短摘要 fixture 会被更早的格式校验先拦下，于是目标断言从未执行。

**事务自动提交**：§3.6 写死"事务内不得 await 非 IndexedDB Promise"，并给出既有代码的两处先例作为佐证；T8 的实现红线重复了一遍。

**未知 store 漏检**：T10 要求按 `db.objectStoreNames` 动态枚举 + 分类穷尽 + 未分类即失败，并强制一条"临时加第三个 store 必须让验证器失败"的测试——这条守的正是"随版本演进越来越空的检查"。

## 8. 变更记录

| 版本 | 变更类型 | 变更内容 | 经办人 | 时间 |
|---|---|---|---|---|
| v1.0 | 初稿 | 冻结恢复器 + 等价验证器 + 负样本矩阵的 12 个 TDD 任务、文件写集、依赖图、关键设计决定与 6 个待决问题 | Fable 5 | 2026-08-07 |
