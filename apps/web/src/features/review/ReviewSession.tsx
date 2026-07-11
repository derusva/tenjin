import type { LearningChannel } from "@tenjin/core";
import { useEffect, useRef, useState } from "react";

import {
  AssessmentFailIcon,
  AssessmentHesitantIcon,
  AssessmentPassIcon,
} from "../../components/icons.js";
import type { VerificationResult } from "../ledger/ledgerRuntime.js";
import type { ReviewPresentation } from "./reviewQueue.js";

export interface ReviewSessionProps {
  readonly items: readonly ReviewPresentation[];
  readonly onAnswer: (
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ) => Promise<void>;
  readonly onExit: () => void;
}

const REASON_COPY: Readonly<Record<ReviewPresentation["reason"], string>> = {
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
  const [announcement, setAnnouncement] = useState("");
  const [saveError, setSaveError] = useState<string | undefined>();
  const firstAssessmentRef = useRef<HTMLButtonElement>(null);
  const nextContentRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusNextContentRef = useRef(false);
  const current = items[currentIndex];

  useEffect(() => {
    if (revealed) {
      firstAssessmentRef.current?.focus();
    }
  }, [revealed]);

  useEffect(() => {
    if (!shouldFocusNextContentRef.current) {
      return;
    }

    nextContentRef.current?.focus();
    shouldFocusNextContentRef.current = false;
  }, [currentIndex]);

  const liveStatus = (
    <p
      className={saveError === undefined ? "visually-hidden" : "review-error"}
      role={saveError === undefined ? "status" : "alert"}
      aria-atomic="true"
    >
      {saveError ?? announcement}
    </p>
  );

  if (items.length === 0) {
    return (
      <section className="review-view utility-view" aria-labelledby="empty-review-title">
        {liveStatus}
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
        {liveStatus}
        <h1 id="review-complete-title" ref={nextContentRef} tabIndex={-1}>
          本次复习完成
        </h1>
        <button className="secondary-action" type="button" onClick={onExit}>
          结束本次
        </button>
      </section>
    );
  }
  const itemToReview = current;

  async function answer(result: VerificationResult) {
    setSaving(true);
    setSaveError(undefined);
    try {
      await onAnswer(itemToReview.itemId, itemToReview.channel, result);
      shouldFocusNextContentRef.current = true;
      setAnnouncement(
        currentIndex + 1 < items.length
          ? "回答已保存，下一题已载入"
          : "回答已保存",
      );
      setCurrentIndex((index) => index + 1);
      setRevealed(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      setSaveError(`回答未保存：${detail}。请重试。`);
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
      {liveStatus}
      <header className="review-header">
        <p className="wordmark">Tenjin</p>
        <p className="review-progress">
          {currentIndex + 1} / {items.length}
        </p>
      </header>
      <article className="review-item">
        <h1 id="review-item-title" ref={nextContentRef} tabIndex={-1}>
          {current.prompt}
        </h1>
        <p className="review-channel">{current.channel} 通道</p>

        {revealed ? (
          <>
            {current.reveal === undefined ? null : (
              <section
                className="ruled-section review-answer"
                aria-labelledby="review-answer-title"
              >
                <h2 id="review-answer-title">{current.reveal.label}</h2>
                <p>{current.reveal.text}</p>
              </section>
            )}
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
                ref={firstAssessmentRef}
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
            onClick={() => {
              setSaveError(undefined);
              setAnnouncement("内容已揭示，请选择自我评估");
              setRevealed(true);
            }}
          >
            揭示
          </button>
        )}
      </article>
    </section>
  );
}
