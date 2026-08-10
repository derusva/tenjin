import type {
  CaptureCreatedEvent,
  LearningChannel,
} from "@tenjin/core";
import type {
  CoachImportRepository,
  ContextImageRecord,
  LedgerRepository,
} from "@tenjin/storage-indexeddb";
import { useEffect, useRef, useState } from "react";

import {
  ChevronRightIcon,
  DataIcon,
  RecordIcon,
  ReviewIcon,
  SearchIcon,
  UndoIcon,
} from "./components/icons.js";
import type { StoragePersistenceStatus } from "./app/storagePersistence.js";
import {
  CaptureComposer,
  type CaptureDraft,
} from "./features/capture/CaptureComposer.js";
import { LocalImagePreview } from "./features/capture/LocalImagePreview.js";
import {
  IMAGE_ONLY_CAPTURE_ORIGINAL,
  type CaptureCommand,
} from "./features/capture/createCapture.js";
import {
  CoachImportView,
  type CoachImportConfirmation,
  type CoachImportConfirmationResult,
  type CoachImportViewProps,
} from "./features/coach-import/CoachImportView.js";
import { CoachHelpView } from "./features/coach-import/CoachHelpView.js";
import type {
  LedgerRuntime,
  VerificationResult,
} from "./features/ledger/ledgerRuntime.js";
import {
  useLedger,
  type SaveCaptureResult,
} from "./features/ledger/useLedger.js";
import { ReviewSession } from "./features/review/ReviewSession.js";
import type { ReviewPresentation } from "./features/review/reviewQueue.js";
import { SearchView } from "./features/search/SearchView.js";

export interface AppProps {
  readonly repository: LedgerRepository & Partial<CoachImportRepository>;
  readonly runtime: LedgerRuntime;
  readonly writeGate: { assertWritable(): void };
  readonly storagePersistence?: StoragePersistenceStatus;
  readonly prepareImage?: (file: File) => Promise<ContextImageRecord>;
  readonly coachImportDependencies?: Pick<
    CoachImportViewProps,
    | "readClipboardText"
    | "writeClipboardText"
    | "digestTransfer"
  >;
  readonly backupRestoreActions?: {
    readonly restoreSupported: boolean;
    readonly restoreEligible: boolean;
    readonly onExportBackup: () => Promise<void>;
    readonly onRestoreBackup: (file: File) => Promise<void>;
  };
}

type AppView =
  | "record"
  | "review"
  | "search"
  | "data"
  | "coach-import"
  | "coach-help";

const NAVIGATION: readonly {
  readonly view: AppView;
  readonly label: string;
  readonly icon: typeof RecordIcon;
}[] = [
  { view: "record", label: "记录", icon: RecordIcon },
  { view: "review", label: "复习", icon: ReviewIcon },
  { view: "search", label: "搜索", icon: SearchIcon },
  { view: "data", label: "数据", icon: DataIcon },
];

const UNDO_WINDOW_MS = 8_000;

interface UndoToastState {
  readonly source: "manual" | "coach";
  readonly targets: readonly SaveCaptureResult[];
  readonly importDigest?: `sha256:${string}`;
  readonly error?: string;
}

function isSameUndoState(
  left: UndoToastState,
  right: UndoToastState,
): boolean {
  return (
    left.source === right.source &&
    left.importDigest === right.importDigest &&
    left.targets.length === right.targets.length &&
    left.targets.every(
      (target, index) =>
        target.captureId === right.targets[index]?.captureId &&
        target.contextHash === right.targets[index]?.contextHash,
    )
  );
}

const CAPTURE_CHANNEL: Readonly<
  Record<
    CaptureCreatedEvent["payload"]["captureType"],
    LearningChannel
  >
> = {
  lookup: "R",
  listening_miss: "L",
  production_correction: "P",
};

const STORAGE_PERSISTENCE_COPY: Readonly<
  Record<StoragePersistenceStatus, string>
> = {
  persisted: "存储状态：已持久化",
  "best-effort": "存储状态：尽力保留",
  unsupported: "存储状态：浏览器不支持持久化",
};

export function App({
  repository,
  runtime,
  writeGate,
  storagePersistence = "unsupported",
  prepareImage,
  coachImportDependencies,
  backupRestoreActions,
}: AppProps) {
  const ledger = useLedger({ repository, runtime, writeGate });
  const [currentView, setCurrentView] = useState<AppView>("record");
  const [reviewItems, setReviewItems] = useState<readonly ReviewPresentation[]>(
    [],
  );
  const [reviewSessionKey, setReviewSessionKey] = useState(0);
  const [lastCoachReviewItemIds, setLastCoachReviewItemIds] = useState<
    readonly string[]
  >([]);
  const [coachImportResetVersion, setCoachImportResetVersion] = useState(0);
  const [captureDraft, setCaptureDraft] = useState<CaptureDraft>({
    captureType: "lookup",
    original: "",
    focus: "",
    corrected: "",
    answer: "",
    image: undefined,
  });
  const [captureSaving, setCaptureSaving] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [undoState, setUndoState] = useState<UndoToastState | undefined>();
  const [undoing, setUndoing] = useState(false);
  const [backupOperation, setBackupOperation] = useState<
    "idle" | "exporting" | "restoring"
  >("idle");
  const [backupMessage, setBackupMessage] = useState<
    { readonly kind: "status" | "error"; readonly text: string } | undefined
  >();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mounted = useRef(false);
  const captureSavingRef = useRef(false);
  const reviewSavingRef = useRef(false);
  const backupOperationRef = useRef<"idle" | "exporting" | "restoring">(
    "idle",
  );
  const mainRef = useRef<HTMLElement>(null);
  const recentChannels = new Map<string, LearningChannel>();
  for (const event of ledger.snapshot.events) {
    if (event.kind === "capture_created") {
      recentChannels.set(
        event.captureId,
        CAPTURE_CHANNEL[event.payload.captureType],
      );
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (undoTimer.current !== undefined) {
        clearTimeout(undoTimer.current);
        undoTimer.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    mainRef.current?.focus({ preventScroll: true });
  }, [currentView]);

  function clearUndoTimer() {
    if (undoTimer.current !== undefined) {
      clearTimeout(undoTimer.current);
      undoTimer.current = undefined;
    }
  }

  function showUndo(next: UndoToastState) {
    clearUndoTimer();
    setUndoState(next);
    undoTimer.current = setTimeout(() => {
      undoTimer.current = undefined;
      setUndoState((current) =>
        current !== undefined && isSameUndoState(current, next)
          ? undefined
          : current,
      );
    }, UNDO_WINDOW_MS);
  }

  function openView(nextView: AppView, preferredItemIds?: readonly string[]) {
    if (captureSavingRef.current || reviewSavingRef.current || undoing) {
      return;
    }
    if (nextView === "review") {
      clearUndoTimer();
      setUndoState(undefined);
      const preferred = new Set(preferredItemIds ?? []);
      setReviewItems([
        ...ledger.reviewItems.filter((item) => preferred.has(item.itemId)),
        ...ledger.reviewItems.filter((item) => !preferred.has(item.itemId)),
      ]);
      setReviewSessionKey((key) => key + 1);
    }
    setCurrentView(nextView);
  }

  async function saveCapture(command: CaptureCommand): Promise<void> {
    if (captureSavingRef.current) {
      throw new Error("记录仍在保存");
    }
    captureSavingRef.current = true;
    setCaptureSaving(true);
    try {
      const result = await ledger.saveCapture(command);
      if (!mounted.current) {
        return;
      }

      showUndo({ source: "manual", targets: [result] });
    } finally {
      captureSavingRef.current = false;
      if (mounted.current) {
        setCaptureSaving(false);
      }
    }
  }

  async function importCoachBatch(
    confirmation: CoachImportConfirmation,
  ): Promise<CoachImportConfirmationResult> {
    if (captureSavingRef.current) {
      throw new Error("记录仍在保存");
    }
    captureSavingRef.current = true;
    setCaptureSaving(true);
    try {
      const result = await ledger.importCoachBatch({
        digest: confirmation.digest,
        items: confirmation.selectedItems.map((item, index) => ({
          focus: item.focus,
          sourceExcerpt: item.sourceExcerpt,
          answer: item.answer,
          ...(confirmation.imageTarget?.selectedItemIndex === index
            ? { image: confirmation.imageTarget.image }
            : {}),
        })),
      });
      if (mounted.current && result.status === "imported") {
        setLastCoachReviewItemIds(
          result.captures.map((capture) => capture.itemId),
        );
        showUndo({
          source: "coach",
          targets: result.captures,
          importDigest: confirmation.digest,
        });
      }
      return { status: result.status };
    } finally {
      captureSavingRef.current = false;
      if (mounted.current) {
        setCaptureSaving(false);
      }
    }
  }

  async function undoCapture(): Promise<void> {
    if (undoState === undefined || undoing) {
      return;
    }

    const target = undoState;
    clearUndoTimer();
    setUndoState((current) =>
      current !== undefined && isSameUndoState(current, target)
        ? {
            source: current.source,
            targets: current.targets,
            ...(current.importDigest === undefined
              ? {}
              : { importDigest: current.importDigest }),
          }
        : current,
    );
    setUndoing(true);
    try {
      if (target.source === "coach") {
        await ledger.discardCaptureBatch(target.targets, target.importDigest);
        if (mounted.current) {
          setLastCoachReviewItemIds([]);
          setCoachImportResetVersion((version) => version + 1);
        }
      } else {
        const capture = target.targets[0];
        if (capture === undefined) {
          throw new Error("没有可撤销的记录");
        }
        await ledger.discardCapture(capture.captureId, capture.contextHash);
      }
      if (mounted.current) {
        setUndoState((current) =>
          current !== undefined && isSameUndoState(current, target)
            ? undefined
            : current,
        );
      }
    } catch (error) {
      if (mounted.current) {
        const message = error instanceof Error ? error.message : String(error);
        setUndoState((current) =>
          current !== undefined && isSameUndoState(current, target)
            ? {
                source: current.source,
                targets: current.targets,
                ...(current.importDigest === undefined
                  ? {}
                  : { importDigest: current.importDigest }),
                error: `撤销失败：${message}。请重试。`,
              }
            : current,
        );
      }
    } finally {
      if (mounted.current) {
        setUndoing(false);
      }
    }
  }

  async function answerReview(
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ): Promise<void> {
    if (reviewSavingRef.current) {
      throw new Error("上一条回答仍在保存");
    }
    reviewSavingRef.current = true;
    setReviewSaving(true);
    try {
      await ledger.answerReview(itemId, channel, result);
    } finally {
      reviewSavingRef.current = false;
      if (mounted.current) {
        setReviewSaving(false);
      }
    }
  }

  async function exportBackup(): Promise<void> {
    if (
      backupRestoreActions === undefined ||
      backupOperationRef.current !== "idle"
    ) {
      return;
    }
    backupOperationRef.current = "exporting";
    setBackupOperation("exporting");
    setBackupMessage(undefined);
    try {
      await backupRestoreActions.onExportBackup();
      if (mounted.current) {
        setBackupMessage({ kind: "status", text: "完整备份已下载" });
      }
    } catch (error) {
      if (mounted.current) {
        const message = error instanceof Error ? error.message : String(error);
        setBackupMessage({ kind: "error", text: `导出失败：${message}` });
      }
    } finally {
      backupOperationRef.current = "idle";
      if (mounted.current) setBackupOperation("idle");
    }
  }

  async function restoreBackup(file: File): Promise<void> {
    if (
      backupRestoreActions === undefined ||
      backupOperationRef.current !== "idle"
    ) {
      return;
    }
    backupOperationRef.current = "restoring";
    setBackupOperation("restoring");
    setBackupMessage(undefined);
    try {
      await backupRestoreActions.onRestoreBackup(file);
      if (mounted.current) {
        setBackupMessage({ kind: "status", text: "恢复完成，正在重新打开…" });
      }
    } catch (error) {
      if (mounted.current) {
        const message = error instanceof Error ? error.message : String(error);
        setBackupMessage({ kind: "error", text: `恢复失败：${message}` });
      }
      backupOperationRef.current = "idle";
      if (mounted.current) setBackupOperation("idle");
    }
  }

  const navigationLocked =
    captureSaving || reviewSaving || undoing || backupOperation !== "idle";
  const restoreBlocked =
    backupRestoreActions !== undefined &&
    (!backupRestoreActions.restoreEligible ||
      ledger.snapshot.events.length > 0 ||
      ledger.snapshot.contexts.length > 0);

  let content;
  if (ledger.status === "loading") {
    content = (
      <section className="utility-view state-view">
        <p role="status">正在加载本地记录…</p>
      </section>
    );
  } else if (ledger.status === "error") {
    content = (
      <section className="utility-view state-view">
        <p role="alert">{ledger.error ?? "读取本地记录失败"}</p>
        <button
          className="secondary-action"
          type="button"
          onClick={() => void ledger.retryRead()}
        >
          重试读取
        </button>
      </section>
    );
  } else if (currentView === "review") {
    content = (
      <ReviewSession
        key={reviewSessionKey}
        items={reviewItems}
        durationMs={120_000}
        onAnswer={answerReview}
        onExit={() => openView("record")}
      />
    );
  } else if (currentView === "search") {
    content = (
      <SearchView
        items={ledger.view.items}
        onBack={() => openView("record")}
      />
    );
  } else if (currentView === "coach-import") {
    content = null;
  } else if (currentView === "coach-help") {
    content = (
      <CoachHelpView
        onBack={() => openView("record")}
        onStartImport={() => openView("coach-import")}
        {...(coachImportDependencies?.writeClipboardText === undefined
          ? {}
          : {
              writeClipboardText:
                coachImportDependencies.writeClipboardText,
            })}
      />
    );
  } else if (currentView === "data") {
    content = (
      <section className="utility-view data-view" aria-labelledby="data-title">
        <h1 id="data-title">数据</h1>
        <div className="data-summary">
          <p>本地事件 {ledger.snapshot.events.length}</p>
          <p>本地上下文 {ledger.snapshot.contexts.length}</p>
          <p>仅保存在此设备</p>
          <p>{STORAGE_PERSISTENCE_COPY[storagePersistence]}</p>
          <p>本地数据仍可能被浏览器或系统清理，持久化也不代表绝对安全。</p>
        </div>
        {backupRestoreActions === undefined ? null : (
          <section
            className="backup-restore-panel"
            aria-labelledby="backup-restore-title"
          >
            <div>
              <h2 id="backup-restore-title">备份与恢复</h2>
              <p>
                完整备份会带走全部原文、图片原始字节和 Coach 导入台账。恢复只写入完全空的本地账本。
              </p>
            </div>
            <div className="backup-restore-actions">
              <button
                type="button"
                disabled={backupOperation !== "idle"}
                onClick={() => void exportBackup()}
              >
                {backupOperation === "exporting" ? "正在导出…" : "导出完整备份"}
              </button>
              <label
                className={
                  backupOperation !== "idle" ||
                  !backupRestoreActions.restoreSupported ||
                  restoreBlocked
                    ? "file-action is-disabled"
                    : "file-action"
                }
              >
                <span>
                  {backupOperation === "restoring" ? "正在恢复…" : "从备份恢复"}
                </span>
                <input
                  aria-label="选择 Tenjin 备份文件"
                  type="file"
                  accept=".tenjin,application/octet-stream,application/zip"
                  disabled={
                    backupOperation !== "idle" ||
                    !backupRestoreActions.restoreSupported ||
                    restoreBlocked
                  }
                  onChange={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    if (file !== undefined) {
                      void restoreBackup(file).finally(() => {
                        input.value = "";
                      });
                    }
                  }}
                />
              </label>
            </div>
            {!backupRestoreActions.restoreSupported ? (
              <p className="backup-note">
                此浏览器缺少恢复所需的多标签写锁；仍可导出备份。
              </p>
            ) : restoreBlocked ? (
              <p className="backup-note">
                当前本地账本并非完全空白；为防止合并污染，恢复入口已锁定。
              </p>
            ) : (
              <p className="backup-note">恢复成功后 Tenjin 会重新加载并启用新设备身份。</p>
            )}
            {backupMessage === undefined ? null : (
              <p
                role={backupMessage.kind === "error" ? "alert" : "status"}
                className={`backup-message ${backupMessage.kind}`}
              >
                {backupMessage.text}
              </p>
            )}
          </section>
        )}
      </section>
    );
  } else {
    content = (
      <section className="record-view">
        <header className="record-header">
          <h1 className="wordmark">Tenjin</h1>
          <p className="record-question">今天遇到了什么？</p>
        </header>
        <section className="coach-entry" aria-labelledby="coach-entry-title">
          <div>
            <h2 id="coach-entry-title">截图先交给 Coach</h2>
            <p>逐句看懂后，把整理出的 1–3 个学习点一次导入。</p>
          </div>
          <div className="coach-entry-actions">
            <button
              type="button"
              disabled={navigationLocked}
              onClick={() => openView("coach-import")}
            >
              从 Coach 导入
            </button>
            <button
              type="button"
              disabled={navigationLocked}
              onClick={() => openView("coach-help")}
            >
              怎么用 Coach
            </button>
          </div>
        </section>
        <CaptureComposer
          draft={captureDraft}
          onDraftChange={setCaptureDraft}
          onSave={saveCapture}
          {...(prepareImage === undefined ? {} : { prepareImage })}
        />
        <section className="quick-actions" aria-label="记录操作">
          <button
            type="button"
            disabled={navigationLocked}
            onClick={() => openView("review")}
          >
            <ReviewIcon aria-hidden="true" size={24} />
            <span>复习 2 分钟</span>
          </button>
          <button
            type="button"
            disabled={navigationLocked}
            onClick={() => openView("search")}
          >
            <SearchIcon aria-hidden="true" size={24} />
            <span>搜索</span>
          </button>
        </section>
        <section className="recent-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <h2 id="recent-title">最近记录</h2>
          </div>
          {ledger.recentEntries.length === 0 ? (
            <p className="empty-state">还没有记录</p>
          ) : (
            <ul className="recent-list">
              {ledger.recentEntries.map((entry) => {
                const channel = recentChannels.get(entry.captureId);
                const imageOnly =
                  entry.context.image !== undefined &&
                  entry.context.original === IMAGE_ONLY_CAPTURE_ORIGINAL;
                return (
                  <li key={entry.captureId}>
                    <article className="recent-row">
                      {entry.context.image === undefined ? null : (
                        <LocalImagePreview
                          className="recent-image-thumbnail"
                          blob={entry.context.image.blob}
                          alt={`最近记录图片：${entry.context.image.name}`}
                        />
                      )}
                      <div className="recent-copy">
                        <h3>
                          {imageOnly
                            ? entry.context.image!.name
                            : (entry.display ??
                              entry.context.corrected ??
                              entry.context.original)}
                        </h3>
                        <p>{entry.context.original}</p>
                        <time dateTime={entry.occurredAt}>
                          {entry.occurredAt}
                        </time>
                      </div>
                      <div className="recent-trail">
                        {channel === undefined ? null : (
                          <span
                            className="recent-channel"
                            aria-label={`${channel} 通道`}
                          >
                            {channel}
                          </span>
                        )}
                        <ChevronRightIcon aria-hidden="true" size={22} />
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <main ref={mainRef} className="app-main" tabIndex={-1}>
        {ledger.status === "ready" && ledger.error !== undefined ? (
          <aside className="ledger-warning" role="alert">
            <p>
              界面未能重新读取本地账本，当前显示的是上次快照：
              {ledger.error}
            </p>
            <button type="button" onClick={() => void ledger.retryRead()}>
              重新读取
            </button>
          </aside>
        ) : null}
        {content}
        <div hidden={currentView !== "coach-import"}>
          <CoachImportView
            onConfirm={importCoachBatch}
            onBack={() => openView("record")}
            onReview={() => openView("review", lastCoachReviewItemIds)}
            resetCompletedImportVersion={coachImportResetVersion}
            {...(prepareImage === undefined ? {} : { prepareImage })}
            {...coachImportDependencies}
          />
        </div>
      </main>
      {undoState === undefined ? null : (
        <aside
          className="undo-toast"
          role={undoState.error === undefined ? "status" : "alert"}
          aria-live={undoState.error === undefined ? "polite" : "assertive"}
        >
          <span>
            {undoState.error ??
              (undoState.source === "coach"
                ? `已导入 ${undoState.targets.length} 条`
                : "已保存")}
          </span>
          <button type="button" disabled={undoing} onClick={undoCapture}>
            <UndoIcon aria-hidden="true" size={18} />
            <span>{undoState.error === undefined ? "撤销" : "重试撤销"}</span>
          </button>
        </aside>
      )}
      <nav className="bottom-nav" aria-label="主要导航">
        {NAVIGATION.map((item) => (
          <button
            className="bottom-nav-item"
            key={item.view}
            type="button"
            disabled={
              navigationLocked ||
              (item.view === "review" && ledger.status !== "ready")
            }
            aria-current={currentView === item.view ? "page" : undefined}
            onClick={() => openView(item.view)}
          >
            <item.icon aria-hidden="true" size={24} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
