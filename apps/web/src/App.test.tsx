import "fake-indexeddb/auto";

import {
  openLedgerRepository,
  type LedgerRepository,
  type LedgerSnapshot,
} from "@tenjin/storage-indexeddb";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import {
  createLedgerRuntime,
  type LedgerRuntime,
} from "./features/ledger/ledgerRuntime.js";

let databaseSequence = 0;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function hexadecimalDigest(text: string): string {
  return [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("database deletion blocked")));
  });
}

async function createHarness(): Promise<{
  readonly databaseName: string;
  readonly repository: LedgerRepository;
  readonly runtime: LedgerRuntime;
  readonly setNow: (timestamp: string) => void;
}> {
  const databaseName = `tenjin-app-test-${databaseSequence++}`;
  const repository = await openLedgerRepository({ dbName: databaseName });
  let now = "2026-07-11T01:00:00.000Z";
  let uuid = 0;
  const runtime = createLedgerRuntime({
    deviceId: "device-app-test",
    existingEvents: [],
    now: () => new Date(now),
    randomUUID: () => `uuid-${++uuid}`,
    digest: async (text) => hexadecimalDigest(text),
  });

  return {
    databaseName,
    repository,
    runtime,
    setNow(timestamp) {
      now = timestamp;
    },
  };
}

async function saveLookup(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = screen.getByRole("textbox", { name: "遇到的词或表达" });
  await user.type(input, text);
  await user.click(screen.getByRole("button", { name: "记下来" }));
  await waitFor(() => expect(input).toHaveValue(""));
}

async function saveLookupWithFakeTimers(
  repository: LedgerRepository,
  text: string,
): Promise<void> {
  const input = screen.getByRole("textbox", { name: "遇到的词或表达" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "记下来" }));

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await act(async () => {
      await repository.readSnapshot();
      await Promise.resolve();
    });
    if (
      !(input as HTMLTextAreaElement).disabled &&
      (input as HTMLTextAreaElement).value === "" &&
      screen.queryByRole("button", { name: "撤销" }) !== null
    ) {
      return;
    }
  }
  throw new Error(`capture ${text} did not settle`);
}

describe("App", () => {
  it("shows the actual storage protection status only in the data view", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        storagePersistence="persisted"
      />,
    );

    try {
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/存储状态/)).not.toBeInTheDocument();

      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByText("存储状态：已持久化")).toBeInTheDocument();
      expect(
        screen.getByText(
          "本地数据仍可能被浏览器或系统清理，持久化也不代表绝对安全。",
        ),
      ).toBeInTheDocument();

      view.rerender(
        <App
          repository={harness.repository}
          runtime={harness.runtime}
          storagePersistence="best-effort"
        />,
      );
      expect(screen.getByText("存储状态：尽力保留")).toBeInTheDocument();

      view.rerender(
        <App
          repository={harness.repository}
          runtime={harness.runtime}
          storagePersistence="unsupported"
        />,
      );
      expect(
        screen.getByText("存储状态：浏览器不支持持久化"),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps review disabled until the initial snapshot is ready", async () => {
    const harness = await createHarness();
    const seededCapture = await harness.runtime.createCapture({
      type: "lookup",
      original: "loaded item",
    });
    await harness.repository.appendCapture(
      seededCapture.events,
      seededCapture.context,
    );
    const initialSnapshot = await harness.repository.readSnapshot();
    const initialRead = createDeferred<LedgerSnapshot>();
    let delayNextRead = true;
    const delayedRepository: LedgerRepository = {
      appendCapture(events, context) {
        return harness.repository.appendCapture(events, context);
      },
      appendEvents(events) {
        return harness.repository.appendEvents(events);
      },
      appendDiscard(event, contextHash) {
        return harness.repository.appendDiscard(event, contextHash);
      },
      readSnapshot() {
        if (delayNextRead) {
          delayNextRead = false;
          return initialRead.promise;
        }
        return harness.repository.readSnapshot();
      },
      close() {
        harness.repository.close();
      },
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={delayedRepository} runtime={harness.runtime} />,
    );

    try {
      expect(screen.getByRole("status")).toHaveTextContent(
        "正在加载本地记录…",
      );
      const navigation = screen.getByRole("navigation", {
        name: "主要导航",
      });
      const review = within(navigation).getByRole("button", { name: "复习" });
      expect(review).toBeDisabled();

      await user.click(review);
      expect(screen.getByRole("status")).toHaveTextContent(
        "正在加载本地记录…",
      );

      await act(async () => {
        initialRead.resolve(initialSnapshot);
        await initialRead.promise;
      });

      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      expect(review).toBeEnabled();
      await user.click(review);
      expect(await screen.findByText("1 / 1")).toBeInTheDocument();
      expect(screen.getByText("loaded item")).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("persists the complete capture, recent, review, search, undo, and data flow", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      expect(await screen.findByRole("heading", { name: "Tenjin" })).toBeInTheDocument();
      expect(screen.getByText("今天遇到了什么？")).toBeInTheDocument();
      expect(screen.getByText("还没有记录")).toBeInTheDocument();
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      expect(
        within(navigation)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["记录", "复习", "搜索", "数据"]);

      await user.click(screen.getByRole("radio", { name: "表达纠正" }));
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "話すです",
      );
      await user.type(
        screen.getByRole("textbox", { name: "纠正后的表达" }),
        "話します",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));

      const recent = await screen.findByRole("region", { name: "最近记录" });
      expect(await within(recent).findByText("話します")).toBeInTheDocument();
      expect(within(recent).getByText("話すです")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();

      let snapshot = await harness.repository.readSnapshot();
      expect(snapshot.contexts).toEqual([
        expect.objectContaining({ original: "話すです", corrected: "話します" }),
      ]);
      expect(snapshot.events.map((event) => event.kind)).toEqual([
        "capture_created",
        "item_created",
        "production_correction_observed",
      ]);
      expect(JSON.stringify(snapshot.events)).not.toContain("話すです");
      expect(JSON.stringify(snapshot.events)).toContain("話します");

      await user.click(screen.getByRole("button", { name: "复习 5 条" }));
      expect(await screen.findByText("1 / 1")).toBeInTheDocument();
      expect(screen.getByText("P 通道")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "揭示" }));
      await user.click(screen.getByRole("button", { name: "不记得" }));
      expect(await screen.findByText("本次复习完成")).toBeInTheDocument();

      snapshot = await harness.repository.readSnapshot();
      expect(snapshot.events.at(-1)).toMatchObject({
        kind: "verification_observed",
        itemId: snapshot.events[1]?.itemId,
        payload: {
          channel: "P",
          result: "fail",
          probeSource: "review",
          immediateRetest: false,
        },
      });

      await user.click(within(navigation).getByRole("button", { name: "复习" }));
      expect(await screen.findByText("1 / 1")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "揭示" }));
      expect(screen.getByText("最近一次没有想起来")).toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      await user.click(within(navigation).getByRole("button", { name: "搜索" }));
      const search = screen.getByRole("searchbox", { name: "搜索学习记录" });
      await user.type(search, " 話します ");
      expect(screen.getByRole("heading", { name: "話します" })).toBeInTheDocument();
      expect(screen.getByText("P unstable")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
      expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
      expect(await screen.findByText("没有找到相关记录")).toBeInTheDocument();

      snapshot = await harness.repository.readSnapshot();
      expect(snapshot.contexts).toEqual([]);
      expect(snapshot.events.map((event) => event.kind)).toEqual([
        "capture_created",
        "item_created",
        "production_correction_observed",
        "verification_observed",
        "capture_discarded",
      ]);

      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByText("本地事件 5")).toBeInTheDocument();
      expect(screen.getByText("本地上下文 0")).toBeInTheDocument();
      expect(screen.getByText("仅保存在此设备")).toBeInTheDocument();
      expect(screen.queryByText(/due|欠账|连续学习|排行榜|KPI/i)).not.toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      expect(screen.getByText("还没有记录")).toBeInTheDocument();

      view.unmount();
      await expect(harness.repository.readSnapshot()).resolves.toMatchObject({
        events: expect.any(Array),
      });
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("shows at most the three newest non-discarded captures", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      for (const [index, text] of ["first", "second", "third", "fourth"].entries()) {
        harness.setNow(`2026-07-11T0${index + 1}:00:00.000Z`);
        await saveLookup(user, text);
      }

      const recent = screen.getByRole("region", { name: "最近记录" });
      const entries = within(recent).getAllByRole("listitem");
      expect(entries.map((entry) => entry.textContent)).toEqual([
        expect.stringContaining("fourth"),
        expect.stringContaining("third"),
        expect.stringContaining("second"),
      ]);
      expect(within(recent).queryByText("first")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps undo available for eight seconds from the latest save and cleans up on unmount", async () => {
    const harness = await createHarness();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await saveLookupWithFakeTimers(harness.repository, "first");
      await act(async () => vi.advanceTimersByTime(4_000));
      await saveLookupWithFakeTimers(harness.repository, "second");

      await act(async () => vi.advanceTimersByTime(7_999));
      expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();

      await saveLookupWithFakeTimers(harness.repository, "third");
      expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      view.unmount();
      vi.useRealTimers();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });
});
