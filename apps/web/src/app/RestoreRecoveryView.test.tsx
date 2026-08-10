import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RestoreRecoveryView } from "./RestoreRecoveryView.js";

describe("RestoreRecoveryView", () => {
  it("retries a pending empty recovery with the selected package", async () => {
    const onRetry = vi.fn<(file: File) => Promise<void>>(async () => undefined);
    const user = userEvent.setup();
    render(
      <RestoreRecoveryView
        state={{ kind: "pending-empty", pendingDeviceId: "restore-device" }}
        onRetry={onRetry}
        onCancel={vi.fn(async () => undefined)}
        onReload={vi.fn()}
      />,
    );

    const backup = new File([new Uint8Array([1, 2])], "ledger.tenjin");
    await user.upload(
      screen.getByLabelText("重新选择 Tenjin 备份文件"),
      backup,
    );

    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(backup));
  });

  it("keeps retry available and reports a rejected package", async () => {
    const user = userEvent.setup();
    render(
      <RestoreRecoveryView
        state={{ kind: "pending-empty", pendingDeviceId: "restore-device" }}
        onRetry={vi.fn(async () => {
          throw new Error("包已损坏");
        })}
        onCancel={vi.fn(async () => undefined)}
        onReload={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("重新选择 Tenjin 备份文件"),
      new File(["bad"], "broken.tenjin"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("包已损坏");
    expect(screen.getByLabelText("重新选择 Tenjin 备份文件")).toBeEnabled();
  });

  it("renders corrupt state fail-closed without retry or cancellation", async () => {
    const onReload = vi.fn();
    const user = userEvent.setup();
    render(
      <RestoreRecoveryView
        state={{ kind: "corrupt", reason: "restore-data-without-marker" }}
        onRetry={vi.fn(async () => undefined)}
        onCancel={vi.fn(async () => undefined)}
        onReload={onReload}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("没有恢复完成标记");
    expect(screen.queryByLabelText("重新选择 Tenjin 备份文件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消恢复" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});
