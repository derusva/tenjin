import { describe, expect, it, vi } from "vitest";

import {
  CaptureImageError,
  MAX_CAPTURE_IMAGE_BYTES,
  prepareCaptureImage,
  type CaptureImageDependencies,
} from "./captureImage.js";

const DIGEST = "ab".repeat(32);

function dependenciesFor(
  bytes: Uint8Array,
  digest = DIGEST,
): CaptureImageDependencies {
  return {
    readArrayBuffer: vi.fn(async () => bytes.slice().buffer),
    sha256: vi.fn(async () => digest),
    validatePreview: vi.fn(async () => undefined),
  };
}

describe("prepareCaptureImage", () => {
  it.each([
    {
      name: "extensionless JPEG by magic bytes",
      fileName: "IMG_0001",
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
      mediaType: "image/jpeg",
    },
    {
      name: "extensionless PNG by magic bytes",
      fileName: "clipboard-image",
      bytes: Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
      mediaType: "image/png",
    },
    {
      name: "extensionless HEIC by magic bytes",
      fileName: "IMG_0002",
      bytes: Uint8Array.from([
        0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      ]),
      mediaType: "image/heic",
    },
    {
      name: "extensionless HEIF by magic bytes",
      fileName: "IMG_0003",
      bytes: Uint8Array.from([
        0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
      ]),
      mediaType: "image/heif",
    },
  ] as const)("recognizes $name and returns persistent metadata", async ({
    fileName,
    bytes,
    mediaType,
  }) => {
    const dependencies = dependenciesFor(bytes, DIGEST.toUpperCase());
    const file = new File([bytes], fileName);

    const image = await prepareCaptureImage(file, dependencies);

    expect(image).toMatchObject({
      mediaType,
      name: fileName,
      byteLength: bytes.byteLength,
      sha256: DIGEST,
    });
    expect(image.blob).toBeInstanceOf(Blob);
    expect(image.blob.size).toBe(bytes.byteLength);
    expect(image.blob.type).toBe(mediaType);
    expect(dependencies.readArrayBuffer).toHaveBeenCalledTimes(1);
    expect(dependencies.sha256).toHaveBeenCalledTimes(1);
    expect(dependencies.validatePreview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a misleading extension", "photo.png", ""],
    ["a misleading browser MIME", "photo", "image/png"],
  ] as const)("rejects arbitrary bytes with %s", async (_case, name, type) => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);

    await expect(
      prepareCaptureImage(
        new File([bytes], name, { type }),
        dependenciesFor(bytes),
      ),
    ).rejects.toMatchObject({
      code: "unsupported-image",
    } satisfies Partial<CaptureImageError>);
  });

  it("rejects unsupported and oversized files before persistence", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    await expect(
      prepareCaptureImage(
        new File([bytes], "notes.txt", { type: "text/plain" }),
        dependenciesFor(bytes),
      ),
    ).rejects.toMatchObject({
      code: "unsupported-image",
    } satisfies Partial<CaptureImageError>);

    const readArrayBuffer = vi.fn(async () => bytes.slice().buffer);
    const oversized = {
      name: "large.png",
      size: MAX_CAPTURE_IMAGE_BYTES + 1,
      type: "image/png",
    } as File;
    await expect(
      prepareCaptureImage(oversized, {
        readArrayBuffer,
        sha256: async () => DIGEST,
        validatePreview: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "file-too-large",
    } satisfies Partial<CaptureImageError>);
    expect(readArrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an invalid digest instead of persisting unverifiable bytes", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);

    await expect(
      prepareCaptureImage(
        new File([bytes], "photo.jpg"),
        dependenciesFor(bytes, "not-a-sha256"),
      ),
    ).rejects.toMatchObject({
      code: "digest-failed",
    } satisfies Partial<CaptureImageError>);
  });

  it("rejects a supported file when the current browser cannot preview it", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);
    const dependencies: CaptureImageDependencies = {
      ...dependenciesFor(bytes),
      validatePreview: vi.fn(async () => {
        throw new Error("decode failed");
      }),
    };

    await expect(
      prepareCaptureImage(
        new File([bytes], "photo.jpg"),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "preview-failed",
    } satisfies Partial<CaptureImageError>);
  });
});
