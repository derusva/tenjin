import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  readCaptureDropDirectory,
  type CaptureSpikeReaderDependencies,
  type SelectedSpikeFile,
  type SpikeDirectoryResult,
  type SpikePackageResult,
  type SpikePayloadPreview,
} from "./captureSpikeReader.js";
import type {
  CaptureSpikeManifestV0,
  CaptureSpikePayloadV0,
} from "./captureSpikeV0.js";
import { CaptureSpikeDiagnostic } from "./CaptureSpikeDiagnostic.js";
import { createSelectedSpikeFile } from "./test/createSpikeFiles.js";

type Inspect = typeof readCaptureDropDirectory;
type ReadyPackage = Extract<SpikePackageResult, { readonly status: "ready" }>;

const SHA = "a".repeat(64);
const CAPTURE_ID = "spike-20260712-164100-000-482731";
const CAPTURED_AT = "2026-07-12T08:41:00.000Z";
const SCRIPT_TEXT = "<script>window.__captureSpikeInjected = true</script>";

const readerDependencies: CaptureSpikeReaderDependencies = {
  readArrayBuffer: async (file) => file.arrayBuffer(),
  sha256: async () => SHA,
  now: () => 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selection(name: string): readonly SelectedSpikeFile[] {
  return [
    createSelectedSpikeFile(
      `2026-07/${name}/capture.json`,
      new TextEncoder().encode("{}").buffer as ArrayBuffer,
      "application/json",
    ),
  ];
}

function asFileList(selected: readonly SelectedSpikeFile[]): FileList {
  const files = selected.map(({ file }) => file);
  const list: { readonly length: number; item(index: number): File | null } &
    Record<number, File> = {
    length: files.length,
    item: (index) => files[index] ?? null,
  };
  files.forEach((file, index) => {
    list[index] = file;
  });
  return list as unknown as FileList;
}

function choose(input: HTMLElement, selected: readonly SelectedSpikeFile[]) {
  fireEvent.change(input, { target: { files: asFileList(selected) } });
}

function directory(
  packages: readonly SpikePackageResult[] = [],
  overrides: Partial<SpikeDirectoryResult> = {},
): SpikeDirectoryResult {
  return {
    packages,
    ignoredWithoutManifest: [],
    truncatedPackageCount: 0,
    selectionIssues: [],
    ...overrides,
  };
}

function manifest(
  payloads: readonly CaptureSpikePayloadV0[],
  overrides: Partial<CaptureSpikeManifestV0> = {},
): CaptureSpikeManifestV0 {
  return {
    schemaVersion: 0,
    spikeBuild: 1,
    captureId: CAPTURE_ID,
    capturedAt: CAPTURED_AT,
    shardMonth: "2026-07",
    transport: "ios-shortcut-spike",
    hashMode: "none",
    payloads,
    ...overrides,
  };
}

function readyPackage(options: {
  readonly captureId?: string;
  readonly payloads: readonly SpikePayloadPreview[];
  readonly descriptors: readonly CaptureSpikePayloadV0[];
  readonly manifestOverrides?: Partial<CaptureSpikeManifestV0>;
}): ReadyPackage {
  const captureId = options.captureId ?? CAPTURE_ID;
  const packagePath = `2026-07/${captureId}`;
  return {
    status: "ready",
    packagePath,
    manifest: manifest(options.descriptors, {
      captureId,
      ...options.manifestOverrides,
    }),
    payloads: options.payloads,
  };
}

function textReadyPackage(text: string, captureId = CAPTURE_ID): ReadyPackage {
  const descriptor: CaptureSpikePayloadV0 = {
    payloadId: "payload-text-1",
    inputIndex: 1,
    observedType: "Text",
    previewKind: "text",
    path: "payloads/01.txt",
  };
  return readyPackage({
    captureId,
    descriptors: [descriptor],
    payloads: [
      {
        kind: "text",
        payloadId: descriptor.payloadId,
        inputIndex: descriptor.inputIndex,
        observedType: descriptor.observedType,
        actualByteLength: new TextEncoder().encode(text).byteLength,
        localSha256: SHA,
        localHashDurationMs: 1.25,
        text,
      },
    ],
  });
}

function renderDiagnostic(inspect: Inspect) {
  return render(
    <CaptureSpikeDiagnostic
      ledgerHref="../"
      readerDependencies={readerDependencies}
      inspect={inspect}
    />,
  );
}

function renderDefaultDiagnostic() {
  return render(
    <CaptureSpikeDiagnostic
      ledgerHref="../"
      readerDependencies={readerDependencies}
    />,
  );
}

describe("CaptureSpikeDiagnostic", () => {
  it("uses the raw-drop reader by default and explains that the simplified shortcut works", async () => {
    const selected = createSelectedSpikeFile(
      "2026-07/20260714-001800-000/probe",
      new TextEncoder().encode("辞書形のまま保存する").buffer as ArrayBuffer,
    );
    renderDefaultDiagnostic();

    choose(screen.getByLabelText("选择 Tenjin 收件箱目录"), [selected]);

    const capture = await screen.findByRole("article", {
      name: "原始测试文件可读取",
    });
    expect(within(capture).getByText("辞書形のまま保存する")).toBeInTheDocument();
    expect(within(capture).getByText("由 Tenjin 自动生成元数据")).toBeInTheDocument();
    expect(within(capture).getByRole("heading", { name: "#01 · 文字" })).toBeInTheDocument();
    expect(within(capture).queryByText("sourceApp")).not.toBeInTheDocument();
    expect(within(capture).queryByText("hashMode")).not.toBeInTheDocument();
    expect(within(capture).queryByText("本地 SHA-256")).not.toBeInTheDocument();
    expect(
      screen.getByText(/不代表快捷指令安装或分享链路已经通过/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/iCloud Drive → Shortcuts → Tenjin → CaptureLogSpike/),
    ).toBeInTheDocument();
  });

  it("configures a directory picker and moves from the empty state through reading to a package result", async () => {
    const pending = deferred<SpikeDirectoryResult>();
    const inspect = vi.fn<Inspect>(() => pending.promise);
    const view = renderDiagnostic(inspect);

    expect(screen.getByRole("heading", { name: "捕获链路诊断" })).toBeInTheDocument();
    expect(screen.getByText(/不会创建 Tenjin 记录/)).toBeInTheDocument();
    expect(screen.getByText(/这里只读预览，不导入账本/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回 Tenjin" })).toHaveAttribute("href", "../");
    expect(screen.getByText("尚未选择收件箱目录")).toBeInTheDocument();
    const announcement = screen.getByRole("status");
    expect(announcement).toBeEmptyDOMElement();

    const input = screen.getByLabelText("选择 Tenjin 收件箱目录") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("multiple");
    expect(input).toHaveAttribute("webkitdirectory", "");

    const selected = selection("first");
    choose(input, selected);
    expect(screen.getByRole("status")).toHaveTextContent("正在识别");
    expect(screen.getByRole("status")).toBe(announcement);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(inspect).toHaveBeenCalledWith(
      [{ file: selected[0]!.file, relativePath: selected[0]!.relativePath }],
      readerDependencies,
    );

    await act(async () => pending.resolve(directory([textReadyPackage("第一条")])))
    expect(await screen.findByText(CAPTURE_ID)).toBeInTheDocument();
    const preview = screen.getByText("第一条");
    expect(preview).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(announcement);
    expect(announcement).toHaveTextContent("读取完成：1 个包");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(preview.closest('[aria-live], [role="status"]')).toBeNull();
    expect(
      view.container
        .querySelector(".capture-spike-results")
        ?.querySelector('[aria-live], [role="status"], [role="alert"]'),
    ).toBeNull();
  });

  it("renders the complete ready metadata, preserves payload order, and keeps captured URLs non-interactive", async () => {
    const url = "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E";
    const textDescriptor: CaptureSpikePayloadV0 = {
      payloadId: "text",
      inputIndex: 1,
      observedType: "Text",
      previewKind: "text",
      path: "payloads/01.txt",
      mediaType: "text/plain; charset=utf-8",
      sourceByteLength: 3,
      sourceSha256: SHA,
      sourceHashDurationMs: 2,
    };
    const urlDescriptor: CaptureSpikePayloadV0 = {
      payloadId: "url",
      inputIndex: 2,
      observedType: "URL",
      previewKind: "url",
      path: "payloads/02.txt",
      sourceSha256: SHA,
      sourceHashDurationMs: 3,
    };
    const result = directory([
      readyPackage({
        descriptors: [textDescriptor, urlDescriptor],
        manifestOverrides: { hashMode: "sha256" },
        payloads: [
          {
            kind: "text",
            payloadId: "text",
            inputIndex: 1,
            observedType: "Text",
            sourceMediaType: "text/plain; charset=utf-8",
            browserMediaType: "text/plain",
            actualByteLength: 3,
            localSha256: SHA,
            localHashDurationMs: 1,
            sourceDigestMatches: true,
            text: "abc",
          },
          {
            kind: "url",
            payloadId: "url",
            inputIndex: 2,
            observedType: "URL",
            actualByteLength: url.length,
            localSha256: SHA,
            localHashDurationMs: 1,
            sourceDigestMatches: true,
            rawUrl: url,
          },
        ],
      }),
    ]);
    const inspect = vi.fn<Inspect>(async () => result);
    renderDiagnostic(inspect);
    choose(screen.getByLabelText("选择 Tenjin 收件箱目录"), selection("ready"));

    const capture = await screen.findByRole("article", { name: CAPTURE_ID });
    expect(within(capture).getByText(CAPTURED_AT)).toBeInTheDocument();
    expect(within(capture).getByText("来源身份未提供")).toBeInTheDocument();
    expect(within(capture).getByText("sha256")).toBeInTheDocument();
    expect(within(capture).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "#01 · Text",
      "#02 · URL",
    ]);
    expect(within(capture).getByText("text/plain; charset=utf-8")).toBeInTheDocument();
    expect(within(capture).getByText("text/plain")).toBeInTheDocument();
    expect(within(capture).getAllByText("未提供")).toHaveLength(2);
    expect(within(capture).getAllByText(SHA)).toHaveLength(2);
    expect(within(capture).getAllByText("与源端一致")).toHaveLength(2);
    const urlPreview = [...capture.querySelectorAll("pre")].find(
      (element) => element.textContent === url,
    );
    expect(urlPreview?.tagName).toBe("PRE");
  });

  it("replaces a ready package atomically with an unavailable package and keeps iCloud and local digest copy distinct", async () => {
    const ready = directory([textReadyPackage("不得泄漏的 sibling preview")]);
    const unavailable = directory([
      {
        status: "temporarily-unavailable",
        packagePath: `2026-07/${CAPTURE_ID}`,
        issues: [
          {
            disposition: "temporarily-unavailable",
            code: "payload-read-unavailable",
            relativePath: `2026-07/${CAPTURE_ID}/payloads/01.txt`,
            retryable: true,
          },
        ],
      },
    ]);
    const digestUnavailable = directory([
      {
        status: "temporarily-unavailable",
        packagePath: `2026-07/${CAPTURE_ID}`,
        issues: [
          {
            disposition: "temporarily-unavailable",
            code: "local-digest-unavailable",
            retryable: true,
          },
        ],
      },
    ]);
    const inspect = vi
      .fn<Inspect>()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(digestUnavailable);
    renderDiagnostic(inspect);
    const input = screen.getByLabelText("选择 Tenjin 收件箱目录");

    choose(input, selection("first"));
    expect(await screen.findByText("不得泄漏的 sibling preview")).toBeInTheDocument();
    choose(input, selection("second"));
    expect(await screen.findByText(/可能仍在 iCloud 下载/)).toBeInTheDocument();
    expect(screen.queryByText("不得泄漏的 sibling preview")).not.toBeInTheDocument();

    choose(input, selection("third"));
    expect(await screen.findByText(/本机摘要计算暂不可用，请重试/)).toBeInTheDocument();
    const digestAlert = screen.getByRole("alert", {
      name: `2026-07/${CAPTURE_ID} 诊断`,
    });
    expect(digestAlert).not.toHaveTextContent("iCloud");
  });

  it("renders captured text and URLs literally as preformatted text", async () => {
    const unsafeUrl = "javascript:alert(1)\nhttps://example.com";
    const descriptors: readonly CaptureSpikePayloadV0[] = [
      { payloadId: "text", inputIndex: 1, observedType: "Text", previewKind: "text", path: "payloads/01.txt" },
      { payloadId: "url", inputIndex: 2, observedType: "URL", previewKind: "url", path: "payloads/02.txt" },
    ];
    const result = directory([
      readyPackage({
        descriptors,
        payloads: [
          { kind: "text", payloadId: "text", inputIndex: 1, observedType: "Text", actualByteLength: 1, localSha256: SHA, localHashDurationMs: 1, text: SCRIPT_TEXT },
          { kind: "url", payloadId: "url", inputIndex: 2, observedType: "URL", actualByteLength: 1, localSha256: SHA, localHashDurationMs: 1, rawUrl: unsafeUrl },
        ],
      }),
    ]);
    const inspect = vi.fn<Inspect>(async () => result);
    const view = renderDiagnostic(inspect);
    choose(screen.getByLabelText("选择 Tenjin 收件箱目录"), selection("unsafe"));

    expect(await screen.findByText(SCRIPT_TEXT)).toBeInTheDocument();
    expect(
      [...view.container.querySelectorAll("pre")].some(
        (preview) => preview.textContent === unsafeUrl,
      ),
    ).toBe(true);
    expect(view.container.querySelector("script")).toBeNull();
    expect(
      [...view.container.querySelectorAll("pre")].map(
        (preview) => preview.textContent,
      ),
    ).toEqual(expect.arrayContaining([SCRIPT_TEXT, unsafeUrl]));
  });

  it("revokes image object URLs when loading a replacement and when unmounting", async () => {
    const firstFile = new File([new Uint8Array([1])], "first.png", { type: "image/png" });
    const secondFile = new File([new Uint8Array([2])], "second.png", { type: "image/png" });
    const imagePackage = (captureId: string, file: File): ReadyPackage => {
      const descriptor: CaptureSpikePayloadV0 = { payloadId: "image", inputIndex: 1, observedType: "Photo Media", previewKind: "image", path: "payloads/01.png" };
      return readyPackage({ captureId, descriptors: [descriptor], payloads: [{ kind: "image", payloadId: "image", inputIndex: 1, observedType: "Photo Media", browserMediaType: "image/png", actualByteLength: file.size, localSha256: SHA, localHashDurationMs: 1, file }] });
    };
    const secondPending = deferred<SpikeDirectoryResult>();
    const inspect = vi
      .fn<Inspect>()
      .mockResolvedValueOnce(directory([imagePackage(CAPTURE_ID, firstFile)]))
      .mockImplementationOnce(() => secondPending.promise);
    const createObjectURL = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.fn();
    const previousCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    try {
      const view = renderDiagnostic(inspect);
      const input = screen.getByLabelText("选择 Tenjin 收件箱目录");
      choose(input, selection("image-one"));
      const firstImage = await screen.findByRole("img", { name: "捕获图片 1" });
      await waitFor(() => expect(firstImage).toHaveAttribute("src", "blob:first"));

      choose(input, selection("image-two"));
      expect(screen.queryByRole("img", { name: "捕获图片 1" })).not.toBeInTheDocument();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
      await act(async () => secondPending.resolve(directory([imagePackage("spike-20260712-164101-000-482732", secondFile)])));
      const secondImage = await screen.findByRole("img", { name: "捕获图片 1" });
      await waitFor(() => expect(secondImage).toHaveAttribute("src", "blob:second"));
      view.unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
    } finally {
      if (previousCreate === undefined) delete (URL as { createObjectURL?: unknown }).createObjectURL;
      else Object.defineProperty(URL, "createObjectURL", previousCreate);
      if (previousRevoke === undefined) delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      else Object.defineProperty(URL, "revokeObjectURL", previousRevoke);
    }
  });

  it("ignores stale reads, clears the file input for retry, and preserves a result when selection is cancelled", async () => {
    const first = deferred<SpikeDirectoryResult>();
    const second = deferred<SpikeDirectoryResult>();
    const inspect = vi.fn<Inspect>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    renderDiagnostic(inspect);
    const input = screen.getByLabelText("选择 Tenjin 收件箱目录") as HTMLInputElement;
    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "selected" });

    choose(input, selection("slow-a"));
    expect(input.value).toBe("");
    choose(input, selection("fast-b"));
    await act(async () => second.resolve(directory([textReadyPackage("结果 B", "spike-20260712-164102-000-482733")])));
    expect(await screen.findByText("结果 B")).toBeInTheDocument();
    await act(async () => first.resolve(directory([textReadyPackage("过期结果 A")])));
    expect(screen.queryByText("过期结果 A")).not.toBeInTheDocument();
    expect(screen.getByText("结果 B")).toBeInTheDocument();

    choose(input, []);
    expect(screen.getByText("结果 B")).toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("renders invalid, ignored, selection, truncation, permission, and abort diagnostics without calling them iCloud failures", async () => {
    const result = directory(
      [{ status: "invalid", packagePath: `2026-07/${CAPTURE_ID}`, issues: [{ disposition: "invalid-package", code: "manifest-invalid-json", retryable: false }] }],
      {
        ignoredWithoutManifest: ["2026-07/ignored"],
        truncatedPackageCount: 2,
        selectionIssues: [{ disposition: "invalid-selection", code: "relative-path-unavailable", retryable: false }],
      },
    );
    const notAllowed = Object.assign(new Error("private detail"), { name: "NotAllowedError" });
    const cancelled = Object.assign(new Error("private cancellation"), { name: "AbortError" });
    const inspect = vi
      .fn<Inspect>()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(notAllowed)
      .mockRejectedValueOnce(cancelled);
    renderDiagnostic(inspect);
    const input = screen.getByLabelText("选择 Tenjin 收件箱目录");

    choose(input, selection("invalid"));
    expect(await screen.findByText("manifest-invalid-json")).toBeInTheDocument();
    expect(screen.getByText(/capture.json 不是有效的 JSON/)).toBeInTheDocument();
    expect(screen.getByText(/没有提供相对路径/)).toBeInTheDocument();
    expect(screen.getByText(/保留 1 个尚未完成的旧测试目录/)).toBeInTheDocument();
    expect(screen.getByText(/已截断：还有 2 个包未读取/)).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "目录选择诊断" })).toBeInTheDocument();
    expect(
      screen.getByRole("alert", {
        name: `2026-07/${CAPTURE_ID} 诊断`,
      }),
    ).toBeInTheDocument();

    choose(input, selection("permission"));
    const permissionAlert = await screen.findByRole("alert");
    expect(permissionAlert).toHaveTextContent(/文件权限/);
    expect(permissionAlert).not.toHaveTextContent("iCloud");
    expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();

    choose(input, selection("cancelled"));
    const cancelledAlert = await screen.findByRole("alert");
    expect(cancelledAlert).toHaveTextContent(/选择已取消/);
    expect(cancelledAlert).not.toHaveTextContent("iCloud");
    expect(cancelledAlert).not.toHaveTextContent("private cancellation");
  });

  it("turns synchronous inspect failures and hostile error names into safe recoverable states", async () => {
    const hostile = {};
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("name getter escaped");
      },
    });
    const inspect = vi
      .fn<Inspect>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("synchronous private detail"), {
          name: "NotAllowedError",
        });
      })
      .mockRejectedValueOnce(hostile);
    renderDiagnostic(inspect);
    const input = screen.getByLabelText("选择 Tenjin 收件箱目录");

    expect(() => choose(input, selection("sync-throw"))).not.toThrow();
    expect(await screen.findByRole("alert")).toHaveTextContent(/文件权限/);
    expect(screen.queryByText(/synchronous private detail/)).not.toBeInTheDocument();

    choose(input, selection("hostile-name"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/读取目录失败/);
    expect(screen.queryByText(/name getter escaped/)).not.toBeInTheDocument();
  });

  it("keeps payload heading IDs unique across packages and limits live regions to state messages", async () => {
    const first = textReadyPackage("first", "spike-20260712-164103-000-482734");
    const second = textReadyPackage("second", "spike-20260712-164104-000-482735");
    const inspect = vi.fn<Inspect>(async () => directory([first, second]));
    const view = renderDiagnostic(inspect);
    choose(screen.getByLabelText("选择 Tenjin 收件箱目录"), selection("ids"));
    await screen.findByText("first");

    const payloadHeadings = screen.getAllByRole("heading", { level: 3 });
    expect(new Set(payloadHeadings.map((heading) => heading.id)).size).toBe(
      payloadHeadings.length,
    );
    expect(view.container.querySelector(".capture-spike-workbench")).not.toHaveAttribute(
      "aria-live",
    );
  });

  it("keeps local digest failures local even when the browser reports a permission-shaped name", async () => {
    const result = directory([
      {
        status: "temporarily-unavailable",
        packagePath: `2026-07/${CAPTURE_ID}`,
        issues: [
          {
            disposition: "temporarily-unavailable",
            code: "local-digest-unavailable",
            errorName: "NotAllowedError",
            retryable: true,
          },
        ],
      },
    ]);
    const inspect = vi.fn<Inspect>(async () => result);
    renderDiagnostic(inspect);
    choose(screen.getByLabelText("选择 Tenjin 收件箱目录"), selection("digest"));

    const alert = await screen.findByRole("alert", {
      name: `2026-07/${CAPTURE_ID} 诊断`,
    });
    expect(alert).toHaveTextContent("本机摘要计算暂不可用，请重试");
    expect(alert).not.toHaveTextContent(/iCloud|文件权限/);
  });

});
