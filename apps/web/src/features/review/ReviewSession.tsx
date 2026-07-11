import type { LearningChannel, ReviewItem } from "@tenjin/core";
import { useState } from "react";

import {
  AssessmentFailIcon,
  AssessmentHesitantIcon,
  AssessmentPassIcon,
} from "../../components/icons.js";
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
      <section className="review-view utility-view" aria-labelledby="empty-review-title">
        <h1 id="empty-review-title">暂时没有可复习的内容</h1>
        <button className="secondary-action" type="button" onClick={onExit}>
          返回记录
        </button>
      </section>
    );
  }

  if (current === undefined) {
    return (
      <section className="review-view utility-view" aria-labelledby="review-complete-title">
        <h1 id="review-complete-title">本次复习完成</h1>
        <button className="secondary-action" type="button" onClick={onExit}>
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
    <section
      className="review-view"
      aria-labelledby="review-item-title"
      aria-busy={saving}
    >
      <header className="review-header">
        <p className="wordmark">Tenjin</p>
        <p className="review-progress">
          {currentIndex + 1} / {items.length}
        </p>
      </header>
      <article className="review-item">
        <h1 id="review-item-title">{current.item.display}</h1>
        <p className="review-channel">{current.channel} 通道</p>

        {revealed ? (
          <>
            <section className="ruled-section" aria-labelledby="review-notes-title">
              <h2 id="review-notes-title">笔记</h2>
              <p>暂无笔记</p>
            </section>
            <section className="ruled-section" aria-labelledby="review-reason-title">
              <h2 id="review-reason-title">为什么出现</h2>
              <p>{REASON_COPY[current.reason]}</p>
            </section>
            <p className="review-prompt">你想起来了吗？</p>
            <div className="assessment-actions" role="group" aria-label="自我评估">
              <button
                className="assessment-pass"
                type="button"
                disabled={saving}
                onClick={() => answer("pass")}
              >
                <AssessmentPassIcon aria-hidden="true" size={23} />
                <span>记得</span>
              </button>
              <button
                className="assessment-hesitant"
                type="button"
                disabled={saving}
                onClick={() => answer("hesitant")}
              >
                <AssessmentHesitantIcon aria-hidden="true" size={23} />
                <span>有点慢</span>
              </button>
              <button
                className="assessment-fail"
                type="button"
                disabled={saving}
                onClick={() => answer("fail")}
              >
                <AssessmentFailIcon aria-hidden="true" size={23} />
                <span>不记得</span>
              </button>
            </div>
          </>
        ) : (
          <button
            className="reveal-action"
            type="button"
            onClick={() => setRevealed(true)}
          >
            揭示
          </button>
        )}
      </article>
    </section>
  );
}
