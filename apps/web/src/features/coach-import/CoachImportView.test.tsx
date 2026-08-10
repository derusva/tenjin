import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ContextImageRecord } from "@tenjin/storage-indexeddb";

import { COACH_TRANSFER_REPAIR_PROMPT } from "./coachPrompt.js";
import {
  CoachImportView,
  type CoachImportConfirmationResult,
} from "./CoachImportView.js";

const DIGEST = `sha256:${"ab".repeat(32)}` as const;
const FIRST_ITEM = {
  type: "lookup",
  focus: "手を打つ",
  sourceExcerpt: "大丈夫、手は打ったから。",
  answer: "采取措施。",
} as const;
const SECOND_ITEM = {
  type: "lookup",
  focus: "パッとしない",
  sourceExcerpt: "パッとしない生徒がいましてねぇ。",
  answer: "不起眼、平平无奇。",
} as const;

function coachJson(items: readonly unknown[] = [FIRST_ITEM]): string {
  return JSON.stringify({
    schema: "tenjin.coach-transfer/v1",
    items,
  });
}

function imported(): Promise<CoachImportConfirmationResult> {
  return Promise.resolve({ status: "imported" });
}

function renderImport(
  overrides: Partial<React.ComponentProps<typeof CoachImportView>> = {},
) {
  const onConfirm = overrides.onConfirm ?? vi.fn(imported);
  const digestTransfer =
    overrides.digestTransfer ?? vi.fn(async () => DIGEST);
  render(
    <CoachImportView
      onConfirm={onConfirm}
      digestTransfer={digestTransfer}
      {...overrides}
    />,
  );
  return { onConfirm, digestTransfer };
}

async function pasteAndPreview(
  user: ReturnType<typeof userEvent.setup>,
  json: string,
  overrides: Partial<React.ComponentProps<typeof CoachImportView>> = {},
) {
  const readClipboardText = vi.fn(async () => json);
  const harness = renderImport({ readClipboardText, ...overrides });
  await user.click(screen.getByRole("button", { name: "粘贴并预览" }));
  await screen.findByRole("heading", { name: "2. 核对条目" });
  return { ...harness, readClipboardText };
}

describe("CoachImportView", () => {
  it("reads raw clipboard JSON, previews it, and confirms through one callback", async () => {
    const user = userEvent.setup();
    const { onConfirm, digestTransfer, readClipboardText } =
      await pasteAndPreview(user, coachJson());

    expect(readClipboardText).toHaveBeenCalledTimes(1);
    expect(digestTransfer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "导入第 1 条" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "第 1 条学习点" })).toHaveValue(
      FIRST_ITEM.focus,
    );

    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      canonicalTransfer: coachJson(),
      digest: DIGEST,
      selectedItems: [FIRST_ITEM],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("已导入 1 条");
  });

  it("offers review, continue, and record actions after a successful import", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onContinue = vi.fn();
    const onBack = vi.fn();
    await pasteAndPreview(user, coachJson(), {
      onReview,
      onContinue,
      onBack,
    });

    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: "现在复习" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "返回记录" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "继续导入" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    const input = screen.getByRole("textbox", {
      name: /Coach JSON；自动读取失败时/,
    });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "2. 核对条目" })).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("focuses the manual textarea when clipboard reading is denied", async () => {
    const user = userEvent.setup();
    const readClipboardText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const { onConfirm } = renderImport({ readClipboardText });

    await user.click(screen.getByRole("button", { name: "粘贴并预览" }));

    const input = screen.getByRole("textbox", {
      name: /Coach JSON；自动读取失败时/,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "长按并选择“粘贴”",
    );
    await waitFor(() => expect(input).toHaveFocus());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("parses manually pasted text without rereading the clipboard", async () => {
    const user = userEvent.setup();
    const readClipboardText = vi.fn(async () => "should not be read");
    renderImport({ readClipboardText });
    const input = screen.getByRole("textbox", {
      name: /Coach JSON；自动读取失败时/,
    });
    fireEvent.change(input, { target: { value: coachJson() } });

    await user.click(screen.getByRole("button", { name: "预览输入内容" }));

    expect(
      await screen.findByRole("heading", { name: "2. 核对条目" }),
    ).toBeInTheDocument();
    expect(readClipboardText).not.toHaveBeenCalled();
  });

  it("shows and copies the parser repair prompt without attempting a write", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    const { onConfirm } = renderImport({ writeClipboardText });
    fireEvent.change(
      screen.getByRole("textbox", {
        name: /Coach JSON；自动读取失败时/,
      }),
      { target: { value: "not json" } },
    );

    await user.click(screen.getByRole("button", { name: "预览输入内容" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "INVALID_ENVELOPE",
    );
    expect(
      screen.getByRole("textbox", { name: "给 Coach 的修复提示" }),
    ).toHaveValue(COACH_TRANSFER_REPAIR_PROMPT);
    await user.click(screen.getByRole("button", { name: "复制修复提示" }));
    expect(writeClipboardText).toHaveBeenCalledWith(
      COACH_TRANSFER_REPAIR_PROMPT,
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("treats a zero-item batch as valid and never offers a write", async () => {
    const user = userEvent.setup();
    const readClipboardText = vi.fn(async () => coachJson([]));
    const { onConfirm } = renderImport({ readClipboardText });

    await user.click(screen.getByRole("button", { name: "粘贴并预览" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "这一批没有值得导入的条目",
    );
    expect(screen.queryByRole("button", { name: /确认导入/ })).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("edits the retained item and drops a deselected item", async () => {
    const user = userEvent.setup();
    const { onConfirm } = await pasteAndPreview(
      user,
      coachJson([FIRST_ITEM, SECOND_ITEM]),
    );

    await user.clear(screen.getByRole("textbox", { name: "第 1 条学习点" }));
    await user.type(
      screen.getByRole("textbox", { name: "第 1 条学习点" }),
      " 手を打つ ",
    );
    await user.clear(screen.getByRole("textbox", { name: "第 1 条来源句" }));
    await user.type(
      screen.getByRole("textbox", { name: "第 1 条来源句" }),
      " 手はもう打った。 ",
    );
    await user.clear(screen.getByRole("textbox", { name: "第 1 条解释" }));
    await user.type(
      screen.getByRole("textbox", { name: "第 1 条解释" }),
      " 已采取措施。 ",
    );
    await user.click(screen.getByRole("checkbox", { name: "导入第 2 条" }));
    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const confirmation = vi.mocked(onConfirm).mock.calls[0]![0];
    expect(confirmation.canonicalTransfer).toBe(
      coachJson([FIRST_ITEM, SECOND_ITEM]),
    );
    expect(confirmation.selectedItems).toEqual([
      {
        type: "lookup",
        focus: "手を打つ",
        sourceExcerpt: "手はもう打った。",
        answer: "已采取措施。",
      },
    ]);
  });

  it("disables confirmation when every proposal is deselected or required text is blank", async () => {
    const user = userEvent.setup();
    const { onConfirm } = await pasteAndPreview(user, coachJson());
    const checkbox = screen.getByRole("checkbox", { name: "导入第 1 条" });

    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "确认导入 0 条" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("至少保留一条");
    await user.click(checkbox);
    await user.clear(screen.getByRole("textbox", { name: "第 1 条解释" }));
    expect(screen.getByRole("button", { name: "确认导入 1 条" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("请补全");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the edited preview intact when the single confirmation callback fails", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    await pasteAndPreview(user, coachJson(), { onConfirm });
    const answer = screen.getByRole("textbox", { name: "第 1 条解释" });
    await user.clear(answer);
    await user.type(answer, "编辑后解释");

    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "storage unavailable",
    );
    expect(answer).toHaveValue("编辑后解释");
    expect(screen.getByRole("button", { name: "确认导入 1 条" })).toBeEnabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps an optional image unattached by default and can assign it to one selected item", async () => {
    const user = userEvent.setup();
    const image: ContextImageRecord = {
      blob: new Blob(["png"], { type: "image/png" }),
      mediaType: "image/png",
      name: "p5r.png",
      byteLength: 3,
      sha256: "cd".repeat(32),
    };
    const prepareImage = vi.fn(async () => image);
    const { onConfirm } = await pasteAndPreview(
      user,
      coachJson([FIRST_ITEM, SECOND_ITEM]),
      { prepareImage },
    );
    const file = new File(["png"], "p5r.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("选择原截图"), file);

    expect(prepareImage).toHaveBeenCalledWith(file);
    expect(
      await screen.findByRole("img", { name: "待导入截图：p5r.png" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "不附到任何条目" }),
    ).toBeChecked();
    const target = screen.getByRole("radio", {
      name: `附到第 2 条：${SECOND_ITEM.focus}`,
    });
    await user.click(target);
    await user.click(screen.getByRole("button", { name: "确认导入 2 条" }));

    const confirmation = vi.mocked(onConfirm).mock.calls[0]![0];
    expect(confirmation.imageTarget).toEqual({
      selectedItemIndex: 1,
      image,
    });
  });

  it("clears an image target when that proposal is deselected", async () => {
    const user = userEvent.setup();
    const image: ContextImageRecord = {
      blob: new Blob(["png"], { type: "image/png" }),
      mediaType: "image/png",
      name: "p5r.png",
      byteLength: 3,
      sha256: "ef".repeat(32),
    };
    const { onConfirm } = await pasteAndPreview(
      user,
      coachJson([FIRST_ITEM, SECOND_ITEM]),
      { prepareImage: async () => image },
    );
    await user.upload(
      screen.getByLabelText("选择原截图"),
      new File(["png"], "p5r.png", { type: "image/png" }),
    );
    await screen.findByRole("img", { name: "待导入截图：p5r.png" });
    await user.click(
      screen.getByRole("radio", {
        name: `附到第 2 条：${SECOND_ITEM.focus}`,
      }),
    );
    await user.click(screen.getByRole("checkbox", { name: "导入第 2 条" }));

    const imageGroup = screen.getByRole("group", { name: "图片附到" });
    expect(
      within(imageGroup).getByRole("radio", { name: "不附到任何条目" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    const confirmation = vi.mocked(onConfirm).mock.calls[0]![0];
    expect(confirmation).not.toHaveProperty("imageTarget");
  });

  it("reports an already-imported result without offering a second write", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async (): Promise<CoachImportConfirmationResult> => ({
      status: "already-imported",
    }));
    await pasteAndPreview(user, coachJson(), { onConfirm });

    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "已经导入过",
    );
    expect(
      screen.queryByRole("button", { name: "现在复习" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入 1 条" })).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("returns an imported preview to a confirmable state after batch undo", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(imported);
    const { rerender } = render(
      <CoachImportView
        onConfirm={onConfirm}
        digestTransfer={async () => DIGEST}
        onReview={() => undefined}
        resetCompletedImportVersion={0}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: /Coach JSON；自动读取失败时/,
      }),
      { target: { value: coachJson() } },
    );
    await user.click(screen.getByRole("button", { name: "预览输入内容" }));
    await user.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    expect(await screen.findByText("已导入 1 条")).toBeInTheDocument();

    rerender(
      <CoachImportView
        onConfirm={onConfirm}
        digestTransfer={async () => DIGEST}
        onReview={() => undefined}
        resetCompletedImportVersion={1}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("已导入 1 条")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "现在复习" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "确认导入 1 条" }),
      ).toBeEnabled();
    });
  });
});
