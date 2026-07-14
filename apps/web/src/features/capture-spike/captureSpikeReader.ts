import {
  parseCaptureSpikeManifestV0,
  type CaptureSpikeManifestV0,
  type CaptureSpikePayloadV0,
  type SpikeManifestIssueCode,
} from "./captureSpikeV0.js";

export interface SelectedSpikeFile {
  readonly file: File;
  readonly relativePath: string;
}

export interface CaptureSpikeReaderDependencies {
  readonly readArrayBuffer: (file: File) => Promise<ArrayBuffer>;
  readonly sha256: (bytes: ArrayBuffer) => Promise<string>;
  readonly now: () => number;
}

export type SpikeReadIssueDisposition =
  | "invalid-selection"
  | "temporarily-unavailable"
  | "invalid-package";

export type SpikeReadIssueCode =
  | SpikeManifestIssueCode
  | "relative-path-unavailable"
  | "duplicate-selected-relative-path"
  | "manifest-read-unavailable"
  | "shard-month-path-mismatch"
  | "payload-missing"
  | "payload-read-unavailable"
  | "payload-invalid-utf8"
  | "raw-file-too-large"
  | "raw-package-too-large"
  | "source-byte-length-mismatch"
  | "source-digest-mismatch"
  | "local-digest-unavailable";

export interface SpikeReadIssue {
  readonly disposition: SpikeReadIssueDisposition;
  readonly code: SpikeReadIssueCode;
  readonly relativePath?: string;
  readonly errorName?: string;
  readonly retryable: boolean;
}

interface SpikePayloadPreviewBase {
  readonly payloadId: string;
  readonly inputIndex: number;
  readonly observedType: string;
  readonly sourceMediaType?: string;
  readonly browserMediaType?: string;
  readonly actualByteLength: number;
  readonly localSha256: string;
  readonly localHashDurationMs: number;
  readonly sourceDigestMatches?: boolean;
}

export type SpikePayloadPreview =
  | (SpikePayloadPreviewBase & {
      readonly kind: "text";
      readonly text: string;
    })
  | (SpikePayloadPreviewBase & {
      readonly kind: "url";
      readonly rawUrl: string;
    })
  | (SpikePayloadPreviewBase & {
      readonly kind: "image";
      readonly file: File;
    });

export type SpikePackageResult =
  | {
      readonly status: "ready";
      readonly packagePath: string;
      readonly manifest: CaptureSpikeManifestV0;
      readonly payloads: readonly SpikePayloadPreview[];
      readonly packageSource?: "raw";
    }
  | {
      readonly status: "temporarily-unavailable";
      readonly packagePath: string;
      readonly manifest?: CaptureSpikeManifestV0;
      readonly issues: readonly SpikeReadIssue[];
    }
  | {
      readonly status: "invalid";
      readonly packagePath: string;
      readonly issues: readonly SpikeReadIssue[];
    };

export interface SpikeDirectoryResult {
  readonly packages: readonly SpikePackageResult[];
  readonly ignoredWithoutManifest: readonly string[];
  readonly truncatedPackageCount: number;
  readonly selectionIssues: readonly SpikeReadIssue[];
}

interface DecodedPayload {
  readonly ok: true;
  readonly value: string;
}

interface InvalidDecodedPayload {
  readonly ok: false;
  readonly code: "unexpected-utf8-bom" | "payload-invalid-utf8";
}

const SHARD_MONTH_SEGMENT = /^\d{4}-\d{2}$/;
const RAW_CAPTURE_DIRECTORY_SEGMENT = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/;
const RAW_IMAGE_MEDIA_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
]);
const RAW_MAX_FILE_BYTES = 20 * 1024 * 1024;
const RAW_MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function decodePayload(bytes: ArrayBuffer): DecodedPayload | InvalidDecodedPayload {
  const source = new Uint8Array(bytes);
  if (source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
    return { ok: false, code: "unexpected-utf8-bom" };
  }

  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return { ok: false, code: "payload-invalid-utf8" };
  }

  if (!bytesEqual(source, new TextEncoder().encode(value))) {
    return { ok: false, code: "payload-invalid-utf8" };
  }
  return { ok: true, value };
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator === -1 ? "" : relativePath.slice(0, separator);
}

function baseName(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator === -1 ? relativePath : relativePath.slice(separator + 1);
}

function inferPackagePath(relativePath: string): string | undefined {
  const segments = relativePath.split("/");
  for (let index = 0; index <= segments.length - 3; index += 1) {
    if (SHARD_MONTH_SEGMENT.test(segments[index] ?? "")) {
      return segments.slice(0, index + 2).join("/");
    }
  }
  return undefined;
}

function errorName(error: unknown): string | undefined {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    try {
      const name = Reflect.get(error, "name");
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function issue(
  disposition: SpikeReadIssueDisposition,
  code: SpikeReadIssueCode,
  retryable: boolean,
  relativePath?: string,
  error?: unknown,
): SpikeReadIssue {
  const name = errorName(error);
  return {
    disposition,
    code,
    retryable,
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(name === undefined ? {} : { errorName: name }),
  };
}

function unavailablePackage(
  packagePath: string,
  issues: readonly SpikeReadIssue[],
  manifest?: CaptureSpikeManifestV0,
): SpikePackageResult {
  return {
    status: "temporarily-unavailable",
    packagePath,
    issues,
    ...(manifest === undefined ? {} : { manifest }),
  };
}

function invalidPackage(
  packagePath: string,
  issues: readonly SpikeReadIssue[],
): SpikePackageResult {
  return { status: "invalid", packagePath, issues };
}

function packageShardMonth(packagePath: string): string | undefined {
  const segments = packagePath.split("/");
  return segments.at(-2);
}

function rawImageMediaType(file: File, bytes: ArrayBuffer): string | undefined {
  const browserType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (RAW_IMAGE_MEDIA_TYPES.has(browserType)) {
    return browserType;
  }

  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "heic") {
    return "image/heic";
  }
  if (extension === "heif") {
    return "image/heif";
  }

  const source = new Uint8Array(bytes);
  if (source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    source[0] === 0x89 &&
    source[1] === 0x50 &&
    source[2] === 0x4e &&
    source[3] === 0x47 &&
    source[4] === 0x0d &&
    source[5] === 0x0a &&
    source[6] === 0x1a &&
    source[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    source[4] === 0x66 &&
    source[5] === 0x74 &&
    source[6] === 0x79 &&
    source[7] === 0x70
  ) {
    const brand = String.fromCharCode(...source.slice(8, 12));
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) {
      return "image/heic";
    }
    if (["mif1", "msf1"].includes(brand)) {
      return "image/heif";
    }
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length === 0 || /\s/.test(candidate)) {
    return false;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sixDigitPathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return String((hash >>> 0) % 1_000_000).padStart(6, "0");
}

function padDatePart(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function rawCaptureId(packagePath: string, capturedAt: Date): string {
  const directoryTimestamp = RAW_CAPTURE_DIRECTORY_SEGMENT.exec(
    baseName(packagePath),
  );
  if (directoryTimestamp !== null) {
    return `spike-${directoryTimestamp[1]}${directoryTimestamp[2]}${directoryTimestamp[3]}-${directoryTimestamp[4]}${directoryTimestamp[5]}${directoryTimestamp[6]}-${directoryTimestamp[7]}-${sixDigitPathHash(packagePath)}`;
  }
  const date = [
    capturedAt.getUTCFullYear(),
    padDatePart(capturedAt.getUTCMonth() + 1),
    padDatePart(capturedAt.getUTCDate()),
  ].join("");
  const time = [
    padDatePart(capturedAt.getUTCHours()),
    padDatePart(capturedAt.getUTCMinutes()),
    padDatePart(capturedAt.getUTCSeconds()),
  ].join("");
  return `spike-${date}-${time}-${padDatePart(capturedAt.getUTCMilliseconds(), 3)}-${sixDigitPathHash(packagePath)}`;
}

function rawCapturedAt(packagePath: string, fallbackTimestamp: number): Date {
  const directoryTimestamp = rawPackageTimestamp(packagePath);
  if (directoryTimestamp !== undefined) {
    return directoryTimestamp;
  }
  return new Date(
    Number.isFinite(fallbackTimestamp) && fallbackTimestamp > 0
      ? fallbackTimestamp
      : 0,
  );
}

function rawPackageTimestamp(packagePath: string): Date | undefined {
  const match = RAW_CAPTURE_DIRECTORY_SEGMENT.exec(baseName(packagePath));
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const parentMonth = packageShardMonth(packagePath);
  if (parentMonth !== `${match[1]}-${match[2]}`) {
    return undefined;
  }

  const localDate = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (
    localDate.getFullYear() !== year ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day ||
    localDate.getHours() !== hour ||
    localDate.getMinutes() !== minute ||
    localDate.getSeconds() !== second ||
    localDate.getMilliseconds() !== millisecond
  ) {
    return undefined;
  }
  return localDate;
}

function rawPayloadPath(packagePath: string, relativePath: string): string {
  return relativePath.slice(packagePath.length + 1);
}

function isSafeRawPayloadPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  return value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

async function readRawPackage(
  packagePath: string,
  selectedByPath: ReadonlyMap<string, SelectedSpikeFile>,
  dependencies: CaptureSpikeReaderDependencies,
): Promise<SpikePackageResult> {
  const selectedPayloads = [...selectedByPath.values()]
    .filter((selected) =>
      selected.relativePath.startsWith(`${packagePath}/`) &&
      baseName(selected.relativePath) !== "capture.json",
    )
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (selectedPayloads.length === 0 || selectedPayloads.length > 20) {
    return invalidPackage(packagePath, [
      issue("invalid-package", "invalid-payload", false, packagePath),
    ]);
  }

  const oversizedPayload = selectedPayloads.find(
    (selected) => selected.file.size > RAW_MAX_FILE_BYTES,
  );
  if (oversizedPayload !== undefined) {
    return invalidPackage(packagePath, [
      issue(
        "invalid-package",
        "raw-file-too-large",
        false,
        oversizedPayload.relativePath,
      ),
    ]);
  }
  const packageByteLength = selectedPayloads.reduce(
    (total, selected) => total + selected.file.size,
    0,
  );
  if (packageByteLength > RAW_MAX_PACKAGE_BYTES) {
    return invalidPackage(packagePath, [
      issue("invalid-package", "raw-package-too-large", false, packagePath),
    ]);
  }

  const payloads: SpikePayloadPreview[] = [];
  const descriptors: CaptureSpikePayloadV0[] = [];
  for (const [index, selected] of selectedPayloads.entries()) {
    let bytes: ArrayBuffer;
    try {
      bytes = await dependencies.readArrayBuffer(selected.file);
    } catch (error) {
      return unavailablePackage(packagePath, [
        issue(
          "temporarily-unavailable",
          "payload-read-unavailable",
          true,
          selected.relativePath,
          error,
        ),
      ]);
    }

    let localSha256: string;
    let localHashDurationMs: number;
    try {
      const startedAt = dependencies.now();
      localSha256 = await dependencies.sha256(bytes);
      localHashDurationMs = dependencies.now() - startedAt;
    } catch (error) {
      return unavailablePackage(packagePath, [
        issue(
          "temporarily-unavailable",
          "local-digest-unavailable",
          true,
          selected.relativePath,
          error,
        ),
      ]);
    }

    const inputIndex = index + 1;
    const payloadId = `raw-${String(inputIndex).padStart(3, "0")}`;
    const path = rawPayloadPath(packagePath, selected.relativePath);
    if (!isSafeRawPayloadPath(path)) {
      return invalidPackage(packagePath, [
        issue(
          "invalid-package",
          "unsafe-payload-path",
          false,
          selected.relativePath,
        ),
      ]);
    }
    const imageMediaType = rawImageMediaType(selected.file, bytes);
    if (imageMediaType !== undefined) {
      descriptors.push({
        payloadId,
        inputIndex,
        observedType: "Raw Image",
        previewKind: "image",
        path,
        mediaType: imageMediaType,
        originalName: selected.file.name,
        sourceByteLength: bytes.byteLength,
      });
      payloads.push({
        payloadId,
        inputIndex,
        observedType: "Raw Image",
        sourceMediaType: imageMediaType,
        ...(selected.file.type.length === 0
          ? {}
          : { browserMediaType: selected.file.type }),
        actualByteLength: bytes.byteLength,
        localSha256,
        localHashDurationMs,
        kind: "image",
        file: selected.file,
      });
      continue;
    }

    const decoded = decodePayload(bytes);
    if (!decoded.ok) {
      return invalidPackage(packagePath, [
        issue("invalid-package", decoded.code, false, selected.relativePath),
      ]);
    }
    const kind = isHttpUrl(decoded.value) ? "url" : "text";
    const mediaType = kind === "url"
      ? "text/uri-list; charset=utf-8"
      : "text/plain; charset=utf-8";
    const observedType = kind === "url" ? "Raw URL" : "Raw Text";
    descriptors.push({
      payloadId,
      inputIndex,
      observedType,
      previewKind: kind,
      path,
      mediaType,
      originalName: selected.file.name,
      sourceByteLength: bytes.byteLength,
    });
    const base = {
      payloadId,
      inputIndex,
      observedType,
      sourceMediaType: mediaType,
      ...(selected.file.type.length === 0
        ? {}
        : { browserMediaType: selected.file.type }),
      actualByteLength: bytes.byteLength,
      localSha256,
      localHashDurationMs,
    };
    payloads.push(
      kind === "url"
        ? { ...base, kind, rawUrl: decoded.value }
        : { ...base, kind, text: decoded.value },
    );
  }

  const earliestModifiedAt = selectedPayloads.reduce(
    (earliest, selected) => Math.min(earliest, selected.file.lastModified),
    Number.POSITIVE_INFINITY,
  );
  const capturedAt = rawCapturedAt(packagePath, earliestModifiedAt);
  const shardMonth = packageShardMonth(packagePath) ?? [
    capturedAt.getUTCFullYear(),
    padDatePart(capturedAt.getUTCMonth() + 1),
  ].join("-");
  const manifest: CaptureSpikeManifestV0 = {
    schemaVersion: 0,
    spikeBuild: 1,
    captureId: rawCaptureId(packagePath, capturedAt),
    capturedAt: capturedAt.toISOString(),
    shardMonth,
    transport: "ios-shortcut-spike",
    hashMode: "none",
    payloads: descriptors,
  };

  return {
    status: "ready",
    packagePath,
    packageSource: "raw",
    manifest,
    payloads,
  };
}

function previewBase(
  payload: CaptureSpikePayloadV0,
  file: File,
  bytes: ArrayBuffer,
  localSha256: string,
  localHashDurationMs: number,
): SpikePayloadPreviewBase {
  return {
    payloadId: payload.payloadId,
    inputIndex: payload.inputIndex,
    observedType: payload.observedType,
    actualByteLength: bytes.byteLength,
    localSha256,
    localHashDurationMs,
    ...(payload.mediaType === undefined
      ? {}
      : { sourceMediaType: payload.mediaType }),
    ...(file.type.length === 0 ? {} : { browserMediaType: file.type }),
    ...(payload.sourceSha256 === undefined
      ? {}
      : { sourceDigestMatches: true }),
  };
}

async function readPackage(
  packagePath: string,
  selectedByPath: ReadonlyMap<string, SelectedSpikeFile>,
  dependencies: CaptureSpikeReaderDependencies,
): Promise<SpikePackageResult> {
  const manifestPath = `${packagePath}/capture.json`;
  const selectedManifest = selectedByPath.get(manifestPath);
  if (selectedManifest === undefined) {
    return unavailablePackage(packagePath, [
      issue(
        "temporarily-unavailable",
        "manifest-read-unavailable",
        true,
        manifestPath,
      ),
    ]);
  }

  let manifestBytes: ArrayBuffer;
  try {
    manifestBytes = await dependencies.readArrayBuffer(selectedManifest.file);
  } catch (error) {
    return unavailablePackage(packagePath, [
      issue(
        "temporarily-unavailable",
        "manifest-read-unavailable",
        true,
        manifestPath,
        error,
      ),
    ]);
  }

  const parsed = parseCaptureSpikeManifestV0(manifestBytes);
  if (!parsed.ok) {
    return invalidPackage(
      packagePath,
      parsed.issues.map((manifestIssue) =>
        issue(
          "invalid-package",
          manifestIssue.code,
          false,
          manifestPath,
        ),
      ),
    );
  }
  const manifest = parsed.value;

  if (packageShardMonth(packagePath) !== manifest.shardMonth) {
    return invalidPackage(packagePath, [
      issue(
        "invalid-package",
        "shard-month-path-mismatch",
        false,
        manifestPath,
      ),
    ]);
  }

  const payloads: SpikePayloadPreview[] = [];
  for (const payload of manifest.payloads) {
    const relativePath = `${packagePath}/${payload.path}`;
    const selectedPayload = selectedByPath.get(relativePath);
    if (selectedPayload === undefined) {
      return unavailablePackage(
        packagePath,
        [
          issue(
            "temporarily-unavailable",
            "payload-missing",
            true,
            relativePath,
          ),
        ],
        manifest,
      );
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await dependencies.readArrayBuffer(selectedPayload.file);
    } catch (error) {
      return unavailablePackage(
        packagePath,
        [
          issue(
            "temporarily-unavailable",
            "payload-read-unavailable",
            true,
            relativePath,
            error,
          ),
        ],
        manifest,
      );
    }

    if (
      payload.sourceByteLength !== undefined &&
      payload.sourceByteLength !== bytes.byteLength
    ) {
      return invalidPackage(packagePath, [
        issue(
          "invalid-package",
          "source-byte-length-mismatch",
          false,
          relativePath,
        ),
      ]);
    }

    let decoded: DecodedPayload | undefined;
    if (payload.previewKind === "text" || payload.previewKind === "url") {
      const result = decodePayload(bytes);
      if (!result.ok) {
        return invalidPackage(packagePath, [
          issue("invalid-package", result.code, false, relativePath),
        ]);
      }
      decoded = result;
    }

    let localSha256: string;
    let localHashDurationMs: number;
    try {
      const startedAt = dependencies.now();
      localSha256 = await dependencies.sha256(bytes);
      localHashDurationMs = dependencies.now() - startedAt;
    } catch (error) {
      return unavailablePackage(
        packagePath,
        [
          issue(
            "temporarily-unavailable",
            "local-digest-unavailable",
            true,
            relativePath,
            error,
          ),
        ],
        manifest,
      );
    }

    if (
      payload.sourceSha256 !== undefined &&
      payload.sourceSha256 !== localSha256
    ) {
      return invalidPackage(packagePath, [
        issue(
          "invalid-package",
          "source-digest-mismatch",
          false,
          relativePath,
        ),
      ]);
    }

    const base = previewBase(
      payload,
      selectedPayload.file,
      bytes,
      localSha256,
      localHashDurationMs,
    );
    if (payload.previewKind === "text") {
      payloads.push({ ...base, kind: "text", text: decoded!.value });
    } else if (payload.previewKind === "url") {
      payloads.push({ ...base, kind: "url", rawUrl: decoded!.value });
    } else {
      payloads.push({ ...base, kind: "image", file: selectedPayload.file });
    }
  }

  return { status: "ready", packagePath, manifest, payloads };
}

export function snapshotSelectedFiles(
  files: FileList,
): readonly SelectedSpikeFile[] {
  const snapshot: SelectedSpikeFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files.item(index);
    if (file !== null) {
      snapshot.push({ file, relativePath: file.webkitRelativePath });
    }
  }
  return snapshot;
}

export async function readCaptureLogSpikeDirectory(
  files: readonly SelectedSpikeFile[],
  dependencies: CaptureSpikeReaderDependencies,
  options: {
    readonly maxPackages?: 1 | 2 | 3;
    readonly acceptRawWithoutManifest?: boolean;
    readonly newestRawFirst?: boolean;
  } = {},
): Promise<SpikeDirectoryResult> {
  const selectionIssues: SpikeReadIssue[] = [];
  const groupedByPath = new Map<string, SelectedSpikeFile[]>();

  for (const selected of files) {
    if (selected.relativePath.length === 0) {
      selectionIssues.push(
        issue(
          "invalid-selection",
          "relative-path-unavailable",
          false,
        ),
      );
      continue;
    }
    const samePath = groupedByPath.get(selected.relativePath) ?? [];
    samePath.push(selected);
    groupedByPath.set(selected.relativePath, samePath);
  }

  const selectedByPath = new Map<string, SelectedSpikeFile>();
  const presentPaths = new Set(groupedByPath.keys());
  const duplicatePaths = new Set<string>();
  for (const relativePath of [...groupedByPath.keys()].sort()) {
    const selected = groupedByPath.get(relativePath)!;
    if (selected.length > 1) {
      duplicatePaths.add(relativePath);
      selectionIssues.push(
        issue(
          "invalid-selection",
          "duplicate-selected-relative-path",
          false,
          relativePath,
        ),
      );
    } else {
      selectedByPath.set(relativePath, selected[0]!);
    }
  }

  const manifestPackagePaths = new Set(
    [...presentPaths]
      .filter((relativePath) => {
        const packagePath = inferPackagePath(relativePath);
        return (
          baseName(relativePath) === "capture.json" &&
          packagePath !== undefined &&
          parentPath(relativePath) === packagePath
        );
      })
      .map(parentPath),
  );
  const ambiguousPackagePaths = new Set(
    [...duplicatePaths]
      .map(inferPackagePath)
      .filter((packagePath): packagePath is string => packagePath !== undefined),
  );
  const rawPackagePaths = new Set(
    [...presentPaths]
      .filter((relativePath) => baseName(relativePath) !== "capture.json")
      .map(inferPackagePath)
      .filter((packagePath): packagePath is string =>
        packagePath !== undefined &&
        rawPackageTimestamp(packagePath) !== undefined &&
        !manifestPackagePaths.has(packagePath),
      ),
  );
  const candidatePackagePaths = options.acceptRawWithoutManifest === true
    ? new Set([...manifestPackagePaths, ...rawPackagePaths])
    : manifestPackagePaths;
  const allPackagePaths = [...candidatePackagePaths]
    .filter((packagePath) => !ambiguousPackagePaths.has(packagePath))
    .sort((left, right) => {
      if (options.newestRawFirst !== true) {
        return left.localeCompare(right);
      }
      const leftIsRaw = rawPackagePaths.has(left);
      const rightIsRaw = rawPackagePaths.has(right);
      if (leftIsRaw !== rightIsRaw) {
        return leftIsRaw ? -1 : 1;
      }
      return right.localeCompare(left);
    });

  const ignoredWithoutManifest = new Set<string>();
  for (const relativePath of presentPaths) {
    const packagePath = inferPackagePath(relativePath);
    if (
      packagePath !== undefined &&
      !manifestPackagePaths.has(packagePath) &&
      (options.acceptRawWithoutManifest !== true ||
        !rawPackagePaths.has(packagePath))
    ) {
      ignoredWithoutManifest.add(packagePath);
    }
  }

  const maximum = options.maxPackages ?? 3;
  const packagePaths = allPackagePaths.slice(0, maximum);
  const packages: SpikePackageResult[] = [];
  for (const packagePath of packagePaths) {
    packages.push(
      manifestPackagePaths.has(packagePath)
        ? await readPackage(packagePath, selectedByPath, dependencies)
        : await readRawPackage(packagePath, selectedByPath, dependencies),
    );
  }

  return {
    packages,
    ignoredWithoutManifest: [...ignoredWithoutManifest].sort(),
    truncatedPackageCount: allPackagePaths.length - packagePaths.length,
    selectionIssues,
  };
}

export function readCaptureDropDirectory(
  files: readonly SelectedSpikeFile[],
  dependencies: CaptureSpikeReaderDependencies,
  options: { readonly maxPackages?: 1 | 2 | 3 } = {},
): Promise<SpikeDirectoryResult> {
  return readCaptureLogSpikeDirectory(files, dependencies, {
    ...options,
    acceptRawWithoutManifest: true,
    newestRawFirst: true,
  });
}
