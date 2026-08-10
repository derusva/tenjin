# Coach Import Complete Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one complete user-visible loop: fixed Coach conversation -> `整理` -> copy JSON -> Tenjin strict preview -> atomic confirmed import -> immediate R review, with backup/restore and duplicate protection already working before the entry point is exposed.

**Architecture:** Work stays on one implementation branch and the Coach entry point remains absent until every release gate passes. Reuse the existing lookup event family; add optional `focus` to contexts, a single atomic multi-capture write, and a v3 `importReceipts` store committed in the same IndexedDB transaction. Complete the already-reviewed A1 restore slice first, then extend `.tenjin` full backups to include `focus` and receipts so the import path never creates state that cannot be restored.

**Tech Stack:** TypeScript 5.9, React 19, IndexedDB via `idb`, Vitest, Testing Library, existing `@tenjin/core`, `@tenjin/storage-indexeddb`, `@tenjin/exchange`, PWA/Vite.

---

## Product and release decision

This plan supersedes the user-operated Stage 0 ritual. On 2026-08-10 the owner explicitly chose the one-time complete route and accepted the irreversible DB v3, focus identity, and package-schema v2 changes. The user is not asked to collect JSON in Notes, count batches, or manually re-enter Coach output. Format instability is handled by a strict parser plus a repair message; semantic mistakes are handled in the preview. Real usage begins only after the complete slice is deployed.

The implementation may use multiple commits, but GitHub Pages must not expose a partial path. The record-page entry point is added only in the final UI task, after A1 restore, atomic import, receipts, backup round-trip, and review integration are green.

The parser accepts exactly two transport envelopes because ChatGPT's code-block Copy button normally places raw code on the clipboard:

1. the entire trimmed input is one JSON object; or
2. the entire trimmed input is one `json` fenced block, with only whitespace outside it.

No brace scanning, candidate selection, field guessing, unknown-key stripping, or model-authored confidence is allowed.

## Final user flow

1. In Tenjin, open `怎么用 Coach` and tap `复制 Coach 设置` once.
2. Paste that setting into one fixed Coach conversation.
3. Send a screenshot or Japanese text. Coach translates every sentence, then explains only 1-3 useful sticking points.
4. Send the exact message `整理`.
5. Tap the Coach code block's Copy button.
6. In Tenjin, tap `从 Coach 导入` -> `粘贴并预览`.
7. Edit or deselect any proposed item; optionally attach the original screenshot to one item.
8. Tap `确认导入 N 条`. All selected items and the receipt commit atomically, or nothing commits.
9. Tap `现在复习`; the imported items are immediately available in a two-minute R review session.

## Frozen Coach prompt

```text
你是我的固定日语 Coach。目标是帮助我提高真实日语理解能力。

普通模式：
1. 收到截图或日文后，按原文顺序逐句完整翻译成自然中文，不得跳句，也不得因为推测我认识而省略。
2. 每句先列日文，再给中文；必要时说明省略的主语、指代、语气和上下文。
3. 完整翻译后，只额外展开 1-3 个我实际可能卡住、且值得复习的语言单位。
4. 不输出 N1 高频、星级、掌握度、学习画像或无依据的词源判断。

当我单独发送「整理」时：
1. 只整理本轮我实际没懂、追问过或确实值得留下的内容，共 0-3 条，目标 1-2 条；没有就输出空 items。
2. 回复只能包含一个 json 代码块，围栏外不得有任何文字。
3. schema 必须是 tenjin.coach-transfer/v1。
4. 每条只能有 type、focus、sourceExcerpt、answer，以及可选的 transferSentence。
5. type 固定为 lookup。
6. focus 是可独立复习的最小完整语言单位，保留决定意义的助词、活用和句法槽位；能自然规范化才规范化。
7. sourceExcerpt 必须是包含 focus 的原始日文句子。
8. answer 只解释 focus 在该句中的实际含义，最多一两句，不得编造。
9. transferSentence 默认省略；只有本轮已经得到可靠的迁移例句时才提供。
10. 不得增加任何其他字段，必须使用合法 JSON、双引号且无尾逗号。
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

Each selected card exposes `focus`, `sourceExcerpt`, `answer`, and optional `transferSentence`. Reuse `prepareCaptureImage` for one chosen card only. `transferSentence` stays preview-only in this release and is not persisted or used as proof of mastery.

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
