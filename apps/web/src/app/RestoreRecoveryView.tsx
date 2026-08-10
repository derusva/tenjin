import { useState } from "react";

import type { RestoreActivationState } from "./restoreActivation.js";

export interface RestoreRecoveryViewProps {
  readonly state: Extract<
    RestoreActivationState,
    { readonly kind: "pending-empty" | "corrupt" }
  >;
  readonly initialError?: string;
  readonly onRetry: (file: File) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onReload: () => void;
}

function corruptReason(
  state: Extract<RestoreActivationState, { readonly kind: "corrupt" }>,
): string {
  switch (state.reason) {
    case "pending-device-id-invalid":
      return "待恢复的设备身份无效。";
    case "restore-marker-invalid":
      return "恢复完成标记已损坏。";
    case "restore-marker-device-id-mismatch":
      return "恢复完成标记与待恢复设备不一致。";
    case "restore-commit-incomplete":
      return "恢复完成标记存在，但账本时钟不完整。";
    case "restore-data-without-marker":
      return "检测到未完成写入的数据，但没有恢复完成标记。";
    case "restore-storage-state-invalid":
      return "本地恢复状态无法验证。";
  }
}

export function RestoreRecoveryView({
  state,
  initialError,
  onRetry,
  onCancel,
  onReload,
}: RestoreRecoveryViewProps) {
  const [busy, setBusy] = useState<"retry" | "cancel" | undefined>();
  const [error, setError] = useState(initialError);

  async function retry(file: File): Promise<void> {
    if (busy !== undefined) return;
    setBusy("retry");
    setError(undefined);
    try {
      await onRetry(file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function cancel(): Promise<void> {
    if (busy !== undefined) return;
    setBusy("cancel");
    setError(undefined);
    try {
      await onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(undefined);
    }
  }

  if (state.kind === "corrupt") {
    return (
      <div className="app-shell">
        <main className="app-main">
          <section
            className="utility-view state-view recovery-view"
            aria-labelledby="restore-corrupt-title"
          >
            <h1 className="wordmark" id="restore-corrupt-title">
              恢复已安全暂停
            </h1>
            <p role="alert">{corruptReason(state)}</p>
            <p>
              Tenjin 没有启用可能错误的设备身份，也没有继续写入。请重新检查；若状态仍不变，再清除此站点的本地数据后从备份恢复。
            </p>
            <button className="secondary-action" type="button" onClick={onReload}>
              重新检查
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <section
          className="utility-view state-view recovery-view"
          aria-labelledby="restore-pending-title"
        >
          <h1 className="wordmark" id="restore-pending-title">
            恢复未完成
          </h1>
          <p>
            本地账本仍为空。请重新选择同一份 <code>.tenjin</code> 备份；也可以取消本次恢复，回到空账本。
          </p>
          <div className="recovery-actions">
            <label className={busy === undefined ? "file-action" : "file-action is-disabled"}>
              <span>{busy === "retry" ? "正在验证并恢复…" : "重新选择备份"}</span>
              <input
                aria-label="重新选择 Tenjin 备份文件"
                type="file"
                accept=".tenjin,application/octet-stream,application/zip"
                disabled={busy !== undefined}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (file !== undefined) {
                    void retry(file).finally(() => {
                      input.value = "";
                    });
                  }
                }}
              />
            </label>
            <button
              className="secondary-action"
              type="button"
              disabled={busy !== undefined}
              onClick={() => void cancel()}
            >
              {busy === "cancel" ? "正在取消…" : "取消恢复"}
            </button>
          </div>
          {error === undefined ? null : <p role="alert">{error}</p>}
        </section>
      </main>
    </div>
  );
}
