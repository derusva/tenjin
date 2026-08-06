# A1 账本导出器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `@tenjin/exchange` 包，把账本快照确定性地导出成 `HANDOFF.md` §5.3 定义的 `.tenjin` **完整备份包**。

**Architecture:** 纯函数库，不依赖 IndexedDB、DOM 或浏览器。输入是一个普通对象（事件数组 + context 数组，图片以 `Uint8Array` 传入），输出是 `Uint8Array` 形式的 zip 字节。水位从事件集派生而非读时钟——这样导出是事件集的纯函数，与账本"派生视图可重建"的纪律一致。Blob ↔ Uint8Array 的转换留在调用方（后续 UI 计划），因此本包 `lib` 保持 `["ES2023"]`、无 DOM 依赖、可在纯 Node 下测试。

**Tech Stack:** TypeScript（NodeNext、strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）、Vitest、fflate（zip 实现）。

**范围边界：** 本计划只做导出，且**只做完整备份模式**。校验器、恢复器、等价验证器、负样本矩阵在下一份计划（它们依赖本计划确定的包格式）。UI 与真机 runbook 在第三份计划。切片总定义见 [`docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`](../../decisions/2026-08-05-a1-ledger-recovery-slice.md)。

**抽象交换模式本轮不做**（切片 §3.1）：它唯一的价值是不携带原文，而 `apps/web/src/features/capture/createCapture.ts:165` 把 `display = corrected ?? original` 写进 `item_created.payload.display`，lookup 下 `corrected` 恒为 `undefined`——原句因此进了**事件本身**，抽象包按现状不可能不泄漏。前置条件是 `focus` 分离落地。本计划仍然把泄漏扫描器建起来并用**正向对照**证明它有效，这样抽象模式恢复时可以直接拿它证否。

**Task 6（开放 `structurallyEqual`）已移出本计划**：导出器不需要它，只有下一份计划的等价验证器需要。不提前扩大 `@tenjin/storage-indexeddb` 的公共 API。

**待拍板项已在此解决：** `HANDOFF.md` §17 把「`.tenjin` 压缩实现库」列为未定。本计划选 **fflate**：约 30KB、无原生依赖、浏览器与 Node 同源可用、提供同步 API（测试无需处理流），且支持逐文件设置 `mtime`——这是"同一输入产出逐字节相同的包"所必需的。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/exchange/package.json` | 包声明；依赖 `@tenjin/core`（仅取 `Event`、`HybridLogicalClock` 类型）与 `fflate` |
| `packages/exchange/tsconfig.json` | 镜像 `packages/core/tsconfig.json` |
| `packages/exchange/src/canonicalJson.ts` | 确定性 JSON 序列化（递归排序键、拒绝 undefined 与非有限数） |
| `packages/exchange/src/watermark.ts` | 从事件集派生每设备最大 seq 与最大 HLC；HLC 比较 |
| `packages/exchange/src/eventOrder.ts` | 事件的规范全序比较 |
| `packages/exchange/src/manifest.ts` | manifest 类型与构造 |
| `packages/exchange/src/exportPackage.ts` | 组装 zip 条目并编码为 `.tenjin` 字节 |
| `packages/exchange/src/index.ts` | 公开出口 |
| 各 `*.test.ts` | 与源码同目录，沿用仓内既有约定 |

`canonicalJson` 与 contextHash 的序列化（`apps/web/src/features/ledger/ledgerRuntime.ts:97-108`）**是两件不同的事**，不得互相复用：后者用固定字面量顺序且只覆盖四个字段，是内容身份的一部分，改动会改变历史 hash；前者递归排序全部键，只服务导出的字节确定性。Task 1 的测试会把这条区别钉住。

---

## Task 1: 搭建 `@tenjin/exchange` 包与 canonical JSON

**Files:**
- Create: `packages/exchange/package.json`
- Create: `packages/exchange/tsconfig.json`
- Create: `packages/exchange/src/canonicalJson.ts`
- Create: `packages/exchange/src/index.ts`
- Test: `packages/exchange/src/canonicalJson.test.ts`

- [ ] **Step 1: 创建包声明**

`packages/exchange/package.json`：

```json
{
  "name": "@tenjin/exchange",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "pretest": "pnpm --filter @tenjin/core build",
    "test": "vitest run",
    "pretypecheck": "pnpm --filter @tenjin/core build",
    "typecheck": "tsc --noEmit",
    "prebuild": "pnpm --filter @tenjin/core build",
    "build": "tsc --project tsconfig.json"
  },
  "dependencies": {
    "@tenjin/core": "workspace:*",
    "fflate": "^0.8.2"
  }
}
```

`packages/exchange/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

`packages/exchange/src/index.ts`：

```ts
export * from "./canonicalJson.js";
```

- [ ] **Step 2: 写失败测试**

`packages/exchange/src/canonicalJson.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonicalJson.js";

describe("canonicalJson", () => {
  it("orders object keys independently of insertion order", () => {
    const left = { b: 1, a: { d: 2, c: 3 } };
    const right = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
  });

  it("rejects values it cannot represent deterministically", () => {
    expect(() => canonicalJson(() => undefined)).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
  });

  it("escapes strings the same way JSON.stringify does", () => {
    expect(canonicalJson({ "日本語\n": 'a"b' })).toBe('{"日本語\\n":"a\\"b"}');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @tenjin/exchange test
```

预期：FAIL，报找不到 `./canonicalJson.js`。

- [ ] **Step 4: 实现**

`packages/exchange/src/canonicalJson.ts`：

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Deterministic JSON used for package bytes only.
 *
 * This is NOT the context-hash serialiser. The context hash uses a fixed
 * literal field order over four fields and is part of content identity;
 * changing it would change historical hashes. This function recursively
 * sorts every key and exists purely so that the same ledger exports to the
 * same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalJson cannot serialise the non-finite number ${String(value)}`,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(
    `canonicalJson cannot serialise a value of type ${Object.prototype.toString.call(value)}`,
  );
}
```

- [ ] **Step 5: 安装依赖并运行测试确认通过**

```bash
pnpm install
```

```bash
pnpm --filter @tenjin/exchange test
```

预期：6 个测试全部 PASS。

- [ ] **Step 6: 确认类型与 lint 干净**

```bash
pnpm --filter @tenjin/exchange typecheck
```

预期：无输出、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add packages/exchange pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(exchange): add canonical JSON serialiser"
```

---

## Task 2: 事件规范全序

**Files:**
- Create: `packages/exchange/src/eventOrder.ts`
- Modify: `packages/exchange/src/index.ts`
- Test: `packages/exchange/src/eventOrder.test.ts`

排序键与 `packages/core/src/reducer.ts` 的账本全序一致：`(hlc.wallTime, hlc.counter, deviceId, seq, eventId)`。导出必须自己持有这个顺序，因为 reducer 的比较函数没有对外导出。

- [ ] **Step 1: 写失败测试**

`packages/exchange/src/eventOrder.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Event } from "@tenjin/core";
import { compareEventsCanonically, sortEventsCanonically } from "./eventOrder.js";

function stub(
  overrides: Partial<{
    eventId: string;
    deviceId: string;
    seq: number;
    wallTime: number;
    counter: number;
  }>,
): Event {
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? "device-a:1",
    deviceId: overrides.deviceId ?? "device-a",
    seq: overrides.seq ?? 1,
    hlc: {
      wallTime: overrides.wallTime ?? 1_000,
      counter: overrides.counter ?? 0,
    },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "item_created",
    captureId: "capture-1",
    itemId: "item-1",
    payload: {
      display: "手を打つ",
      identityKey: "手を打つ",
      targetChannels: ["R"],
    },
  } as Event;
}
```

> `item_created` 在信封层同时要求 `itemId` 与 `captureId`（`packages/core/src/events.ts`）。`vitest` 走 esbuild 转译、不做完整类型检查，因此只有 `tsc --noEmit` 会抓到缺字段——每个任务的 typecheck 步骤不可跳过。

```ts

describe("compareEventsCanonically", () => {
  it("orders by wallTime first", () => {
    const older = stub({ wallTime: 1 });
    const newer = stub({ wallTime: 2 });
    expect(compareEventsCanonically(older, newer)).toBeLessThan(0);
    expect(compareEventsCanonically(newer, older)).toBeGreaterThan(0);
  });

  it("breaks wallTime ties with the counter", () => {
    const first = stub({ wallTime: 1, counter: 0 });
    const second = stub({ wallTime: 1, counter: 1 });
    expect(compareEventsCanonically(first, second)).toBeLessThan(0);
  });

  it("breaks clock ties with deviceId then seq then eventId", () => {
    const a = stub({ deviceId: "device-a", seq: 2, eventId: "device-a:2" });
    const b = stub({ deviceId: "device-b", seq: 1, eventId: "device-b:1" });
    expect(compareEventsCanonically(a, b)).toBeLessThan(0);

    const seqLow = stub({ deviceId: "device-a", seq: 1, eventId: "x" });
    const seqHigh = stub({ deviceId: "device-a", seq: 2, eventId: "a" });
    expect(compareEventsCanonically(seqLow, seqHigh)).toBeLessThan(0);
  });

  it("returns 0 only for identical ordering keys", () => {
    expect(compareEventsCanonically(stub({}), stub({}))).toBe(0);
  });
});

describe("sortEventsCanonically", () => {
  it("produces the same order regardless of input order", () => {
    const events = [
      stub({ eventId: "device-b:1", deviceId: "device-b", wallTime: 3 }),
      stub({ eventId: "device-a:1", deviceId: "device-a", wallTime: 1 }),
      stub({ eventId: "device-a:2", deviceId: "device-a", seq: 2, wallTime: 2 }),
    ];
    const forward = sortEventsCanonically(events).map((event) => event.eventId);
    const reversed = sortEventsCanonically([...events].reverse()).map(
      (event) => event.eventId,
    );
    expect(forward).toEqual(["device-a:1", "device-a:2", "device-b:1"]);
    expect(reversed).toEqual(forward);
  });

  it("does not mutate the input array", () => {
    const events = [
      stub({ eventId: "b", wallTime: 2 }),
      stub({ eventId: "a", wallTime: 1 }),
    ];
    sortEventsCanonically(events);
    expect(events.map((event) => event.eventId)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @tenjin/exchange test eventOrder
```

预期：FAIL，找不到 `./eventOrder.js`。

- [ ] **Step 3: 实现**

`packages/exchange/src/eventOrder.ts`：

```ts
import type { Event } from "@tenjin/core";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The canonical total order over events, matching the ledger fold order in
 * packages/core/src/reducer.ts. Exports must be byte-stable, so this order is
 * applied before serialisation.
 */
export function compareEventsCanonically(left: Event, right: Event): number {
  return (
    compareNumbers(left.hlc.wallTime, right.hlc.wallTime) ||
    compareNumbers(left.hlc.counter, right.hlc.counter) ||
    compareStrings(left.deviceId, right.deviceId) ||
    compareNumbers(left.seq, right.seq) ||
    compareStrings(left.eventId, right.eventId)
  );
}

export function sortEventsCanonically(
  events: readonly Event[],
): readonly Event[] {
  return [...events].sort(compareEventsCanonically);
}
```

`packages/exchange/src/index.ts` 追加：

```ts
export * from "./eventOrder.js";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @tenjin/exchange test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/exchange
git commit -m "feat(exchange): add canonical event ordering"
```

---

## Task 3: 从事件集派生水位

**Files:**
- Create: `packages/exchange/src/watermark.ts`
- Modify: `packages/exchange/src/index.ts`
- Test: `packages/exchange/src/watermark.test.ts`

水位从事件派生、不读 clock store。理由：① 导出因此是事件集的纯函数，与「派生视图全部可重建」一致；② `HANDOFF.md` §5.5 的水位语义是"导出设备已见的 `{device_id: max_seq}`"，我们只能声明自己实际持有的，而 clock store 可能因失败的 append 而高于实际持有量（seq 空洞），拿它当水位会让 §14.4 的数据健康指标虚高。

- [ ] **Step 1: 写失败测试**

`packages/exchange/src/watermark.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Event } from "@tenjin/core";
import { compareHlc, deriveWatermark } from "./watermark.js";

function stub(deviceId: string, seq: number, wallTime: number, counter = 0): Event {
  return {
    schemaVersion: 1,
    eventId: `${deviceId}:${seq}`,
    deviceId,
    seq,
    hlc: { wallTime, counter },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "capture_discarded",
    captureId: "capture-1",
    payload: { reason: "undo" },
  } as Event;
}

describe("compareHlc", () => {
  it("orders by wallTime then counter", () => {
    expect(compareHlc({ wallTime: 1, counter: 9 }, { wallTime: 2, counter: 0 })).toBeLessThan(0);
    expect(compareHlc({ wallTime: 2, counter: 0 }, { wallTime: 2, counter: 1 })).toBeLessThan(0);
    expect(compareHlc({ wallTime: 2, counter: 1 }, { wallTime: 2, counter: 1 })).toBe(0);
  });
});

describe("deriveWatermark", () => {
  it("returns a zero baseline for an empty ledger", () => {
    expect(deriveWatermark([])).toEqual({
      maxSeqByDevice: {},
      maxHlc: { wallTime: 0, counter: 0 },
    });
  });

  it("keeps the highest seq per device", () => {
    const watermark = deriveWatermark([
      stub("device-a", 1, 10),
      stub("device-a", 7, 20),
      stub("device-a", 3, 30),
      stub("device-b", 2, 40),
    ]);
    expect(watermark.maxSeqByDevice).toEqual({ "device-a": 7, "device-b": 2 });
  });

  it("keeps the highest HLC across every device", () => {
    const watermark = deriveWatermark([
      stub("device-a", 1, 100, 5),
      stub("device-b", 1, 100, 9),
      stub("device-c", 1, 99, 12),
    ]);
    expect(watermark.maxHlc).toEqual({ wallTime: 100, counter: 9 });
  });

  it("is independent of input order", () => {
    const events = [stub("device-a", 4, 40), stub("device-a", 1, 10), stub("device-b", 9, 20)];
    expect(deriveWatermark(events)).toEqual(deriveWatermark([...events].reverse()));
  });

  it("does not invent devices that hold no events", () => {
    expect(Object.keys(deriveWatermark([stub("device-a", 1, 1)]).maxSeqByDevice)).toEqual([
      "device-a",
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @tenjin/exchange test watermark
```

预期：FAIL，找不到 `./watermark.js`。

- [ ] **Step 3: 实现**

`packages/exchange/src/watermark.ts`：

```ts
import type { Event, HybridLogicalClock } from "@tenjin/core";

export interface LedgerWatermark {
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly maxHlc: HybridLogicalClock;
}

export function compareHlc(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  if (left.wallTime !== right.wallTime) {
    return left.wallTime < right.wallTime ? -1 : 1;
  }
  if (left.counter !== right.counter) {
    return left.counter < right.counter ? -1 : 1;
  }
  return 0;
}

/**
 * Derives the exchange watermark from the event set alone. Deliberately does
 * not read the clock store: a failed append can leave the allocator above what
 * the ledger actually holds, and the watermark must only claim held events.
 */
export function deriveWatermark(events: readonly Event[]): LedgerWatermark {
  const maxSeqByDevice: Record<string, number> = {};
  let maxHlc: HybridLogicalClock = { wallTime: 0, counter: 0 };

  for (const event of events) {
    const current = maxSeqByDevice[event.deviceId];
    if (current === undefined || event.seq > current) {
      maxSeqByDevice[event.deviceId] = event.seq;
    }
    if (compareHlc(event.hlc, maxHlc) > 0) {
      maxHlc = { wallTime: event.hlc.wallTime, counter: event.hlc.counter };
    }
  }

  return { maxSeqByDevice, maxHlc };
}
```

`packages/exchange/src/index.ts` 追加：

```ts
export * from "./watermark.js";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @tenjin/exchange test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/exchange
git commit -m "feat(exchange): derive exchange watermark from events"
```

---

## Task 4: Manifest 与导出输入类型

**Files:**
- Create: `packages/exchange/src/manifest.ts`
- Modify: `packages/exchange/src/index.ts`
- Test: `packages/exchange/src/manifest.test.ts`

`foldExternalState` 是**前向兼容闸，不是插槽**。一个空数组证明不了"将来加入导入台账不破格式"，所以不作此声称。它的契约是：**非空即表示该包携带了本版不认识的 fold 外状态，恢复器必须拒绝整个包**（静默丢弃会造成"恢复看似成功、幂等信息已丢"的假绿）。v1 导出恒为空数组；真正加入台账时明确升 `schemaVersion` 到 2 并届时冻结 descriptor 结构——现在不冻结，因为台账形状取决于 Stage 0 结果。拒绝逻辑属于恢复器，在下一份计划实现；本任务只保证导出永远不产生非空值。

`mode` 在 v1 是单成员字面量类型 `"full-backup"`。保留这个字段而不是删掉，是为了将来加入抽象模式时调用方签名不变；恢复器遇到不认识的 mode 必须拒绝。

- [ ] **Step 1: 写失败测试**

`packages/exchange/src/manifest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.js";

const baseInput = {
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
  eventCount: 3,
  contextCount: 2,
  watermark: {
    maxSeqByDevice: { "device-a": 3 },
    maxHlc: { wallTime: 42, counter: 1 },
  },
};

describe("buildManifest", () => {
  it("stamps the package kind, schema version and generation", () => {
    const manifest = buildManifest(baseInput);
    expect(manifest.packageKind).toBe("tenjin-ledger");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generation).toBe(0);
  });

  it("never emits fold-external state in v1", () => {
    expect(buildManifest(baseInput).foldExternalState).toEqual([]);
  });

  it("stamps the only mode this version can produce", () => {
    expect(buildManifest(baseInput).mode).toBe("full-backup");
  });

  it("carries the derived watermark through unchanged", () => {
    const manifest = buildManifest(baseInput);
    expect(manifest.maxSeqByDevice).toEqual({ "device-a": 3 });
    expect(manifest.maxHlc).toEqual({ wallTime: 42, counter: 1 });
  });

  it("rejects a non-canonical exportedAt timestamp", () => {
    expect(() =>
      buildManifest({ ...baseInput, exportedAt: "2026-08-05 12:00:00" }),
    ).toThrow(TypeError);
  });

  it("rejects an empty exporting device id", () => {
    expect(() => buildManifest({ ...baseInput, exportedByDeviceId: "  " })).toThrow(
      TypeError,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @tenjin/exchange test manifest
```

预期：FAIL，找不到 `./manifest.js`。

- [ ] **Step 3: 实现**

`packages/exchange/src/manifest.ts`：

```ts
import type { LedgerWatermark } from "./watermark.js";

/**
 * v1 can only produce full backups. The abstract-exchange mode is deferred
 * until `focus` separation lands, because item_created.payload.display
 * currently carries the source sentence (createCapture.ts:165), so an
 * "abstract" package could not honour its only promise. Restorers must reject
 * any mode they do not recognise.
 */
export type LedgerPackageMode = "full-backup";

export interface LedgerPackageManifest {
  readonly packageKind: "tenjin-ledger";
  readonly schemaVersion: 1;
  readonly mode: LedgerPackageMode;
  readonly generation: number;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly maxHlc: LedgerWatermark["maxHlc"];
  /**
   * Forward-compatibility guard, NOT a reserved slot.
   *
   * A non-empty array means the package carries fold-external state (the first
   * case will be Coach import receipts) that the reading version may not
   * understand. A restorer that does not understand every listed key MUST
   * reject the whole package rather than silently dropping the state - a
   * silent drop produces a restore that looks successful while the idempotency
   * record is gone. v1 exports always emit an empty array; actually adding
   * such state bumps schemaVersion to 2.
   */
  readonly foldExternalState: readonly string[];
}

export interface BuildManifestInput {
  readonly mode: LedgerPackageMode;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly contextCount: number;
  readonly watermark: LedgerWatermark;
}

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function buildManifest(
  input: BuildManifestInput,
): LedgerPackageManifest {
  if (input.exportedByDeviceId.trim().length === 0) {
    throw new TypeError("exportedByDeviceId must be a non-empty string");
  }
  if (!CANONICAL_UTC_TIMESTAMP.test(input.exportedAt)) {
    throw new TypeError(
      `exportedAt must be a canonical UTC ISO-8601 timestamp, received ${input.exportedAt}`,
    );
  }

  return {
    packageKind: "tenjin-ledger",
    schemaVersion: 1,
    mode: input.mode,
    generation: 0,
    exportedByDeviceId: input.exportedByDeviceId,
    exportedAt: input.exportedAt,
    eventCount: input.eventCount,
    contextCount: input.contextCount,
    maxSeqByDevice: input.watermark.maxSeqByDevice,
    maxHlc: input.watermark.maxHlc,
    foldExternalState: [],
  };
}
```

`generation` 固定为 0 并附注释：redaction 尚未实现，因此 ledger generation 目前恒为 0；字段存在是为了 redaction 落地时不改格式。

`packages/exchange/src/index.ts` 追加：

```ts
export * from "./manifest.js";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @tenjin/exchange test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/exchange
git commit -m "feat(exchange): add ledger package manifest"
```

---

## Task 5: 导出为 `.tenjin` 字节

**Files:**
- Create: `packages/exchange/src/exportPackage.ts`
- Create: `packages/exchange/src/inspectPackage.ts`
- Modify: `packages/exchange/src/index.ts`
- Test: `packages/exchange/src/exportPackage.test.ts`

包内条目（v1 只有完整备份，因此 contexts 恒被写入）：

```text
manifest.json                 canonicalJson(manifest)
events.jsonl                  每行 canonicalJson(event)，按规范全序
redactions.jsonl              始终写入，v1 恒为空字符串
contexts/<hex>.json           context 元数据（不含图片字节）
contexts/<hex>.image          该 context 有图片时写入；原始字节
```

`<hex>` 是去掉 `sha256:` 前缀后的摘要值——zip 条目名里带冒号在 Windows 解包时会出问题，完整 hash 仍保存在条目 JSON 内部。

本任务同时建立**泄漏扫描器** `inspectPackage.ts`。它现在没有可证否的对象（完整备份本来就该携带全部原文），但必须先建起来并用**正向对照**证明它确实能找到明文——否则等抽象模式恢复时，那个"扫不到原文"的断言无法与"扫描器本身失灵"区分开。扫描器**必须先解压再扫描**：包是 deflate 压缩的，直接扫 zip 字节即使数据在里面也搜不到，那是个永远 PASS 的检查。

- [ ] **Step 1: 写失败测试**

`packages/exchange/src/exportPackage.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { exportLedgerPackage } from "./exportPackage.js";
import type { ExportContext } from "./exportPackage.js";
import { scanPackagePlaintext } from "./inspectPackage.js";

const SENTINEL_SOURCE = "SENTINEL_SOURCE_TEXT";
const SENTINEL_ANSWER = "SENTINEL_ANSWER_TEXT";

function captureEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "capture_created",
    captureId: `capture-${seq}`,
    contextHash: "sha256:aa",
    payload: { captureType: "lookup" },
  } as Event;
}

/**
 * A real item_created, not a stripped-down stub. createCapture.ts:165 puts the
 * whole source text into payload.display, so this is what production data
 * actually looks like - and it is the reason the abstract mode is deferred.
 */
function itemCreatedEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "item_created",
    captureId: "capture-1",
    itemId: "item-1",
    payload: {
      display: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      identityKey: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      targetChannels: ["R"],
    },
  } as Event;
}

const secretContext: ExportContext = {
  hash: "sha256:aa",
  original: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
  answer: `${SENTINEL_ANSWER}_提前采取措施`,
  createdAt: "2026-08-05T00:00:00.000Z",
  image: {
    mediaType: "image/png",
    name: "shot.png",
    byteLength: 4,
    sha256: "sha256:bb",
    bytes: new Uint8Array([1, 2, 3, 4]),
  },
};

const input = {
  events: [itemCreatedEvent(2, 20), captureEvent(1, 10)],
  contexts: [secretContext],
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
};

describe("exportLedgerPackage", () => {
  it("writes manifest, events and redactions", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain("manifest.json");
    expect(Object.keys(entries)).toContain("events.jsonl");
    expect(Object.keys(entries)).toContain("redactions.jsonl");
    expect(strFromU8(entries["redactions.jsonl"]!)).toBe("");
  });

  it("serialises events in canonical order, one per line", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const lines = strFromU8(entries["events.jsonl"]!).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).eventId).toBe("device-a:1");
    expect(JSON.parse(lines[1]!).eventId).toBe("device-a:2");
  });

  it("carries contexts and raw image bytes", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain("contexts/aa.json");
    expect(entries["contexts/aa.image"]).toEqual(new Uint8Array([1, 2, 3, 4]));
    const stored = JSON.parse(strFromU8(entries["contexts/aa.json"]!));
    expect(stored.hash).toBe("sha256:aa");
    expect(stored.image.sha256).toBe("sha256:bb");
    expect(stored.image.bytes).toBeUndefined();
  });

  it("reports the real context count in the manifest", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(manifest.contextCount).toBe(1);
    expect(manifest.eventCount).toBe(2);
    expect(manifest.mode).toBe("full-backup");
    expect(manifest.foldExternalState).toEqual([]);
  });

  it("produces byte-identical output for the same input", () => {
    expect(exportLedgerPackage(input)).toEqual(exportLedgerPackage(input));
  });

  it("produces byte-identical output when the input arrays are shuffled", () => {
    const forward = exportLedgerPackage(input);
    const shuffled = exportLedgerPackage({
      ...input,
      events: [...input.events].reverse(),
    });
    expect(shuffled).toEqual(forward);
  });

  it("rejects an image whose declared byteLength disagrees with its bytes", () => {
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [
          {
            ...secretContext,
            image: { ...secretContext.image!, byteLength: 99 },
          },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("rejects a context hash without the expected sha256 prefix", () => {
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [{ ...secretContext, hash: "aa" }] }),
    ).toThrow(TypeError);
  });
});

describe("scanPackagePlaintext (positive control)", () => {
  // These assertions are deliberately POSITIVE. A full backup is supposed to
  // carry every byte of the ledger, so there is nothing to prove absent here.
  // What must be proved is that the scanner can actually see through the zip -
  // otherwise the future "an abstract package contains no source text"
  // assertion would pass even when the text is present.

  it("finds text stored inside a context entry", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).toContain(SENTINEL_ANSWER);
  });

  it("finds text stored inside an event payload", () => {
    // This is the exact leak that defers the abstract mode: createCapture.ts
    // writes the whole source text into item_created.payload.display, so the
    // sentence lives in events.jsonl, not only in contexts/.
    const eventsOnly = { ...input, contexts: [] };
    const haystack = scanPackagePlaintext(exportLedgerPackage(eventsOnly));
    expect(haystack).toContain(SENTINEL_SOURCE);
  });

  it("would not find text that is genuinely absent", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).not.toContain("SENTINEL_NEVER_WRITTEN");
  });

  it("does not depend on the raw zip bytes containing the plaintext", () => {
    // Guards the whole approach: scanning the compressed bytes is an
    // always-PASS check, because deflate hides the plaintext.
    const bytes = exportLedgerPackage(input);
    expect(strFromU8(bytes, true)).not.toContain(SENTINEL_ANSWER);
    expect(scanPackagePlaintext(bytes)).toContain(SENTINEL_ANSWER);
  });
});
```


- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @tenjin/exchange test exportPackage
```

预期：FAIL，找不到 `./exportPackage.js`。

- [ ] **Step 3: 实现**

`packages/exchange/src/inspectPackage.ts`（扫描器，必须先解压再扫描）：

```ts
import { strFromU8, unzipSync } from "fflate";

export function readPackageEntries(
  bytes: Uint8Array,
): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/**
 * Renders every entry of a package as text so that plaintext assertions can be
 * made against its real contents.
 *
 * Decompression is mandatory. A package is deflate-compressed, so scanning the
 * raw zip bytes cannot find the plaintext even when it is present - such a
 * check passes unconditionally and proves nothing.
 *
 * Each entry is rendered twice, as UTF-8 and as latin1, so that ASCII markers
 * are still found inside entries that are not valid UTF-8 (image bytes).
 */
export function scanPackagePlaintext(bytes: Uint8Array): string {
  const entries = readPackageEntries(bytes);
  const parts: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (entry === undefined) {
      continue;
    }
    parts.push(name, strFromU8(entry), strFromU8(entry, true));
  }
  return parts.join("\n");
}
```

`packages/exchange/src/exportPackage.ts`：

```ts
import { strToU8, zipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { canonicalJson } from "./canonicalJson.js";
import { sortEventsCanonically } from "./eventOrder.js";
import { buildManifest, type LedgerPackageMode } from "./manifest.js";
import { deriveWatermark } from "./watermark.js";

export interface ExportContextImage {
  readonly mediaType: string;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface ExportContext {
  readonly hash: string;
  readonly original: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly focus?: string;
  readonly image?: ExportContextImage;
  readonly createdAt: string;
}

export interface ExportLedgerPackageInput {
  readonly events: readonly Event[];
  readonly contexts: readonly ExportContext[];
  readonly mode: LedgerPackageMode;
  readonly exportedByDeviceId: string;
  readonly exportedAt: string;
}

const HASH_PREFIX = "sha256:";

function hashToEntryName(hash: string): string {
  if (!hash.startsWith(HASH_PREFIX)) {
    throw new TypeError(`context hash must start with ${HASH_PREFIX}: ${hash}`);
  }
  const hex = hash.slice(HASH_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`context hash must be lowercase hexadecimal: ${hash}`);
  }
  return hex;
}

function contextMetadata(context: ExportContext): Record<string, unknown> {
  const { image, ...rest } = context;
  if (image === undefined) {
    return { ...rest };
  }
  const { bytes, ...imageRest } = image;
  if (bytes.byteLength !== image.byteLength) {
    throw new TypeError(
      `context ${context.hash} declares byteLength ${image.byteLength} but carries ${bytes.byteLength} bytes`,
    );
  }
  return { ...rest, image: { ...imageRest } };
}

export function exportLedgerPackage(
  input: ExportLedgerPackageInput,
): Uint8Array {
  const events = sortEventsCanonically(input.events);
  const contexts = [...input.contexts].sort((left, right) =>
    left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
  );

  const manifest = buildManifest({
    mode: input.mode,
    exportedByDeviceId: input.exportedByDeviceId,
    exportedAt: input.exportedAt,
    eventCount: events.length,
    contextCount: contexts.length,
    watermark: deriveWatermark(events),
  });

  const eventsJsonl =
    events.map((event) => canonicalJson(event)).join("\n") +
    (events.length > 0 ? "\n" : "");

  // 每次导出内部现构造，不提到模块级常量——理由见下方说明。
  const mtime = new Date(1980, 0, 1, 12, 0, 0, 0);
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    "manifest.json": [strToU8(canonicalJson(manifest)), { mtime }],
    "events.jsonl": [strToU8(eventsJsonl), { mtime }],
    "redactions.jsonl": [strToU8(""), { mtime }],
  };

  for (const context of contexts) {
    const hex = hashToEntryName(context.hash);
    files[`contexts/${hex}.json`] = [
      strToU8(canonicalJson(contextMetadata(context))),
      { mtime },
    ];
    if (context.image !== undefined) {
      files[`contexts/${hex}.image`] = [context.image.bytes, { mtime }];
    }
  }

  return zipSync(files, { level: 6 });
}
```

这里有两个坑，都已在落地实现中踩实并修掉。

**其一：`mtime: 0` 不是「可能不确定」，而是直接抛错。** zip 存的是 DOS 日期，有效范围只有 1980–2099，Unix 纪元（1970）不在其中，fflate 抛 `date not in range 1980-2099`。所以固定值取 `new Date(1980, 0, 1, 12, 0, 0, 0)`；取正午而非午夜，是为了避开个别时区 DST 直接抹掉本地午夜的情况。

**其二：这个 `Date` 必须在每次导出内部现构造，绝不能提到模块级常量。** `Date` 存的是绝对时刻，而 fflate 编码 DOS 字段时读的是**本地日历 getter**（`getFullYear` / `getMonth` / `getHours`…）；两者只有在**同一时区内构造并编码**才互相抵消。模块级常量会把「加载那一刻所在时区」冻进一个绝对时刻，进程之后换到别的时区就编码出不同字节——在更西的时区甚至读回 1979、导出**直接抛错**。实测同一进程、同一个在 UTC+8 下构造的模块级常量：`UTC` 与 `Asia/Tokyo` 产出两个不同的包摘要，`America/Los_Angeles` 抛 `date not in range 1980-2099`。对应的真实场景是「在日本做完备份，把设备带到美西，PWA 一直没重启」。改成每次导出现构造后，同一输入在这三个时区产出的包字节完全一致。

字节确定性是后续等价验证与摘要辅助断言的前提；若两次导出仍不逐字节相同，调实现直到「byte-identical」测试变绿为止，**不要放宽那两个测试**。另注意：断言「常量的日历字段对不对」是**无效测试**——把常量留着、调用点改成 `new Date()`，它照样绿。要断言就断言**产出字节里的 DOS 字段**。

> **本代码块是计划当时的草案，不等于最终实现。** 除上面的 `mtime` 外，落地版还在三处收紧（以 `packages/exchange/src/` 为准）：① `buildManifest` 增加了 `mode` 的运行时白名单——`LedgerPackageMode` 是编译期字面量，运行时拦不住 `"abstract-exchange"`，而抽象模式正因为兑现不了「不携带原文」才暂缓；② `ExportContext` 去掉了预留的 `focus`，`contextMetadata` 改为按 schemaVersion 1 的**封闭字段表**显式构造，遇未知字段抛错而非静默丢弃（备份路径静默丢字段＝丢数据）；③ 摘要形状严格校验：context hash 为 `sha256:` + 64 位小写十六进制，图片 `sha256` 为**裸** 64 位小写十六进制、无前缀。

`packages/exchange/src/index.ts` 追加：

```ts
export * from "./exportPackage.js";
export * from "./inspectPackage.js";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @tenjin/exchange test
```

预期：全部 PASS，含两个 byte-identical 用例与四个扫描器正向对照用例。特别检查最后一个用例——它同时断言「压缩字节里搜不到明文」和「解压后搜得到」，这两条一起把"扫压缩字节"这个假绿写法钉死了。

- [ ] **Step 5: 全仓类型与 lint**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

预期：均退出码 0。

- [ ] **Step 6: 提交**

```bash
git add packages/exchange
git commit -m "feat(exchange): export full ledger backup packages"
```

Task 5 完成且全仓测试通过后，本计划到此为止——**停下交审，不继续恢复器与 UI**。

---

## 自检结果

**切片规格覆盖**：本计划覆盖切片文档 §7 第 1 步（导出器）、§3 的包格式与命名纪律、§3.2 的 `foldExternalState` 前向兼容闸语义（导出侧：永不产生非空值；拒绝逻辑属恢复器）、以及 §5.3 要求的泄漏扫描器**正向对照**。切片第 2–3 步（恢复器、等价验证器、10 条负样本矩阵、2 条 must-not-fail）与第 4–5 步（UI、真机 runbook）不在本计划内，已在开头声明。

**must-not-fail 的提前覆盖**：「行序打乱仍 PASS」在本计划里以「输入数组打乱产出字节相同」的形式提前成立，这是规范排序的直接结果。「键序打乱」由 `canonicalJson` 的键排序测试覆盖（Task 1）。

**抽象模式相关断言的处置**：切片 §5.2 L2 中"抽象包 R/L/P 一字不变"、§5.3 第 10 条原「抽象包混入原文」均随抽象模式一并暂缓，已在切片文档改写。本计划把扫描器建好并证明其有效，使这些断言恢复时可以直接落地。

**占位符扫描**：无 TBD / TODO；每个改动步骤都带完整代码与确切命令。Task 5 Step 3 关于 `mtime` 的说明是明确的失败处置指令（调实现直到测试变绿，不许放宽测试），不是占位符。

**类型一致性**：`LedgerWatermark`（Task 3）被 Task 4 的 `BuildManifestInput.watermark` 与 Task 5 的 `deriveWatermark` 使用，字段名一致；`LedgerPackageMode`（Task 4，v1 为单成员字面量 `"full-backup"`）被 Task 5 的 `ExportLedgerPackageInput.mode` 复用；`ExportContext.image.bytes: Uint8Array`（Task 5）与 manifest 的 `contextCount` 无冲突；`compareHlc`（Task 3）导出备用，恢复器会用到；`scanPackagePlaintext` / `readPackageEntries`（Task 5）供下一份计划的等价验证器复用。

> **本节起草时的一处判断已被推翻，保留记录以免重蹈。** 原文写的是「`ExportContext` 预留了可选 `focus` 字段，本计划不实现它的任何行为」——这是错的，落地实现里 `focus` **已被移除**（见 Step 3 后的收紧说明第 ② 条）。预留一个没有行为的字段并不是无害的：`contextMetadata` 当时用 `...rest` 展开，于是任何多余键（实测 `focus` 与 `futureField` 都会）被写进 `schemaVersion: 1` 的包，在内容寻址层制造「同 hash 不同内容」的对象。现在 `contextMetadata` 按封闭字段表显式构造、遇未知键抛错。`focus` 要落地时必须连同 hash 与 identity 语义一起升 schema，而不是先埋一个空字段。

**已知的当前实现缺陷（不在本计划修，但已记录）**：`createCapture.ts:165` 把整句原文写进 `item_created.payload.display`，违反 `HANDOFF.md` §4.1「原句不进入状态字段」。这是抽象模式暂缓的直接原因，修复属 `focus` 分离工作。
