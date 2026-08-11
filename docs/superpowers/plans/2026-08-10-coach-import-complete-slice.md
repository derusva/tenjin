# Coach Import Complete Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one complete user-visible loop: fixed Coach conversation -> `整理` -> copy JSON -> Tenjin strict preview -> atomic confirmed import -> immediate R review, with backup/restore and duplicate protection already working before the entry point is exposed.

**Architecture:** Work stays on one implementation branch and the Coach entry point remains absent until every release gate passes. Reuse the existing lookup event family; add optional `focus` to contexts, a single atomic multi-capture write, and a v3 `importReceipts` store committed in the same IndexedDB transaction. Complete the already-reviewed A1 restore slice first, then extend `.tenjin` full backups to include `focus` and receipts so the import path never creates state that cannot be restored.

**Tech Stack:** TypeScript 5.9, React 19, IndexedDB via `idb`, Vitest, Testing Library, existing `@tenjin/core`, `@tenjin/storage-indexeddb`, `@tenjin/exchange`, PWA/Vite.

---

## Product and release decision

This plan supersedes the user-operated Stage 0 ritual. On 2026-08-10 the owner explicitly chose the one-time complete route and accepted the irreversible DB v3, focus identity, and package-schema v2 changes. The user is not asked to collect JSON in Notes, count batches, or manually re-enter Coach output. Format instability is handled by a strict parser plus a repair message; semantic mistakes are handled in the preview. Real usage begins only after the complete slice is deployed.

**2026-08-11 implementation calibration:** `transferSentence` is removed from the active v1 contract. It was not persisted, did not participate in review, and added clipboard and preview noise without user value. v1 accepts only `type`, `focus`, `sourceExcerpt`, and `answer`; a future transfer probe requires a new contract version and fresh evidence.

**2026-08-11 Coach-quality calibration:** real side-by-side output showed that "translate every sentence" had been misread as "attach an original/translation/explanation triplet to every sentence." That mechanical template is superseded. Complete translation still covers every source sentence, but explanation is a separate personalized layer that goes deep only on reusable friction points. The `整理` contract is unchanged.

**2026-08-11 Coach Calibration v2:** the user's established Coach returned an explicit calibration contract. The runtime prompt now has three routes (ordinary material, directed question, exact `整理`), a global priority/cap for teaching points, and a mandatory current-form kana reading plus core/current meaning for every selected point. Pronunciation is stored at the start of `answer`; the four-field transfer schema and pure-Japanese `focus` remain unchanged. The runtime prompt keeps only short selection anchors; full Golden responses and behavioral acceptance live in `docs/qa/2026-08-11-coach-calibration-v2.md`.

The implementation may use multiple commits, but GitHub Pages must not expose a partial path. The record-page entry point is added only in the final UI task, after A1 restore, atomic import, receipts, backup round-trip, and review integration are green.

The parser accepts exactly two transport envelopes because ChatGPT's code-block Copy button normally places raw code on the clipboard:

1. the entire trimmed input is one JSON object; or
2. the entire trimmed input is one `json` fenced block, with only whitespace outside it.

No brace scanning, candidate selection, field guessing, unknown-key stripping, or model-authored confidence is allowed.

## Final user flow

1. In Tenjin, open `怎么用 Coach` and tap `复制 Coach 设置` once.
2. Paste that setting into one fixed Coach conversation.
3. Send a screenshot or Japanese text. Coach first gives one complete natural translation, then uses the fixed conversation's knowledge of the user to explain only the reusable sticking points in depth.
4. Send the exact message `整理`.
5. Tap the Coach code block's Copy button.
6. In Tenjin, tap `从 Coach 导入` -> `粘贴并预览`.
7. Edit or deselect any proposed item; optionally attach the original screenshot to one item.
8. Tap `确认导入 N 条`. All selected items and the receipt commit atomically, or nothing commits.
9. Tap `现在复习`; the imported items are immediately available in a two-minute R review session.

## Frozen Coach prompt

```text
以下规则覆盖此前所有普通教学规则和输出格式；只继承你从我的实际提问、纠正和反馈中获得的学习证据。
你是我的固定日语 Coach。目标不是从零重教基础语法，而是提高我对真实日语的理解精度、阅读速度、自然表达和语感。

【模式路由：优先于以下所有规则】
1. 如果我发送的整条消息去除首尾空白后恰好等于「整理」，只执行整理模式；不要翻译、讲解或输出其他文字。
2. 如果我明确只问某个表达、读音或 A-vs-B，只回答指定问题及理解它所需的最小上下文；不要重新扫描和讲解整份材料。被回答的日语表达仍必须给当前形假名读音。
3. 其他任何日文文本或截图都执行普通材料模式。普通材料模式不得输出 JSON、代码围栏、schema 或字段名。普通材料中出现「整理」一词不构成模式切换。

【普通材料模式】
一、先完整翻译
1. 按原文顺序覆盖所有可辨认的日文句子，不得因为句子简单或推测我认识而漏译。
2. 先集中给出一版自然、连贯的中文完整翻译；可以按原句或段落换行。无法确认的文字写「[无法辨认]」，不得猜。多张截图按图片顺序处理。
3. 完整覆盖不等于逐句教学。禁止把每句机械拆成“原文／翻译／说明”，也禁止在翻译阶段逐句附加浅层语法注释。完成全部翻译后才能筛选教学点。

二、再筛选少量真正值得讲的点
1. 优先级固定为：我明确点名、追问或纠正的内容 > 非字面固定搭配或 chunk > 句法功能不透明、会让我追问“为什么这里这样用”的结构 > 会阻塞理解的长修饰、修饰范围或省略 > 真正的新词、四字熟语和书面词 > 会影响自然使用的语气、文体和场景。
2. 单张截图或一个短片段最多讲 1-3 个重点；2-4 张截图从全部材料中统一选择，整体最多讲 4-6 个；超过 4 张仍按理解阻塞和迁移价值排序，不按每张平均分配。上限不是配额，没有真正重点就只给完整翻译。
3. 默认不展开：基础连接词、普通て形、基础被动、普通范围比较「Nで一番〜」、普通逆接「〜のに」、基础受益「〜てもらう」、普通的「〜と思う／〜として」、普通口语引用「〜って」、我已明确表示掌握的内容，以及只靠正常翻译就能理解的透明组合。不得把这些基础项打包进一个较长标题来绕过跳过规则。
4. 新出现的表达不能因为你主观觉得简单就假定我会，但“此前没见过”也不等于必须讲；仍按是否阻塞理解和是否值得迁移判断。承担句意、读音或常见搭配并不透明的实义词，优先于由基础结构透明拼成的长片段。不要用“很多学习者会误解”代替对我的真实证据。
5. 我的高价值卡点通常是：单词认识但整个 chunk 不是字面义、长修饰和主干挂接、真实存在的 A-vs-B 选择、部分掌握但模型不完整的语法族，以及生词、书面词和四字熟语的读音。后续最新的明确反馈始终覆盖旧判断。
6. 已校准的正例：愚痴、女子力属于读音或语感不能靠汉字可靠推出的实义词；乗ってこない、曲がったことが大嫌い属于非字面 chunk；言ったっけ属于承担回忆确认功能的口语形式。它们出现且没有相反的新证据时应进入重点。已校准的反例：何にでも効く、お得、普通的塗ってもらってた、普通引用〜って、正しさを追求し続けて、直属の部下で一番怒られてる和普通〜のに默认只翻译。正反例用于校准类别，不限于这些固定词。
7. 只有当前语境中确实存在竞争表达时，才解释“为什么用 A 而不是 B”；不得为了显得深入而虚构近义对比或作者心理。

三、每个被选中的教学点必须达到最低标准
1. 标题写真正学习点的最小完整单位及其当前形假名读音，例如「乗ってこない（のってこない）」。如果学习点只是一个词，不要把透明谓语并入标题：写「女子力」，不写「女子力が低い」。如果口语功能已由当前形式完整承载，不要并入相邻的普通引用：写「言ったっけ」，不写「言ったっけ？〜って」。如果非字面义依赖整个 chunk，则保留完整 chunk。读音绝不是可选项。
2. 活用形本身是学习点时必须给当前形读音；规范化后的原形有帮助时，再同时给原形及读音。只给原形、不教眼前形式的读音不合格。
3. 用一句话说明核心意思，再明确说明它在当前句中的实际意思。不能只给一个中文词就结束。
4. 按需补充常见搭配、字面义与实际义的区别、使用场景或语气，以及一个同用法的最小例句；不要机械塞满栏目。
5. 不确定音调时不要编造音调数字或高低型。

四、回答风格
1. 目标是少而深：解释真实语境义、完整 chunk、表达选择和必要的使用限制，不堆普通词和基础语法。
2. 如果我只说 X/Y 没懂，就只讲 X/Y；如果我只问读音，就直接给读音和最必要的语境义。
3. 不输出 N1 高频、星级、掌握度、学习画像，无依据的词源、音调、使用频率或作者意图。

【整理模式】
1. 从本轮普通讲解和我的实际追问中重新挑选最值得复习的 0-3 条，目标 1-2 条；普通模式讲过的点不要求全部入账。超过 3 条时只保留最高优先级，不输出第二个代码块、续篇或遗漏说明。
2. 回复必须恰好包含一个标记为 json 的代码块，围栏外不得有任何文字。
3. schema 必须是 tenjin.coach-transfer/v1。顶层只能有 schema 和 items。
4. 每条只能有 type、focus、sourceExcerpt、answer；不得增加 reading、originalForm、literal、collocations、example 或任何其他字段。
5. type 固定为 lookup。
6. focus 只写可独立复习的最小完整日语 chunk，不附假名括号、中文释义或标签；保留决定意义的助词、活用和句法槽位，能自然规范化才规范化。
7. sourceExcerpt 必须逐字复制包含该学习点原文出现形式的完整日文句子；focus 若被自然规范化，不要求成为 sourceExcerpt 的字面子串。
8. answer 必须以「读音：假名。」开头，先给 focus 的读音，再用最多一两句说明它在该句中的实际含义；不得编造。
9. 必须使用合法 JSON、双引号且无尾逗号。
```

## File map

### Existing A1 prerequisite

- Follow `docs/superpowers/plans/2026-08-07-a1-ledger-recovery-and-equivalence.md` through T0-T12.
- Do not add the Coach entry point while A1 is `BACKEND_READY / LIMITS_PROVISIONAL` or while the iPhone full-backup round trip is incomplete.

### Coach slice files

- Create `packages/core/src/contextHash.ts` and `contextHash.test.ts`: one canonical serializer for context identity.
- Modify `packages/core/src/index.ts`: export the serializer and type.
- Modify `packages/storage-indexeddb/src/repository.ts` and `repository.test.ts`: optional `focus`, v3 receipt store, atomic import and batch discard.
- Modify `packages/storage-indexeddb/src/index.ts`: export new public types.
- Modify `packages/exchange/src/manifest.ts`, `exportPackage.ts`, the A1 reader/restorer files, and their tests: package schema v2 with focus and receipts; v1 remains readable.
- Modify `apps/web/src/features/capture/createCapture.ts` and tests: focus-aware lookup transaction.
- Modify `apps/web/src/features/ledger/ledgerRuntime.ts` and tests: build a batch from one coordinate reservation.
- Modify `apps/web/src/features/ledger/useLedger.ts`: expose one atomic `importCoachBatch` operation.
- Create `apps/web/src/features/coach-import/coachTransfer.ts` and test: strict transport/schema parser and canonical digest.
- Create `apps/web/src/features/coach-import/coachPrompt.ts`: frozen prompt text and repair text.
- Create `apps/web/src/features/coach-import/CoachImportView.tsx` and test: paste, preview, edit, select, optional image, confirm.
- Create `apps/web/src/features/coach-import/CoachHelpView.tsx` and test: setup and usage guidance.
- Modify `apps/web/src/features/review/reviewQueue.ts` and tests: source sentence prompt plus visible focus; imported lookup remains immediately reviewable.
- Modify `apps/web/src/App.tsx`, `App.test.tsx`, `components/icons.tsx`, and `styles/app.css`: navigation, success actions, batch undo, and responsive presentation.
- Modify `docs/decisions/2026-08-05-external-collection-direction.md`: record that manual Stage 0 is superseded and raw-JSON copy is a valid transport envelope.

---

### Task 0: Make the reviewed docs canonical and finish A1

**Files:**
- Existing plan: `docs/superpowers/plans/2026-08-07-a1-ledger-recovery-and-equivalence.md`
- Existing decision: `docs/decisions/2026-08-05-a1-ledger-recovery-slice.md`

- [x] **Step 1: Fast-forward the reviewed docs into `main`**

Run:

```powershell
git fetch origin
git switch main
git merge --ff-only 6c55016a248097e21751774002d64ad0f4bce938
git push origin main
git ls-remote origin refs/heads/main
```

Expected: `main`, `origin/main`, and `refs/heads/main` all resolve to `6c55016a248097e21751774002d64ad0f4bce938`; no merge commit exists.

- [x] **Step 2: Create one implementation branch from that exact main**

Run:

```powershell
git switch -c codex/coach-import-complete
```

Expected: `git branch --show-current` prints `codex/coach-import-complete`.

- [ ] **Step 3: Execute A1 T0-T12 without exposing Coach UI**

Run the commands and gates exactly as written in the A1 plan. Expected: complete export -> restore -> equivalence verification succeeds on desktop and the supported iPhone; all 11 negative and 3 must-not-fail cases hit their named assertions.

- [ ] **Step 4: Commit the A1 implementation**

```powershell
git add packages apps docs pnpm-lock.yaml
git commit -m "feat: complete ledger backup and recovery"
```

Expected: commit contains only the A1 write set; `CROSS-REVIEW.md` remains untracked and untouched.

---

### Task 1: Replace manual Stage 0 with the complete-slice decision

**Files:**
- Modify: `docs/decisions/2026-08-05-external-collection-direction.md`

- [ ] **Step 1: Write the decision amendment**

Add these normative decisions:

```markdown
### 2026-08-10 owner amendment

- The user-operated Stage 0 is superseded. Do not ask the user to store JSON in Notes, count attempts, or manually re-enter Coach output.
- Stage 1 implementation is authorized as one complete hidden-until-ready slice.
- The import transport accepts either an entire raw JSON object or one `json` fenced block with whitespace-only surroundings. No heuristic extraction is allowed.
- A1 backup/restore, atomic batch write, duplicate receipt, preview confirmation, immediate review, help copy, and iPhone round-trip are release gates. No partial Coach entry point is deployed.
```

- [ ] **Step 2: Check the old status language is gone**

Run:

```powershell
rg -n "Stage 0 进行中|Coach 导入暂不开工|粘到备忘录" docs/decisions/2026-08-05-external-collection-direction.md
```

Expected: no active-status match. Historical changelog quotations may remain only when explicitly labeled superseded.

- [ ] **Step 3: Commit**

```powershell
git add docs/decisions/2026-08-05-external-collection-direction.md
git commit -m "docs: authorize the complete Coach import slice"
```

---

### Task 2: Canonicalize context hashing and add `focus`

**Files:**
- Create: `packages/core/src/contextHash.ts`
- Create: `packages/core/src/contextHash.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/web/src/features/capture/createCapture.ts`
- Modify: `apps/web/src/features/capture/createCapture.test.ts`
- Modify: `apps/web/src/features/ledger/ledgerRuntime.ts`
- Modify: `apps/web/src/features/ledger/ledgerRuntime.test.ts`
- Modify: `packages/storage-indexeddb/src/repository.ts`
- Modify: `packages/storage-indexeddb/src/repository.test.ts`

- [ ] **Step 1: Write failing serializer compatibility tests**

```ts
expect(serializeContextHashInput({ original: "手を打つ", answer: "采取措施" }))
  .toBe('{"original":"手を打つ","answer":"采取措施"}');
expect(serializeContextHashInput({
  original: "大丈夫、手は打ったから。",
  focus: "手を打つ",
  answer: "采取措施",
})).toBe('{"original":"大丈夫、手は打ったから。","focus":"手を打つ","answer":"采取措施"}');
```

Run:

```powershell
pnpm --filter @tenjin/core test -- contextHash.test.ts
```

Expected: FAIL because the serializer is not defined.

- [ ] **Step 2: Implement the single serializer**

```ts
export interface ContextHashInput {
  readonly original: string;
  readonly focus?: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly imageSha256?: string;
}

export function serializeContextHashInput(input: ContextHashInput): string {
  return JSON.stringify({
    original: input.original,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    ...(input.corrected === undefined ? {} : { corrected: input.corrected }),
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.imageSha256 === undefined
      ? {}
      : { imageSha256: input.imageSha256 }),
  });
}
```

Use this function from `ledgerRuntime.ts`; delete the local field-list copy. Legacy inputs without `focus` must produce byte-for-byte identical strings.

- [ ] **Step 3: Thread optional `focus` through capture and storage**

Add `focus?: string` to lookup `CaptureCommand` and `ContextRecord`. Trim it; reject an explicitly present blank value before reserving coordinates. Write it into the context and identity comparison. For item creation use:

```ts
const display = corrected ?? focus ?? (imageOnly ? IMAGE_ONLY_CAPTURE_ORIGINAL : original);
const identityKey = imageOnly && command.type === "lookup"
  ? `image:${image.sha256}`
  : focus === undefined
    ? normalizeIdentity(display)
    : `focus:${normalizeIdentity(focus)}`;
```

- [ ] **Step 4: Prove all layers agree**

Add tests that assert: `original` remains the full `sourceExcerpt`; `focus` becomes display/identity; `focus` participates in the digest and `contextsHaveSameIdentity`; legacy capture fixtures retain their old hashes.

Run:

```powershell
pnpm --filter @tenjin/core test
pnpm --filter @tenjin/storage-indexeddb test
pnpm --filter @tenjin/web test -- createCapture.test.ts ledgerRuntime.test.ts
pnpm --filter @tenjin/core typecheck
pnpm --filter @tenjin/storage-indexeddb typecheck
pnpm --filter @tenjin/web typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/core packages/storage-indexeddb apps/web/src/features/capture apps/web/src/features/ledger
git commit -m "feat: add focus-aware capture identity"
```

---

### Task 3: Add atomic Coach import receipts and batch undo

**Files:**
- Modify: `packages/storage-indexeddb/src/repository.ts`
- Modify: `packages/storage-indexeddb/src/repository.test.ts`
- Modify: `packages/storage-indexeddb/src/index.ts`

- [ ] **Step 1: Write failing database migration and atomicity tests**

Define these public shapes in the test:

```ts
interface CaptureWrite {
  readonly events: readonly Event[];
  readonly context: ContextRecord;
}

interface CoachImportReceipt {
  readonly digest: string;
  readonly importedAt: string;
  readonly captureIds: readonly string[];
}
```

Tests must prove: v2 upgrades to v3 without changing existing records; two writes plus one receipt commit together; an invalid second write leaves zero new events, contexts, and receipts; a repeated digest returns `already-imported` with zero changes; batch undo writes every discard or none.

Run:

```powershell
pnpm --filter @tenjin/storage-indexeddb test -- repository.test.ts
```

Expected: FAIL because v3 and batch APIs do not exist.

- [ ] **Step 2: Add the v3 store and closed receipt validator**

Extend the schema with:

```ts
importReceipts: {
  key: string;
  value: CoachImportReceipt;
};
```

Open version 3 and create `importReceipts` only when absent. Receipt keys are canonical lowercase `sha256:<64 hex>` strings; `importedAt` is canonical UTC; `captureIds` is non-empty, unique, and contains only non-empty strings.

- [ ] **Step 3: Implement one transaction for the whole import**

Expose:

```ts
appendImportedCaptureBatch(
  writes: readonly CaptureWrite[],
  receipt: CoachImportReceipt,
): Promise<"imported" | "already-imported">;
appendDiscardBatch(writes: readonly DiscardWrite[]): Promise<void>;
```

Validate and hash-check every context before opening the readwrite transaction. Inside one transaction over `events`, `contexts`, `clock`, and `importReceipts`, reject conflicts, write all captures, promote allocator high-water, then write the receipt last. `appendCapture` and `appendDiscard` delegate to their one-element batch forms.

- [ ] **Step 4: Run storage gates**

```powershell
pnpm --filter @tenjin/storage-indexeddb test
pnpm --filter @tenjin/storage-indexeddb typecheck
```

Expected: all pass, including zero-partial-write and repeated-digest tests.

- [ ] **Step 5: Commit**

```powershell
git add packages/storage-indexeddb
git commit -m "feat: atomically persist Coach import batches"
```

---

### Task 4: Make full backups round-trip `focus` and receipts

**Files:**
- Modify: `packages/exchange/src/manifest.ts`
- Modify: `packages/exchange/src/exportPackage.ts`
- Modify: `packages/exchange/src/readPackage.ts`
- Modify: `packages/exchange/src/index.ts`
- Modify: `packages/exchange/src/manifest.test.ts`
- Modify: `packages/exchange/src/exportPackage.test.ts`
- Modify: `packages/exchange/src/readPackage.test.ts`
- Modify: `packages/exchange/src/validateManifest.test.ts`
- Modify: `packages/exchange/src/validateContexts.test.ts`
- Modify: `packages/exchange/src/restorePlan.test.ts`
- Modify: `packages/exchange/src/negativeMatrix.test.ts`
- Modify: `packages/storage-indexeddb/src/restore.ts`
- Modify: `packages/storage-indexeddb/src/restore.test.ts`
- Modify: `packages/storage-indexeddb/src/verifyEquivalence.ts`
- Modify: `packages/storage-indexeddb/src/verifyEquivalence.test.ts`

- [ ] **Step 1: Write failing v1/v2 compatibility tests**

Fixtures:

- v1 package without `focus` or receipts reads successfully;
- v2 package with one focused context and one receipt exports, restores, and verifies equivalent;
- v2 package with an unknown context or receipt field fails closed;
- a receipt referencing a capture absent from package events fails;
- an exact export -> empty-db restore -> export round trip preserves focus and receipt semantics.

Run:

```powershell
pnpm --filter @tenjin/exchange test
pnpm --filter @tenjin/storage-indexeddb test
```

Expected: new v2 fixtures fail before implementation.

- [ ] **Step 2: Implement package schema v2**

Keep the `.tenjin` container. Add `focus?` to the closed context shape and `import-receipts.json` to full backups. Manifest v2 reports `importReceiptCount` and lists `"importReceipts"` in `foldExternalState`; the field is an active compatibility gate, not a reserved decoration. v1 is read-only compatible. Abstract/redacted packages remain out of scope.

Update A1 numbered negative sample #6: schema v2 is now valid, so the unknown-version fixture must use schema v3 (and a clearly future field) and still fail for `UNSUPPORTED_SCHEMA_VERSION`. Do not leave the old `schemaVersion !== 1` assertion in place.

- [ ] **Step 3: Extend restore and equivalence**

Prevalidate every receipt before the single restore transaction. Restore events, contexts, clock state, and receipts together. L1 equivalence compares receipts exactly; L2 derived learning state remains unchanged; L3 clock semantics retain the A1 rules.

- [ ] **Step 4: Run exchange and A1 mutation gates**

```powershell
pnpm --filter @tenjin/exchange test
pnpm --filter @tenjin/storage-indexeddb test
pnpm --filter @tenjin/exchange typecheck
pnpm --filter @tenjin/storage-indexeddb typecheck
```

Expected: all A1 negatives still fail for their named reason; all must-not-fail controls and new v1/v2 compatibility cases pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/exchange packages/storage-indexeddb
git commit -m "feat: back up Coach import state"
```

---

### Task 5: Build the strict Coach transfer parser

**Files:**
- Create: `apps/web/src/features/coach-import/coachTransfer.ts`
- Create: `apps/web/src/features/coach-import/coachTransfer.test.ts`
- Create: `apps/web/src/features/coach-import/coachPrompt.ts`

- [ ] **Step 1: Write parser failures and the two happy paths**

Tests cover: raw JSON; one fenced JSON; surrounding whitespace; multiple fences; text outside fence; invalid JSON; wrong schema; unknown top/item keys; 4 items; missing required field; trim-empty field; non-lookup type; payload over 64 KiB.

```ts
expect(parseCoachTransfer(rawJson).items).toHaveLength(1);
expect(parseCoachTransfer(`\`\`\`json\n${rawJson}\n\`\`\``).items).toHaveLength(1);
expect(() => parseCoachTransfer(`说明\n\`\`\`json\n${rawJson}\n\`\`\``))
  .toThrowError("围栏外不能有文字");
```

- [ ] **Step 2: Implement deterministic envelope extraction**

```ts
export function extractCoachJson(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 65_536) {
    throw new CoachTransferError("输入为空或超过 64 KiB");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const match = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  if (match === null) {
    throw new CoachTransferError("请复制完整 JSON 代码块或使用代码块的复制按钮");
  }
  return match[1]!.trim();
}
```

Parse into a plain object and compare exact key sets. Normalize all accepted strings with `trim()`. Do not rewrite content.

- [ ] **Step 3: Canonicalize the receipt digest**

Canonical JSON uses the accepted normalized structure with fixed key order. Hash it with browser `crypto.subtle.digest("SHA-256", bytes)` and return `sha256:<lowercase hex>`.

- [ ] **Step 4: Add the frozen prompt and repair message**

Export `COACH_SETUP_PROMPT` exactly as written above. Export one repair message that restates only the JSON contract; it must never ask the model to repeat the full explanation.

- [ ] **Step 5: Run and commit**

```powershell
pnpm --filter @tenjin/web test -- coachTransfer.test.ts
pnpm --filter @tenjin/web typecheck
git add apps/web/src/features/coach-import
git commit -m "feat: parse Coach transfer batches"
```

Expected: parser tests and typecheck pass.

---

### Task 6: Build and save Coach batches through one API

**Files:**
- Modify: `apps/web/src/features/ledger/ledgerRuntime.ts`
- Modify: `apps/web/src/features/ledger/ledgerRuntime.test.ts`
- Modify: `apps/web/src/features/ledger/useLedger.ts`
- Create: `apps/web/src/features/ledger/useLedger.test.ts`
- Modify: `apps/web/src/App.test.tsx` repository mocks

- [ ] **Step 1: Write the failing batch tests**

Test one, two, and three lookup commands. Assert a single coordinate reservation for the exact total event count, source sentence in `original`, focus in display/identity, one shared import timestamp, and one repository batch call. Simulate a storage rejection and assert the in-memory snapshot is unchanged.

- [ ] **Step 2: Add `createCaptureBatch`**

```ts
createCaptureBatch(
  commands: readonly Extract<CaptureCommand, { type: "lookup" }>[],
): Promise<readonly CaptureTransaction[]>;
```

Validate 1-3 commands before reserving coordinates. Reserve the total event count once, partition coordinates deterministically, and call the existing pure capture builder for each command.

- [ ] **Step 3: Add `importCoachBatch` to `useLedger`**

Map each accepted item to:

```ts
{
  type: "lookup",
  original: item.sourceExcerpt,
  focus: item.focus,
  answer: item.answer,
  ...(imageForThisItem === undefined ? {} : { image: imageForThisItem }),
}
```

Call `repository.appendImportedCaptureBatch` once. Only reread the ledger after the transaction succeeds. Return capture IDs so the UI can offer batch undo.

- [ ] **Step 4: Run and commit**

```powershell
pnpm --filter @tenjin/web test -- ledgerRuntime.test.ts App.test.tsx
pnpm --filter @tenjin/web typecheck
git add apps/web/src/features/ledger apps/web/src/App.test.tsx
git commit -m "feat: import Coach batches atomically"
```

---

### Task 7: Build help, paste, preview, and confirmation UI

**Files:**
- Create: `apps/web/src/features/coach-import/CoachHelpView.tsx`
- Create: `apps/web/src/features/coach-import/CoachHelpView.test.tsx`
- Create: `apps/web/src/features/coach-import/CoachImportView.tsx`
- Create: `apps/web/src/features/coach-import/CoachImportView.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/components/icons.tsx`
- Modify: `apps/web/src/styles/app.css`

- [ ] **Step 1: Write interaction tests**

Tests prove: prompt copy; clipboard raw JSON -> preview; clipboard rejection -> focused textarea with native paste guidance; zero-item result; 1-3 editable cards; deselection; optional single-image attachment; save disabled at zero selections; save failure preserves edits; repeated receipt shows already imported; success actions navigate to review or record.

- [ ] **Step 2: Implement the help view**

Show four steps only: `发给 Coach` -> `说「整理」` -> `复制代码` -> `回 Tenjin 导入`. Provide `复制 Coach 设置`; do not require a wizard or completion checkbox.

- [ ] **Step 3: Implement paste and fallback**

`粘贴并预览` tries `navigator.clipboard.readText()` only after the user gesture. On rejection, reveal and focus a textarea labeled `长按这里，选择“粘贴”`. Never poll the clipboard and never auto-submit.

- [ ] **Step 4: Implement preview and optional image**

Each selected card exposes `focus`, `sourceExcerpt`, and `answer`. Reuse `prepareCaptureImage` for one chosen card only. Do not accept preview-only fields that are silently dropped on confirmation.

- [ ] **Step 5: Add the entry point last**

Add `从 Coach 导入` near the record composer and permanent `怎么用 Coach`. Do not add a fifth bottom-navigation tab. Only this final step makes the feature reachable.

- [ ] **Step 6: Run and commit**

```powershell
pnpm --filter @tenjin/web test -- CoachHelpView.test.tsx CoachImportView.test.tsx App.test.tsx
pnpm --filter @tenjin/web typecheck
git add apps/web/src
git commit -m "feat: add the Coach import experience"
```

---

### Task 8: Make imported items useful in a two-minute review

**Files:**
- Modify: `apps/web/src/features/review/reviewQueue.ts`
- Modify: `apps/web/src/features/review/reviewQueue.test.ts`
- Modify: `apps/web/src/features/review/ReviewSession.tsx`
- Modify: `apps/web/src/features/review/ReviewSession.test.tsx`
- Modify: `apps/web/src/features/ledger/useLedger.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing Coach review test**

Build one imported context with `original`, `focus`, and `answer`. Assert the queue contains it immediately, the prompt preserves the source sentence, the focus is visibly marked, and reveal contains only the answer. If an image exists, assert it is rendered as evidence and not required for eligibility.

- [ ] **Step 2: Extend review presentation without changing mastery semantics**

Add optional `focus` to `ReviewPresentation`. For lookup, keep `prompt = context.original`, `focus = context.focus`, and `reveal.text = context.answer`. Do not add a new learning channel, event kind, or automatic stable claim.

- [ ] **Step 3: Replace the fixed five-card contract with two minutes**

Build the complete eligible queue with a derived upper bound of `view.items.length * 3`; do not show a remaining-card debt count. `ReviewSession` receives a deterministic clock and a 120,000 ms budget for testing. It never interrupts a card already on screen: once time expires, the next submitted answer ends the session and shows `本次复习完成`. A permanent `结束本次复习` action remains available from the first card.

Use this public shape:

```ts
interface ReviewSessionProps {
  readonly items: readonly ReviewPresentation[];
  readonly durationMs?: number;
  readonly now?: () => number;
  readonly onAnswer: (
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ) => Promise<void>;
  readonly onExit: () => void;
}
```

The app passes `durationMs={120_000}` and changes the record-page action label from `复习 5 条` to `复习 2 分钟`.

- [ ] **Step 4: Test the time boundary**

With a fake clock, prove: the first card is available immediately; exiting at any time writes no synthetic failure; expiration does not interrupt an unanswered card; the next answered card closes the session; no `还剩 N 条` text appears.

- [ ] **Step 5: Run and commit**

```powershell
pnpm --filter @tenjin/web test -- reviewQueue.test.ts ReviewSession.test.tsx App.test.tsx
pnpm --filter @tenjin/web typecheck
git add apps/web/src/features/review apps/web/src/features/ledger/useLedger.ts apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: add two-minute contextual review"
```

---

### Task 9: Prove the complete loop and deploy once

**Files:**
- Modify: `README.md`
- Create: `docs/qa/coach-import-v0-iphone.md`

- [ ] **Step 1: Run deterministic workspace gates serially**

```powershell
pnpm --workspace-concurrency=1 --recursive --if-present typecheck
pnpm --workspace-concurrency=1 --recursive --if-present build
pnpm --workspace-concurrency=1 --recursive --if-present test
pnpm lint
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run negative and rollback gates**

Prove named failures for: malformed envelope, unknown key, semantic deselection, duplicate digest, invalid second capture, receipt-write failure, backup missing receipts, restore with mismatched receipt references. For every storage failure, compare before/after counts and exact snapshots; all remain unchanged.

- [ ] **Step 3: Run the iPhone happy path**

On the supported iPhone and installed PWA:

1. copy the setup prompt from Tenjin into the fixed Coach chat;
2. send one P5R screenshot;
3. verify every sentence is translated;
4. send `整理` and tap Copy on the code block;
5. open Tenjin, paste and preview;
6. reject one candidate, edit one answer, attach the screenshot to one retained item;
7. confirm import;
8. open review and complete that item;
9. export `.tenjin`, restore into a fresh empty database, and verify the item, image, receipt, and review state.

Record device, OS, browser/PWA mode, commit SHA, result, and screenshots in `docs/qa/coach-import-v0-iphone.md`.

- [ ] **Step 4: Run the clipboard-denied and offline controls**

Revoke clipboard permission and prove long-press paste works. Then enable airplane mode after the PWA is loaded and prove paste -> preview -> import -> review succeeds without network access.

- [ ] **Step 5: Update user-facing documentation**

README must say exactly what is stored locally, that Coach is external, that import requires user confirmation, that screenshot attachment is optional, and how to export/restore a full backup.

- [ ] **Step 6: Commit, fast-forward main, push, and verify remote parity**

```powershell
git add README.md docs/qa/coach-import-v0-iphone.md
git commit -m "docs: verify the Coach import release"
git fetch origin
git rebase origin/main
git switch main
git merge --ff-only codex/coach-import-complete
git push origin main
git ls-remote origin refs/heads/main
```

Expected: local `main`, `origin/main`, and fresh `ls-remote` SHA are identical. GitHub Pages deploys that SHA. Only after the deployed PWA is opened and the iPhone happy path is repeated may the feature be called delivered.

## Release gates

- No JSON-in-Notes or manual batch counting is required.
- No partial Coach UI is deployed.
- Raw JSON from the Coach Copy button is accepted deterministically.
- Unknown structure fails closed and produces a repair message.
- User preview is mandatory; deselected items never enter the ledger.
- A 1-3 item batch plus receipt is atomic; failures create zero partial records.
- Repeating the same batch creates zero new records.
- `focus` is used consistently in hash, identity, display, backup, restore, and review.
- Manual captures without an explicit focus remain sentence-identity items; exact Coach focus identity may therefore produce a separate item. This accepted limitation is visible in docs and is never hidden behind fuzzy auto-merge.
- `.tenjin` backup and empty-ledger restore preserve events, contexts, images, receipts, and derived review state.
- Imported items are immediately reviewable in a two-minute session; no new mastery claim is inferred from Coach output.
- iPhone clipboard success, clipboard denial, offline use, and full backup round-trip all pass on the deployed SHA.

## Explicit non-goals

- No Custom GPT Action or direct ChatGPT-to-Tenjin network call.
- No LLM or OCR inside Tenjin.
- No background collection, URL collection, multi-image batch, or voice capture.
- No Coach-generated mastery, frequency, JLPT level, confidence, or semantic-shift taxonomy in the ledger.
- No transfer sentence as promotion evidence in v0.
- No restore into a non-empty ledger or cross-device merge.
