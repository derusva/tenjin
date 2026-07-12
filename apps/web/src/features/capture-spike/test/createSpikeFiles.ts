import type {
  CaptureSpikeManifestV0,
  CaptureSpikePayloadV0,
} from "../captureSpikeV0.js";

export const SPIKE_CAPTURE_ID = "spike-20260712-164100-000-482731";
export const SPIKE_CAPTURED_AT = "2026-07-12T08:41:00.000Z";
export const SPIKE_SHA256 = "a".repeat(64);
export const SPIKE_JAPANESE_TEXT = "日本語をそのまま保存する。";

export interface SpikeFixturePayload {
  readonly descriptor: CaptureSpikePayloadV0;
  readonly bytes: ArrayBuffer;
}

export interface SpikeFilesFixture {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly captureJson: ArrayBuffer;
  readonly payloads: readonly SpikeFixturePayload[];
}

export interface CreateSpikeFilesOptions {
  readonly manifestOverrides?: Readonly<Record<string, unknown>>;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function encodeSpikeManifest(value: unknown): ArrayBuffer {
  return copyArrayBuffer(new TextEncoder().encode(JSON.stringify(value)));
}

export function createSpikeFiles(
  options: CreateSpikeFilesOptions = {},
): SpikeFilesFixture {
  const textBytes = new TextEncoder().encode(SPIKE_JAPANESE_TEXT);
  const pngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
    1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68,
    65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0,
    0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const payloads = [
    {
      payloadId: "payload-text-1",
      inputIndex: 1,
      observedType: "Text",
      previewKind: "text",
      path: "payloads/01.txt",
      mediaType: "text/plain; charset=utf-8",
      originalName: "学習メモ.txt",
      sourceByteLength: textBytes.byteLength,
    },
    {
      payloadId: "payload-image-2",
      inputIndex: 2,
      observedType: "Photo Media",
      previewKind: "image",
      path: "payloads/02.png",
      mediaType: "image/png",
      originalName: "問題.png",
      sourceByteLength: pngBytes.byteLength,
    },
  ] satisfies readonly CaptureSpikePayloadV0[];
  const baseManifest = {
    schemaVersion: 0,
    spikeBuild: 1,
    captureId: SPIKE_CAPTURE_ID,
    capturedAt: SPIKE_CAPTURED_AT,
    shardMonth: "2026-07",
    transport: "ios-shortcut-spike",
    hashMode: "none",
    payloads,
  } satisfies CaptureSpikeManifestV0;
  const manifest: Readonly<Record<string, unknown>> = {
    ...baseManifest,
    ...options.manifestOverrides,
  };

  return {
    manifest,
    captureJson: encodeSpikeManifest(manifest),
    payloads: [
      {
        descriptor: payloads[0]!,
        bytes: copyArrayBuffer(textBytes),
      },
      {
        descriptor: payloads[1]!,
        bytes: copyArrayBuffer(pngBytes),
      },
    ],
  };
}
