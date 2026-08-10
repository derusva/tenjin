import type {
  CoachImportRepository,
  LedgerRepository,
  LedgerSnapshot,
} from "@tenjin/storage-indexeddb";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createLedgerRuntime } from "./ledgerRuntime.js";
import {
  useLedger,
  type ImportCoachBatchResult,
} from "./useLedger.js";

const NOW = "2026-08-11T01:02:03.000Z";
const DIGEST = `sha256:${"ab".repeat(32)}` as const;

function createHarness(options: {
  readonly importResult?: "imported" | "already-imported";
  readonly importError?: Error;
} = {}) {
  let snapshot: LedgerSnapshot = { events: [], contexts: [] };
  let sequence = 0;
  let uuid = 0;
  const reservationCalls: Array<{ readonly count: number }> = [];
  const readSnapshot = vi.fn(async () => snapshot);
  const appendImportedCaptureBatch = vi.fn<
    CoachImportRepository["appendImportedCaptureBatch"]
  >(async (writes) => {
    if (options.importError !== undefined) {
      throw options.importError;
    }
    const status = options.importResult ?? "imported";
    if (status === "imported") {
      snapshot = {
        events: writes.flatMap(({ events }) => [...events]),
        contexts: writes.map(({ context }) => context),
      };
    }
    return status;
  });
  const appendDiscardBatch = vi.fn<CoachImportRepository["appendDiscardBatch"]>(
    async () => undefined,
  );
  const hasImportReceipt = vi.fn<CoachImportRepository["hasImportReceipt"]>(
    async () => options.importResult === "already-imported",
  );
  const repository: LedgerRepository & CoachImportRepository = {
    async reserveEventCoordinates(_deviceId, physicalTime, count) {
      reservationCalls.push({ count });
      return Array.from({ length: count }, () => {
        sequence += 1;
        return {
          seq: sequence,
          hlc: { wallTime: physicalTime, counter: sequence - 1 },
        };
      });
    },
    async appendCapture() {},
    async appendEvents() {},
    async appendDiscard() {},
    hasImportReceipt,
    appendImportedCaptureBatch,
    appendDiscardBatch,
    readSnapshot,
    close() {},
  };
  const runtime = createLedgerRuntime({
    deviceId: "device-coach-import",
    reserveEventCoordinates: (...args) =>
      repository.reserveEventCoordinates(...args),
    now: () => new Date(NOW),
    randomUUID: () => `uuid-${++uuid}`,
    digest: async () => "cd".repeat(32),
  });

  return {
    appendDiscardBatch,
    appendImportedCaptureBatch,
    hasImportReceipt,
    readSnapshot,
    repository,
    reservationCalls,
    runtime,
  };
}

describe("useLedger Coach batches", () => {
  it("blocks every ledger write before runtime allocation after a tab yields", async () => {
    const harness = createHarness();
    const assertWritable = vi.fn(() => {
      throw new Error("runtime yielded");
    });
    const { result } = renderHook(() =>
      useLedger({
        repository: harness.repository,
        runtime: harness.runtime,
        writeGate: { assertWritable },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(
      result.current.saveCapture({
        type: "lookup",
        original: "手を打つ",
        answer: "采取措施",
      }),
    ).rejects.toThrow("runtime yielded");
    await expect(
      result.current.importCoachBatch({
        digest: DIGEST,
        items: [
          {
            sourceExcerpt: "手は打った",
            focus: "手を打つ",
            answer: "采取措施",
          },
        ],
      }),
    ).rejects.toThrow("runtime yielded");
    await expect(
      result.current.answerReview("item-1", "R", "pass"),
    ).rejects.toThrow("runtime yielded");
    await expect(
      result.current.discardCapture("capture-1", "sha256:context"),
    ).rejects.toThrow("runtime yielded");
    await expect(
      result.current.discardCaptureBatch([
        { captureId: "capture-1", contextHash: "sha256:context" },
      ]),
    ).rejects.toThrow("runtime yielded");

    expect(assertWritable).toHaveBeenCalledTimes(5);
    expect(harness.reservationCalls).toEqual([]);
    expect(harness.hasImportReceipt).not.toHaveBeenCalled();
    expect(harness.appendImportedCaptureBatch).not.toHaveBeenCalled();
    expect(harness.appendDiscardBatch).not.toHaveBeenCalled();
    expect(harness.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("builds one shared-timestamp batch and refreshes only after atomic import", async () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useLedger({ repository: harness.repository, runtime: harness.runtime }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const image = {
      blob: new Blob(["png"], { type: "image/png" }),
      mediaType: "image/png" as const,
      name: "source.png",
      byteLength: 3,
      sha256: "ef".repeat(32),
    };
    let imported: ImportCoachBatchResult | undefined;
    await act(async () => {
      imported = await result.current.importCoachBatch({
        digest: DIGEST,
        items: [
          {
            sourceExcerpt: "大丈夫、手は打ったから。",
            focus: "手を打つ",
            answer: "采取措施",
          },
          {
            sourceExcerpt: "パッとしない生徒",
            focus: "パッとしない",
            answer: "不起眼；平平无奇",
            image,
          },
        ],
      });
    });

    expect(harness.reservationCalls).toEqual([{ count: 6 }]);
    expect(harness.appendImportedCaptureBatch).toHaveBeenCalledTimes(1);
    const [writes, receipt] = harness.appendImportedCaptureBatch.mock.calls[0]!;
    expect(writes).toHaveLength(2);
    expect(writes.map(({ context }) => context)).toEqual([
      expect.objectContaining({
        original: "大丈夫、手は打ったから。",
        focus: "手を打つ",
        answer: "采取措施",
        createdAt: NOW,
      }),
      expect.objectContaining({
        original: "パッとしない生徒",
        focus: "パッとしない",
        answer: "不起眼；平平无奇",
        image,
        createdAt: NOW,
      }),
    ]);
    expect(receipt).toEqual({
      digest: DIGEST,
      importedAt: NOW,
      captureIds: writes.map(({ events }) =>
        events.find((event) => event.kind === "capture_created")!.captureId,
      ),
    });
    expect(imported).toEqual({
      status: "imported",
      captures: receipt.captureIds.map((captureId, index) => ({
        captureId,
        contextHash: writes[index]!.context.hash,
        itemId: writes[index]!.events.find(
          (event) => event.kind === "item_created",
        )!.itemId,
      })),
    });
    expect(harness.readSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot.events).toHaveLength(6);
    expect(result.current.snapshot.contexts).toHaveLength(2);
  });

  it("keeps the in-memory snapshot unchanged when atomic storage rejects", async () => {
    const harness = createHarness({ importError: new Error("write failed") });
    const { result } = renderHook(() =>
      useLedger({ repository: harness.repository, runtime: harness.runtime }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = result.current.snapshot;

    await act(async () => {
      await expect(
        result.current.importCoachBatch({
          digest: DIGEST,
          items: [
            {
              sourceExcerpt: "手は打った",
              focus: "手を打つ",
              answer: "采取措施",
            },
          ],
        }),
      ).rejects.toThrow("write failed");
    });

    expect(result.current.snapshot).toBe(before);
    expect(harness.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns a duplicate receipt without exposing unstored capture IDs", async () => {
    const harness = createHarness({ importResult: "already-imported" });
    const { result } = renderHook(() =>
      useLedger({ repository: harness.repository, runtime: harness.runtime }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let duplicate: ImportCoachBatchResult | undefined;
    await act(async () => {
      duplicate = await result.current.importCoachBatch({
        digest: DIGEST,
        items: [
          {
            sourceExcerpt: "手は打った",
            focus: "手を打つ",
            answer: "采取措施",
          },
        ],
      });
    });

    expect(duplicate).toEqual({ status: "already-imported", captures: [] });
    expect(harness.hasImportReceipt).toHaveBeenCalledWith(DIGEST);
    expect(harness.reservationCalls).toEqual([]);
    expect(harness.appendImportedCaptureBatch).not.toHaveBeenCalled();
    expect(harness.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("creates and persists every batch discard through one repository call", async () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useLedger({ repository: harness.repository, runtime: harness.runtime }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.discardCaptureBatch([
        { captureId: "capture-a", contextHash: "sha256:a" },
        { captureId: "capture-b", contextHash: "sha256:b" },
      ]);
    });

    expect(harness.reservationCalls).toEqual([{ count: 2 }]);
    expect(harness.appendDiscardBatch).toHaveBeenCalledTimes(1);
    expect(harness.appendDiscardBatch).toHaveBeenCalledWith([
      {
        event: expect.objectContaining({
          kind: "capture_discarded",
          captureId: "capture-a",
        }),
        contextHash: "sha256:a",
      },
      {
        event: expect.objectContaining({
          kind: "capture_discarded",
          captureId: "capture-b",
        }),
        contextHash: "sha256:b",
      },
    ]);
    expect(harness.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("passes the Coach receipt digest only for an import batch undo", async () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useLedger({ repository: harness.repository, runtime: harness.runtime }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.discardCaptureBatch(
        [{ captureId: "capture-coach", contextHash: "sha256:coach" }],
        DIGEST,
      );
    });

    expect(harness.appendDiscardBatch).toHaveBeenCalledWith(
      [
        {
          event: expect.objectContaining({
            kind: "capture_discarded",
            captureId: "capture-coach",
          }),
          contextHash: "sha256:coach",
        },
      ],
      DIGEST,
    );
  });
});
