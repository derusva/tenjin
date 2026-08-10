import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { COACH_SETUP_PROMPT } from "./coachPrompt.js";
import { CoachHelpView } from "./CoachHelpView.js";

describe("CoachHelpView", () => {
  it("shows only the four practical steps and the frozen setup prompt", () => {
    render(<CoachHelpView />);

    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/把截图或日文发给固定 Coach/)).toBeInTheDocument();
    expect(screen.getByText(/单独说「整理」/)).toBeInTheDocument();
    expect(screen.getByText(/复制代码/)).toBeInTheDocument();
    expect(screen.getByText(/回 Tenjin/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Coach 设置" })).toHaveValue(
      COACH_SETUP_PROMPT,
    );
  });

  it("copies the exact frozen prompt", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    render(<CoachHelpView writeClipboardText={writeClipboardText} />);

    await user.click(screen.getByRole("button", { name: "复制 Coach 设置" }));

    expect(writeClipboardText).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).toHaveBeenCalledWith(COACH_SETUP_PROMPT);
    expect(screen.getByRole("status")).toHaveTextContent("已复制 Coach 设置");
  });

  it("selects the prompt for native copying when clipboard writing is denied", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(<CoachHelpView writeClipboardText={writeClipboardText} />);

    await user.click(screen.getByRole("button", { name: "复制 Coach 设置" }));

    const prompt = screen.getByRole("textbox", { name: "Coach 设置" });
    expect(screen.getByRole("alert")).toHaveTextContent("长按并选择“复制”");
    expect(prompt).toHaveFocus();
    expect(prompt).toHaveProperty("selectionStart", 0);
    expect(prompt).toHaveProperty("selectionEnd", COACH_SETUP_PROMPT.length);
  });

  it("exposes optional navigation callbacks without owning app routing", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onStartImport = vi.fn();
    render(
      <CoachHelpView onBack={onBack} onStartImport={onStartImport} />,
    );

    await user.click(screen.getByRole("button", { name: "返回" }));
    await user.click(screen.getByRole("button", { name: "从 Coach 导入" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onStartImport).toHaveBeenCalledTimes(1);
  });
});
