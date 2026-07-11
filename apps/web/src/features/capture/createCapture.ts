import {
  normalizeIdentity,
  type CaptureCreatedEvent,
  type Event,
  type HybridLogicalClock,
  type ItemCreatedEvent,
  type ListeningMissObservedEvent,
  type LookupObservedEvent,
  type ProductionCorrectionObservedEvent,
} from "@tenjin/core";
import type { ContextRecord } from "@tenjin/storage-indexeddb";

export type CaptureCommand =
  | {
      readonly type: "lookup";
      readonly original: string;
      readonly captureDurationMs?: number;
    }
  | {
      readonly type: "listening_miss";
      readonly original: string;
      readonly captureDurationMs?: number;
    }
  | {
      readonly type: "production_correction";
      readonly original: string;
      readonly corrected?: string;
      readonly captureDurationMs?: number;
    };

export interface CaptureDependencies {
  readonly deviceId: string;
  readonly now: () => Date;
  readonly nextId: (prefix: "capture" | "item" | "event") => string;
  readonly nextSequence: () => {
    readonly seq: number;
    readonly hlc: HybridLogicalClock;
  };
  readonly hashContext: (context: {
    readonly original: string;
    readonly corrected?: string;
  }) => Promise<string>;
}

export interface CaptureTransaction {
  readonly events: readonly Event[];
  readonly context: ContextRecord;
  readonly promoted: boolean;
}

interface CommonEventFields {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly hlc: HybridLogicalClock;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: "user";
  readonly ruleVersion: "vertical-slice-v1";
}

function nextEventFields(
  dependencies: CaptureDependencies,
  timestamp: string,
): CommonEventFields {
  const { seq, hlc } = dependencies.nextSequence();

  return {
    schemaVersion: 1,
    eventId: dependencies.nextId("event"),
    deviceId: dependencies.deviceId,
    seq,
    hlc,
    occurredAt: timestamp,
    recordedAt: timestamp,
    actor: "user",
    ruleVersion: "vertical-slice-v1",
  };
}

export async function createCapture(
  command: CaptureCommand,
  dependencies: CaptureDependencies,
): Promise<CaptureTransaction> {
  if (dependencies.deviceId.trim().length === 0) {
    throw new TypeError("deviceId must be a non-empty string");
  }

  const original = command.original.trim();
  if (original.length === 0) {
    throw new TypeError("original must be a non-empty string");
  }

  const corrected =
    command.type === "production_correction"
      ? command.corrected?.trim() || undefined
      : undefined;
  const timestamp = dependencies.now().toISOString();
  const contextInput =
    corrected === undefined ? { original } : { original, corrected };
  const contextHash = await dependencies.hashContext(contextInput);
  const context: ContextRecord = {
    hash: contextHash,
    ...contextInput,
    createdAt: timestamp,
  };
  const captureId = dependencies.nextId("capture");
  const capturePayload =
    command.captureDurationMs === undefined
      ? { captureType: command.type }
      : {
          captureType: command.type,
          captureDurationMs: command.captureDurationMs,
        };
  const captureCreated = {
    ...nextEventFields(dependencies, timestamp),
    kind: "capture_created",
    captureId,
    contextHash,
    payload: capturePayload,
  } satisfies CaptureCreatedEvent;
  const events: Event[] = [captureCreated];

  if (command.type === "production_correction" && corrected === undefined) {
    return {
      events,
      context,
      promoted: false,
    };
  }

  const display = corrected ?? original;
  const itemId = dependencies.nextId("item");
  const targetChannels =
    command.type === "lookup"
      ? (["R"] as const)
      : command.type === "listening_miss"
        ? (["L"] as const)
        : (["P"] as const);
  const itemCreated = {
    ...nextEventFields(dependencies, timestamp),
    kind: "item_created",
    captureId,
    itemId,
    refs: [captureCreated.eventId],
    payload: {
      display,
      identityKey: normalizeIdentity(display),
      targetChannels,
    },
  } satisfies ItemCreatedEvent;

  events.push(itemCreated);

  if (command.type === "lookup") {
    const observation = {
      ...nextEventFields(dependencies, timestamp),
      kind: "lookup_observed",
      captureId,
      itemId,
      refs: [captureCreated.eventId],
      payload: {
        channel: "R",
        result: "lookup",
      },
    } satisfies LookupObservedEvent;
    events.push(observation);
  } else if (command.type === "listening_miss") {
    const observation = {
      ...nextEventFields(dependencies, timestamp),
      kind: "listening_miss_observed",
      captureId,
      itemId,
      refs: [captureCreated.eventId],
      payload: {
        channel: "L",
        result: "miss",
      },
    } satisfies ListeningMissObservedEvent;
    events.push(observation);
  } else {
    const observation = {
      ...nextEventFields(dependencies, timestamp),
      kind: "production_correction_observed",
      captureId,
      itemId,
      refs: [captureCreated.eventId],
      payload: {
        channel: "P",
        result: "correction",
      },
    } satisfies ProductionCorrectionObservedEvent;
    events.push(observation);
  }

  return {
    events,
    context,
    promoted: true,
  };
}
