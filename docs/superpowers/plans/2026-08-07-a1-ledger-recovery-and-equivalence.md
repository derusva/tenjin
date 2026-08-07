# A1 账本恢复器与等价验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `.tenjin` 完整备份包能被严格校验并原子恢复到**空账本**，并交付一套能失败的独立等价验证器 + 11 条负样本 + 3 条 must-not-fail，补齐 `HANDOFF.md` 阶段 A1 Gate 的后端部分。

**Architecture:** 三层，边界即责任。`@tenjin/exchange` 保持纯函数、无 DOM、无 IndexedDB、无 Node 依赖，负责**解包与全部校验**，产出已验证的 `LedgerRestorePlan`；`@tenjin/storage-indexeddb` 定义自己的输入类型并负责**原子写入**与**原始读取**；等价验证器住在 storage 层，复习队列构造函数由调用方注入。**exchange 与 storage 互不依赖**；两者的集成、结构兼容断言与真实摘要接线**全部落在 `apps/web` 的集成测试**里——那是唯一同时依赖两者的地方。

**Tech Stack:** TypeScript（NodeNext、strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）、Vitest、idb、fake-indexeddb；ZIP **写用 fflate、读用 `@zip.js/zip.js`**（见 §3.3，owner 已冻结为 B-reader-only）。

**基线：** `fa4e048`。切片总定义见 [`docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`](../../decisions/2026-08-05-a1-ledger-recovery-slice.md)（**v1.5**）。

**状态：计划待审；批准后方可开工。** CRC 路线已冻结（§3.3），但 **T0 硬 Gate 未通过前 T3 不得开工**。

**交付口径（不可含糊）：** 本计划完成后只能声称 **BACKEND_READY / LIMITS_PROVISIONAL**——恢复能力在后端可用并已验证，限额仍是临时安全上限。**不得**声称"端到端恢复已交付"或"A1 完成"：§3.10 的激活状态机要到 UI 切片才落地，在那之前用户无法完成一次真实恢复。

---

## 0. 本计划明确不做

- Web 数据页按钮或任何 UI 实现；真机 runbook 的执行；
- Coach JSON 导入；`focus` 字段；DB 升到 v3；`importReceipts`；
- **非空账本恢复或任何形式的 merge / 去重 / 覆盖**（切片 §5.2.1 第 4 条）；
- `abstract-exchange` 模式的任何部分；
- 复习时间预算改造；教学或引导 UI；
- `newDeviceId` 的生成与 localStorage 写入（属 UI 切片，见 §3.8、§3.10）。

`packages/exchange` **新增且仅新增一个运行时依赖 `@zip.js/zip.js`**（只用于 restore 读包，见 §3.3；此前"不得新增运行时依赖"的说法随该冻结作废）。仍不得整包引入 DOM lib 或 `@types/node`，**其测试也不得 `import "node:crypto"`**（见 §3.2）——这条类型边界正是 T0 必须先验证的项目之一。

---

## 1. 文件写集

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/core/src/contextHash.ts` + `.test.ts` | 新建 | T1 |
| `packages/core/src/index.ts` | 追加 export | T1 |
| `apps/web/src/features/ledger/ledgerRuntime.ts` | 复用 core 序列化（**仅此**） | T1 |
| `apps/web/src/features/capture/createCapture.ts` | 复用 core 类型（**仅此**） | T1 |
| **`packages/exchange/package.json`** | 加 `@zip.js/zip.js` 运行时依赖 | **T0** |
| **`pnpm-lock.yaml`** | 随上一行更新（与 T11 同一文件，注意先后） | **T0**、T11 |
| `packages/exchange/src/zipReaderProbe.test.ts` | 新建（T0 的能力探针，可在 Gate 通过后保留为回归测试） | **T0** |
| `packages/exchange/src/limits.ts` + `.test.ts` | 新建 | T2 |
| `packages/exchange/src/exportPackage.ts` | 追加导出前限额预检 | T2 |
| `packages/exchange/src/manifest.ts` + `.test.ts` | 收紧 `exportedByDeviceId` / `exportedAt` 校验（消除 exporter↔reader 漂移，见 T4） | **T4** |
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
| **`apps/web/package.json`** | 加 `@tenjin/exchange` devDependency；改三个 pre 脚本 | **T11** |
| **`pnpm-lock.yaml`** | 随上一行更新 | **T11** |
| `apps/web/src/features/ledger/restoreIntegration.test.ts` | 新建（**仅测试**） | T11 |

**绝对不得触碰：** `CROSS-REVIEW.md`（见 §5 的 Gate 定义）。

## 2. 任务依赖

```text
T0 (zip.js 能力硬 Gate) ─> T3
T1 ─> T6
T2 ─> T3 ─> T4 ─┐
          T5 ───┼─> T7 ─> T8 ─> T9 ─> T10 ─┬─> T11
          T6 ───┘                          └─> T12
```

T0、T1、T2 可并行；其余严格串行。**T0 任一项失败即停止并上报——不得自动改走路线 A，不得放宽任何安全边界。**

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

**必须加一条负样本**（矩阵第 11 条）：篡改 `events.jsonl` 或 `manifest.json` 的压缩数据、**不更新 CRC**，且构造成解压后仍是合法 UTF-8 / JSON / 通过 schema 的形态——必须因 `CRC_MISMATCH` 被拒。它是唯一能证明"CRC 校验真的在跑"的测试，其余校验对它全部无感。

### 3.4 ZIP 防护：严格读取器 + 按**实际产出**计量

体积上限**必须按实际解压产出计量**，不能只信中央目录声明的 `originalSize`——那是**攻击者可控的值**，伪造成"很小"的条目完全可以展开出几百 MB。

用 `@zip.js/zip.js` 的流式读取，把每个 entry 的输出接进一个**计数 `WritableStream`**：每收到一个 chunk 就累加单 entry 与总量，**任一越界立即通过 `AbortSignal` 终止**并抛错。计数发生在 chunk 层，因此终止点与实际写出的字节严格对应，不依赖任何声明值。

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

UI 切片按此实现，不得自行发挥。

#### 3.10.1 前一版的缺陷：从「任一 store 非空」推断「已提交」

前一版的状态表写着「pending 存在 + 任一 store 非空 → `RESTORE_PENDING_COMMITTED` → 提升该 id」。**这是错的，会毁掉一个完好的账本。**

反例：用户有一个**正常使用中的非空账本**，某次误点进恢复流程，pending 已经写下，随后 restore 因"目标库非空"被拒（正确行为）。此时磁盘上是「pending 存在 + 三 store 非空」——按旧表，下次启动会判定为"已提交"，把一个**从未被使用过的新 `deviceId`** 提升为正式身份，扣到那本**原封未动的旧账本**上。那个账本的 clock 里没有这个新身份的分配器记录，于是它从 `seq = 1` 开始发号，而账本里早已有旧身份发到很高的号——身份与账本从此对不上，且**没有任何报错**。

根因是把**推断**当**事实**：「非空」有两种成因（本来就有 / 我们刚写的），旧表只考虑了后一种。

#### 3.10.2 锁协议

- **所有可写 runtime 在其整个生命周期内持有一个 shared lock**（命名锁，如 Web Locks API 的 `shared` 模式）。不是"恢复时才加锁"——平时不持有，恢复方就无从知道还有谁在写。
- **恢复方的顺序**：① 通知其它 runtime 转入只读并**关闭连接**（释放各自的 shared lock）；② 然后申请**exclusive lock**；③ 拿不到 → **拒绝进入恢复流程**（fail-closed）；④ 运行环境不提供该能力 → 同样拒绝，不得"假装安全地继续"。
- **三 store 全空的检查必须在拿到 exclusive lock 之后、在该锁内进行**。锁外检查是 check-then-act。

#### 3.10.3 顺序被改了：先验空，再写 pending

```text
1. 禁写          停止本 runtime 的一切写入路径（采集、复习、撤销）
2. 让位          通知其它 runtime 转只读并关闭连接
3. exclusive     申请 exclusive lock；拿不到即拒绝，全程 fail-closed
4. 验空          在锁内检查 events / contexts / clock 三 store 全为 count === 0
   4a. 非空      →【拒绝】在此终止。**不写 pending**；localStorage 与原 deviceId 一字不动；
                   用户看到的是"当前账本非空，无法恢复"，而不是任何中间态
   4b. 全空      → 继续
5. 写并读回      生成 newDeviceId → 写 localStorage 的 pendingRestoreDeviceId → 立即读回校验一致
6. restore       调用 restoreLedger(input, pendingRestoreDeviceId)
7. 提升          成功后把 pendingRestoreDeviceId 提升为 tenjin.deviceId
8. 删 pending / close repository / reload
```

**第 4 步必须在第 5 步之前**，这是与前一版最重要的差别。这样 pending 只会为"当时确实为空的库"写下，`RESTORE_ABORTED_DIRTY` 这种状态在磁盘上不可能出现。

#### 3.10.4 `COMMITTED` 必须是事实，不是推断：durable commit marker

即便有了上面的顺序，「pending + 非空 = 已提交」仍然依赖一个前提：**在 pending 写下之后、除了我们的 restore 之外没有任何东西写过这个库**。要让这个前提成立，就得证明**每一条写路径**都参与了同一把锁——而那是一个需要穷举、且必须永远保持为真的审计义务，在一个还会继续长的代码库里没人能真正担保。

因此本计划要求：**恢复必须写一个 durable commit marker，与恢复数据在同一个 readwrite 事务内提交。** `COMMITTED` 的判据是**这个 marker 存在**，而不是"某个 store 非空"。

两处连带后果，已一并纳入本计划，不得遗漏：

- **T8**：`restoreLedger` 在同一事务内写入 marker（本轮 DB 保持 v2，marker 落在既有 `clock` store，键名 `restore-commit`）；
- **T10 L3**：clock 的精确键集合相应变为 `{"global-hlc", "restore-commit"} ∪ {"device-sequence:<id>" | id ∈ maxSeqByDevice}`。

> **与 owner 指令的差异（须知悉）**：owner 把 marker 写成了条件项（"若无法保证所有写路径参与同一锁，则必须改用"）。本计划**无条件采用** marker，因为条件的成立需要一份永远有效的穷举证明，而 marker 只需一条记录就把推断变成事实。若你坚持条件化，需回改 T8 与 T10 两处。

#### 3.10.5 状态表（据上）

| pending | commit marker | 状态 | 动作 |
|---|---|---|---|
| 无 | 任意 | `NORMAL` | 正常启动 |
| 有 | **无** | `RESTORE_PENDING_EMPTY` | **保持禁写**。两条出路：用**同一个** pending id 重新选包继续；或**显式取消**（删 pending → `NORMAL`）。不得静默丢弃 pending，不得自动铸新 id，**不得提升该 id** |
| 有 | **有** | `RESTORE_PENDING_COMMITTED` | **绝不再次 restore**。跑健全性检查 → 提升同一个 pending id → 删 pending → close → reload |

**失败清理规则：**

- 第 4a 步被拒（非空）→ 因为**根本没写 pending**，下次启动就是 `NORMAL`，无需清理；
- `restore` 抛错（零写入，marker 也未写）→ pending 保留、marker 不存在 → `RESTORE_PENDING_EMPTY`，可用同一 id 重试或显式取消；
- `restore` 成功但提升前崩溃 → marker 已随数据原子提交 → `RESTORE_PENDING_COMMITTED`，用同一 id 完成提升；
- **任何情况下都不得在未提升时铸新 id。**

#### 3.10.6 三个 UI Gate（UI 切片必须通过）

- **U1「DB 已提交但提升前崩溃」**：在第 6 步之后、第 7 步之前强杀应用；重启后必须进入 `RESTORE_PENDING_COMMITTED`，用同一 id 完成提升，且**不得再次调用 restore**。
- **U2「另一标签页持有旧 runtime」**：开两个标签页，其一进入恢复流程；必须要么被 fail-closed 拒绝，要么另一标签页被强制转只读并关闭连接。**绝不允许**"一个标签页恢复完成、另一个拿旧 `deviceId` 继续写"。
- **U3「既有非空库的恢复被拒」**：拿一个**正常使用中的非空账本**走恢复流程。必须在第 4a 步被拒；**localStorage 一字未改**（无 pending、`tenjin.deviceId` 原样）；随后**重启**——必须落在 `NORMAL`，**不得**进入 `RESTORE_PENDING_COMMITTED`，**不得**提升任何新 id，账本逐条不变。这条直接打 §3.10.1 那个反例。

---

## 4. 任务

### T0: `@zip.js/zip.js` 能力硬 Gate（阻塞 T3）

**Files:** `packages/exchange/package.json`、`pnpm-lock.yaml`、新建 `packages/exchange/src/zipReaderProbe.test.ts`

这是一道 **Gate 而不是实现任务**：先用探针实测证明这个库能同时满足下列全部要求，再谈写 `readPackage.ts`。**任一项失败即停止并上报——不得自动改走路线 A，不得放宽任何一条安全边界来"让它过"。**

- [ ] **G1 严格模式** — 读取器必须配置 `strictness: "strict"`、`checkSignature: true`、`checkOverlappingEntry: true`，并断言这三项确实生效（各配一条负样本：签名损坏、条目重叠）。
- [ ] **G2 明确拒绝清单** — 加密条目、multi-disk、ZIP64、以及本包不支持的 compression method（只允许 store 与 deflate），**逐项各一条负样本证明被拒**，且错误可区分。这些不是"大概不会遇到"，而是攻击面：一个声明加密或跨盘的包若被静默当普通包读，后面的全部校验都建立在错误的解析上。
- [ ] **G3 按实际产出限额** — 用**计数 `WritableStream`**接每个 entry 的输出，按 chunk 累加单 entry 与总解压字节，越界立即经 `AbortSignal` 终止。负样本：伪造较小 `originalSize`、实际展开更大——必须在**实际产出**触限时终止，且错误消息指向输出限额而**不是**任何更早的格式检查。
- [ ] **G4 CRC** — 篡改压缩数据但不更新 CRC，且构造成解压后仍是合法 UTF-8 / JSON / 通过 schema——必须报 **`CRC_MISMATCH`**。这是整个 T0 里最关键的一条：它是唯一能证明"CRC 真的在校验"的测试。
- [ ] **G5 双运行路径** — 同一份代码在 **Node**（Vitest）与**目标 Safari / iPhone** 路径下都能跑通 G1–G4。zip.js 基于 Web Streams，两边的可用性与 worker 行为并不当然一致；只在 Node 验过就上线，等于把失败推迟到真机。
- [ ] **G6 类型边界** — **`pnpm --filter @tenjin/exchange typecheck` 必须仍然退出 0**，且 `packages/exchange/tsconfig.json` 的 `lib` 仍为 `["ES2023"]`、既无 DOM 也无 `@types/node`。

> **G6 是本 Gate 里最可能失败的一项，务必先做。** zip.js 的公开 API 建立在 Web Streams（`ReadableStream` / `WritableStream` / `TransformStream`）之上，而这些类型在 TypeScript 里来自 DOM lib。若无法用 §3.5 那种极窄的本地 `declare` 把它们收敛在包内，就说明这个库无法在不破坏 exchange 类型边界的前提下使用——**那就是 T0 失败**，停下上报，由 owner 重新决定路线，而不是顺手给 exchange 加 DOM lib。

**Gate 产出**：把 G1–G6 各自的实测结果（命令、真实输出、结论）写回 §3.3，再进入 T3。探针测试文件可保留为回归测试。

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

**导出器必须共享同一份限额并在导出前预检**：`exportLedgerPackage` 压缩前校验条目数 / context 数 / 每条目声明大小 / 解压总量，压缩后再校验压缩体积。必须有一条测试证明"超限的账本导出即抛错，而不是产出一个自家恢复器拒收的包"。

---

### T3: 严格读包（zip.js）、UTF-8 严格解码、条目白名单

> **T0 未全绿之前不得开工。** 读取器为 `@zip.js/zip.js`，配置与拒绝清单沿用 T0 的 G1/G2 并在本任务落成生产代码；限额按 T0 的 G3 用计数 `WritableStream` + `AbortSignal` 实现；CRC 由读取器负责（G4）。

条目名白名单与重复条目检测仍是本任务的职责：读取器给出条目清单后，先按 §3.4 的白名单正则筛，再检测重名。**重名必须在拿到条目清单时就检出**——若把条目收进一个以名字为键的 map，重复项会静默塌成最后一个，那个"两条同名条目"的事实从此消失。

必须包含的测试（每条注释写清守什么）：

```ts
it("rejects a path traversal entry name", () => {
  // Whitelist, not blacklist: anything that is not exactly one of the five
  // legal shapes is rejected, so `../` never needs a special case.
});

it("rejects a duplicate entry name", () => {
  // Duplicates must be caught from the entry list, before anything keys them
  // by name - a name-keyed map silently collapses them to the last one and the
  // fact that there were two is gone.
});

it("rejects invalid UTF-8 in a text entry", () => {
  // A non-fatal TextDecoder turns these bytes into U+FFFD and this check would
  // never fire.
});

it("accepts a missing or empty redactions.jsonl but rejects a non-empty one", () => {});

it("rejects an entry that lies about originalSize and expands past the cap", () => {
  // The forged-size bomb: the central directory claims a small size, the
  // stream produces far more. Only the second pass, counting ACTUAL output,
  // can catch this. Assert on the output-limit error message so a red light
  // from some earlier format check cannot be mistaken for this guard firing.
  // NOTE: this stays a T3 unit test; the numbered matrix slot 11 belongs to
  // CRC (see T12).
});
```

限额按 §3.4 用计数 `WritableStream` 实现，按 chunk 累计**实际产出**字节，越界经 `AbortSignal` 终止。

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
| `contextCount` | 非负安全整数，且**精确等于**实际 context 条目数 | 同上 |
| `maxHlc` | `{ wallTime, counter }` 均为非负安全整数；**等于**事件集派生值；无多余键 | 数值不符 / 缺 `counter` / 多一个键 |
| `maxSeqByDevice` | 键为 canonical 非空 deviceId；值为**正**安全整数；键集与值**都**等于事件集派生结果 | 多一个设备 / 少一个设备 / 值偏大 / 值为 0 / 键含空白 |
| `foldExternalState` | 数组且**必须为空** | `["importReceipts"]` |

`foldExternalState` 非空的错误消息必须点明"本版不认识该状态，**拒绝整包**而非丢弃"；测试注释写清理由：静默丢弃 = 恢复看似成功但幂等信息已丢。

#### T4.1 消除 exporter ↔ reader 漂移（必须同批改 `manifest.ts`）

**现状是漂移的**：已交付的 `buildManifest` 对 `exportedByDeviceId` 只查 `trim().length === 0`，所以 `" device-a "` **能导出**；而上表的 reader 要求 `value === value.trim()`，会**拒绝**它。也就是说导出器能产出一个自家恢复器拒收的包——这类缺陷只有在真要恢复的那天才会暴露，正是备份路径上最不能有的。

`exportedAt` 同理：现有正则接受 `"2026-02-30T00:00:00.000Z"`（形状合法、日期不存在），而 `Date.parse` 会把它规范成 3 月 2 日，往返比对即可识破。

因此 `packages/exchange/src/manifest.ts` 与 `manifest.test.ts` **纳入本任务写集**，`buildManifest` 收紧到与 reader **逐字同一套规则**：

- `exportedByDeviceId`：非空 且 `value === value.trim()`；
- `exportedAt`：正则 且 `new Date(Date.parse(value)).toISOString() === value`。

必须补两类测试：

1. **非法闰日**：`"2026-02-30T00:00:00.000Z"`、`"2025-02-29T00:00:00.000Z"` 在**导出侧**即被拒；
2. **exporter → reader 自兼容**：凡 `buildManifest` 接受的输入，其产出必须能通过 T4 的 reader 校验。这条是防漂移的结构性保证——它把"两套规则是否一致"变成一条会红的测试，而不是靠人记得同步改两处。

---

### T5: events.jsonl 解析与逐事件校验

**解析顺序：先解析全部行 → 按规范全序排序 → 再做全部校验。** 这样行序不影响任何校验结果，must-not-fail 的"行序打乱"是结构性成立而非碰巧成立。

校验项：

- 每行一个 JSON 对象；空行只允许出现在文件末尾；任何解析失败拒绝；
- 每条过 `validateEvent`（core 已导出，`packages/core/src/events.ts:531`）；
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

`eventId` 与 `${deviceId}:${seq}` 不符；`deviceId` / `eventId` 首尾含空白；同一 `deviceId` 重复 `seq`；`occurredAt > recordedAt`；未撤销 capture 的 context 缺失；events.jsonl 中间出现空行。

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
11a. **durable commit marker**（§3.10.4）：`restore-commit` 记录**在同一个事务内**与数据一起提交，内容含 `newDeviceId` 与提交时刻。必须有一条测试证明**事务失败时它也不存在**——若它能在数据没写成的情况下留下，UI 会把一个失败的恢复读成 `COMMITTED` 并提升新身份，比没有 marker 更糟；
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

**必须跑完全部层再返回，不得首错短路。** 否则一个 L1 差异会掩盖 L2/L3 是否真的执行过，而"某层从未运行"与"某层通过"在只看 `ok` 时无法区分。必须有一条测试：制造同时触发 L1 与 L2 的差异，断言 `failures` 里**两个 code 都在**。

**L1**：按 `db.objectStoreNames` **动态枚举**。`events` / `contexts` 属精确相等类（`structurallyEqual`，Blob 逐字节）；`clock` 属具名语义类（交给 L3）；**任何未分类 store 产出 `L1_STORE_UNCLASSIFIED` 并判失败**。必须有一条测试：给测试库临时加第三个 store，断言验证器失败。

**L2**：`deriveLedger` 的完整 `ItemView` 逐字段相等 → `L2_ITEM_VIEW`；复习队列序列 → `L2_REVIEW_QUEUE`（探针注入）。

**L3（全部只读，不得改动被验证的库）**：

- `global-hlc` 已持久化且**严格大于**包内最大 HLC；
- 每个历史设备的 `device-sequence:<id>` 水位已持久化且值正确；
- **`newDeviceId` 不存在 `device-sequence` 记录**；
- **clock 的键集合精确等于** `{"global-hlc", "restore-commit"} ∪ {"device-sequence:<id>" | id ∈ maxSeqByDevice}`——新身份的 `device-sequence` 键、任何多余的旧身份键都不得存在（`restore-commit` 见 §3.10.4）；
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

### T11: apps/web 集成测试（含依赖边界改动）

**Files:** `apps/web/package.json`、`pnpm-lock.yaml`、新建 `apps/web/src/features/ledger/restoreIntegration.test.ts`

exchange 与 storage **互不依赖**，所以两者的集成只能在同时依赖它们的地方验证。`apps/web` 目前只依赖 `@tenjin/core` 与 `@tenjin/storage-indexeddb`，必须补齐：

- [ ] **Step 1: `apps/web/package.json` 加 devDependency**

```json
"devDependencies": {
  "@tenjin/exchange": "workspace:*",
  ...
}
```

devDependency 而非 dependency：生产代码不引用它，只有集成测试引用。

- [ ] **Step 2: 三个 pre 脚本必须同时构建 exchange 与 storage**

```json
"pretest": "pnpm --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
"pretypecheck": "pnpm --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build",
"prebuild": "pnpm --filter @tenjin/storage-indexeddb --filter @tenjin/exchange build"
```

用多个 `--filter` 而不是 `&&`：避免依赖 shell 的链式语法。两个包各自的 `prebuild` 会构建 core，无需再列。

- [ ] **Step 3: `pnpm install` 更新 lockfile**，并把 `pnpm-lock.yaml` 一并纳入本任务提交。

- [ ] **Step 4: 集成测试三块内容**

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
| 11 | **篡改 `events.jsonl` / `manifest.json` 的压缩数据、不更新 CRC，且解压后仍是合法 UTF-8 / JSON / 通过 schema** | package | §3.3 的 CRC 校验 | **`CRC_MISMATCH`**；**依赖 CRC 路线冻结** |

第 11 条是唯一能证明"CRC 校验真的在跑"的测试——其余全部校验对它无感，因为它构造成处处合法。

**forged `originalSize` 的 zip bomb 保留为 T3 单测**（不占矩阵编号），但**必须存在**；它与第 11 条守的是两件不同的事：前者是体积，后者是完整性。

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
```

全仓四条，全部退出 0：

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

加 `git diff --check` 干净。

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
| 2 | T11 新增 apps/web 集成测试 + 改 `package.json` / `pnpm-lock.yaml` | **批准**，仅测试与依赖声明，无生产代码 |
| 3 | `structurallyEqual` 导出面 | **package-internal named export**；不进 root `index.ts`，不建 `/testing` |
| 4 | `newDeviceId` 来源 | **调用方生成并传入**；storage 永不生成；必须 canonical（非空 / trim 后非空 / `value === value.trim()`） |
| 5 | 禁用集合 | 事件全部 `deviceId` ∪ `manifest.exportedByDeviceId` |
| 6 | localStorage 与 IndexedDB 一致性 | 由 §3.10 的状态机与六步协议保证；本轮只交付后端 |
| 7 | 单图 20 MiB | **正式产品约束** |
| 8 | 其余限额 | **provisional security ceilings**，是拒绝阈值不是支持容量 |
| 9 | ZIP64 | 本轮不引入；`entries <= 65_535`、`contexts <= 32_766` |
| 10 | 最低支持设备 | **用户实际在用的 iPhone**。具体机型是 UI / 真机 Gate 的前置，**不阻塞后端**；限额冻结在那时进行 |
| 11 | exchange 测试用 crypto | **禁用 `node:crypto`**；用注入式确定性假摘要或预计算 fixture；真实摘要由 T11 集成测试证明 |
| 12 | `TextDecoder` 窄声明 | **按 §3.5 当前写法执行**；若将来别处引入 `@types/node` 导致冲突，届时由 exchange 独立 typecheck 暴露并收敛 |
| 13 | `events` 上限 200,000 | 保持 **provisional ceiling**，等真机数据再校准，不作为待决问题 |
| 14 | 交付口径 | **BACKEND_READY / LIMITS_PROVISIONAL**；不得声称 A1 完成 |
| 15 | **CRC 路线** | **已冻结为 B-reader-only**：写侧保留 fflate、导出字节合同一字不改；读侧新增 `@zip.js/zip.js`。exchange 因此**新增且仅新增这一个运行时依赖**（旧的"不得新增运行时依赖"作废） |
| 16 | **恢复提交判据** | **durable commit marker**（§3.10.4），与恢复数据同事务提交；`COMMITTED` 是 marker 存在这一**事实**，不是"某 store 非空"这一**推断** |

## 7. 仍需 owner 决定的问题

**无。** 上一版唯一的阻塞项（CRC 路线）已冻结为 B-reader-only。

余下的**不是决定而是 Gate**：**T0 必须全绿**（G1–G6，尤其 G6 类型边界）才可进 T3。T0 任一项失败即停止并上报，**不得自动改走路线 A，不得放宽任何安全边界**。

---

## 8. 自检结果

**规格矛盾**：对照切片 v1.5 逐条核。抽象模式只出现在"必须拒绝"语境（T4）；恢复语义按切片 §5.2.1 四条写进 T8 测试 13；"零写入风险"的错误措辞已在切片 §7.2 作废，本计划 §3.6 用事务纪律取代；交付口径统一为 BACKEND_READY / LIMITS_PROVISIONAL；负样本数量、切片与计划均为 11 + 3。CRC 冻结后已清理三处旧说法：§0 的"不得新增运行时依赖"、§3.3 的"路线 B 必须替换 exporter"、依赖图与 Tech Stack。**未发现残留矛盾。**

**永远 PASS 的断言**：① 声明体积上限——实现若改成"先解压再判断"，超限测试仍会通过，故 T3 强制一条"证明未解压即拒"的断言；② 伪造 `originalSize`——只信中央目录等于没有防护，故 §3.4 强制按**实际产出**计量、T0-G3 单列为 Gate；③ **CRC**——不校验 CRC 时，一个"处处合法但内容被改"的包会通过全部其余校验，故立为 T0-G4 与矩阵第 11 条；④ UTF-8——非 fatal 解码器让该校验永不触发，§3.5 写死 fatal，exchange typecheck 列为独立 Gate 并进 T0-G6；⑤ 摘要自洽——"改字节同时改摘要"能骗过形状与自洽校验，T6 强制专打此假绿的测试；⑥ **真实摘要**——两个同样错的摘要互相比对也会"通过"，故 T11 先断言 `crypto.subtle` 存在并核对 NIST 向量，再谈往返；⑦ 复习队列——只断言"相同"无法区分"没在比"，T11 强制断言探针被调用两次 + 专属 `L2_REVIEW_QUEUE`；⑧ 首错短路——一个 L1 差异会掩盖 L2/L3 是否执行过，T10 强制"两个 code 同时出现"；⑨ **空库判定**——只查 `events` 会把"打开过但没采集"（clock 非空）的库判为空，T8 测试 6–8 三个方向各一条；⑩ **`COMMITTED` 判据**——从"某 store 非空"推断已提交，会把"非空库被拒 + 残留 pending"误读成已提交并提升新身份，故改为 durable marker 并配 U3；⑪ **exporter↔reader 漂移**——导出器接受而恢复器拒绝的包，只有在真要恢复那天才暴露，故 T4.1 加一条 exporter→reader 自兼容测试把它变成会红的检查。

**错误 fixture**：T6 负样本必须用**生产形状**摘要（context hash 为 `sha256:` + 64 位小写 hex，image sha256 为裸 64 位 hex）。导出器那轮的教训是短摘要 fixture 会被更早的格式校验先拦下，目标断言从未执行。

**事务自动提交**：§3.6 写死"事务内不得 await 非 IndexedDB Promise"并给出既有代码先例；T8 实现红线重复一遍。

**未知 store 漏检**：T10 要求动态枚举 + 分类穷尽 + 未分类即 `L1_STORE_UNCLASSIFIED`，并强制"临时加第三个 store 必须失败"的测试。

**验证器污染被验证对象**：T10 的 L3 全只读；"首次 reserve seq === 1"只在一次性克隆库上跑。

**依赖边界**：exchange 与 storage 互不依赖，集成只在 `apps/web`；为此 T11 显式纳入 `package.json` 与 `pnpm-lock.yaml` 写集，并把三个 pre 脚本改为同时构建两个包——否则集成测试会在 CI 上因构建顺序失败，而本地因残留 `dist/` 侥幸通过。

## 9. 变更记录

| 版本 | 变更类型 | 变更内容 | 经办人 | 时间 |
|---|---|---|---|---|
| v1.0 | 初稿 | 冻结恢复器 + 等价验证器 + 负样本矩阵的 12 个 TDD 任务、文件写集、依赖图、关键设计决定与待决问题 | Fable 5 | 2026-08-07 |
| v1.1 | 收口 | active-capture 引用规则、`ContextRecord` 全约束、`eventId` 形状与排序、Clock Gate 只读化、类型边界、`TextDecoder` 窄声明、ZIP 流式实际产出、分层 failure code、限额分类、身份与激活协议 | Fable 5（据 Codex 复审） | 2026-08-07 |
| v1.3 | 收口 | **CRC 路线冻结为 B-reader-only**（写侧保留 fflate、导出字节合同不动；读侧新增 `@zip.js/zip.js`），并新增 **T0 硬 Gate**（G1 严格模式 / G2 加密·multi-disk·ZIP64·不支持压缩法的拒绝清单 / G3 计数 WritableStream + AbortSignal 按实际产出限额 / G4 CRC_MISMATCH / G5 Node 与目标 Safari 双路径 / G6 ES2023 无 DOM 类型边界），失败即停不得改走 A；同步清理"不得新增运行时依赖"与"B 要替换 exporter"两处旧说法。**修 UI 激活状态机**：可写 runtime 全程持 shared lock、恢复方先让位再取 exclusive lock、验空移到写 pending 之前、`COMMITTED` 改由 durable commit marker 判定（连带 T8 写 marker、T10 键集合含 `restore-commit`），新增 U3。T4.1 消除 exporter↔reader 漂移（`exportedByDeviceId` canonical、`exportedAt` 往返比对、非法闰日与自兼容测试），`manifest.ts` 纳入写集。T11 指定 Node 环境并先验 `crypto.subtle` 与 NIST 向量 | Fable 5（据 Codex 复审） | 2026-08-07 |
| v1.2 | 收口 | T11 纳入 `apps/web/package.json` 与 `pnpm-lock.yaml` 写集并改三个 pre 脚本；exchange 测试禁用 `node:crypto`；新增 §3.3 CRC 完整性（两条路线、阻塞 T3、矩阵第 11 条）；恢复 clock 负样本并把 forged size 降为 T3 单测，矩阵定为 11 + 3；身份收紧为三条 canonical 校验；空库改为三 store `count === 0` 并加三方向负例；L3 加 clock 键集合精确断言；T6 补 `byteLength` 下界、`blob.type === mediaType`、trim 非空；T4 展开 manifest 全字段表；新增 §3.10 UI 激活状态机与 U1/U2 Gate；机械同步（切片 v1.3、CROSS-REVIEW Gate 定义、状态改"计划待审"、最低支持设备、`TextDecoder` 与 `events` 上限移出待决） | Fable 5（据 Codex 复审） | 2026-08-07 |
