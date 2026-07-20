import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  CaptureIcon,
  ListeningMissIcon,
  LookupIcon,
  PasteIcon,
  ProductionCorrectionIcon,
} from "../../components/icons.js";
import type { CaptureCommand } from "./createCapture.js";

export interface CaptureDraft {
  readonly captureType: CaptureCommand["type"];
  readonly original: string;
  readonly corrected: string;
}

export interface CaptureComposerProps {
  readonly draft?: CaptureDraft;
  readonly onDraftChange?: (draft: CaptureDraft) => void;
  readonly onSave: (command: CaptureCommand) => Promise<void>;
  readonly readClipboardText?: () => Promise<string>;
}

type SaveStatus = "idle" | "saving" | "success" | "error";
type PasteStatus = "idle" | "reading" | "success" | "empty" | "error";

async function readSystemClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText === undefined) {
    throw new Error("Clipboard reading is unavailable");
  }
  return navigator.clipboard.readText();
}

export function CaptureComposer({
  draft,
  onDraftChange,
  onSave,
  readClipboardText = readSystemClipboardText,
}: CaptureComposerProps) {
  const [internalDraft, setInternalDraft] = useState<CaptureDraft>({
    captureType: "lookup",
    original: "",
    corrected: "",
  });
  const currentDraft = draft ?? internalDraft;
  const { captureType, original, corrected } = currentDraft;
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [pasteStatus, setPasteStatus] = useState<PasteStatus>("idle");
  const captureStartedAt = useRef<number | undefined>(undefined);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const currentDraftRef = useRef(currentDraft);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    captureStartedAt.current = Date.now();

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    currentDraftRef.current = currentDraft;
  }, [currentDraft]);

  useEffect(() => {
    if (
      pasteStatus === "success" ||
      pasteStatus === "empty" ||
      pasteStatus === "error"
    ) {
      originalInput.current?.focus();
    }
  }, [pasteStatus]);

  function updateDraft(nextDraft: CaptureDraft) {
    if (draft === undefined) {
      setInternalDraft(nextDraft);
    }
    onDraftChange?.(nextDraft);
  }

  async function pasteClipboardText() {
    if (pasteStatus === "reading" || saveStatus === "saving") {
      return;
    }

    setSaveStatus("idle");
    setPasteStatus("reading");
    try {
      const clipboardText = await readClipboardText();
      if (!mounted.current) {
        return;
      }
      if (clipboardText.trim().length === 0) {
        setPasteStatus("empty");
        return;
      }

      const input = originalInput.current;
      const latestDraft = currentDraftRef.current;
      const latestOriginal = input?.value ?? latestDraft.original;
      const selectionStart = input?.selectionStart ?? latestOriginal.length;
      const selectionEnd = input?.selectionEnd ?? selectionStart;
      updateDraft({
        ...latestDraft,
        original:
          latestOriginal.slice(0, selectionStart) +
          clipboardText +
          latestOriginal.slice(selectionEnd),
      });
      setPasteStatus("success");
    } catch {
      if (mounted.current) {
        setPasteStatus("error");
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pasteStatus === "reading") {
      return;
    }

    const trimmedOriginal = original.trim();
    if (trimmedOriginal.length === 0) {
      return;
    }

    const submittedAt = Date.now();
    const captureDurationMs =
      captureStartedAt.current === undefined
        ? 0
        : Math.max(0, submittedAt - captureStartedAt.current);
    let command: CaptureCommand;

    if (captureType === "lookup") {
      command = {
        type: "lookup",
        original: trimmedOriginal,
        captureDurationMs,
      };
    } else if (captureType === "listening_miss") {
      command = {
        type: "listening_miss",
        original: trimmedOriginal,
        captureDurationMs,
      };
    } else {
      const trimmedCorrection = corrected.trim();
      command =
        trimmedCorrection.length === 0
          ? {
              type: "production_correction",
              original: trimmedOriginal,
              captureDurationMs,
            }
          : {
              type: "production_correction",
              original: trimmedOriginal,
              corrected: trimmedCorrection,
              captureDurationMs,
            };
    }

    setSaveStatus("saving");

    try {
      await onSave(command);
      if (!mounted.current) {
        return;
      }

      updateDraft({ ...currentDraft, original: "", corrected: "" });
      captureStartedAt.current = Date.now();
      setPasteStatus("idle");
      setSaveStatus("success");
    } catch {
      if (mounted.current) {
        setSaveStatus("error");
      }
    }
  }

  const isSaving = saveStatus === "saving";
  const isReadingClipboard = pasteStatus === "reading";
  const isBusy = isSaving || isReadingClipboard;

  return (
    <form
      className="capture-composer"
      onSubmit={handleSubmit}
      aria-busy={isBusy}
    >
      <div className="capture-entry">
        <div className="capture-entry-tools">
          <span>粘贴或输入</span>
          <button
            className="capture-paste-action"
            type="button"
            disabled={isBusy}
            onClick={() => void pasteClipboardText()}
          >
            <PasteIcon aria-hidden="true" size={17} />
            <span>{pasteStatus === "reading" ? "读取中…" : "粘贴"}</span>
          </button>
        </div>
        <label className="visually-hidden" htmlFor="capture-original">
          遇到的词或表达
        </label>
        <textarea
          ref={originalInput}
          className="capture-input"
          id="capture-original"
          rows={4}
          placeholder="词语、句子、听到的近似音都可以"
          value={original}
          disabled={isBusy}
          onChange={(event) => {
            setPasteStatus("idle");
            setSaveStatus("idle");
            updateDraft({
              ...currentDraft,
              original: event.currentTarget.value,
            });
          }}
        />

        <fieldset className="capture-types" disabled={isBusy}>
          <legend className="visually-hidden">记录类型</legend>
          <label className="capture-type">
            <input
              type="radio"
              name="capture-type"
              value="lookup"
              checked={captureType === "lookup"}
              onChange={() => {
                updateDraft({ ...currentDraft, captureType: "lookup" });
              }}
            />
            <LookupIcon aria-hidden="true" size={19} />
            <span>查过</span>
          </label>
          <label className="capture-type">
            <input
              type="radio"
              name="capture-type"
              value="listening_miss"
              checked={captureType === "listening_miss"}
              onChange={() => {
                updateDraft({
                  ...currentDraft,
                  captureType: "listening_miss",
                });
              }}
            />
            <ListeningMissIcon aria-hidden="true" size={19} />
            <span>没听出</span>
          </label>
          <label className="capture-type">
            <input
              type="radio"
              name="capture-type"
              value="production_correction"
              checked={captureType === "production_correction"}
              onChange={() => {
                updateDraft({
                  ...currentDraft,
                  captureType: "production_correction",
                });
              }}
            />
            <ProductionCorrectionIcon aria-hidden="true" size={19} />
            <span>表达纠正</span>
          </label>
        </fieldset>
      </div>

      {pasteStatus === "success" ? (
        <p className="capture-paste-feedback" role="status" aria-live="polite">
          已粘贴，选择类型后记下来
        </p>
      ) : pasteStatus === "empty" ? (
        <p className="capture-paste-feedback" role="status" aria-live="polite">
          剪贴板里没有文字
        </p>
      ) : pasteStatus === "error" ? (
        <p className="capture-paste-feedback capture-error" role="alert">
          无法自动读取。请在输入框内长按并选择“粘贴”
        </p>
      ) : null}

      {captureType === "production_correction" ? (
        <div className="capture-correction">
          <label htmlFor="capture-corrected">纠正后的表达</label>
          <textarea
            className="capture-input capture-input-corrected"
            id="capture-corrected"
            rows={2}
            value={corrected}
            disabled={isBusy}
            onChange={(event) => {
              updateDraft({
                ...currentDraft,
                corrected: event.currentTarget.value,
              });
            }}
          />
        </div>
      ) : null}

      <button
        className="primary-action"
        type="submit"
        disabled={isBusy || original.trim().length === 0}
      >
        <CaptureIcon aria-hidden="true" size={22} />
        <span>{isSaving ? "保存中…" : "记下来"}</span>
      </button>

      {saveStatus === "success" ? (
        <p className="capture-feedback" role="status" aria-live="polite">
          已记下
        </p>
      ) : null}
      {saveStatus === "error" ? (
        <p className="capture-feedback capture-error" role="alert" aria-live="assertive">
          保存失败，请再试一次
        </p>
      ) : null}
    </form>
  );
}
