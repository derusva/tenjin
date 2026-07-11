import type { HybridLogicalClock } from "@tenjin/core";
import type { ContextRecord, LedgerRepository } from "@tenjin/storage-indexeddb";
import { describe, expect, it } from "vitest";

import {
  createCapture,
  type CaptureCommand,
  type CaptureDependencies,
  type CaptureTransaction,
} from "./createCapture.js";

const CAPTURED_AT = "2026-07-11T08:15:30.000Z";

interface DependencyHarness {
  readonly dependencies: CaptureDependencies;
  readonly hashedContexts: Array<{
    original: string;
    corrected?: string;
  }>;
  readonly nowCalls: () => number;
}

function createDependencyHarness(): DependencyHarness {
  const ids = {
    capture: 0,
    item: 0,
    event: 0,
  };
  const hashedContexts: Array<{
    original: string;
    corrected?: string;
  }> = [];
  let sequence = 0;
  let nowCallCount = 0;

  return {
    dependencies: {
      deviceId: "device-1",
      now: () => {
        nowCallCount += 1;
        return new Date(CAPTURED_AT);
      },
      nextId: (prefix) => {
        ids[prefix] += 1;
        return `${prefix}-${ids[prefix]}`;
      },
      nextSequence: () => {
        sequence += 1;
        return {
          seq: sequence,
          hlc: {
            wallTime: Date.parse(CAPTURED_AT),
            counter: sequence - 1,
          } satisfies HybridLogicalClock,
        };
      },
      hashContext: async (context) => {
        hashedContexts.push({ ...context });
        return "sha256:context-1";
      },
    },
    hashedContexts,
    nowCalls: () => nowCallCount,
  };
}

function expectRepositoryCompatible(
  repository: Pick<LedgerRepository, "appendCapture">,
  transaction: CaptureTransaction,
): Promise<void> {
  return repository.appendCapture(transaction.events, transaction.context);
}

describe("createCapture", () => {
  it("creates the lookup capture, R item, and observation chain", async () => {
    const harness = createDependencyHarness();

    const transaction = await createCapture(
      {
        type: "lookup",
        original: "  ＴｅｎＪｉｎ  ",
        captureDurationMs: 4_200,
      },
      harness.dependencies,
    );

    expect(transaction).toEqual({
      promoted: true,
      context: {
        hash: "sha256:context-1",
        original: "ＴｅｎＪｉｎ",
        createdAt: CAPTURED_AT,
      } satisfies ContextRecord,
      events: [
        {
          schemaVersion: 1,
          eventId: "event-1",
          deviceId: "device-1",
          seq: 1,
          hlc: {
            wallTime: Date.parse(CAPTURED_AT),
            counter: 0,
          },
          occurredAt: CAPTURED_AT,
          recordedAt: CAPTURED_AT,
          actor: "user",
          kind: "capture_created",
          ruleVersion: "vertical-slice-v1",
          captureId: "capture-1",
          contextHash: "sha256:context-1",
          payload: {
            captureType: "lookup",
            captureDurationMs: 4_200,
          },
        },
        {
          schemaVersion: 1,
          eventId: "event-2",
          deviceId: "device-1",
          seq: 2,
          hlc: {
            wallTime: Date.parse(CAPTURED_AT),
            counter: 1,
          },
          occurredAt: CAPTURED_AT,
          recordedAt: CAPTURED_AT,
          actor: "user",
          kind: "item_created",
          ruleVersion: "vertical-slice-v1",
          captureId: "capture-1",
          itemId: "item-1",
          refs: ["event-1"],
          payload: {
            display: "ＴｅｎＪｉｎ",
            identityKey: "tenjin",
            targetChannels: ["R"],
          },
        },
        {
          schemaVersion: 1,
          eventId: "event-3",
          deviceId: "device-1",
          seq: 3,
          hlc: {
            wallTime: Date.parse(CAPTURED_AT),
            counter: 2,
          },
          occurredAt: CAPTURED_AT,
          recordedAt: CAPTURED_AT,
          actor: "user",
          kind: "lookup_observed",
          ruleVersion: "vertical-slice-v1",
          captureId: "capture-1",
          itemId: "item-1",
          refs: ["event-1"],
          payload: {
            channel: "R",
            result: "lookup",
          },
        },
      ],
    });
    expect(harness.hashedContexts).toEqual([
      { original: "ＴｅｎＪｉｎ" },
    ]);
    expect(harness.nowCalls()).toBe(1);
    expect(JSON.stringify(transaction.events[0])).not.toContain("ＴｅｎＪｉｎ");

    const repository = {
      appendCapture: async () => undefined,
    } satisfies Pick<LedgerRepository, "appendCapture">;
    await expect(expectRepositoryCompatible(repository, transaction)).resolves.toBeUndefined();
  });

  it("creates the listening-miss capture, L item, and observation chain", async () => {
    const harness = createDependencyHarness();

    const transaction = await createCapture(
      {
        type: "listening_miss",
        original: "  聞き取れない  ",
      },
      harness.dependencies,
    );

    expect(transaction.promoted).toBe(true);
    expect(transaction.context).toEqual({
      hash: "sha256:context-1",
      original: "聞き取れない",
      createdAt: CAPTURED_AT,
    });
    expect(transaction.events.map((event) => event.kind)).toEqual([
      "capture_created",
      "item_created",
      "listening_miss_observed",
    ]);
    expect(transaction.events[0]?.payload).toEqual({
      captureType: "listening_miss",
    });
    expect(transaction.events[1]).toMatchObject({
      captureId: "capture-1",
      itemId: "item-1",
      refs: ["event-1"],
      payload: {
        display: "聞き取れない",
        identityKey: "聞き取れない",
        targetChannels: ["L"],
      },
    });
    expect(transaction.events[2]).toMatchObject({
      captureId: "capture-1",
      itemId: "item-1",
      refs: ["event-1"],
      payload: {
        channel: "L",
        result: "miss",
      },
    });
    expect(harness.hashedContexts).toEqual([
      { original: "聞き取れない" },
    ]);
    expect(harness.nowCalls()).toBe(1);
  });

  it("uses the correction for the context, P item, and observation chain", async () => {
    const harness = createDependencyHarness();

    const transaction = await createCapture(
      {
        type: "production_correction",
        original: "  話すです  ",
        corrected: "  話します  ",
      },
      harness.dependencies,
    );

    expect(transaction.promoted).toBe(true);
    expect(transaction.context).toEqual({
      hash: "sha256:context-1",
      original: "話すです",
      corrected: "話します",
      createdAt: CAPTURED_AT,
    });
    expect(transaction.events.map((event) => event.kind)).toEqual([
      "capture_created",
      "item_created",
      "production_correction_observed",
    ]);
    expect(transaction.events[0]?.payload).toEqual({
      captureType: "production_correction",
    });
    expect(transaction.events[1]).toMatchObject({
      refs: ["event-1"],
      payload: {
        display: "話します",
        identityKey: "話します",
        targetChannels: ["P"],
      },
    });
    expect(transaction.events[2]).toMatchObject({
      refs: ["event-1"],
      payload: {
        channel: "P",
        result: "correction",
      },
    });
    expect(harness.hashedContexts).toEqual([
      { original: "話すです", corrected: "話します" },
    ]);
    expect(harness.nowCalls()).toBe(1);
  });

  it("keeps an explicitly blank correction in context only as absent", async () => {
    const harness = createDependencyHarness();

    const transaction = await createCapture(
      {
        type: "production_correction",
        original: "  話すです  ",
        corrected: "   ",
      },
      harness.dependencies,
    );

    expect(transaction).toMatchObject({
      promoted: false,
      context: {
        hash: "sha256:context-1",
        original: "話すです",
        createdAt: CAPTURED_AT,
      },
    });
    expect(transaction.context).not.toHaveProperty("corrected");
    expect(transaction.events).toHaveLength(1);
    expect(transaction.events[0]).toMatchObject({
      kind: "capture_created",
      captureId: "capture-1",
      contextHash: "sha256:context-1",
      payload: {
        captureType: "production_correction",
      },
    });
    expect(harness.hashedContexts).toEqual([
      { original: "話すです" },
    ]);
    expect(harness.nowCalls()).toBe(1);
  });

  it.each<CaptureCommand>([
    { type: "lookup", original: "   " },
    { type: "listening_miss", original: "\n\t" },
    {
      type: "production_correction",
      original: "",
      corrected: "话します",
    },
  ])("rejects an empty original for $type", async (command) => {
    const harness = createDependencyHarness();

    await expect(
      createCapture(command, harness.dependencies),
    ).rejects.toThrow("original");
    expect(harness.hashedContexts).toEqual([]);
    expect(harness.nowCalls()).toBe(0);
  });

  it("rejects a blank device ID before creating a transaction", async () => {
    const harness = createDependencyHarness();

    await expect(
      createCapture(
        { type: "lookup", original: "tenjin" },
        { ...harness.dependencies, deviceId: "  " },
      ),
    ).rejects.toThrow("deviceId");
    expect(harness.hashedContexts).toEqual([]);
    expect(harness.nowCalls()).toBe(0);
  });
});
