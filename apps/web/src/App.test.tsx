import "fake-indexeddb/auto";

import { Blob as NodeBlob } from "node:buffer";
import {
  openLedgerRepository,
  type ContextImageRecord,
  type LedgerRepository,
  type LedgerSnapshot,
} from "@tenjin/storage-indexeddb";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App as TenjinApp, type AppProps } from "./App.js";
import { IMAGE_ONLY_CAPTURE_ORIGINAL } from "./features/capture/createCapture.js";
import {
  createLedgerRuntime,
  type LedgerRuntime,
} from "./features/ledger/ledgerRuntime.js";

let databaseSequence = 0;
const WRITABLE_GATE = { assertWritable: () => undefined };

type TestAppProps = Omit<AppProps, "writeGate"> & {
  readonly writeGate?: AppProps["writeGate"];
};

function App({ writeGate = WRITABLE_GATE, ...props }: TestAppProps) {
  return <TenjinApp {...props} writeGate={writeGate} />;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function hexadecimalDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
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
    digest: hexadecimalDigest,
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
  it("opens the permanent Coach guide and returns to the record screen", async () => {
    const harness = await createHarness();
    const writeClipboardText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        coachImportDependencies={{ writeClipboardText }}
      />,
    );

    try {
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "怎么用 Coach" }));
      expect(
        screen.getByRole("heading", { name: "怎么用 Coach" }),
      ).toBeInTheDocument();
      expect(screen.getByText("看完逐句翻译后，单独说「整理」")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "复制 Coach 设置" }));
      expect(writeClipboardText).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "返回" }));
      expect(
        screen.getByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("imports a Coach batch atomically and undoes the complete batch", async () => {
    const harness = await createHarness();
    const digest = `sha256:${"ab".repeat(32)}` as const;
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        coachImportDependencies={{
          digestTransfer: vi.fn(async () => digest),
        }}
      />,
    );

    try {
      expect(
        await screen.findByRole("heading", { name: "Tenjin" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "从 Coach 导入" }));

      const json = JSON.stringify({
        schema: "tenjin.coach-transfer/v1",
        items: [
          {
            type: "lookup",
            focus: "手を打つ",
            sourceExcerpt: "大丈夫、手は打ったから。",
            answer: "逐句翻译后，这里表示已经采取了措施。",
          },
          {
            type: "lookup",
            focus: "パッとしない",
            sourceExcerpt: "パッとしない生徒がいましてねぇ。",
            answer: "逐句翻译后，这里表示不起眼、平平无奇。",
          },
        ],
      });
      fireEvent.change(
        screen.getByRole("textbox", {
          name: /Coach JSON；自动读取失败时/,
        }),
        { target: { value: json } },
      );
      await user.click(screen.getByRole("button", { name: "预览输入内容" }));
      expect(
        await screen.findByRole("heading", { name: "2. 核对条目" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "确认导入 2 条" }));
      expect(await screen.findAllByText("已导入 2 条")).toHaveLength(2);

      const importedSnapshot = await harness.repository.readSnapshot();
      expect(
        importedSnapshot.events.filter(
          (event) => event.kind === "capture_created",
        ),
      ).toHaveLength(2);
      expect(importedSnapshot.contexts.map((context) => context.focus)).toEqual([
        "手を打つ",
        "パッとしない",
      ]);

      await user.click(screen.getByRole("button", { name: "撤销" }));
      await waitFor(async () => {
        const snapshot = await harness.repository.readSnapshot();
        expect(snapshot.contexts).toHaveLength(0);
        expect(
          snapshot.events.filter(
            (event) => event.kind === "capture_discarded",
          ),
        ).toHaveLength(2);
      });

      await waitFor(() => {
        expect(screen.queryByText("已导入 2 条")).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "现在复习" }),
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "确认导入 2 条" }),
        ).toBeEnabled();
      });

      await user.click(
        screen.getByRole("button", { name: "确认导入 2 条" }),
      );
      expect(await screen.findAllByText("已导入 2 条")).toHaveLength(2);

      const reimportedSnapshot = await harness.repository.readSnapshot();
      expect(
        reimportedSnapshot.events.filter(
          (event) => event.kind === "capture_created",
        ),
      ).toHaveLength(4);
      expect(reimportedSnapshot.contexts).toHaveLength(2);
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps a Coach preview across navigation and resets the next view to the top", async () => {
    const harness = await createHarness();
    const digest = `sha256:${"bd".repeat(32)}` as const;
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        coachImportDependencies={{
          digestTransfer: vi.fn(async () => digest),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      await user.click(screen.getByRole("button", { name: "从 Coach 导入" }));
      fireEvent.change(
        screen.getByRole("textbox", {
          name: /Coach JSON；自动读取失败时/,
        }),
        {
          target: {
            value: JSON.stringify({
              schema: "tenjin.coach-transfer/v1",
              items: [
                {
                  type: "lookup",
                  focus: "手を打つ",
                  sourceExcerpt: "大丈夫、手は打ったから。",
                  answer: "采取措施。",
                },
              ],
            }),
          },
        },
      );
      await user.click(screen.getByRole("button", { name: "预览输入内容" }));
      const answer = await screen.findByRole("textbox", {
        name: "第 1 条解释",
      });
      await user.clear(answer);
      await user.type(answer, "已经采取措施。");

      document.documentElement.scrollTop = 455;
      document.body.scrollTop = 455;
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      await waitFor(() => {
        expect(document.documentElement.scrollTop).toBe(0);
        expect(document.body.scrollTop).toBe(0);
        expect(screen.getByRole("main")).toHaveFocus();
      });

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      await user.click(screen.getByRole("button", { name: "从 Coach 导入" }));
      expect(
        screen.getByRole("heading", { name: "2. 核对条目" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "第 1 条解释" }),
      ).toHaveValue("已经采取措施。");
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("reviews a newly imported Coach batch before the backlog and clears undo", async () => {
    const harness = await createHarness();
    const digest = `sha256:${"bc".repeat(32)}` as const;
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        coachImportDependencies={{
          digestTransfer: vi.fn(async () => digest),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "古い復習待ちの文",
      );
      await user.type(
        screen.getByRole("textbox", { name: "查到的意思 / 解释（可选）" }),
        "旧条目的解释",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "遇到的词或表达" }),
        ).toHaveValue(""),
      );

      await user.click(screen.getByRole("button", { name: "从 Coach 导入" }));
      const json = JSON.stringify({
        schema: "tenjin.coach-transfer/v1",
        items: [
          {
            type: "lookup",
            focus: "手を打つ",
            sourceExcerpt: "新しい対象は、手を打つです。",
            answer: "这里的学习点是采取措施。",
          },
        ],
      });
      fireEvent.change(
        screen.getByRole("textbox", {
          name: /Coach JSON；自动读取失败时/,
        }),
        { target: { value: json } },
      );
      await user.click(screen.getByRole("button", { name: "预览输入内容" }));
      await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));
      expect(await screen.findAllByText("已导入 1 条")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "现在复习" }));

      expect(
        screen.getByRole("heading", {
          name: "新しい対象は、手を打つです。",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("学习点：手を打つ")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "撤销" }),
      ).not.toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

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
      await user.click(screen.getByRole("button", { name: "复习 2 分钟" }));
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

  it("keeps an unfinished lookup focus draft across local navigation", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App repository={harness.repository} runtime={harness.runtime} />,
    );

    try {
      await screen.findByText("还没有记录");
      await user.type(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
        "大丈夫、手は打ったから。",
      );
      await user.type(
        screen.getByRole("textbox", { name: "要复习的片段（可选）" }),
        "手を打つ",
      );
      const navigation = screen.getByRole("navigation", { name: "主要导航" });

      await user.click(
        within(navigation).getByRole("button", { name: "搜索" }),
      );
      await screen.findByRole("heading", { name: "搜索" });
      await user.click(
        within(navigation).getByRole("button", { name: "记录" }),
      );

      expect(
        screen.getByRole("textbox", { name: "遇到的词或表达" }),
      ).toHaveValue("大丈夫、手は打ったから。");
      expect(
        screen.getByRole("textbox", { name: "要复习的片段（可选）" }),
      ).toHaveValue("手を打つ");
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

  it("exports a full backup and forwards a selected .tenjin file only from the data view", async () => {
    const harness = await createHarness();
    const onExportBackup = vi.fn(async () => undefined);
    const onRestoreBackup = vi.fn<(file: File) => Promise<void>>(async () =>
      undefined,
    );
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        backupRestoreActions={{
          restoreSupported: true,
          restoreEligible: true,
          onExportBackup,
          onRestoreBackup,
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      expect(screen.queryByRole("heading", { name: "备份与恢复" })).not.toBeInTheDocument();

      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByRole("heading", { name: "备份与恢复" })).toBeInTheDocument();
      expect(
        screen.getByText(/全部原文、图片原始字节和 Coach 导入台账/),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "导出完整备份" }));
      expect(onExportBackup).toHaveBeenCalledOnce();
      expect(await screen.findByRole("status")).toHaveTextContent("完整备份已下载");

      const backup = new File([new Uint8Array([1, 2, 3])], "ledger.tenjin", {
        type: "application/octet-stream",
      });
      await user.upload(
        screen.getByLabelText("选择 Tenjin 备份文件"),
        backup,
      );
      await waitFor(() => expect(onRestoreBackup).toHaveBeenCalledWith(backup));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "恢复完成，正在重新打开…",
      );
      expect(screen.getByLabelText("选择 Tenjin 备份文件")).toBeDisabled();
      expect(
        within(navigation).getByRole("button", { name: "记录" }),
      ).toBeDisabled();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("recovers the data view controls when backup restore is rejected", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        backupRestoreActions={{
          restoreSupported: true,
          restoreEligible: true,
          onExportBackup: vi.fn(async () => undefined),
          onRestoreBackup: vi.fn(async () => {
            throw new Error("备份损坏");
          }),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      const input = screen.getByLabelText("选择 Tenjin 备份文件");
      await user.upload(input, new File(["bad"], "broken.tenjin"));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "恢复失败：备份损坏",
      );
      expect(input).toBeEnabled();
      expect(
        within(navigation).getByRole("button", { name: "记录" }),
      ).toBeEnabled();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps export available but disables restore when browser recovery locking is unavailable", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        backupRestoreActions={{
          restoreSupported: false,
          restoreEligible: true,
          onExportBackup: vi.fn(async () => undefined),
          onRestoreBackup: vi.fn(async () => undefined),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByRole("button", { name: "导出完整备份" })).toBeEnabled();
      expect(screen.getByLabelText("选择 Tenjin 备份文件")).toBeDisabled();
      expect(screen.getByText(/此浏览器缺少恢复所需的多标签写锁/)).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("keeps restore disabled when the ledger is non-empty", async () => {
    const harness = await createHarness();
    const transaction = await harness.runtime.createCapture({
      type: "lookup",
      original: "已有记录",
      answer: "existing",
    });
    await harness.repository.appendCapture(
      transaction.events,
      transaction.context,
    );
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        backupRestoreActions={{
          restoreSupported: true,
          restoreEligible: true,
          onExportBackup: vi.fn(async () => undefined),
          onRestoreBackup: vi.fn(async () => undefined),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByLabelText("选择 Tenjin 备份文件")).toBeDisabled();
      expect(screen.getByText(/当前本地账本并非完全空白/)).toBeInTheDocument();
    } finally {
      view.unmount();
      harness.repository.close();
      await deleteDatabase(harness.databaseName);
    }
  });

  it("uses the authoritative four-store eligibility when the folded snapshot is empty", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        backupRestoreActions={{
          restoreSupported: true,
          restoreEligible: false,
          onExportBackup: vi.fn(async () => undefined),
          onRestoreBackup: vi.fn(async () => undefined),
        }}
      />,
    );

    try {
      await screen.findByRole("heading", { name: "Tenjin" });
      const navigation = screen.getByRole("navigation", { name: "主要导航" });
      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByText("本地事件 0")).toBeInTheDocument();
      expect(screen.getByText("本地上下文 0")).toBeInTheDocument();
      expect(screen.getByLabelText("选择 Tenjin 备份文件")).toBeDisabled();
      expect(
        screen.getByText(/当前本地账本并非完全空白/),
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
      expect(
        await screen.findByRole("heading", { name: "loaded item" }),
      ).toBeInTheDocument();
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

      await user.click(screen.getByRole("button", { name: "复习 2 分钟" }));
      expect(
        await screen.findByRole("heading", { name: "話すです" }),
      ).toBeInTheDocument();
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
      expect(
        await screen.findByRole("heading", { name: "話すです" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "揭示" }));
      expect(screen.getByText("最近一次没有想起来")).toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      await user.click(within(navigation).getByRole("button", { name: "搜索" }));
      const search = screen.getByRole("searchbox", { name: "搜索学习记录" });
      await user.type(search, " 話します ");
      expect(screen.getByRole("heading", { name: "話します" })).toBeInTheDocument();
      expect(screen.getByText("P unstable")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "撤销" }),
      ).not.toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      await saveLookup(user, "只用于撤销的临时记录");
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "只用于撤销的临时记录" }),
        ).not.toBeInTheDocument(),
      );

      snapshot = await harness.repository.readSnapshot();
      expect(snapshot.contexts).toEqual([
        expect.objectContaining({ original: "話すです", corrected: "話します" }),
      ]);
      expect(snapshot.events.map((event) => event.kind)).toEqual([
        "capture_created",
        "item_created",
        "production_correction_observed",
        "verification_observed",
        "capture_created",
        "capture_discarded",
      ]);

      await user.click(within(navigation).getByRole("button", { name: "数据" }));
      expect(screen.getByText("本地事件 6")).toBeInTheDocument();
      expect(screen.getByText("本地上下文 1")).toBeInTheDocument();
      expect(screen.getByText("仅保存在此设备")).toBeInTheDocument();
      expect(screen.queryByText(/due|欠账|连续学习|排行榜|KPI/i)).not.toBeInTheDocument();

      await user.click(within(navigation).getByRole("button", { name: "记录" }));
      expect(screen.getByRole("heading", { name: "話します" })).toBeInTheDocument();

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

  it("persists a pure image, shows it in R review, and restores its recent thumbnail after remount", async () => {
    const harness = await createHarness();
    const user = userEvent.setup();
    const image = {
      // Vitest's Node Blob has the runtime methods this IndexedDB integration
      // test needs; the product contract intentionally remains the DOM Blob.
      blob: new NodeBlob(["png"], { type: "image/png" }) as unknown as Blob,
      mediaType: "image/png",
      name: "lesson.png",
      byteLength: 3,
      sha256:
        "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
    } as const satisfies ContextImageRecord;
    const prepareImage = vi.fn(async () => image);
    let view = render(
      <App
        repository={harness.repository}
        runtime={harness.runtime}
        prepareImage={prepareImage}
      />,
    );

    try {
      await screen.findByText("还没有记录");
      await user.upload(
        screen.getByLabelText("选择图片"),
        new File(["png"], "lesson.png", { type: "image/png" }),
      );
      await screen.findByRole("img", {
        name: "所选图片预览：lesson.png",
      });
      await user.type(
        screen.getByRole("textbox", {
          name: "查到的意思 / 解释（可选）",
        }),
        "课程截图的解释",
      );
      await user.click(screen.getByRole("button", { name: "记下来" }));

      const recent = await screen.findByRole("region", { name: "最近记录" });
      expect(
        await within(recent).findByRole("img", {
          name: "最近记录图片：lesson.png",
        }),
      ).toBeInTheDocument();
      expect(
        within(recent).getByRole("heading", { name: "lesson.png" }),
      ).toBeInTheDocument();

      const storedContext = (await harness.repository.readSnapshot()).contexts[0];
      expect(storedContext).toMatchObject({
        original: IMAGE_ONLY_CAPTURE_ORIGINAL,
        answer: "课程截图的解释",
        image: {
          mediaType: "image/png",
          name: "lesson.png",
          byteLength: 3,
          sha256: image.sha256,
        },
      });
      expect(Object.prototype.toString.call(storedContext?.image?.blob)).toBe(
        "[object Blob]",
      );

      await user.click(screen.getByRole("button", { name: "复习 2 分钟" }));
      expect(
        await screen.findByRole("img", {
          name: "复习图片：lesson.png",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("课程截图的解释")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "揭示" }));
      expect(screen.getByText("课程截图的解释")).toBeInTheDocument();

      view.unmount();
      view = render(
        <App
          repository={harness.repository}
          runtime={harness.runtime}
          prepareImage={prepareImage}
        />,
      );

      const restoredRecent = await screen.findByRole("region", {
        name: "最近记录",
      });
      expect(
        await within(restoredRecent).findByRole("img", {
          name: "最近记录图片：lesson.png",
        }),
      ).toBeInTheDocument();
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
