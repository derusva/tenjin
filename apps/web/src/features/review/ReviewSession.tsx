import type { LearningChannel, ReviewItem } from "@tenjin/core";
import { useState } from "react";

import type { VerificationResult } from "../ledger/ledgerRuntime.js";

export interface ReviewSessionProps {
  readonly items: readonly ReviewItem[];
  readonly onAnswer: (
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ) => Promise<void>;
  readonly onExit: () => void;
}

const REASON_COPY: Readonly<Record<ReviewItem["reason"], string>> = {
  "recent-failure": "最近一次没有想起来",
  unstable: "这个通道仍不稳定",
  "stable-check": "低频确认，确保仍能调用",
};

export function ReviewSession({
  items,
  onAnswer,
  onExit,
}: ReviewSessionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = items[currentIndex];

  if (items.length === 0) {
    return (
      <section aria-labelledby="empty-review-title">
        <h1 id="empty-review-title">暂时没有可复习的内容</h1>
        <button type="button" onClick={onExit}>
          返回记录
        </button>
      </section>
    );
  }

  if (current === undefined) {
    return (
      <section aria-labelledby="review-complete-title">
        <h1 id="review-complete-title">本次复习完成</h1>
        <button type="button" onClick={onExit}>
          结束本次
        </button>
      </section>
    );
  }
  const itemToReview = current;

  async function answer(result: VerificationResult) {
    setSaving(true);
    try {
      await onAnswer(itemToReview.itemId, itemToReview.channel, result);
      setCurrentIndex((index) => index + 1);
      setRevealed(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="review-item-title" aria-busy={saving}>
      <p>{currentIndex + 1} / {items.length}</p>
      <p>{current.channel} 通道</p>
      <h1 id="review-item-title">{current.item.display}</h1>

      {revealed ? (
        <>
          <section aria-labelledby="review-notes-title">
            <h2 id="review-notes-title">笔记</h2>
            <p>暂无笔记</p>
          </section>
          <p>你想起来了吗？</p>
          <div role="group" aria-label="自我评估">
            <button
              type="button"
              disabled={saving}
              onClick={() => answer("pass")}
            >
              记得
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => answer("hesitant")}
            >
              有点慢
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => answer("fail")}
            >
              不记得
            </button>
          </div>
          <section aria-labelledby="review-reason-title">
            <h2 id="review-reason-title">为什么出现</h2>
            <p>{REASON_COPY[current.reason]}</p>
          </section>
        </>
      ) : (
        <button type="button" onClick={() => setRevealed(true)}>
          揭示
        </button>
      )}
    </section>
  );
}
