# Tenjin 可运行竖切版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 交付一个离线可运行的 Tenjin PWA，让用户能完成记录、复习、搜索和状态查看。

**Architecture:** pnpm workspace 将纯 TypeScript core、IndexedDB 适配器和 React PWA 分开。所有学习状态由不可变事件集合重算，浏览器存储只保存事件与 context。

**Tech Stack:** TypeScript 5、React 19、Vite 7、Vitest、fast-check、Testing Library、idb、fake-indexeddb、vite-plugin-pwa、lucide-react。

## Global Constraints

- core 不可依赖 DOM、React、IndexedDB、网络或 LLM。
- 生产行为必须先有失败测试，再写最小实现。
- 不显示 due、欠账、连续学习、排行榜或假 KPI。
- 不注入演示数据。
- 所有常用动作必须适配 390px 宽移动 viewport。
- 现有 HANDOFF.md 与 CROSS-REVIEW.md 不得被覆盖或清理。

---

### Task 1: Workspace、identity 与事件边界

**Files:**
- Create: .gitattributes
- Create: .gitignore
- Create: package.json
- Create: pnpm-workspace.yaml
- Create: tsconfig.base.json
- Create: packages/core/package.json
- Create: packages/core/tsconfig.json
- Create: packages/core/src/identity.test.ts
- Create: packages/core/src/identity.ts
- Create: packages/core/src/events.test.ts
- Create: packages/core/src/events.ts
- Create: packages/core/src/index.ts

**Interfaces:**
- Produces: normalizeIdentity(input: string): string
- Produces: validateEvent(event: unknown): ValidationResult
- Produces: Event、CaptureCreatedEvent、VerificationObservedEvent 类型

- [ ] **Step 1: 建立 workspace 配置并写 identity 失败测试**

    expect(normalizeIdentity(" ＴｅｎＪｉｎ ")).toBe("tenjin")
    expect(normalizeIdentity("カタカナ")).toBe("かたかな")

- [ ] **Step 2: 运行 pnpm --filter @tenjin/core test，确认因模块缺失而失败**
- [ ] **Step 3: 实现 NFKC、trim、ASCII 小写与片假名转平假名**
- [ ] **Step 4: 写事件信封校验失败测试，覆盖 eventId/deviceId/seq/occurredAt/recordedAt/kind**
- [ ] **Step 5: 实现 discriminated union 与无 DOM 的运行时校验**
- [ ] **Step 6: 运行 core 测试与 typecheck，确认全绿**

### Task 2: 确定性 reducer 与预算复习

**Files:**
- Create: packages/core/src/reducer.test.ts
- Create: packages/core/src/reducer.ts
- Create: packages/core/src/review.test.ts
- Create: packages/core/src/review.ts
- Modify: packages/core/src/index.ts

**Interfaces:**
- Consumes: Event
- Produces: deriveLedger(events: readonly Event[]): LedgerView
- Produces: selectReviewItems(view: LedgerView, budget: number): ReviewItem[]

- [ ] **Step 1: 写 lookup/listening/production 分别激活 R/L/P unstable 的失败测试**
- [ ] **Step 2: 实现按 canonical key 排序的纯 reducer**
- [ ] **Step 3: 写 hesitant 不晋升、fail 清零、三次跨 7 天 pass 进入 stable 的失败测试**
- [ ] **Step 4: 实现通道验证状态机**
- [ ] **Step 5: 写 capture_discarded 排除整条 capture 证据链的失败测试**
- [ ] **Step 6: 实现 refs 过滤和撤销派生**
- [ ] **Step 7: 写随机事件排列得到相同 LedgerView 的 fast-check 属性测试**
- [ ] **Step 8: 实现固定预算排序：近期 fail → unstable → stable 低频抽查**
- [ ] **Step 9: 运行全部 core 测试**

### Task 3: IndexedDB 事务存储

**Files:**
- Create: packages/storage-indexeddb/package.json
- Create: packages/storage-indexeddb/tsconfig.json
- Create: packages/storage-indexeddb/src/repository.test.ts
- Create: packages/storage-indexeddb/src/repository.ts
- Create: packages/storage-indexeddb/src/index.ts

**Interfaces:**
- Produces: LedgerRepository
- Produces: appendCapture(events: Event[], context: ContextRecord): Promise<void>
- Produces: appendEvents(events: Event[]): Promise<void>
- Produces: readSnapshot(): Promise<{ events: Event[]; contexts: ContextRecord[] }>

- [ ] **Step 1: 使用 fake-indexeddb 写事件与 context 同事务提交的失败测试**
- [ ] **Step 2: 写事务异常时两者都不落盘的失败测试**
- [ ] **Step 3: 用 idb 实现 events 与 contexts object stores**
- [ ] **Step 4: 写重复 eventId 幂等测试并实现 put 语义**
- [ ] **Step 5: 运行 storage 与 core 测试**

### Task 4: Capture 应用服务与主屏

**Files:**
- Create: apps/web/package.json
- Create: apps/web/tsconfig.json
- Create: apps/web/vite.config.ts
- Create: apps/web/index.html
- Create: apps/web/src/test/setup.ts
- Create: apps/web/src/features/capture/createCapture.test.ts
- Create: apps/web/src/features/capture/createCapture.ts
- Create: apps/web/src/features/capture/CaptureComposer.test.tsx
- Create: apps/web/src/features/capture/CaptureComposer.tsx
- Create: apps/web/src/components/icons.tsx

**Interfaces:**
- Produces: createCapture(command, clock, ids): CaptureTransaction
- Produces: CaptureComposer({ onSave }): JSX.Element

- [ ] **Step 1: 写三种 capture command 生成正确事件链的失败测试**
- [ ] **Step 2: 实现 context hash、capture_created、item_created 和通道观察事件**
- [ ] **Step 3: 写空输入不提交、分类切换、表达纠正第二输入的组件失败测试**
- [ ] **Step 4: 实现可访问的 CaptureComposer**
- [ ] **Step 5: 写保存失败不显示成功、保存成功清空输入的失败测试**
- [ ] **Step 6: 接入 LedgerRepository 并运行 web 测试**

### Task 5: Review、搜索与撤销闭环

**Files:**
- Create: apps/web/src/features/review/ReviewSession.test.tsx
- Create: apps/web/src/features/review/ReviewSession.tsx
- Create: apps/web/src/features/search/SearchView.test.tsx
- Create: apps/web/src/features/search/SearchView.tsx
- Create: apps/web/src/features/ledger/useLedger.ts
- Create: apps/web/src/App.test.tsx
- Create: apps/web/src/App.tsx
- Create: apps/web/src/main.tsx

**Interfaces:**
- Produces: useLedger() 读取快照并追加事件
- Produces: ReviewSession 一屏一项、揭示、自评
- Produces: SearchView 按 display 与 identityKey 查询

- [ ] **Step 1: 写复习在揭示前隐藏证据、揭示后可 pass/hesitant/fail 的失败测试**
- [ ] **Step 2: 实现 review 回答追加 verification_observed**
- [ ] **Step 3: 写搜索可找到 R/L/P 状态和最近证据的失败测试**
- [ ] **Step 4: 实现搜索与 item 详情摘要**
- [ ] **Step 5: 写保存后 8 秒内撤销追加 capture_discarded 的失败测试**
- [ ] **Step 6: 实现 App 导航、最近记录与撤销 toast**
- [ ] **Step 7: 跑完整 UI 测试**

### Task 6: 视觉系统与 PWA

**Files:**
- Create: apps/web/src/styles/tokens.css
- Create: apps/web/src/styles/app.css
- Create: apps/web/public/tenjin-mark.svg
- Modify: apps/web/vite.config.ts
- Modify: apps/web/src/main.tsx

**Interfaces:**
- Consumes: docs/design/tenjin-home-mobile-concept.png
- Produces: 可安装 manifest 与离线 service worker

- [ ] **Step 1: 从概念图锁定颜色、字体、间距、边线、图标和容器规则**
- [ ] **Step 2: 实现 390px 移动布局和宽屏居中布局**
- [ ] **Step 3: 配置 vite-plugin-pwa、manifest、theme_color 和图标**
- [ ] **Step 4: 运行 pnpm build，确认生成 manifest 与 service worker**
- [ ] **Step 5: 运行 typecheck、tests 和 lint**

### Task 7: 浏览器验收

**Files:**
- Create: docs/qa/2026-07-11-tenjin-vertical-slice.md
- Modify: README.md

**Interfaces:**
- Produces: 桌面与移动截图、核心流程证据、视觉 fidelity ledger

- [ ] **Step 1: 启动本地 preview 并在浏览器完成 capture → review → search → undo**
- [ ] **Step 2: 截取概念原生比例移动视图与桌面视图**
- [ ] **Step 3: 用 view_image 同时检查概念图和实现截图**
- [ ] **Step 4: 至少核对文案、布局、字体、配色、边线、图标、移动溢出七项并修复差异**
- [ ] **Step 5: 更新 README 的启动、测试和构建命令**
- [ ] **Step 6: 最终运行 pnpm test、pnpm typecheck、pnpm build**

