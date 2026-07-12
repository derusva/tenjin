import { useCallback, useEffect, useRef, useState } from "react";

import {
  readCaptureLogSpikeDirectory,
  snapshotSelectedFiles,
  type CaptureSpikeReaderDependencies,
  type SpikeDirectoryResult,
  type SpikePackageResult,
  type SpikePayloadPreview,
  type SpikeReadIssue,
  type SpikeReadIssueCode,
} from "./captureSpikeReader.js";

export interface CaptureSpikeDiagnosticProps {
  readonly ledgerHref: string;
  readonly readerDependencies: CaptureSpikeReaderDependencies;
  readonly inspect?: typeof readCaptureLogSpikeDirectory;
}

type DiagnosticState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | { readonly kind: "result"; readonly result: SpikeDirectoryResult }
  | { readonly kind: "failed"; readonly errorName?: string };

const ISSUE_COPY: Readonly<Record<SpikeReadIssueCode, string>> = {
  "manifest-too-large": "capture.json 超过诊断读取上限。",
  "manifest-invalid-utf8": "capture.json 不是有效的 UTF-8。",
  "unexpected-utf8-bom": "文件包含 v0 不接受的 UTF-8 BOM。",
  "manifest-invalid-json": "capture.json 不是有效的 JSON。",
  "manifest-unknown-field": "capture.json 包含 v0 未定义的字段。",
  "unsupported-schema-version": "schemaVersion 不是诊断页支持的版本。",
  "unsupported-spike-build": "spikeBuild 不是诊断页支持的版本。",
  "invalid-capture-id": "captureId 不符合 v0 诊断格式。",
  "invalid-captured-at": "capturedAt 不是有效的 UTC 时间。",
  "invalid-shard-month": "shardMonth 不是有效月份。",
  "invalid-payload": "payload 描述不符合 v0 诊断契约。",
  "payload-unknown-field": "payload 包含 v0 未定义的字段。",
  "duplicate-payload-id": "包内出现重复的 payloadId。",
  "duplicate-payload-path": "包内出现重复的 payload 路径。",
  "duplicate-input-index": "包内出现重复的输入顺序。",
  "unsafe-payload-path": "payload 路径不安全。",
  "invalid-source-length": "源端字节数记录无效。",
  "invalid-source-digest": "源端摘要记录无效。",
  "relative-path-unavailable": "浏览器没有提供相对路径；请直接选择 CaptureLogSpike 月份目录。",
  "duplicate-selected-relative-path": "所选目录含有重复的相对路径。",
  "manifest-read-unavailable": "capture.json 暂时无法读取，请重新选择目录后重试。",
  "shard-month-path-mismatch": "目录月份与 capture.json 的 shardMonth 不一致。",
  "payload-missing": "文件暂不可读，可能仍在 iCloud 下载；请稍后重试。",
  "payload-read-unavailable": "文件暂不可读，可能仍在 iCloud 下载；请稍后重试。",
  "payload-invalid-utf8": "文字 payload 不是有效的 UTF-8。",
  "source-byte-length-mismatch": "本地文件字节数与源端记录不一致。",
  "source-digest-mismatch": "本地 SHA-256 与源端摘要不一致。",
  "local-digest-unavailable": "本机摘要计算暂不可用，请重试。",
};

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  try {
    const name = Reflect.get(error, "name");
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function isPermissionError(name: string | undefined): boolean {
  return name === "NotAllowedError" || name === "SecurityError";
}

function issueCopy(issue: SpikeReadIssue): string {
  if (issue.code === "local-digest-unavailable") {
    return ISSUE_COPY[issue.code];
  }
  if (issue.errorName === "AbortError") {
    return "文件读取已取消；请重新选择目录。";
  }
  if (isPermissionError(issue.errorName)) {
    return "浏览器没有文件权限；请重新授权或选择目录。";
  }
  return ISSUE_COPY[issue.code];
}

function failedCopy(name: string | undefined): string {
  if (name === "AbortError") {
    return "目录选择已取消；可以重新选择。";
  }
  if (isPermissionError(name)) {
    return "无法读取所选目录，请检查浏览器文件权限后重试。";
  }
  return "读取目录失败，请重新选择 CaptureLogSpike 月份目录。";
}

function IssueList({
  issues,
  label,
}: {
  readonly issues: readonly SpikeReadIssue[];
  readonly label: string;
}) {
  return (
    <div className="capture-spike-issues" role="alert" aria-label={label}>
      <ul className="capture-spike-issue-list">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.relativePath ?? "package"}-${index}`}>
            <code>{issue.code}</code>
            <p>{issueCopy(issue)}</p>
            {issue.relativePath === undefined ? null : (
              <p className="capture-spike-path">{issue.relativePath}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CaptureImage({ file, inputIndex }: { readonly file: File; readonly inputIndex: number }) {
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    image.current?.setAttribute("src", objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return (
    <img
      ref={image}
      className="capture-spike-image"
      alt={`捕获图片 ${inputIndex}`}
    />
  );
}

function PayloadPreview({
  payload,
  titleId,
}: {
  readonly payload: SpikePayloadPreview;
  readonly titleId: string;
}) {
  const sourceDigestCopy =
    payload.sourceDigestMatches === true
      ? "与源端一致"
      : payload.sourceDigestMatches === false
        ? "与源端不一致"
        : "源端摘要未提供";

  return (
    <section className="capture-spike-payload" aria-labelledby={titleId}>
      <h3 id={titleId}>
        #{String(payload.inputIndex).padStart(2, "0")} · {payload.observedType}
      </h3>
      <dl className="capture-spike-data-grid">
        <div><dt>payloadId</dt><dd>{payload.payloadId}</dd></div>
        <div><dt>源端 mediaType</dt><dd>{payload.sourceMediaType ?? "未提供"}</dd></div>
        <div><dt>浏览器 mediaType</dt><dd>{payload.browserMediaType ?? "未提供"}</dd></div>
        <div><dt>字节数</dt><dd>{payload.actualByteLength} 字节</dd></div>
        <div><dt>本地 SHA-256</dt><dd className="capture-spike-hash">{payload.localSha256}</dd></div>
        <div><dt>源端摘要比较</dt><dd>{sourceDigestCopy}</dd></div>
        <div><dt>本地计算耗时</dt><dd>{payload.localHashDurationMs.toFixed(2)} ms</dd></div>
      </dl>
      <div className="capture-spike-preview">
        <p className="capture-spike-preview-label">预览</p>
        {payload.kind === "text" ? (
          <pre>{payload.text}</pre>
        ) : payload.kind === "url" ? (
          <pre>{payload.rawUrl}</pre>
        ) : (
          <CaptureImage file={payload.file} inputIndex={payload.inputIndex} />
        )}
      </div>
    </section>
  );
}

function PackageResult({
  packageResult,
  packageIndex,
}: {
  readonly packageResult: SpikePackageResult;
  readonly packageIndex: number;
}) {
  const titleId = `capture-spike-package-${packageIndex}`;
  if (packageResult.status === "ready") {
    return (
      <article className="capture-spike-package" aria-labelledby={titleId}>
        <header className="capture-spike-package-header">
          <div>
            <p className="capture-spike-kicker">READY · PACKAGE {String(packageIndex + 1).padStart(2, "0")}</p>
            <h2 id={titleId}>{packageResult.manifest.captureId}</h2>
          </div>
          <span className="capture-spike-state-mark" aria-label="状态 ready">R</span>
        </header>
        <p className="capture-spike-path">{packageResult.packagePath}</p>
        <dl className="capture-spike-data-grid capture-spike-package-data">
          <div><dt>capturedAt</dt><dd>{packageResult.manifest.capturedAt}</dd></div>
          <div><dt>sourceApp</dt><dd>{packageResult.manifest.sourceApp ?? "来源身份未提供"}</dd></div>
          <div><dt>hashMode</dt><dd>{packageResult.manifest.hashMode}</dd></div>
          <div><dt>payload 数</dt><dd>{packageResult.payloads.length}</dd></div>
        </dl>
        <div className="capture-spike-payloads">
          {packageResult.payloads.map((payload, payloadIndex) => (
            <PayloadPreview
              key={`${packageResult.packagePath}/${payload.payloadId}`}
              payload={payload}
              titleId={`capture-spike-payload-${packageIndex}-${payloadIndex}`}
            />
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className="capture-spike-package capture-spike-package-problem" aria-labelledby={titleId}>
      <p className="capture-spike-kicker">
        {packageResult.status === "invalid" ? "INVALID" : "UNAVAILABLE"} · PACKAGE {String(packageIndex + 1).padStart(2, "0")}
      </p>
      <h2 id={titleId}>{packageResult.status === "invalid" ? "无效" : "暂不可用"}</h2>
      <p className="capture-spike-path">{packageResult.packagePath}</p>
      <IssueList issues={packageResult.issues} label={`${packageResult.packagePath} 诊断`} />
    </article>
  );
}

function DiagnosticResult({ result }: { readonly result: SpikeDirectoryResult }) {
  const hasNoDiscovery =
    result.packages.length === 0 &&
    result.selectionIssues.length === 0 &&
    result.ignoredWithoutManifest.length === 0;

  return (
    <div className="capture-spike-results">
      {result.selectionIssues.length === 0 ? null : (
        <section className="capture-spike-selection-diagnostic" aria-labelledby="capture-spike-selection-title">
          <h2 id="capture-spike-selection-title">选择无效</h2>
          <IssueList issues={result.selectionIssues} label="目录选择诊断" />
        </section>
      )}
      {result.ignoredWithoutManifest.length === 0 ? null : (
        <aside className="capture-spike-notice">
          忽略 {result.ignoredWithoutManifest.length} 个没有 capture.json 的目录：{" "}
          <span className="capture-spike-path">{result.ignoredWithoutManifest.join("、")}</span>
        </aside>
      )}
      {result.truncatedPackageCount === 0 ? null : (
        <aside className="capture-spike-notice capture-spike-notice-accent">
          已截断：还有 {result.truncatedPackageCount} 个包未读取。请缩小测试目录后重试。
        </aside>
      )}
      {hasNoDiscovery ? (
        <div className="capture-spike-empty state-view">
          <p>没有找到可读取的 capture.json。</p>
        </div>
      ) : null}
      <div className="capture-spike-package-list">
        {result.packages.map((packageResult, index) => (
          <PackageResult key={packageResult.packagePath} packageResult={packageResult} packageIndex={index} />
        ))}
      </div>
    </div>
  );
}

function announcementCopy(state: DiagnosticState): string {
  if (state.kind === "idle") {
    return "";
  }
  if (state.kind === "reading") {
    return "正在读取 CaptureLogSpike。";
  }
  if (state.kind === "failed") {
    return "读取失败，可以重新选择目录。";
  }

  const truncated = state.result.truncatedPackageCount;
  return `读取完成：${state.result.packages.length} 个包${
    truncated === 0 ? "。" : `，另有 ${truncated} 个包未读取。`
  }`;
}

export function CaptureSpikeDiagnostic({
  ledgerHref,
  readerDependencies,
  inspect = readCaptureLogSpikeDirectory,
}: CaptureSpikeDiagnosticProps) {
  const [state, setState] = useState<DiagnosticState>({ kind: "idle" });
  const requestGeneration = useRef(0);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  const configureDirectoryInput = useCallback((input: HTMLInputElement | null) => {
    if (input !== null) {
      input.setAttribute("webkitdirectory", "");
    }
  }, []);

  function selectDirectory(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.currentTarget.files;
    if (fileList === null || fileList.length === 0) {
      event.currentTarget.value = "";
      return;
    }

    const selected = snapshotSelectedFiles(fileList);
    event.currentTarget.value = "";
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState({ kind: "reading" });

    const fail = (error: unknown) => {
      if (requestGeneration.current === generation) {
        const name = errorName(error);
        setState({
          kind: "failed",
          ...(name === undefined ? {} : { errorName: name }),
        });
      }
    };

    let inspection: ReturnType<typeof inspect>;
    try {
      inspection = inspect(selected, readerDependencies);
    } catch (error) {
      fail(error);
      return;
    }

    void inspection.then(
      (result) => {
        if (requestGeneration.current === generation) {
          setState({ kind: "result", result });
        }
      },
      fail,
    );
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <section className="utility-view capture-spike-view" aria-labelledby="capture-spike-title">
          <a className="secondary-action capture-spike-back" href={ledgerHref}>返回 Tenjin</a>
          <header className="capture-spike-header">
            <p className="capture-spike-eyebrow">STAGE A · READ-ONLY FIELD SHEET</p>
            <h1 id="capture-spike-title">捕获链路诊断</h1>
            <p className="capture-spike-lede">逐包核对 iPhone → iCloud → 浏览器的实际交付结果。</p>
          </header>
          <aside className="capture-spike-warning" aria-label="阶段 A 只读提示">
            <strong>仅用于阶段 A</strong>
            <span>不会导入，也不会保存到 Tenjin；刷新或离开页面即丢弃结果。</span>
          </aside>
          <label className="secondary-action capture-spike-picker">
            <span>选择 CaptureLogSpike 月份目录</span>
            <input
              ref={configureDirectoryInput}
              className="capture-spike-directory-input"
              type="file"
              multiple
              onChange={selectDirectory}
            />
          </label>
          <p
            className="visually-hidden capture-spike-announcement"
            role="status"
          >
            {announcementCopy(state)}
          </p>

          <div className="capture-spike-workbench">
            {state.kind === "idle" ? (
              <div className="capture-spike-empty state-view">
                <p>尚未选择 CaptureLogSpike 月份目录</p>
              </div>
            ) : state.kind === "reading" ? (
              <div className="capture-spike-empty state-view">
                <p>正在读取 CaptureLogSpike…</p>
              </div>
            ) : state.kind === "failed" ? (
              <div className="capture-spike-empty state-view">
                <p role="alert">暂不可用：{failedCopy(state.errorName)}</p>
              </div>
            ) : (
              <DiagnosticResult result={state.result} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
