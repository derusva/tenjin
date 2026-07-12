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
  options: { readonly maxPackages?: 1 | 2 | 3 } = {},
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
  for (const relativePath of [...groupedByPath.keys()].sort()) {
    const selected = groupedByPath.get(relativePath)!;
    if (selected.length > 1) {
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

  const allPackagePaths = [...selectedByPath.keys()]
    .filter((relativePath) => {
      const packagePath = inferPackagePath(relativePath);
      return (
        baseName(relativePath) === "capture.json" &&
        packagePath !== undefined &&
        parentPath(relativePath) === packagePath
      );
    })
    .map(parentPath)
    .sort();
  const manifestPackagePaths = new Set(allPackagePaths);

  const ignoredWithoutManifest = new Set<string>();
  for (const relativePath of selectedByPath.keys()) {
    const packagePath = inferPackagePath(relativePath);
    if (
      packagePath !== undefined &&
      !manifestPackagePaths.has(packagePath)
    ) {
      ignoredWithoutManifest.add(packagePath);
    }
  }

  const maximum = options.maxPackages ?? 3;
  const packagePaths = allPackagePaths.slice(0, maximum);
  const packages: SpikePackageResult[] = [];
  for (const packagePath of packagePaths) {
    packages.push(
      await readPackage(packagePath, selectedByPath, dependencies),
    );
  }

  return {
    packages,
    ignoredWithoutManifest: [...ignoredWithoutManifest].sort(),
    truncatedPackageCount: allPackagePaths.length - packagePaths.length,
    selectionIssues,
  };
}
