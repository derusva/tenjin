import {
  MAX_CONTEXT_IMAGE_BYTES,
  type ContextImageMediaType,
  type ContextImageRecord,
} from "@tenjin/storage-indexeddb";

export const MAX_CAPTURE_IMAGE_BYTES = MAX_CONTEXT_IMAGE_BYTES;

export type CaptureImageIssueCode =
  | "empty-file"
  | "file-too-large"
  | "unsupported-image"
  | "read-failed"
  | "digest-failed"
  | "preview-failed";

export class CaptureImageError extends Error {
  readonly code: CaptureImageIssueCode;

  constructor(code: CaptureImageIssueCode, message: string) {
    super(message);
    this.name = "CaptureImageError";
    this.code = code;
  }
}

export interface CaptureImageDependencies {
  readonly readArrayBuffer: (file: File) => Promise<ArrayBuffer>;
  readonly sha256: (bytes: ArrayBuffer) => Promise<string>;
  readonly validatePreview: (blob: Blob) => Promise<void>;
}

const SHA256_HEXADECIMAL = /^[a-f0-9]{64}$/;

function mediaTypeFromMagicBytes(
  bytes: ArrayBuffer,
): ContextImageMediaType | undefined {
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

async function browserSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function validateBrowserPreview(blob: Blob): Promise<void> {
  const source = URL.createObjectURL(blob);
  try {
    const image = new Image();
    if (typeof image.decode === "function") {
      image.src = source;
      await image.decode();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("image preview failed")),
        { once: true },
      );
      image.src = source;
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

const BROWSER_DEPENDENCIES: CaptureImageDependencies = {
  readArrayBuffer: (file) => file.arrayBuffer(),
  sha256: browserSha256,
  validatePreview: validateBrowserPreview,
};

export async function prepareCaptureImage(
  file: File,
  dependencies: CaptureImageDependencies = BROWSER_DEPENDENCIES,
): Promise<ContextImageRecord> {
  if (file.size <= 0) {
    throw new CaptureImageError("empty-file", "图片文件是空的");
  }
  if (file.size > MAX_CAPTURE_IMAGE_BYTES) {
    throw new CaptureImageError(
      "file-too-large",
      "图片不能超过 20 MB",
    );
  }
  if (file.name.trim().length === 0) {
    throw new CaptureImageError(
      "unsupported-image",
      "图片文件名不可为空",
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await dependencies.readArrayBuffer(file);
  } catch {
    throw new CaptureImageError("read-failed", "无法读取这张图片");
  }
  if (bytes.byteLength !== file.size) {
    throw new CaptureImageError(
      "read-failed",
      "图片读取不完整，请重新选择",
    );
  }

  const mediaType = mediaTypeFromMagicBytes(bytes);
  if (mediaType === undefined) {
    throw new CaptureImageError(
      "unsupported-image",
      "图片内容不是有效的 JPEG、PNG、HEIC 或 HEIF",
    );
  }

  let sha256: string;
  try {
    sha256 = (await dependencies.sha256(bytes)).toLowerCase();
  } catch {
    throw new CaptureImageError(
      "digest-failed",
      "无法计算图片摘要，请重试",
    );
  }
  if (!SHA256_HEXADECIMAL.test(sha256)) {
    throw new CaptureImageError(
      "digest-failed",
      "图片摘要无效，请重试",
    );
  }

  const blob = file.slice(0, file.size, mediaType);
  try {
    await dependencies.validatePreview(blob);
  } catch {
    throw new CaptureImageError(
      "preview-failed",
      "当前浏览器无法预览这张图片，请改用 JPEG 或 PNG",
    );
  }

  return {
    blob,
    mediaType,
    name: file.name,
    byteLength: bytes.byteLength,
    sha256,
  };
}
