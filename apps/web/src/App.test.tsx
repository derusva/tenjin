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
    reserveEventCoordinates: (deviceId, physicalTime, count) =>
      repository.reserveEventCoordinates(deviceId, physicalTime, count),
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
  it("offers a retry when the initial local snapshot read fails", async () => {
    const harness = await createHarness();
    let readAttempt = 0;
    const retryingRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      appendDiscard: (...args) => harness.repository.appendDiscard(...args),
      readSnapshot() {
        readAttempt += 1;
        return readAttempt === 1
          ? Promise.reject(new Error("temporary read failure"))
          : harness.repository.readSnapshot();
      },
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={retryingRepository} runtime={harness.runtime} />,
    );

    try {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "temporary read failure",
      );
      await user.click(screen.getByRole("button", { name: "重试读取" }));
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      expect(readAttempt).toBe(2);
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps the last snapshot after a committed write when refresh fails", async () => {
    const harness = await createHarness();
    let readAttempt = 0;
    const staleRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      appendDiscard: (...args) => harness.repository.appendDiscard(...args),
      readSnapshot() {
        readAttempt += 1;
        return readAttempt === 2
          ? Promise.reject(new Error("refresh failed"))
          : harness.repository.readSnapshot();
      },
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={staleRepository} runtime={harness.runtime} />,
    );

    try {
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "保存后刷新失败",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "当前显示的是上次快照",
      );
      expect(
        screen.getByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      await expect(harness.repository.readSnapshot()).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "capture_created" }),
        ]),
      });

      await user.click(screen.getByRole("button", { name: "重新读取" }));
      expect(
        await screen.findByRole("heading", { name: "保存后刷新失败" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps the undo target available when discard persistence fails", async () => {
    const harness = await createHarness();
    let discardAttempts = 0;
    const flakyRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      appendDiscard(...args) {
        discardAttempts += 1;
        return discardAttempts === 1
          ? Promise.reject(new Error("discard failed"))
          : harness.repository.appendDiscard(...args);
      },
      readSnapshot: () => harness.repository.readSnapshot(),
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={flakyRepository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      await saveLookup(user, "undo retry");
      await user.click(screen.getByRole("button", { name: "撤销" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "撤销失败：discard failed",
      );
      await user.click(screen.getByRole("button", { name: "重试撤销" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "重试撤销" }),
        ).not.toBeInTheDocument(),
      );
      expect(discardAttempts).toBe(2);
      expect(
        (await harness.repository.readSnapshot()).events.at(-1),
      ).toMatchObject({ kind: "capture_discarded" });
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("does not attach an older undo failure to a newer capture", async () => {
    const harness = await createHarness();
    const firstDiscard = createDeferred<void>();
    let discardAttempts = 0;
    const concurrentRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      async appendDiscard(...args) {
        discardAttempts += 1;
        if (discardAttempts === 1) {
          await firstDiscard.promise;
          throw new Error("old discard failed");
        }
        await harness.repository.appendDiscard(...args);
      },
      readSnapshot: () => harness.repository.readSnapshot(),
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={concurrentRepository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      await saveLookup(user, "older capture");
      await user.click(screen.getByRole("button", { name: "撤销" }));
      await saveLookup(user, "newer capture");

      await act(async () => {
        firstDiscard.resolve(undefined);
        await firstDiscard.promise;
      });

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled(),
      );
      expect(
        screen.queryByRole("button", { name: "重试撤销" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "newer capture" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "撤销" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "newer capture" }),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("heading", { name: "older capture" }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("does not clear a newer undo target when an older undo succeeds", async () => {
    const harness = await createHarness();
    const firstDiscard = createDeferred<void>();
    let discardAttempts = 0;
    const concurrentRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      async appendDiscard(...args) {
        discardAttempts += 1;
        if (discardAttempts === 1) {
          await firstDiscard.promise;
        }
        await harness.repository.appendDiscard(...args);
      },
      readSnapshot: () => harness.repository.readSnapshot(),
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={concurrentRepository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      await saveLookup(user, "older capture");
      await user.click(screen.getByRole("button", { name: "撤销" }));
      await saveLookup(user, "newer capture");

      await act(async () => {
        firstDiscard.resolve(undefined);
        await firstDiscard.promise;
      });

      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "older capture" }),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("heading", { name: "newer capture" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("prevents review navigation from restarting an answer while it is saving", async () => {
    const harness = await createHarness();
    const seededCapture = await harness.runtime.createCapture({
      type: "listening_miss",
      original: "pending review item",
    });
    await harness.repository.appendCapture(
      seededCapture.events,
      seededCapture.context,
    );
    const answerWrite = createDeferred<void>();
    let appendEventCalls = 0;
    const delayedRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      appendCapture: (...args) => harness.repository.appendCapture(...args),
      async appendEvents(...args) {
        appendEventCalls += 1;
        await answerWrite.promise;
        await harness.repository.appendEvents(...args);
      },
      appendDiscard: (...args) => harness.repository.appendDiscard(...args),
      readSnapshot: () => harness.repository.readSnapshot(),
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={delayedRepository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByRole("heading", { name: "pending review item" });
      await user.click(screen.getByRole("button", { name: "复习 5 条" }));
      await user.click(screen.getByRole("button", { name: "揭示" }));
      await user.click(screen.getByRole("button", { name: "不记得" }));
      await waitFor(() => expect(appendEventCalls).toBe(1));

      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      const reviewNavigation = within(navigation).getByRole("button", {
        name: "复习",
      });
      expect(reviewNavigation).toBeDisabled();
      fireEvent.click(reviewNavigation);
      expect(
        screen.queryByRole("button", { name: "揭示" }),
      ).not.toBeInTheDocument();

      await act(async () => {
        answerWrite.resolve(undefined);
        await answerWrite.promise;
      });
      expect(
        await screen.findByRole("heading", { name: "本次复习完成" }),
      ).toBeInTheDocument();
      expect(
        (await harness.repository.readSnapshot()).events.filter(
          (event) => event.kind === "verification_observed",
        ),
      ).toHaveLength(1);
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps an unfinished correction draft across local navigation", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      await user.click(screen.getByRole("radio", { name: "表达纠正" }));
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "unfinished original",
      );
      await user.type(
        screen.getByRole("textbox", { name: "纠正后的表达" }),
        "unfinished correction",
      );
      const navigation = screen.getByRole("navigation", { name: "主要导航" });

      await user.click(
        within(navigation).getByRole("button", { name: "搜索" }),
      );
      expect(
        await screen.findByRole("heading", { name: "搜索" }),
      ).toBeInTheDocument();
      await user.click(
        within(navigation).getByRole("button", { name: "记录" }),
      );

      expect(screen.getByRole("radio", { name: "表达纠正" })).toBeChecked();
      expect(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
      ).toHaveValue("unfinished original");
      expect(
        screen.getByRole("textbox", { name: "纠正后的表达" }),
      ).toHaveValue("unfinished correction");
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps a failing capture draft visible by locking navigation while saving", async () => {
    const harness = await createHarness();
    const captureWrite = createDeferred<void>();
    let appendCaptureCalls = 0;
    const delayedRepository: LedgerRepository = {
      reserveEventCoordinates: (...args) =>
        harness.repository.reserveEventCoordinates(...args),
      async appendCapture() {
        appendCaptureCalls += 1;
        await captureWrite.promise;
        throw new Error("capture write failed");
      },
      appendEvents: (...args) => harness.repository.appendEvents(...args),
      appendDiscard: (...args) => harness.repository.appendDiscard(...args),
      readSnapshot: () => harness.repository.readSnapshot(),
      close: () => harness.repository.close(),
    };
    const user = userEvent.setup();
    const view = render(
      <App repository={delayedRepository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      const input = screen.getByRole("textbox", {
        name: "遇到的词或表达",
      });
      await user.type(input, "draft that must survive");
      await user.click(screen.getByRole("button", { name: "记下来" }));
      await waitFor(() => expect(appendCaptureCalls).toBe(1));

      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      const searchNavigation = within(navigation).getByRole("button", {
        name: "搜索",
      });
      expect(searchNavigation).toBeDisabled();
      fireEvent.click(searchNavigation);
      expect(input).toHaveValue("draft that must survive");

      await act(async () => {
        captureWrite.resolve(undefined);
        await captureWrite.promise;
      });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "保存失败，请再试一次",
      );
      expect(input).toHaveValue("draft that must survive");
      expect(searchNavigation).toBeEnabled();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });


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

  it("keeps the bottom navigation unchanged and does not expose developer diagnostics", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();

      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      expect(
        within(navigation)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["记录", "复习", "搜索", "数据"]);
      expect(within(navigation).queryByRole("link")).not.toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByText(/捕获诊断/)).not.toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps review disabled until the initial snapshot is ready", async () => {
    const harness = await createHarness();
    const seededCapture = await harness.runtime.createCapture({
      type: "listening_miss",
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
      reserveEventCoordinates(deviceId, physicalTime, count) {
        return harness.repository.reserveEventCoordinates(
          deviceId,
          physicalTime,
          count,
        );
      },
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
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "撤销" }),
        ).not.toBeInTheDocument(),
      );
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

  it("labels recent lookup, listening, and production captures with their learning channels", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");

      await saveLookup(user, "recognition");

      await user.click(screen.getByRole("radio", { name: "没听出" }));
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "listening",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "遇到的词或表达" }),
        ).toHaveValue(""),
      );

      await user.click(screen.getByRole("radio", { name: "表达纠正" }));
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "production original",
      );
      await user.type(
        screen.getByRole("textbox", { name: "纠正后的表达" }),
        "production corrected",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));

      const recent = await screen.findByRole("region", { name: "最近记录" });
      await within(recent).findByRole("heading", {
        level: 3,
        name: "production corrected",
      });
      const entries = within(recent).getAllByRole("listitem");
      expect(
        within(
          entries.find(
            (entry) =>
              within(entry).queryByRole("heading", {
                level: 3,
                name: "recognition",
              }) !== null,
          )!,
        ).getByLabelText("R 通道"),
      ).toHaveTextContent("R");
      expect(
        within(
          entries.find(
            (entry) =>
              within(entry).queryByRole("heading", {
                level: 3,
                name: "listening",
              }) !== null,
          )!,
        ).getByLabelText("L 通道"),
      ).toHaveTextContent("L");
      expect(
        within(
          entries.find(
            (entry) =>
              within(entry).queryByRole("heading", {
                level: 3,
                name: "production corrected",
              }) !== null,
          )!,
        ).getByLabelText("P 通道"),
      ).toHaveTextContent("P");
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
