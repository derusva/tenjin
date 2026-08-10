import type { ItemView, ReviewItem } from "@tenjin/core";
import type { ContextImageRecord } from "@tenjin/storage-indexeddb";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReviewSession } from "./ReviewSession.js";
import type { ReviewPresentation, ReviewReveal } from "./reviewQueue.js";

function makeItem(itemId: string, display: string): ItemView {
  return {
    itemId,
    display,
    identityKey: display.toLocaleLowerCase(),
    targetChannels: ["R", "L", "P"],
    channels: {
      R: { state: "unstable", validPassDates: [] },
      L: { state: "unstable", validPassDates: [] },
      P: { state: "stable", validPassDates: [] },
    },
    evidenceCount: 3,
    lastOccurredAt: "2026-07-11T02:00:00.000Z",
  };
}

function makeReviewItem(
  itemId: string,
  display: string,
  reason: ReviewItem["reason"] = "unstable",
  presentation: {
    readonly prompt?: string;
    readonly focus?: string;
    readonly promptImage?: ContextImageRecord;
    readonly reveal?: ReviewReveal;
  } = {},
): ReviewPresentation {
  return {
    itemId,
    channel: "R",
    reason,
    item: makeItem(itemId, display),
    prompt: presentation.prompt ?? display,
    ...(presentation.focus === undefined ? {} : { focus: presentation.focus }),
    ...(presentation.promptImage === undefined
      ? {}
      : { promptImage: presentation.promptImage }),
    reveal: presentation.reveal,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ReviewSession", () => {
  it("shows a local lookup image as the prompt and keeps its answer hidden until reveal", async () => {
    const user = userEvent.setup();
    const image = {
      blob: new Blob(["png"], { type: "image/png" }),
      mediaType: "image/png",
      name: "lookup.png",
      byteLength: 3,
      sha256: "ab".repeat(32),
    } as const satisfies ContextImageRecord;
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "一期一会", "unstable", {
            prompt: "大丈夫、手は打ったから。",
            focus: "手を打つ",
            promptImage: image,
            reveal: {
              label: "查到的意思 / 解释",
              text: "采取措施",
            },
          }),
        ]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    expect(
      screen.getByRole("img", { name: "复习图片：lookup.png" }),
    ).toHaveClass("review-prompt-thumbnail");
    expect(screen.getByText("学习点：手を打つ")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "大丈夫、手は打ったから。" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("采取措施")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getByText("查到的意思 / 解释")).toBeInTheDocument();
    expect(screen.getByText("采取措施")).toBeInTheDocument();
  });

  it("shows the original P prompt and keeps the correction hidden until reveal", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "話します", "unstable", {
            prompt: "話すです",
            reveal: { label: "纠正后的表达", text: "話します" },
          }),
        ]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "話すです" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("話します")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getByText("纠正后的表达")).toBeInTheDocument();
    expect(screen.getByText("話します")).toBeInTheDocument();
  });

  it("hides evidence and explanation until the current item is revealed", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    expect(screen.getByText("天神")).toBeInTheDocument();
    expect(screen.getByText("R 通道")).toBeInTheDocument();
    expect(screen.queryByText("暂无笔记")).not.toBeInTheDocument();
    expect(screen.queryByText("为什么出现")).not.toBeInTheDocument();
    expect(screen.queryByText("这个通道仍不稳定")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getByText("暂无笔记")).toBeInTheDocument();
    expect(screen.getByText("你想起来了吗？")).toBeInTheDocument();
    expect(screen.getByText("为什么出现")).toBeInTheDocument();
    expect(screen.getByText("这个通道仍不稳定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "记得" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "有点慢" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "不记得" })).toBeEnabled();
  });

  it("moves focus to the first assessment after revealing", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getByRole("button", { name: "记得" })).toHaveFocus();
  });

  it("announces the reveal through one status region", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "内容已揭示，请选择自我评估",
    );
  });

  it.each([
    ["recent-failure", "最近一次没有想起来"],
    ["unstable", "这个通道仍不稳定"],
    ["stable-check", "低频确认，确保仍能调用"],
  ] as const)("explains the %s selection reason", async (reason, copy) => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神", reason)]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it.each([
    ["记得", "pass"],
    ["有点慢", "hesitant"],
    ["不记得", "fail"],
  ] as const)("maps %s to %s and awaits persistence before advancing", async (label, result) => {
    const deferred = createDeferred();
    const answers: unknown[][] = [];
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "天神"),
          makeReviewItem("item-2", "神社"),
        ]}
        onAnswer={(...answer) => {
          answers.push(answer);
          return deferred.promise;
        }}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: label }));

    expect(answers).toEqual([["item-1", "R", result]]);
    expect(screen.getByText("天神")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(screen.getByText("神社")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "揭示" })).toBeEnabled();
    expect(screen.queryByText("暂无笔记")).not.toBeInTheDocument();
  });

  it("shows completion after the final answer and exits explicitly", async () => {
    let exited = false;
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => {
          exited = true;
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(screen.getByText("本次复习完成")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "结束本次" }));
    expect(exited).toBe(true);
  });

  it("keeps the current item and offers a retry when persistence fails", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => {
          throw new Error("write failed");
        }}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "回答未保存：write failed",
    );
    expect(screen.getByRole("heading", { name: "天神" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "记得" })).toBeEnabled();
  });

  it("focuses the next item heading after persistence", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "天神"),
          makeReviewItem("item-2", "神社"),
        ]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "神社" }),
    ).toHaveFocus();
  });

  it("announces persistence without repeating the next item title", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "天神"),
          makeReviewItem("item-2", "神社"),
        ]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "回答已保存，下一题已载入",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("神社");
  });

  it("focuses the completion heading after the final answer", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "本次复习完成" }),
    ).toHaveFocus();
  });

  it("announces final persistence without repeating the completion heading", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("回答已保存");
    expect(screen.getByRole("status")).not.toHaveTextContent("本次复习完成");
  });

  it("offers a return action when no items are available", async () => {
    let exited = false;
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[]}
        onAnswer={async () => undefined}
        onExit={() => {
          exited = true;
        }}
      />,
    );

    expect(screen.getByText("暂时没有可复习的内容")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回记录" }));
    expect(exited).toBe(true);
  });

  it("lets the user end from the first card without writing a synthetic answer", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => undefined);
    const onExit = vi.fn();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={onAnswer}
        onExit={onExit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "结束本次复习" }));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not interrupt a visible card when two minutes expire", async () => {
    const user = userEvent.setup();
    let time = 0;
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "天神"),
          makeReviewItem("item-2", "神社"),
        ]}
        durationMs={120_000}
        now={() => time}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    time = 120_001;
    expect(screen.getByRole("heading", { name: "天神" })).toBeInTheDocument();
    expect(screen.queryByText("本次复习完成")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(screen.getByText("本次复习完成")).toBeInTheDocument();
    expect(screen.queryByText("神社")).not.toBeInTheDocument();
  });

  it("continues before the time budget and never shows a remaining-card debt", async () => {
    const user = userEvent.setup();
    let time = 0;
    render(
      <ReviewSession
        items={[
          makeReviewItem("item-1", "天神"),
          makeReviewItem("item-2", "神社"),
        ]}
        durationMs={120_000}
        now={() => time}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    time = 119_999;
    await user.click(screen.getByRole("button", { name: "揭示" }));
    await user.click(screen.getByRole("button", { name: "记得" }));

    expect(screen.getByRole("heading", { name: "神社" })).toBeInTheDocument();
    expect(screen.queryByText(/还剩\s*\d+\s*条/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+\s*\/\s*\d+/u)).not.toBeInTheDocument();
  });
});
