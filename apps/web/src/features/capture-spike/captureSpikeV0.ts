export type SpikePreviewKind = "text" | "url" | "image";
export type SpikeHashMode = "none" | "sha256";

export interface CaptureSpikePayloadV0 {
  readonly payloadId: string;
  readonly inputIndex: number;
  readonly observedType: string;
  readonly previewKind: SpikePreviewKind;
  readonly path: string;
  readonly mediaType?: string;
  readonly originalName?: string;
  readonly sourceByteLength?: number;
  readonly sourceSha256?: string;
  readonly sourceHashDurationMs?: number;
}

export interface CaptureSpikeManifestV0 {
  readonly schemaVersion: 0;
  readonly spikeBuild: 1;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly shardMonth: string;
  readonly transport: "ios-shortcut-spike";
  readonly hashMode: SpikeHashMode;
  readonly sourceApp?: string;
  readonly payloads: readonly CaptureSpikePayloadV0[];
}

export type SpikeManifestIssueCode =
  | "manifest-too-large"
  | "manifest-invalid-utf8"
  | "unexpected-utf8-bom"
  | "manifest-invalid-json"
  | "manifest-unknown-field"
  | "unsupported-schema-version"
  | "unsupported-spike-build"
  | "invalid-capture-id"
  | "invalid-captured-at"
  | "invalid-shard-month"
  | "invalid-payload"
  | "payload-unknown-field"
  | "duplicate-payload-id"
  | "duplicate-payload-path"
  | "duplicate-input-index"
  | "unsafe-payload-path"
  | "invalid-source-length"
  | "invalid-source-digest";

export interface SpikeManifestIssue {
  readonly code: SpikeManifestIssueCode;
  readonly fieldPath?: string;
}

export type ParseCaptureSpikeManifestResult =
  | { readonly ok: true; readonly value: CaptureSpikeManifestV0 }
  | { readonly ok: false; readonly issues: readonly SpikeManifestIssue[] };

const MAX_MANIFEST_BYTES = 256 * 1024;
const CAPTURE_ID_PATTERN = /^spike-\d{8}-\d{6}-\d{3}-\d{6}$/;
const SHARD_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_RESTRICTED_NAME_PATTERN =
  /^[A-Za-z0-9](?:[!#$&^_.+A-Za-z0-9-]{0,125}[A-Za-z0-9])?$/;
const CHARSET_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/;

const MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "spikeBuild",
  "captureId",
  "capturedAt",
  "shardMonth",
  "transport",
  "hashMode",
  "sourceApp",
  "payloads",
]);

const PAYLOAD_FIELDS = new Set([
  "payloadId",
  "inputIndex",
  "observedType",
  "previewKind",
  "path",
  "mediaType",
  "originalName",
  "sourceByteLength",
  "sourceSha256",
  "sourceHashDurationMs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  return left.every((byte, index) => byte === right[index]);
}

function isRealUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function isShardMonth(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = SHARD_MONTH_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isSafePayloadPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isQuotedString(value: string): boolean {
  if (
    value.length < 3 ||
    !value.startsWith('"') ||
    !value.endsWith('"')
  ) {
    return false;
  }

  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) {
        return false;
      }
      const escapedCode = value.charCodeAt(index);
      if (escapedCode !== 0x09 && (escapedCode < 0x20 || escapedCode > 0x7e)) {
        return false;
      }
    } else if (
      code !== 0x09 &&
      !(code >= 0x20 && code <= 0x21) &&
      !(code >= 0x23 && code <= 0x5b) &&
      !(code >= 0x5d && code <= 0x7e)
    ) {
      return false;
    }
  }

  return true;
}

function mediaTypeBase(value: string): string | undefined {
  const [rawBase, ...parameters] = value.split(";");
  const baseParts = rawBase?.split("/") ?? [];
  if (
    baseParts.length !== 2 ||
    !MEDIA_RESTRICTED_NAME_PATTERN.test(baseParts[0] ?? "") ||
    !MEDIA_RESTRICTED_NAME_PATTERN.test(baseParts[1] ?? "")
  ) {
    return undefined;
  }

  let hasCharset = false;
  for (const rawParameter of parameters) {
    const parameter = rawParameter.trim();
    const equalsIndex = parameter.indexOf("=");
    if (equalsIndex <= 0) {
      return undefined;
    }
    const name = parameter.slice(0, equalsIndex);
    const parameterValue = parameter.slice(equalsIndex + 1);
    const validValue =
      CHARSET_TOKEN_PATTERN.test(parameterValue) ||
      isQuotedString(parameterValue);
    if (
      name.toLowerCase() !== "charset" ||
      hasCharset ||
      !validValue
    ) {
      return undefined;
    }
    hasCharset = true;
  }

  return `${baseParts[0]!.toLowerCase()}/${baseParts[1]!.toLowerCase()}`;
}

function mediaTypeMatchesPreview(
  mediaType: unknown,
  previewKind: unknown,
): boolean {
  if (typeof mediaType !== "string") {
    return false;
  }

  const base = mediaTypeBase(mediaType);
  if (base === undefined) {
    return false;
  }

  if (previewKind === "text") {
    return base === "text/plain";
  }
  if (previewKind === "url") {
    return base === "text/plain" || base === "text/uri-list";
  }
  if (previewKind === "image") {
    return base.startsWith("image/");
  }
  return false;
}

function issue(
  code: SpikeManifestIssueCode,
  fieldPath?: string,
): SpikeManifestIssue {
  return fieldPath === undefined ? { code } : { code, fieldPath };
}

export function parseCaptureSpikeManifestV0(
  bytes: ArrayBuffer,
): ParseCaptureSpikeManifestResult {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    return { ok: false, issues: [issue("manifest-too-large")] };
  }

  const sourceBytes = new Uint8Array(bytes);
  if (
    sourceBytes[0] === 0xef &&
    sourceBytes[1] === 0xbb &&
    sourceBytes[2] === 0xbf
  ) {
    return { ok: false, issues: [issue("unexpected-utf8-bom")] };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    return { ok: false, issues: [issue("manifest-invalid-utf8")] };
  }
  if (!bytesEqual(sourceBytes, new TextEncoder().encode(text))) {
    return { ok: false, issues: [issue("manifest-invalid-utf8")] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, issues: [issue("manifest-invalid-json")] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issues: [issue("manifest-invalid-json")] };
  }

  const issues: SpikeManifestIssue[] = [];
  for (const field of Object.keys(parsed)) {
    if (!MANIFEST_FIELDS.has(field)) {
      issues.push(issue("manifest-unknown-field", field));
    }
  }

  if (parsed.schemaVersion !== 0) {
    issues.push(issue("unsupported-schema-version", "schemaVersion"));
  }
  if (parsed.spikeBuild !== 1) {
    issues.push(issue("unsupported-spike-build", "spikeBuild"));
  }
  if (
    typeof parsed.captureId !== "string" ||
    !CAPTURE_ID_PATTERN.test(parsed.captureId)
  ) {
    issues.push(issue("invalid-capture-id", "captureId"));
  }
  if (!isRealUtcTimestamp(parsed.capturedAt)) {
    issues.push(issue("invalid-captured-at", "capturedAt"));
  }
  if (!isShardMonth(parsed.shardMonth)) {
    issues.push(issue("invalid-shard-month", "shardMonth"));
  }
  if (parsed.transport !== "ios-shortcut-spike") {
    issues.push(issue("invalid-payload", "transport"));
  }

  const hashMode = parsed.hashMode;
  if (hashMode !== "none" && hashMode !== "sha256") {
    issues.push(issue("invalid-source-digest", "hashMode"));
  }
  if (
    parsed.sourceApp !== undefined &&
    (typeof parsed.sourceApp !== "string" || parsed.sourceApp.length === 0)
  ) {
    issues.push(issue("invalid-payload", "sourceApp"));
  }

  const payloads = parsed.payloads;
  if (!Array.isArray(payloads) || payloads.length < 1 || payloads.length > 20) {
    issues.push(issue("invalid-payload", "payloads"));
  } else {
    const payloadIds = new Set<string>();
    const payloadPaths = new Set<string>();
    const inputIndexes = new Set<number>();

    payloads.forEach((payload, index) => {
      const prefix = `payloads[${index}]`;
      if (!isRecord(payload)) {
        issues.push(issue("invalid-payload", prefix));
        return;
      }

      for (const field of Object.keys(payload)) {
        if (!PAYLOAD_FIELDS.has(field)) {
          issues.push(issue("payload-unknown-field", `${prefix}.${field}`));
        }
      }

      if (typeof payload.payloadId !== "string" || payload.payloadId.length === 0) {
        issues.push(issue("invalid-payload", `${prefix}.payloadId`));
      } else if (payloadIds.has(payload.payloadId)) {
        issues.push(issue("duplicate-payload-id", `${prefix}.payloadId`));
      } else {
        payloadIds.add(payload.payloadId);
      }

      if (
        typeof payload.inputIndex !== "number" ||
        !Number.isSafeInteger(payload.inputIndex) ||
        payload.inputIndex < 1
      ) {
        issues.push(issue("invalid-payload", `${prefix}.inputIndex`));
      } else if (inputIndexes.has(payload.inputIndex)) {
        issues.push(issue("duplicate-input-index", `${prefix}.inputIndex`));
      } else {
        inputIndexes.add(payload.inputIndex);
      }

      if (
        typeof payload.observedType !== "string" ||
        payload.observedType.length === 0
      ) {
        issues.push(issue("invalid-payload", `${prefix}.observedType`));
      }
      if (
        payload.previewKind !== "text" &&
        payload.previewKind !== "url" &&
        payload.previewKind !== "image"
      ) {
        issues.push(issue("invalid-payload", `${prefix}.previewKind`));
      }

      if (!isSafePayloadPath(payload.path)) {
        issues.push(issue("unsafe-payload-path", `${prefix}.path`));
      } else if (payloadPaths.has(payload.path)) {
        issues.push(issue("duplicate-payload-path", `${prefix}.path`));
      } else {
        payloadPaths.add(payload.path);
      }

      if (
        payload.mediaType !== undefined &&
        !mediaTypeMatchesPreview(payload.mediaType, payload.previewKind)
      ) {
        issues.push(issue("invalid-payload", `${prefix}.mediaType`));
      }
      if (
        payload.originalName !== undefined &&
        (typeof payload.originalName !== "string" ||
          payload.originalName.length === 0)
      ) {
        issues.push(issue("invalid-payload", `${prefix}.originalName`));
      }

      if (
        payload.sourceByteLength !== undefined &&
        (typeof payload.sourceByteLength !== "number" ||
          !Number.isSafeInteger(payload.sourceByteLength) ||
          payload.sourceByteLength < 0)
      ) {
        issues.push(
          issue("invalid-source-length", `${prefix}.sourceByteLength`),
        );
      }

      const hasDigest = payload.sourceSha256 !== undefined;
      const hasDuration = payload.sourceHashDurationMs !== undefined;
      const validDigest =
        typeof payload.sourceSha256 === "string" &&
        SHA256_PATTERN.test(payload.sourceSha256);
      const validDuration =
        typeof payload.sourceHashDurationMs === "number" &&
        Number.isFinite(payload.sourceHashDurationMs) &&
        payload.sourceHashDurationMs >= 0;

      if (hashMode === "none") {
        if (hasDigest) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceSha256`),
          );
        }
        if (hasDuration) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceHashDurationMs`),
          );
        }
      } else if (hashMode === "sha256") {
        if (!validDigest) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceSha256`),
          );
        }
        if (!validDuration) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceHashDurationMs`),
          );
        }
      } else {
        if (hasDigest && !validDigest) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceSha256`),
          );
        }
        if (hasDuration && (!hasDigest || !validDuration)) {
          issues.push(
            issue("invalid-source-digest", `${prefix}.sourceHashDurationMs`),
          );
        }
      }
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: parsed as unknown as CaptureSpikeManifestV0,
  };
}
