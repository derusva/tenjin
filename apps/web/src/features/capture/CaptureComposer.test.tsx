import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CaptureComposer } from "./CaptureComposer.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

describe("CaptureComposer", () => {
  it("does not read the clock while rendering", () => {
    const now = vi.spyOn(Date, "now");

    renderToString(<CaptureComposer onSave={async () => undefined} />);

    expect(now).not.toHaveBeenCalled();
  });

  it("renders an accessible lookup composer and never submits an empty original", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);

    render(<CaptureComposer onSave={onSave} />);

    const categoryGroup = screen.getByRole("group", { name: "记录类型" });
    const lookup = screen.getByRole("radio", { name: "查过" });
    const listeningMiss = screen.getByRole("radio", { name: "没听出" });
    const correction = screen.getByRole("radio", { name: "表达纠正" });
    const original = screen.getByRole("textbox", {
      name: "遇到的词或表达",
    });
    const submit = screen.getByRole("button", { name: "记下来" });

    expect(categoryGroup).toContainElement(lookup);
    expect(categoryGroup).toContainElement(listeningMiss);
    expect(categoryGroup).toContainElement(correction);
    expect(lookup).toBeChecked();
    expect(listeningMiss).not.toBeChecked();
    expect(correction).not.toBeChecked();
    expect(original.tagName).toBe("TEXTAREA");
    expect(submit).toBeDisabled();

    await user.type(original, "   ");
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pastes clipboard text into the primary capture field without any setup flow", async () => {
    const user = userEvent.setup();
    const readClipboardText = vi.fn(async () => "知らない表現");

    render(
      <CaptureComposer
        onSave={async () => undefined}
        readClipboardText={readClipboardText}
      />,
    );

    expect(
      screen.getByPlaceholderText("词语、句子、听到的近似音都可以"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "粘贴" }));

    expect(readClipboardText).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("textbox", { name: "遇到的词或表达" }),
    ).toHaveValue("知らない表現");
    expect(screen.getByRole("status")).toHaveTextContent(
      "已粘贴，选择类型后记下来",
    );
  });

  it("keeps the native long-press paste path available when clipboard reading fails", async () => {
    const user = userEvent.setup();
    const readClipboardText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    render(
      <CaptureComposer
        onSave={async () => undefined}
        readClipboardText={readClipboardText}
      />,
    );

    await user.click(screen.getByRole("button", { name: "粘贴" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "请在输入框内长按并选择“粘贴”",
    );
    expect(
      screen.getByRole("textbox", { name: "遇到的词或表达" }),
    ).toHaveFocus();
  });

  it("locks editing and save while a clipboard read is pending", async () => {
    let resolveClipboard!: (value: string) => void;
    const clipboard = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    const readClipboardText = vi.fn(() => clipboard);
    const onSave = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(
      <CaptureComposer
        onSave={onSave}
        readClipboardText={readClipboardText}
      />,
    );

    const original = screen.getByRole("textbox", {
      name: "遇到的词或表达",
    });
    await user.type(original, "已有草稿");
    await user.click(screen.getByRole("button", { name: "粘贴" }));

    expect(original).toBeDisabled();
    expect(screen.getByRole("button", { name: "读取中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "记下来" })).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      resolveClipboard("剪贴板内容");
      await clipboard;
    });

    expect(original).toBeEnabled();
    expect(original).toHaveValue("已有草稿剪贴板内容");
  });

  it("shows the correction textarea only for the correction category", async () => {
    const user = userEvent.setup();

    render(<CaptureComposer onSave={async () => undefined} />);

    expect(
      screen.queryByRole("textbox", { name: "纠正后的表达" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "表达纠正" }));

    const corrected = screen.getByRole("textbox", {
      name: "纠正后的表达",
    });
    expect(corrected.tagName).toBe("TEXTAREA");

    await user.click(screen.getByRole("radio", { name: "没听出" }));
    expect(
      screen.queryByRole("textbox", { name: "纠正后的表达" }),
    ).not.toBeInTheDocument();
  });

  it("submits a trimmed lookup command timed from mount", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);

    render(<CaptureComposer onSave={onSave} />);
    await user.type(
      screen.getByRole("textbox", { name: "遇到的词或表达" }),
      "  ＴｅｎＪｉｎ  ",
    );
    now = 12_750;

    await user.click(screen.getByRole("button", { name: "记下来" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      type: "lookup",
      original: "ＴｅｎＪｉｎ",
      captureDurationMs: 2_750,
    });
  });

  it("submits trimmed correction text and omits an explicitly blank correction", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);

    render(<CaptureComposer onSave={onSave} />);
    await user.click(screen.getByRole("radio", { name: "表达纠正" }));
    await user.type(
      screen.getByRole("textbox", { name: "遇到的词或表达" }),
      "  話すです  ",
    );
    await user.type(
      screen.getByRole("textbox", { name: "纠正后的表达" }),
      "   ",
    );
    now = 3_500;

    await user.click(screen.getByRole("button", { name: "记下来" }));

    expect(onSave).toHaveBeenCalledWith({
      type: "production_correction",
      original: "話すです",
      captureDurationMs: 1_500,
    });
  });

  it("disables every input and reports saving while onSave is pending", async () => {
    const deferred = createDeferred();
    const user = userEvent.setup();

    render(<CaptureComposer onSave={() => deferred.promise} />);
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

    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    for (const textbox of screen.getAllByRole("textbox")) {
      expect(textbox).toBeDisabled();
    }

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
  });

  it("clears both inputs, announces success, and restarts timing after a successful save", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);

    render(<CaptureComposer onSave={onSave} />);
    await user.click(screen.getByRole("radio", { name: "表达纠正" }));
    const original = screen.getByRole("textbox", {
      name: "遇到的词或表达",
    });
    const corrected = screen.getByRole("textbox", {
      name: "纠正后的表达",
    });
    await user.type(original, "  話すです  ");
    await user.type(corrected, "  話します  ");
    now = 4_000;

    await user.click(screen.getByRole("button", { name: "记下来" }));

    const success = await screen.findByRole("status");
    expect(success).toHaveTextContent("已记下");
    expect(success).toHaveAttribute("aria-live", "polite");
    expect(original).toHaveValue("");
    expect(corrected).toHaveValue("");
    expect(screen.getByRole("button", { name: "记下来" })).toBeDisabled();
    expect(onSave).toHaveBeenNthCalledWith(1, {
      type: "production_correction",
      original: "話すです",
      corrected: "話します",
      captureDurationMs: 3_000,
    });

    await user.type(original, "次の表現");
    now = 5_500;
    await user.click(screen.getByRole("button", { name: "记下来" }));

    expect(onSave).toHaveBeenNthCalledWith(2, {
      type: "production_correction",
      original: "次の表現",
      captureDurationMs: 1_500,
    });
  });

  it("keeps both inputs and announces an alert when saving fails", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error("storage unavailable");
    });

    render(<CaptureComposer onSave={onSave} />);
    await user.click(screen.getByRole("radio", { name: "表达纠正" }));
    const original = screen.getByRole("textbox", {
      name: "遇到的词或表达",
    });
    const corrected = screen.getByRole("textbox", {
      name: "纠正后的表达",
    });
    await user.type(original, "話すです");
    await user.type(corrected, "話します");

    await user.click(screen.getByRole("button", { name: "记下来" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("保存失败，请再试一次");
    expect(failure).toHaveAttribute("aria-live", "assertive");
    expect(original).toHaveValue("話すです");
    expect(corrected).toHaveValue("話します");
    expect(screen.queryByText("已记下")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "记下来" })).toBeEnabled();
  });
});
