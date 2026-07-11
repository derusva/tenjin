import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  CaptureIcon,
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

  useEffect(() => {
    mounted.current = true;
    captureStartedAt.current = Date.now();

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
    <form
      className="capture-composer"
      onSubmit={handleSubmit}
      aria-busy={isSaving}
    >
      <div className="capture-entry">
        <label className="visually-hidden" htmlFor="capture-original">
          遇到的词或表达
        </label>
        <textarea
          className="capture-input"
          id="capture-original"
          rows={4}
          value={original}
          disabled={isSaving}
          onChange={(event) => {
            setOriginal(event.currentTarget.value);
          }}
        />

        <fieldset className="capture-types" disabled={isSaving}>
          <legend className="visually-hidden">记录类型</legend>
          <label className="capture-type">
            <input
              type="radio"
              name="capture-type"
              value="lookup"
              checked={captureType === "lookup"}
              onChange={() => {
                setCaptureType("lookup");
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
                setCaptureType("listening_miss");
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
                setCaptureType("production_correction");
              }}
            />
            <ProductionCorrectionIcon aria-hidden="true" size={19} />
            <span>表达纠正</span>
          </label>
        </fieldset>
      </div>

      {captureType === "production_correction" ? (
        <div className="capture-correction">
          <label htmlFor="capture-corrected">纠正后的表达</label>
          <textarea
            className="capture-input capture-input-corrected"
            id="capture-corrected"
            rows={2}
            value={corrected}
            disabled={isSaving}
            onChange={(event) => {
              setCorrected(event.currentTarget.value);
            }}
          />
        </div>
      ) : null}

      <button
        className="primary-action"
        type="submit"
        disabled={isSaving || original.trim().length === 0}
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
