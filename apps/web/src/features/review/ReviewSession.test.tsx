import type { ItemView, ReviewItem } from "@tenjin/core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ReviewSession } from "./ReviewSession.js";

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
): ReviewItem {
  return {
    itemId,
    channel: "R",
    reason,
    item: makeItem(itemId, display),
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
  it("hides evidence and explanation until the current item is revealed", async () => {
    const user = userEvent.setup();
    render(
      <ReviewSession
        items={[makeReviewItem("item-1", "天神")]}
        onAnswer={async () => undefined}
        onExit={() => undefined}
      />,
    );

    expect(screen.getByText("1 / 1")).toBeInTheDocument();
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

    expect(screen.getByText("2 / 2")).toBeInTheDocument();
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
});
