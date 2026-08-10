import type { HybridLogicalClock, LearningChannel } from "@tenjin/core";
import type { EventCoordinate } from "@tenjin/storage-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { IMAGE_ONLY_CAPTURE_ORIGINAL } from "../capture/createCapture.js";
import {
  createLedgerRuntime,
  type LedgerRuntimeOptions,
} from "./ledgerRuntime.js";

const EARLIER = "2026-07-11T01:00:00.000Z";
const LATER = "2026-07-11T02:00:00.000Z";

interface ReservationCall {
  readonly deviceId: string;
  readonly physicalTime: number;
  readonly count: number;
}

function createAllocator(options: {
  readonly startSequence?: number;
  readonly initialHlc?: HybridLogicalClock;
  readonly rejectWith?: Error;
} = {}): {
  readonly calls: ReservationCall[];
  readonly reserveEventCoordinates: LedgerRuntimeOptions["reserveEventCoordinates"];
} {
  let sequence = options.startSequence ?? 0;
  let lastHlc = options.initialHlc;
  const calls: ReservationCall[] = [];

  return {
    calls,
    async reserveEventCoordinates(deviceId, physicalTime, count) {
      calls.push({ deviceId, physicalTime, count });
      if (options.rejectWith !== undefined) {
        throw options.rejectWith;
      }

      const coordinates: EventCoordinate[] = [];
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        if (lastHlc === undefined || physicalTime > lastHlc.wallTime) {
          lastHlc = { wallTime: physicalTime, counter: 0 };
        } else {
          lastHlc = {
            wallTime: lastHlc.wallTime,
            counter: lastHlc.counter + 1,
          };
        }
        coordinates.push({ seq: sequence, hlc: lastHlc });
      }
      return coordinates;
    },
  };
}

function runtimeHarness(options: {
  readonly dates?: readonly string[];
  readonly digests?: readonly string[];
  readonly startSequence?: number;
  readonly initialHlc?: HybridLogicalClock;
} = {}) {
  const dates = [...(options.dates ?? [LATER])];
  const uuids = ["capture-uuid", "item-uuid", "next-uuid"];
  let fallbackUuid = 0;
  const digestInputs: string[] = [];
  const digests = [...(options.digests ?? ["A1B2C3"])];
  let nowCallCount = 0;
  const allocator = createAllocator({
    ...(options.startSequence === undefined
      ? {}
      : { startSequence: options.startSequence }),
    ...(options.initialHlc === undefined
      ? {}
      : { initialHlc: options.initialHlc }),
  });

  const runtime = createLedgerRuntime({
    deviceId: "device-local",
    reserveEventCoordinates: allocator.reserveEventCoordinates,
    now: () => {
      nowCallCount += 1;
      return new Date(dates.shift() ?? LATER);
    },
    randomUUID: () => uuids.shift() ?? `fallback-uuid-${++fallbackUuid}`,
    digest: async (text) => {
      digestInputs.push(text);
      return digests.shift() ?? "d00d";
    },
  });

  return {
    allocator,
    digestInputs,
    nowCalls: () => nowCallCount,
    runtime,
  };
}

describe("createLedgerRuntime", () => {
  it("rejects a blank device ID before creating runtime state", () => {
    const allocator = createAllocator();

    expect(() =>
      createLedgerRuntime({
        deviceId: "  ",
        reserveEventCoordinates: allocator.reserveEventCoordinates,
        now: () => new Date(LATER),
        randomUUID: () => "uuid",
        digest: async () => "abc",
      }),
    ).toThrow("deviceId");
  });

  it("uses one reserved coordinate range for every event in a promoted capture", async () => {
    const initialHlc = { wallTime: Date.parse(EARLIER), counter: 4 };
    const { allocator, digestInputs, runtime } = runtimeHarness({
      startSequence: 7,
      initialHlc,
    });

    const transaction = await runtime.createCapture({
      type: "lookup",
      original: "  Tenjin  ",
    });

    expect(allocator.calls).toEqual([
      {
        deviceId: "device-local",
        physicalTime: Date.parse(LATER),
        count: 3,
      },
    ]);
    expect(
      transaction.events.map(({ eventId, seq, hlc }) => ({
        eventId,
        seq,
        hlc,
      })),
    ).toEqual([
      {
        eventId: "device-local:8",
        seq: 8,
        hlc: { wallTime: Date.parse(LATER), counter: 0 },
      },
      {
        eventId: "device-local:9",
        seq: 9,
        hlc: { wallTime: Date.parse(LATER), counter: 1 },
      },
      {
        eventId: "device-local:10",
        seq: 10,
        hlc: { wallTime: Date.parse(LATER), counter: 2 },
      },
    ]);
    expect(transaction.events[0]).toMatchObject({
      captureId: "capture-capture-uuid",
      contextHash: "sha256:a1b2c3",
    });
    expect(transaction.events[1]).toMatchObject({ itemId: "item-item-uuid" });
    expect(digestInputs).toEqual([JSON.stringify({ original: "Tenjin" })]);
  });

  it("includes lookup focus in the digest without replacing the source excerpt", async () => {
    const { digestInputs, runtime } = runtimeHarness({
      digests: ["FACE"],
    });

    const transaction = await runtime.createCapture({
      type: "lookup",
      original: "大丈夫、手は打ったから。",
      focus: "手を打つ",
      answer: "采取措施",
    });

    expect(digestInputs).toEqual([
      '{"original":"大丈夫、手は打ったから。","focus":"手を打つ","answer":"采取措施"}',
    ]);
    expect(transaction.context).toMatchObject({
      hash: "sha256:face",
      original: "大丈夫、手は打ったから。",
      focus: "手を打つ",
      answer: "采取措施",
    });
  });

  it("hashes corrected context with deterministic property order", async () => {
    const { digestInputs, runtime } = runtimeHarness({
      digests: ["ABCDEF0123"],
    });

    const transaction = await runtime.createCapture({
      type: "production_correction",
      original: "話すです",
      corrected: "話します",
    });

    expect(digestInputs).toEqual([
      JSON.stringify({ original: "話すです", corrected: "話します" }),
    ]);
    expect(transaction.context.hash).toBe("sha256:abcdef0123");
  });

  it("hashes lookup answer and image SHA-256 in deterministic property order", async () => {
    const { digestInputs, runtime } = runtimeHarness({
      digests: ["F00D"],
    });
    const imageSha256 = "ab".repeat(32);

    const transaction = await runtime.createCapture({
      type: "lookup",
      original: "",
      answer: "在当前语境中的意思",
      image: {
        blob: new Blob(["png"], { type: "image/png" }),
        mediaType: "image/png",
        name: "lesson.png",
        byteLength: 3,
        sha256: imageSha256,
      },
    });

    expect(digestInputs).toEqual([
      JSON.stringify({
        original: IMAGE_ONLY_CAPTURE_ORIGINAL,
        answer: "在当前语境中的意思",
        imageSha256,
      }),
    ]);
    expect(transaction.context).toMatchObject({
      hash: "sha256:f00d",
      original: IMAGE_ONLY_CAPTURE_ORIGINAL,
      answer: "在当前语境中的意思",
      image: {
        name: "lesson.png",
        sha256: imageSha256,
      },
    });
  });

  it("reserves only one coordinate for an unpromoted correction capture", async () => {
    const { allocator, runtime } = runtimeHarness();

    const transaction = await runtime.createCapture({
      type: "production_correction",
      original: "話すです",
      corrected: "   ",
    });

    expect(transaction.promoted).toBe(false);
    expect(transaction.events).toHaveLength(1);
    expect(allocator.calls).toEqual([
      {
        deviceId: "device-local",
        physicalTime: Date.parse(LATER),
        count: 1,
      },
    ]);
  });

  it("rejects an empty capture before reserving coordinates", async () => {
    const { allocator, digestInputs, runtime } = runtimeHarness();

    await expect(
      runtime.createCapture({ type: "lookup", original: "  " }),
    ).rejects.toThrow("original");
    expect(allocator.calls).toEqual([]);
    expect(digestInputs).toEqual([]);
  });

  it("rejects an explicitly blank focus before reserving coordinates", async () => {
    const { allocator, digestInputs, nowCalls, runtime } = runtimeHarness();

    await expect(
      runtime.createCapture({
        type: "lookup",
        original: "手は打った",
        focus: " \n ",
      }),
    ).rejects.toThrow("focus");
    expect(allocator.calls).toEqual([]);
    expect(digestInputs).toEqual([]);
    expect(nowCalls()).toBe(0);
  });

  it.each([1, 2, 3])(
    "builds a %i-item lookup batch from one reservation and one timestamp",
    async (commandCount) => {
      const { allocator, digestInputs, nowCalls, runtime } = runtimeHarness({
        dates: [LATER, EARLIER],
      });
      const commands = Array.from({ length: commandCount }, (_value, index) => ({
        type: "lookup" as const,
        original: `来源句 ${index + 1}`,
        focus: `学习点 ${index + 1}`,
        answer: `解释 ${index + 1}`,
      }));

      const transactions = await runtime.createCaptureBatch(commands);

      expect(allocator.calls).toEqual([
        {
          deviceId: "device-local",
          physicalTime: Date.parse(LATER),
          count: commandCount * 3,
        },
      ]);
      expect(nowCalls()).toBe(1);
      expect(transactions).toHaveLength(commandCount);
      expect(transactions.flatMap(({ events }) => events)).toHaveLength(
        commandCount * 3,
      );
      expect(
        transactions.flatMap(({ events }) =>
          events.map(({ occurredAt }) => occurredAt),
        ),
      ).toEqual(Array.from({ length: commandCount * 3 }, () => LATER));
      expect(
        transactions.map(({ events }) =>
          events.find((event) => event.kind === "item_created"),
        ),
      ).toEqual(
        commands.map((command) =>
          expect.objectContaining({
            payload: expect.objectContaining({
              display: command.focus,
              identityKey: `focus:${command.focus}`,
            }),
          }),
        ),
      );
      expect(digestInputs).toEqual(
        commands.map((command) => JSON.stringify({
          original: command.original,
          focus: command.focus,
          answer: command.answer,
        })),
      );
    },
  );

  it("validates every lookup command before time, reservation, or hashing", async () => {
    const { allocator, digestInputs, nowCalls, runtime } = runtimeHarness();

    await expect(
      runtime.createCaptureBatch([
        {
          type: "lookup",
          original: "来源句",
          focus: "学习点",
          answer: "解释",
        },
        {
          type: "lookup",
          original: "另一句",
          focus: " \n ",
          answer: "解释",
        },
      ]),
    ).rejects.toThrow("focus");

    expect(nowCalls()).toBe(0);
    expect(allocator.calls).toEqual([]);
    expect(digestInputs).toEqual([]);
  });

  it.each([0, 4])("rejects a %i-item batch before side effects", async (size) => {
    const { allocator, digestInputs, nowCalls, runtime } = runtimeHarness();
    const commands = Array.from({ length: size }, (_value, index) => ({
      type: "lookup" as const,
      original: `来源句 ${index + 1}`,
      focus: `学习点 ${index + 1}`,
      answer: `解释 ${index + 1}`,
    }));

    await expect(runtime.createCaptureBatch(commands)).rejects.toThrow(
      "between 1 and 3",
    );
    expect(nowCalls()).toBe(0);
    expect(allocator.calls).toEqual([]);
    expect(digestInputs).toEqual([]);
  });

  it("keeps physical time scoped to each overlapping capture", async () => {
    const resolutions = new Map<string, (digest: string) => void>();
    const dates = [new Date(EARLIER), new Date(LATER)];
    const allocator = createAllocator();
    const runtime = createLedgerRuntime({
      deviceId: "device-local",
      reserveEventCoordinates: allocator.reserveEventCoordinates,
      now: () => dates.shift() ?? new Date(LATER),
      randomUUID: () => "uuid",
      digest: (text) =>
        new Promise<string>((resolve) => {
          resolutions.set(text, resolve);
        }),
    });

    const firstPromise = runtime.createCapture({
      type: "lookup",
      original: "first",
    });
    const secondPromise = runtime.createCapture({
      type: "lookup",
      original: "second",
    });

    await vi.waitFor(() => {
      expect(resolutions.has(JSON.stringify({ original: "first" }))).toBe(
        true,
      );
      expect(resolutions.has(JSON.stringify({ original: "second" }))).toBe(
        true,
      );
    });
    resolutions.get(JSON.stringify({ original: "first" }))?.("aa");
    const first = await firstPromise;
    expect(first.events.map((event) => event.occurredAt)).toEqual([
      EARLIER,
      EARLIER,
      EARLIER,
    ]);

    resolutions.get(JSON.stringify({ original: "second" }))?.("bb");
    const second = await secondPromise;
    expect(second.events.map((event) => event.occurredAt)).toEqual([
      LATER,
      LATER,
      LATER,
    ]);
    expect(allocator.calls.map(({ physicalTime }) => physicalTime)).toEqual([
      Date.parse(EARLIER),
      Date.parse(LATER),
    ]);
  });

  it.each<{
    readonly channel: LearningChannel;
    readonly result: "pass" | "hesitant" | "fail";
  }>([
    { channel: "R", result: "pass" },
    { channel: "L", result: "hesitant" },
    { channel: "P", result: "fail" },
  ])(
    "creates a $channel $result review verification from one reserved coordinate",
    async ({ channel, result }) => {
      const { allocator, runtime } = runtimeHarness();

      const event = await runtime.createVerification(
        "item-42",
        channel,
        result,
      );

      expect(allocator.calls).toEqual([
        {
          deviceId: "device-local",
          physicalTime: Date.parse(LATER),
          count: 1,
        },
      ]);
      expect(event).toMatchObject({
        schemaVersion: 1,
        eventId: "device-local:1",
        deviceId: "device-local",
        seq: 1,
        occurredAt: LATER,
        recordedAt: LATER,
        actor: "user",
        kind: "verification_observed",
        ruleVersion: "vertical-slice-v1",
        itemId: "item-42",
        payload: {
          channel,
          result,
          probeSource: "review",
          immediateRetest: false,
        },
      });
    },
  );

  it("creates an undo discard event from one reserved coordinate", async () => {
    const { allocator, runtime } = runtimeHarness();

    const event = await runtime.createDiscard("capture-42");

    expect(allocator.calls).toEqual([
      {
        deviceId: "device-local",
        physicalTime: Date.parse(LATER),
        count: 1,
      },
    ]);
    expect(event).toMatchObject({
      schemaVersion: 1,
      eventId: "device-local:1",
      deviceId: "device-local",
      seq: 1,
      actor: "user",
      kind: "capture_discarded",
      ruleVersion: "vertical-slice-v1",
      captureId: "capture-42",
      payload: { reason: "undo" },
    });
  });

  it("creates one reserved discard range for a Coach import batch", async () => {
    const { allocator, nowCalls, runtime } = runtimeHarness();

    const events = await runtime.createDiscardBatch([
      "capture-a",
      "capture-b",
      "capture-c",
    ]);

    expect(nowCalls()).toBe(1);
    expect(allocator.calls).toEqual([
      {
        deviceId: "device-local",
        physicalTime: Date.parse(LATER),
        count: 3,
      },
    ]);
    expect(
      events.map(({ eventId, captureId, occurredAt }) => ({
        eventId,
        captureId,
        occurredAt,
      })),
    ).toEqual([
      {
        eventId: "device-local:1",
        captureId: "capture-a",
        occurredAt: LATER,
      },
      {
        eventId: "device-local:2",
        captureId: "capture-b",
        occurredAt: LATER,
      },
      {
        eventId: "device-local:3",
        captureId: "capture-c",
        occurredAt: LATER,
      },
    ]);
  });

  it.each([
    [[], "between 1 and 3"],
    [["capture-a", "capture-a"], "repeat"],
    [[" capture-a"], "canonical"],
  ] as const)(
    "rejects an invalid discard batch before side effects",
    async (captureIds, expectedMessage) => {
      const { allocator, nowCalls, runtime } = runtimeHarness();

      await expect(runtime.createDiscardBatch(captureIds)).rejects.toThrow(
        expectedMessage,
      );
      expect(nowCalls()).toBe(0);
      expect(allocator.calls).toEqual([]);
    },
  );

  it("does not emit an event when coordinate reservation fails", async () => {
    const allocator = createAllocator({
      rejectWith: new Error("allocator unavailable"),
    });
    const runtime = createLedgerRuntime({
      deviceId: "device-local",
      reserveEventCoordinates: allocator.reserveEventCoordinates,
      now: () => new Date(LATER),
      randomUUID: () => "uuid",
      digest: async () => "abc",
    });

    await expect(
      runtime.createVerification("item-42", "R", "pass"),
    ).rejects.toThrow("allocator unavailable");
  });
});
