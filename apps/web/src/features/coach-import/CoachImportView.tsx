import type { ContextImageRecord } from "@tenjin/storage-indexeddb";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import {
  CaptureImageError,
  prepareCaptureImage,
} from "../capture/captureImage.js";
import { LocalImagePreview } from "../capture/LocalImagePreview.js";
import {
  canonicalizeCoachTransfer,
  CoachTransferError,
  digestCoachTransfer,
  parseCoachTransfer,
  type CoachTransfer,
  type CoachTransferItem,
} from "./coachTransfer.js";

export interface CoachImportImageTarget {
  /** Index into `selectedItems`, after deselected proposals are removed. */
  readonly selectedItemIndex: number;
  readonly image: ContextImageRecord;
}

export interface CoachImportConfirmation {
  /** Canonical form of the complete, normalized Coach batch before preview edits. */
  readonly canonicalTransfer: string;
  /** Digest of `canonicalTransfer`, used as the import receipt identity. */
  readonly digest: `sha256:${string}`;
  /** User-confirmed, preview-edited items only. */
  readonly selectedItems: readonly CoachTransferItem[];
  /** At most one image, attached to exactly one selected item. */
  readonly imageTarget?: CoachImportImageTarget;
}

export type CoachImportConfirmationResult =
  | { readonly status: "imported" }
  | { readonly status: "already-imported" };

export interface CoachImportViewProps {
  readonly onConfirm: (
    confirmation: CoachImportConfirmation,
  ) => Promise<CoachImportConfirmationResult>;
  readonly onBack?: () => void;
  readonly onReview?: () => void;
  readonly onContinue?: () => void;
  readonly onOpenHelp?: () => void;
  readonly resetCompletedImportVersion?: number;
  readonly readClipboardText?: () => Promise<string>;
  readonly writeClipboardText?: (text: string) => Promise<void>;
  readonly prepareImage?: (file: File) => Promise<ContextImageRecord>;
  readonly digestTransfer?: (
    transfer: CoachTransfer,
  ) => Promise<`sha256:${string}`>;
}

interface EditableItem {
  readonly sourceIndex: number;
  readonly selected: boolean;
  readonly focus: string;
  readonly sourceExcerpt: string;
  readonly answer: string;
}

interface PreviewState {
  readonly canonicalTransfer: string;
  readonly digest: `sha256:${string}`;
  readonly items: readonly EditableItem[];
}

type InputAction = "idle" | "clipboard" | "parsing";
type ImageAction = "idle" | "reading";
type SaveAction = "idle" | "saving" | "imported" | "already-imported";
type CopyAction = "idle" | "copying" | "copied" | "error";

const CAPTURE_IMAGE_ACCEPT =
  "image/jpeg,image/png,image/heic,image/heif,.jpg,.jpeg,.png,.heic,.heif";

async function readSystemClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText === undefined) {
    throw new Error("Clipboard reading is unavailable");
  }
  return navigator.clipboard.readText();
}

async function writeSystemClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard writing is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

function editableItem(item: CoachTransferItem, sourceIndex: number): EditableItem {
  return {
    sourceIndex,
    selected: true,
    focus: item.focus,
    sourceExcerpt: item.sourceExcerpt,
    answer: item.answer,
  };
}

function confirmedItem(item: EditableItem): CoachTransferItem {
  return {
    type: "lookup",
    focus: item.focus.trim(),
    sourceExcerpt: item.sourceExcerpt.trim(),
    answer: item.answer.trim(),
  };
}

function itemIsComplete(item: EditableItem): boolean {
  return (
    item.focus.trim().length > 0 &&
    item.sourceExcerpt.trim().length > 0 &&
    item.answer.trim().length > 0
  );
}

export function CoachImportView({
  onConfirm,
  onBack,
  onReview,
  onContinue,
  onOpenHelp,
  resetCompletedImportVersion = 0,
  readClipboardText = readSystemClipboardText,
  writeClipboardText = writeSystemClipboardText,
  prepareImage = prepareCaptureImage,
  digestTransfer = digestCoachTransfer,
}: CoachImportViewProps) {
  const [rawInput, setRawInput] = useState("");
  const [inputAction, setInputAction] = useState<InputAction>("idle");
  const [clipboardError, setClipboardError] = useState<string | undefined>();
  const [parseError, setParseError] = useState<Error | undefined>();
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const [image, setImage] = useState<ContextImageRecord | undefined>();
  const [imageTargetSourceIndex, setImageTargetSourceIndex] = useState<
    number | undefined
  >();
  const [imageAction, setImageAction] = useState<ImageAction>("idle");
  const [imageError, setImageError] = useState<string | undefined>();
  const [saveAction, setSaveAction] = useState<SaveAction>("idle");
  const [saveResultVersion, setSaveResultVersion] = useState(
    resetCompletedImportVersion,
  );
  const [saveError, setSaveError] = useState<string | undefined>();
  const [repairCopyAction, setRepairCopyAction] =
    useState<CopyAction>("idle");
  const focusInputOnIdle = useRef(false);
  const inputArea = useRef<HTMLTextAreaElement>(null);
  const repairArea = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const parseRequest = useRef(0);
  const imageRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      parseRequest.current += 1;
      imageRequest.current += 1;
    };
  }, []);

  const selectedItems = preview?.items.filter((item) => item.selected) ?? [];
  const selectedItemsComplete = selectedItems.every(itemIsComplete);
  const displayedSaveAction =
    saveAction === "imported" &&
    saveResultVersion !== resetCompletedImportVersion
      ? "idle"
      : saveAction;
  const busy =
    inputAction !== "idle" ||
    imageAction !== "idle" ||
    displayedSaveAction === "saving";
  const completed =
    displayedSaveAction === "imported" ||
    displayedSaveAction === "already-imported";
  const canConfirm =
    selectedItems.length > 0 && selectedItemsComplete && !busy && !completed;

  useEffect(() => {
    if (!focusInputOnIdle.current || busy || completed) {
      return;
    }
    inputArea.current?.focus();
    focusInputOnIdle.current = false;
  }, [busy, completed]);

  function resetImportResult() {
    setSaveAction("idle");
    setSaveError(undefined);
  }

  function clearPreparedImage() {
    imageRequest.current += 1;
    if (imageInput.current !== null) {
      imageInput.current.value = "";
    }
    setImage(undefined);
    setImageTargetSourceIndex(undefined);
    setImageAction("idle");
    setImageError(undefined);
  }

  function continueImport() {
    parseRequest.current += 1;
    setRawInput("");
    setInputAction("idle");
    setClipboardError(undefined);
    setParseError(undefined);
    setPreview(undefined);
    setRepairCopyAction("idle");
    clearPreparedImage();
    resetImportResult();
    onContinue?.();
    focusInputOnIdle.current = true;
  }

  async function buildPreview(text: string) {
    const request = ++parseRequest.current;
    setInputAction("parsing");
    setParseError(undefined);
    setPreview(undefined);
    setRepairCopyAction("idle");
    resetImportResult();
    clearPreparedImage();
    try {
      const transfer = parseCoachTransfer(text);
      const canonicalTransfer = canonicalizeCoachTransfer(transfer);
      const digest = await digestTransfer(transfer);
      if (!mounted.current || request !== parseRequest.current) {
        return;
      }
      setPreview({
        canonicalTransfer,
        digest,
        items: transfer.items.map(editableItem),
      });
    } catch (error) {
      if (!mounted.current || request !== parseRequest.current) {
        return;
      }
      setParseError(
        error instanceof Error
          ? error
          : new Error("无法解析 Coach 内容，请重试"),
      );
    } finally {
      if (mounted.current && request === parseRequest.current) {
        setInputAction("idle");
      }
    }
  }

  async function pasteAndPreview() {
    if (busy || completed) {
      return;
    }
    setInputAction("clipboard");
    setClipboardError(undefined);
    setParseError(undefined);
    try {
      const text = await readClipboardText();
      if (!mounted.current) {
        return;
      }
      setRawInput(text);
      setInputAction("idle");
      await buildPreview(text);
    } catch {
      if (!mounted.current) {
        return;
      }
      setInputAction("idle");
      setClipboardError("无法自动读取。请在下面长按并选择“粘贴”。");
      focusInputOnIdle.current = true;
    }
  }

  function updateItem(
    sourceIndex: number,
    update: (item: EditableItem) => EditableItem,
  ) {
    setPreview((current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.map((item) =>
              item.sourceIndex === sourceIndex ? update(item) : item,
            ),
          },
    );
    resetImportResult();
  }

  function toggleItem(sourceIndex: number, selected: boolean) {
    updateItem(sourceIndex, (item) => ({ ...item, selected }));
    if (!selected && imageTargetSourceIndex === sourceIndex) {
      setImageTargetSourceIndex(undefined);
    }
  }

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined || busy || completed) {
      return;
    }
    const request = ++imageRequest.current;
    setImageAction("reading");
    setImageError(undefined);
    setImageTargetSourceIndex(undefined);
    resetImportResult();
    try {
      const prepared = await prepareImage(file);
      if (!mounted.current || request !== imageRequest.current) {
        return;
      }
      setImage(prepared);
    } catch (error) {
      if (!mounted.current || request !== imageRequest.current) {
        return;
      }
      setImage(undefined);
      setImageError(
        error instanceof CaptureImageError
          ? error.message
          : "图片处理失败，请重新选择",
      );
    } finally {
      if (mounted.current && request === imageRequest.current) {
        setImageAction("idle");
      }
    }
  }

  async function copyRepairPrompt() {
    if (!(parseError instanceof CoachTransferError) || busy) {
      return;
    }
    setRepairCopyAction("copying");
    try {
      await writeClipboardText(parseError.repairPrompt);
      if (mounted.current) {
        setRepairCopyAction("copied");
      }
    } catch {
      if (mounted.current) {
        setRepairCopyAction("error");
        repairArea.current?.focus();
        repairArea.current?.select();
      }
    }
  }

  async function confirmImport() {
    if (preview === undefined || !canConfirm) {
      return;
    }
    const confirmedItems = selectedItems.map(confirmedItem);
    const selectedImageIndex = selectedItems.findIndex(
      (item) => item.sourceIndex === imageTargetSourceIndex,
    );
    const confirmation: CoachImportConfirmation = {
      canonicalTransfer: preview.canonicalTransfer,
      digest: preview.digest,
      selectedItems: confirmedItems,
      ...(image === undefined || selectedImageIndex < 0
        ? {}
        : {
            imageTarget: {
              selectedItemIndex: selectedImageIndex,
              image,
            },
          }),
    };

    setSaveAction("saving");
    setSaveError(undefined);
    try {
      const result = await onConfirm(confirmation);
      if (mounted.current) {
        setSaveAction(result.status);
        setSaveResultVersion(resetCompletedImportVersion);
      }
    } catch (error) {
      if (mounted.current) {
        setSaveAction("idle");
        setSaveError(
          error instanceof Error ? error.message : "导入失败，请重试",
        );
      }
    }
  }

  return (
    <section
      className="utility-view coach-import-view"
      aria-labelledby="coach-import-title"
      aria-busy={busy}
    >
      {onBack === undefined ? null : (
        <button
          className="back-action"
          type="button"
          disabled={busy}
          onClick={onBack}
        >
          返回
        </button>
      )}
      <h1 id="coach-import-title">从 Coach 导入</h1>
      <p>1 粘贴 → 2 核对 → 3 保存</p>
      {onOpenHelp === undefined ? null : (
        <button type="button" disabled={busy} onClick={onOpenHelp}>
          怎么用 Coach
        </button>
      )}

      <section aria-labelledby="coach-paste-title">
        <h2 id="coach-paste-title">1. 粘贴 Coach JSON</h2>
        <button
          type="button"
          disabled={busy || completed}
          onClick={() => void pasteAndPreview()}
        >
          {inputAction === "clipboard" ? "读取中…" : "粘贴并预览"}
        </button>
        <label htmlFor="coach-json-input">
          Coach JSON；自动读取失败时，长按这里选择“粘贴”
        </label>
        <textarea
          ref={inputArea}
          id="coach-json-input"
          rows={8}
          value={rawInput}
          disabled={busy || completed}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            parseRequest.current += 1;
            setRawInput(event.currentTarget.value);
            setPreview(undefined);
            setParseError(undefined);
            setClipboardError(undefined);
            resetImportResult();
            clearPreparedImage();
          }}
        />
        <button
          type="button"
          disabled={busy || completed || rawInput.trim().length === 0}
          onClick={() => void buildPreview(rawInput)}
        >
          预览输入内容
        </button>
        {clipboardError === undefined ? null : (
          <p role="alert">{clipboardError}</p>
        )}
      </section>

      {parseError === undefined ? null : (
        <section aria-labelledby="coach-repair-title">
          <h2 id="coach-repair-title">无法解析</h2>
          <p role="alert">
            {parseError instanceof CoachTransferError
              ? `${parseError.code}：${parseError.message}`
              : parseError.message}
          </p>
          {parseError instanceof CoachTransferError ? (
            <>
              <label htmlFor="coach-repair-prompt">给 Coach 的修复提示</label>
              <textarea
                ref={repairArea}
                id="coach-repair-prompt"
                rows={6}
                readOnly
                value={parseError.repairPrompt}
              />
              <button
                type="button"
                disabled={busy || repairCopyAction === "copying"}
                onClick={() => void copyRepairPrompt()}
              >
                {repairCopyAction === "copying" ? "复制中…" : "复制修复提示"}
              </button>
              {repairCopyAction === "copied" ? (
                <p role="status">已复制修复提示</p>
              ) : repairCopyAction === "error" ? (
                <p role="alert">无法自动复制。提示已选中，请长按复制。</p>
              ) : null}
            </>
          ) : null}
        </section>
      )}

      {preview === undefined ? null : preview.items.length === 0 ? (
        <p role="status">这一批没有值得导入的条目</p>
      ) : (
        <section aria-labelledby="coach-preview-title">
          <h2 id="coach-preview-title">2. 核对条目</h2>
          <ol>
            {preview.items.map((item) => {
              const number = item.sourceIndex + 1;
              return (
                <li key={item.sourceIndex}>
                  <article aria-label={`第 ${number} 条`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.selected}
                        disabled={busy || completed}
                        onChange={(event) =>
                          toggleItem(
                            item.sourceIndex,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      导入第 {number} 条
                    </label>
                    <label>
                      学习点
                      <input
                        aria-label={`第 ${number} 条学习点`}
                        value={item.focus}
                        disabled={!item.selected || busy || completed}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateItem(item.sourceIndex, (current) => ({
                            ...current,
                            focus: value,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      来源句
                      <textarea
                        aria-label={`第 ${number} 条来源句`}
                        rows={3}
                        value={item.sourceExcerpt}
                        disabled={!item.selected || busy || completed}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateItem(item.sourceIndex, (current) => ({
                            ...current,
                            sourceExcerpt: value,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      解释
                      <textarea
                        aria-label={`第 ${number} 条解释`}
                        rows={3}
                        value={item.answer}
                        disabled={!item.selected || busy || completed}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateItem(item.sourceIndex, (current) => ({
                            ...current,
                            answer: value,
                          }));
                        }}
                      />
                    </label>
                  </article>
                </li>
              );
            })}
          </ol>

          <section aria-labelledby="coach-image-title">
            <h3 id="coach-image-title">原截图（可选）</h3>
            <label>
              <span>{image === undefined ? "选择原截图" : "更换原截图"}</span>
              <input
                ref={imageInput}
                type="file"
                accept={CAPTURE_IMAGE_ACCEPT}
                disabled={busy || completed}
                aria-label="选择原截图"
                onChange={(event) => void selectImage(event)}
              />
            </label>
            <p>支持单张 JPEG、PNG、HEIC 或 HEIF，图片最多附到一条。</p>
            {imageAction === "reading" ? (
              <p role="status">正在读取图片…</p>
            ) : null}
            {imageError === undefined ? null : (
              <p role="alert">{imageError}</p>
            )}
            {image === undefined ? null : (
              <>
                <LocalImagePreview
                  blob={image.blob}
                  alt={`待导入截图：${image.name}`}
                />
                <button
                  type="button"
                  disabled={busy || completed}
                  onClick={clearPreparedImage}
                >
                  移除原截图
                </button>
                <fieldset disabled={busy || completed}>
                  <legend>图片附到</legend>
                  <label>
                    <input
                      type="radio"
                      name="coach-image-target"
                      checked={imageTargetSourceIndex === undefined}
                      onChange={() => setImageTargetSourceIndex(undefined)}
                    />
                    不附到任何条目
                  </label>
                  {selectedItems.map((item) => (
                    <label key={item.sourceIndex}>
                      <input
                        type="radio"
                        name="coach-image-target"
                        checked={imageTargetSourceIndex === item.sourceIndex}
                        onChange={() =>
                          setImageTargetSourceIndex(item.sourceIndex)
                        }
                      />
                      附到第 {item.sourceIndex + 1} 条：{item.focus}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
          </section>

          <section aria-labelledby="coach-save-title">
            <h2 id="coach-save-title">3. 保存</h2>
            {selectedItems.length === 0 ? (
              <p role="status">至少保留一条才能导入</p>
            ) : selectedItemsComplete ? null : (
              <p role="status">请补全选中条目的学习点、来源句和解释</p>
            )}
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => void confirmImport()}
            >
              {displayedSaveAction === "saving"
                ? "导入中…"
                : `确认导入 ${selectedItems.length} 条`}
            </button>
            {saveError === undefined ? null : (
              <p role="alert">导入失败：{saveError}</p>
            )}
            {completed ? (
              <>
                <p role="status">
                  {displayedSaveAction === "imported"
                    ? `已导入 ${selectedItems.length} 条`
                    : "这一批已经导入过，没有新增记录"}
                </p>
                <div aria-label="导入完成操作">
                  {onReview === undefined ||
                  displayedSaveAction !== "imported" ? null : (
                    <button type="button" onClick={onReview}>
                      现在复习
                    </button>
                  )}
                  <button type="button" onClick={continueImport}>
                    继续导入
                  </button>
                  {onBack === undefined ? null : (
                    <button type="button" onClick={onBack}>
                      返回记录
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </section>
        </section>
      )}
    </section>
  );
}
