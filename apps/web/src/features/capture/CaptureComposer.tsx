import type { ContextImageRecord } from "@tenjin/storage-indexeddb";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  CaptureIcon,
  ListeningMissIcon,
  LookupIcon,
  PasteIcon,
  ProductionCorrectionIcon,
} from "../../components/icons.js";
import {
  CaptureImageError,
  prepareCaptureImage,
} from "./captureImage.js";
import type { CaptureCommand } from "./createCapture.js";
import { LocalImagePreview } from "./LocalImagePreview.js";

export interface CaptureDraft {
  readonly captureType: CaptureCommand["type"];
  readonly original: string;
  readonly focus: string;
  readonly corrected: string;
  readonly answer: string;
  readonly image: ContextImageRecord | undefined;
}

export interface CaptureComposerProps {
  readonly draft?: CaptureDraft;
  readonly onDraftChange?: (draft: CaptureDraft) => void;
  readonly onSave: (command: CaptureCommand) => Promise<void>;
  readonly readClipboardText?: () => Promise<string>;
  readonly prepareImage?: (file: File) => Promise<ContextImageRecord>;
}

type SaveStatus = "idle" | "saving" | "success" | "error";
type PasteStatus = "idle" | "reading" | "success" | "empty" | "error";
type ImageStatus = "idle" | "reading" | "error";

const CAPTURE_IMAGE_ACCEPT =
  "image/jpeg,image/png,image/heic,image/heif,.jpg,.jpeg,.png,.heic,.heif";

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
  prepareImage = prepareCaptureImage,
}: CaptureComposerProps) {
  const [internalDraft, setInternalDraft] = useState<CaptureDraft>({
    captureType: "lookup",
    original: "",
    focus: "",
    corrected: "",
    answer: "",
    image: undefined,
  });
  const currentDraft = draft ?? internalDraft;
  const { captureType, original, focus, corrected, answer, image } = currentDraft;
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [pasteStatus, setPasteStatus] = useState<PasteStatus>("idle");
  const [imageStatus, setImageStatus] = useState<ImageStatus>("idle");
  const [imageError, setImageError] = useState<string | undefined>();
  const captureStartedAt = useRef<number | undefined>(undefined);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageSelection = useRef(0);
  const currentDraftRef = useRef(currentDraft);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    captureStartedAt.current = Date.now();

    return () => {
      mounted.current = false;
      imageSelection.current += 1;
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
    currentDraftRef.current = nextDraft;
    if (draft === undefined) {
      setInternalDraft(nextDraft);
    }
    onDraftChange?.(nextDraft);
  }

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined || saveStatus === "saving") {
      return;
    }

    const selection = ++imageSelection.current;
    setSaveStatus("idle");
    setImageStatus("reading");
    setImageError(undefined);
    try {
      const prepared = await prepareImage(file);
      if (!mounted.current || imageSelection.current !== selection) {
        return;
      }
      updateDraft({
        ...currentDraftRef.current,
        image: prepared,
      });
      setImageStatus("idle");
    } catch (error) {
      if (!mounted.current || imageSelection.current !== selection) {
        return;
      }
      setImageStatus("error");
      setImageError(
        error instanceof CaptureImageError
          ? error.message
          : "图片处理失败，请重新选择",
      );
    }
  }

  function removeImage() {
    imageSelection.current += 1;
    if (imageInput.current !== null) {
      imageInput.current.value = "";
    }
    updateDraft({
      ...currentDraftRef.current,
      image: undefined,
    });
    setImageStatus("idle");
    setImageError(undefined);
    setSaveStatus("idle");
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
    if (trimmedOriginal.length === 0 && image === undefined) {
      return;
    }

    const submittedAt = Date.now();
    const captureDurationMs =
      captureStartedAt.current === undefined
        ? 0
        : Math.max(0, submittedAt - captureStartedAt.current);
    let command: CaptureCommand;

    if (captureType === "lookup") {
      const trimmedFocus = focus.trim();
      const trimmedAnswer = answer.trim();
      command = {
        type: "lookup",
        original: trimmedOriginal,
        ...(trimmedFocus.length === 0 ? {} : { focus: trimmedFocus }),
        ...(trimmedAnswer.length === 0 ? {} : { answer: trimmedAnswer }),
        ...(image === undefined ? {} : { image }),
        captureDurationMs,
      };
    } else if (captureType === "listening_miss") {
      command = {
        type: "listening_miss",
        original: trimmedOriginal,
        ...(image === undefined ? {} : { image }),
        captureDurationMs,
      };
    } else {
      const trimmedCorrection = corrected.trim();
      command =
        trimmedCorrection.length === 0
          ? {
              type: "production_correction",
              original: trimmedOriginal,
              ...(image === undefined ? {} : { image }),
              captureDurationMs,
            }
          : {
              type: "production_correction",
              original: trimmedOriginal,
              corrected: trimmedCorrection,
              ...(image === undefined ? {} : { image }),
              captureDurationMs,
            };
    }

    setSaveStatus("saving");

    try {
      await onSave(command);
      if (!mounted.current) {
        return;
      }

      updateDraft({
        captureType: currentDraft.captureType,
        original: "",
        focus: "",
        corrected: "",
        answer: "",
        image: undefined,
      });
      if (imageInput.current !== null) {
        imageInput.current.value = "";
      }
      captureStartedAt.current = Date.now();
      setPasteStatus("idle");
      setImageStatus("idle");
      setImageError(undefined);
      setSaveStatus("success");
    } catch {
      if (mounted.current) {
        setSaveStatus("error");
      }
    }
  }

  const isSaving = saveStatus === "saving";
  const isReadingClipboard = pasteStatus === "reading";
  const isReadingImage = imageStatus === "reading";
  const isBusy = isSaving || isReadingClipboard || isReadingImage;
  const canSubmit = original.trim().length > 0 || image !== undefined;

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
        <div className="capture-image-picker">
          <label className="capture-image-action">
            <input
              ref={imageInput}
              className="visually-hidden"
              type="file"
              accept={CAPTURE_IMAGE_ACCEPT}
              disabled={isBusy}
              aria-label="选择图片"
              onChange={(event) => void selectImage(event)}
            />
            <span>{image === undefined ? "选择图片" : "更换图片"}</span>
          </label>
          <span>单张 JPEG、PNG、HEIC 或 HEIF，最大 20 MB</span>
        </div>
        {image === undefined ? null : (
          <figure className="capture-image-preview">
            <LocalImagePreview
              className="capture-image-thumbnail"
              blob={image.blob}
              alt={`所选图片预览：${image.name}`}
            />
            <figcaption>
              <strong>{image.name}</strong>
              <span>{Math.ceil(image.byteLength / 1024)} KB</span>
            </figcaption>
            <button
              type="button"
              disabled={isBusy}
              onClick={removeImage}
            >
              移除图片
            </button>
          </figure>
        )}

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

      {imageStatus === "reading" ? (
        <p className="capture-image-feedback" role="status" aria-live="polite">
          正在读取图片…
        </p>
      ) : imageStatus === "error" ? (
        <p className="capture-image-feedback capture-error" role="alert">
          {imageError ?? "图片处理失败，请重新选择"}
        </p>
      ) : null}

      {captureType === "lookup" ? (
        <>
          <div className="capture-focus">
            <label htmlFor="capture-focus">要复习的片段（可选）</label>
            <textarea
              className="capture-input capture-input-focus"
              id="capture-focus"
              rows={1}
              value={focus}
              disabled={isBusy}
              onChange={(event) => {
                setSaveStatus("idle");
                updateDraft({
                  ...currentDraft,
                  focus: event.currentTarget.value,
                });
              }}
            />
          </div>
          <div className="capture-answer">
            <label htmlFor="capture-answer">查到的意思 / 解释（可选）</label>
            <textarea
              className="capture-input capture-input-answer"
              id="capture-answer"
              rows={2}
              value={answer}
              disabled={isBusy}
              onChange={(event) => {
                setSaveStatus("idle");
                updateDraft({
                  ...currentDraft,
                  answer: event.currentTarget.value,
                });
              }}
            />
          </div>
        </>
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
        disabled={isBusy || !canSubmit}
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
