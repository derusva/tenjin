import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  ListeningMissIcon,
  LookupIcon,
  ProductionCorrectionIcon,
} from "../../components/icons.js";
import type { CaptureCommand } from "./createCapture.js";

export interface CaptureComposerProps {
  readonly onSave: (command: CaptureCommand) => Promise<void>;
}

type SaveStatus = "idle" | "saving" | "success" | "error";

export function CaptureComposer({ onSave }: CaptureComposerProps) {
  const [captureType, setCaptureType] =
    useState<CaptureCommand["type"]>("lookup");
  const [original, setOriginal] = useState("");
  const [corrected, setCorrected] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const captureStartedAt = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  captureStartedAt.current ??= Date.now();

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedOriginal = original.trim();
    if (trimmedOriginal.length === 0) {
      return;
    }

    const captureDurationMs = Math.max(
      0,
      Date.now() - (captureStartedAt.current ?? Date.now()),
    );
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

      setOriginal("");
      setCorrected("");
      captureStartedAt.current = Date.now();
      setSaveStatus("success");
    } catch {
      if (mounted.current) {
        setSaveStatus("error");
      }
    }
  }

  const isSaving = saveStatus === "saving";

  return (
    <form onSubmit={handleSubmit} aria-busy={isSaving}>
      <fieldset disabled={isSaving}>
        <legend>记录类型</legend>
        <label>
          <input
            type="radio"
            name="capture-type"
            value="lookup"
            checked={captureType === "lookup"}
            onChange={() => {
              setCaptureType("lookup");
            }}
          />
          <LookupIcon aria-hidden="true" size={18} />
          查过
        </label>
        <label>
          <input
            type="radio"
            name="capture-type"
            value="listening_miss"
            checked={captureType === "listening_miss"}
            onChange={() => {
              setCaptureType("listening_miss");
            }}
          />
          <ListeningMissIcon aria-hidden="true" size={18} />
          没听出
        </label>
        <label>
          <input
            type="radio"
            name="capture-type"
            value="production_correction"
            checked={captureType === "production_correction"}
            onChange={() => {
              setCaptureType("production_correction");
            }}
          />
          <ProductionCorrectionIcon aria-hidden="true" size={18} />
          表达纠正
        </label>
      </fieldset>

      <label htmlFor="capture-original">遇到的词或表达</label>
      <textarea
        id="capture-original"
        value={original}
        disabled={isSaving}
        onChange={(event) => {
          setOriginal(event.currentTarget.value);
        }}
      />

      {captureType === "production_correction" ? (
        <>
          <label htmlFor="capture-corrected">纠正后的表达</label>
          <textarea
            id="capture-corrected"
            value={corrected}
            disabled={isSaving}
            onChange={(event) => {
              setCorrected(event.currentTarget.value);
            }}
          />
        </>
      ) : null}

      <button
        type="submit"
        disabled={isSaving || original.trim().length === 0}
      >
        {isSaving ? "保存中…" : "记下来"}
      </button>

      {saveStatus === "success" ? (
        <p role="status" aria-live="polite">
          已记下
        </p>
      ) : null}
      {saveStatus === "error" ? (
        <p role="alert" aria-live="assertive">
          保存失败，请再试一次
        </p>
      ) : null}
    </form>
  );
}
