import type {
  CaptureCreatedEvent,
  LearningChannel,
  ReviewItem,
} from "@tenjin/core";
import type { LedgerRepository } from "@tenjin/storage-indexeddb";
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
import { CaptureComposer } from "./features/capture/CaptureComposer.js";
import type { CaptureCommand } from "./features/capture/createCapture.js";
import type { LedgerRuntime } from "./features/ledger/ledgerRuntime.js";
import {
  useLedger,
  type SaveCaptureResult,
} from "./features/ledger/useLedger.js";
import { ReviewSession } from "./features/review/ReviewSession.js";
import { SearchView } from "./features/search/SearchView.js";

export interface AppProps {
  readonly repository: LedgerRepository;
  readonly runtime: LedgerRuntime;
  readonly storagePersistence?: StoragePersistenceStatus;
}

type AppView = "record" | "review" | "search" | "data";

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
  storagePersistence = "unsupported",
}: AppProps) {
  const ledger = useLedger({ repository, runtime });
  const [currentView, setCurrentView] = useState<AppView>("record");
  const [reviewItems, setReviewItems] = useState<readonly ReviewItem[]>([]);
  const [reviewSessionKey, setReviewSessionKey] = useState(0);
  const [undoTarget, setUndoTarget] = useState<SaveCaptureResult | undefined>();
  const [undoing, setUndoing] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mounted = useRef(false);
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

  function clearUndoTimer() {
    if (undoTimer.current !== undefined) {
      clearTimeout(undoTimer.current);
      undoTimer.current = undefined;
    }
  }

  function openView(nextView: AppView) {
    if (nextView === "review") {
      setReviewItems([...ledger.reviewItems]);
      setReviewSessionKey((key) => key + 1);
    }
    setCurrentView(nextView);
  }

  async function saveCapture(command: CaptureCommand): Promise<void> {
    const result = await ledger.saveCapture(command);
    if (!mounted.current) {
      return;
    }

    clearUndoTimer();
    setUndoTarget(result);
    undoTimer.current = setTimeout(() => {
      undoTimer.current = undefined;
      setUndoTarget(undefined);
    }, UNDO_WINDOW_MS);
  }

  async function undoCapture(): Promise<void> {
    if (undoTarget === undefined || undoing) {
      return;
    }

    const target = undoTarget;
    clearUndoTimer();
    setUndoTarget(undefined);
    setUndoing(true);
    try {
      await ledger.discardCapture(
        target.captureId,
        target.contextHash,
      );
    } finally {
      if (mounted.current) {
        setUndoing(false);
      }
    }
  }

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
      </section>
    );
  } else if (currentView === "review") {
    content = (
      <ReviewSession
        key={reviewSessionKey}
        items={reviewItems}
        onAnswer={ledger.answerReview}
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
      </section>
    );
  } else {
    content = (
      <section className="record-view">
        <header className="record-header">
          <h1 className="wordmark">Tenjin</h1>
          <p className="record-question">今天遇到了什么？</p>
        </header>
        <CaptureComposer onSave={saveCapture} />
        <section className="quick-actions" aria-label="记录操作">
          <button type="button" onClick={() => openView("review")}>
            <ReviewIcon aria-hidden="true" size={24} />
            <span>复习 5 条</span>
          </button>
          <button type="button" onClick={() => openView("search")}>
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
                return (
                  <li key={entry.captureId}>
                    <article className="recent-row">
                      <div className="recent-copy">
                        <h3>
                          {entry.display ??
                            entry.context.corrected ??
                            entry.context.original}
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
      <main className="app-main">{content}</main>
      {undoTarget === undefined ? null : (
        <aside className="undo-toast" role="status" aria-live="polite">
          <span>已保存</span>
          <button type="button" disabled={undoing} onClick={undoCapture}>
            <UndoIcon aria-hidden="true" size={18} />
            <span>撤销</span>
          </button>
        </aside>
      )}
      <nav className="bottom-nav" aria-label="主要导航">
        {NAVIGATION.map((item) => (
          <button
            className="bottom-nav-item"
            key={item.view}
            type="button"
            disabled={item.view === "review" && ledger.status !== "ready"}
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
