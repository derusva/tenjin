import { useRef, useState } from "react";

import { COACH_SETUP_PROMPT } from "./coachPrompt.js";

export interface CoachHelpViewProps {
  readonly onBack?: () => void;
  readonly onStartImport?: () => void;
  readonly writeClipboardText?: (text: string) => Promise<void>;
}

type CopyStatus = "idle" | "copying" | "copied" | "error";

async function writeSystemClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard writing is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

export function CoachHelpView({
  onBack,
  onStartImport,
  writeClipboardText = writeSystemClipboardText,
}: CoachHelpViewProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const promptArea = useRef<HTMLTextAreaElement>(null);

  async function copyPrompt() {
    if (copyStatus === "copying") {
      return;
    }
    setCopyStatus("copying");
    try {
      await writeClipboardText(COACH_SETUP_PROMPT);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
      promptArea.current?.focus();
      promptArea.current?.select();
    }
  }

  return (
    <section
      className="utility-view coach-help-view"
      aria-labelledby="coach-help-title"
    >
      {onBack === undefined ? null : (
        <button className="back-action" type="button" onClick={onBack}>
          返回
        </button>
      )}
      <h1 id="coach-help-title">怎么用 Coach</h1>

      <ol aria-label="Coach 导入四步">
        <li>把截图或日文发给固定 Coach 对话</li>
        <li>看完逐句翻译后，单独说「整理」</li>
        <li>点 JSON 代码块的“复制代码”</li>
        <li>回 Tenjin，选择“从 Coach 导入”</li>
      </ol>

      <section aria-labelledby="coach-setup-title">
        <h2 id="coach-setup-title">首次设置</h2>
        <p>把下面的设置复制到固定 Coach 对话一次即可。</p>
        <label htmlFor="coach-setup-prompt">Coach 设置</label>
        <textarea
          ref={promptArea}
          id="coach-setup-prompt"
          rows={18}
          readOnly
          value={COACH_SETUP_PROMPT}
        />
        <button
          type="button"
          disabled={copyStatus === "copying"}
          onClick={() => void copyPrompt()}
        >
          {copyStatus === "copying" ? "复制中…" : "复制 Coach 设置"}
        </button>
        {copyStatus === "copied" ? (
          <p role="status" aria-live="polite">
            已复制 Coach 设置
          </p>
        ) : copyStatus === "error" ? (
          <p role="alert">
            无法自动复制。设置内容已选中，请长按并选择“复制”。
          </p>
        ) : null}
      </section>

      {onStartImport === undefined ? null : (
        <button type="button" onClick={onStartImport}>
          从 Coach 导入
        </button>
      )}
    </section>
  );
}
