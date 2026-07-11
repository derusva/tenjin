import type { ReviewItem } from "@tenjin/core";
import type { LedgerRepository } from "@tenjin/storage-indexeddb";
import { useEffect, useRef, useState } from "react";

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
}

type AppView = "record" | "review" | "search" | "data";

const NAVIGATION: readonly { readonly view: AppView; readonly label: string }[] = [
  { view: "record", label: "记录" },
  { view: "review", label: "复习" },
  { view: "search", label: "搜索" },
  { view: "data", label: "数据" },
];

const UNDO_WINDOW_MS = 8_000;

export function App({ repository, runtime }: AppProps) {
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
    content = <p role="status">正在加载本地记录…</p>;
  } else if (ledger.status === "error") {
    content = (
      <p role="alert">{ledger.error ?? "读取本地记录失败"}</p>
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
      <section aria-labelledby="data-title">
        <h1 id="data-title">数据</h1>
        <p>本地事件 {ledger.snapshot.events.length}</p>
        <p>本地上下文 {ledger.snapshot.contexts.length}</p>
        <p>仅保存在此设备</p>
      </section>
    );
  } else {
    content = (
      <>
        <header>
          <h1>Tenjin</h1>
          <p>今天遇到了什么？</p>
        </header>
        <CaptureComposer onSave={saveCapture} />
        <section aria-label="记录操作">
          <button type="button" onClick={() => openView("review")}>
            复习 5 条
          </button>
          <button type="button" onClick={() => openView("search")}>
            搜索
          </button>
        </section>
        <section aria-labelledby="recent-title">
          <h2 id="recent-title">最近记录</h2>
          {ledger.recentEntries.length === 0 ? (
            <p>还没有记录</p>
          ) : (
            <ul>
              {ledger.recentEntries.map((entry) => (
                <li key={entry.captureId}>
                  <article>
                    <h3>
                      {entry.display ??
                        entry.context.corrected ??
                        entry.context.original}
                    </h3>
                    <p>{entry.context.original}</p>
                    <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <main>{content}</main>
      {undoTarget === undefined ? null : (
        <aside role="status" aria-live="polite">
          <span>已保存</span>
          <button type="button" disabled={undoing} onClick={undoCapture}>
            撤销
          </button>
        </aside>
      )}
      <nav aria-label="主要导航">
        {NAVIGATION.map((item) => (
          <button
            key={item.view}
            type="button"
            aria-current={currentView === item.view ? "page" : undefined}
            onClick={() => openView(item.view)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </>
  );
}
