import {
  serializeContextHashInput,
  type CaptureDiscardedEvent,
  type LearningChannel,
  type VerificationObservedEvent,
} from "@tenjin/core";
import type { EventCoordinate } from "@tenjin/storage-indexeddb";

import {
  createCapture as buildCapture,
  type CaptureCommand,
  type CaptureDependencies,
  type CaptureTransaction,
} from "../capture/createCapture.js";

export interface LedgerRuntimeOptions {
  readonly deviceId: string;
  readonly reserveEventCoordinates: (
    deviceId: string,
    physicalTime: number,
    count: number,
  ) => Promise<readonly EventCoordinate[]>;
  readonly now: () => Date;
  readonly randomUUID: () => string;
  readonly digest: (text: string) => Promise<string>;
}

export type VerificationResult = "pass" | "hesitant" | "fail";

type LookupCaptureCommand = Extract<CaptureCommand, { readonly type: "lookup" }>;

export interface LedgerRuntime {
  createCapture(command: CaptureCommand): Promise<CaptureTransaction>;
  createCaptureBatch(
    commands: readonly LookupCaptureCommand[],
  ): Promise<readonly CaptureTransaction[]>;
  createVerification(
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ): Promise<VerificationObservedEvent>;
  createDiscard(captureId: string): Promise<CaptureDiscardedEvent>;
  createDiscardBatch(
    captureIds: readonly string[],
  ): Promise<readonly CaptureDiscardedEvent[]>;
}

export function createLedgerRuntime(
  options: LedgerRuntimeOptions,
): LedgerRuntime {
  const deviceId = options.deviceId.trim();
  if (deviceId.length === 0) {
    throw new TypeError("deviceId must be a non-empty string");
  }

  function timestampedEventFields(
    timestamp: Date,
    coordinate: EventCoordinate,
  ) {
    const { seq, hlc } = coordinate;
    const isoTimestamp = timestamp.toISOString();
    return {
      schemaVersion: 1 as const,
      eventId: `${deviceId}:${seq}`,
      deviceId,
      seq,
      hlc,
      occurredAt: isoTimestamp,
      recordedAt: isoTimestamp,
      actor: "user" as const,
      ruleVersion: "vertical-slice-v1" as const,
    };
  }

  function createCaptureDependencies(
    captureTime: Date,
    coordinates: readonly EventCoordinate[],
  ): CaptureDependencies {
    let coordinateIndex = 0;
    let issuedSequence: number | undefined;

    return {
      deviceId,
      now() {
        return captureTime;
      },
      nextId(prefix) {
        if (prefix === "event") {
          if (issuedSequence === undefined) {
            throw new Error("nextSequence must be called before the event ID");
          }
          return `${deviceId}:${issuedSequence}`;
        }
        return `${prefix}-${options.randomUUID()}`;
      },
      nextSequence() {
        const next = coordinates[coordinateIndex];
        if (next === undefined) {
          throw new Error("capture emitted more events than reserved");
        }
        coordinateIndex += 1;
        issuedSequence = next.seq;
        return next;
      },
      async hashContext(context) {
        const hexadecimal = await options.digest(
          serializeContextHashInput(context),
        );
        return `sha256:${hexadecimal.toLowerCase()}`;
      },
    };
  }

  async function reserve(timestamp: Date, count: number) {
    const coordinates = await options.reserveEventCoordinates(
      deviceId,
      timestamp.getTime(),
      count,
    );
    if (coordinates.length !== count) {
      throw new Error(
        `coordinate allocator returned ${coordinates.length}; expected ${count}`,
      );
    }
    return coordinates;
  }

  function validateCaptureCommand(command: CaptureCommand): void {
    if (
      command.original.trim().length === 0 &&
      (command.image?.name.trim().length ?? 0) === 0
    ) {
      throw new TypeError("original must be a non-empty string");
    }
    if (
      command.type === "lookup" &&
      Object.hasOwn(command, "focus") &&
      (typeof command.focus !== "string" || command.focus.trim().length === 0)
    ) {
      throw new TypeError("focus must be a non-empty string when provided");
    }
  }

  function captureEventCount(command: CaptureCommand): number {
    return command.type === "production_correction" &&
      !command.corrected?.trim()
      ? 1
      : command.original.trim().length === 0 &&
          command.image !== undefined &&
          ((command.type === "listening_miss") ||
            (command.type === "lookup" && !command.answer?.trim()))
        ? 1
        : 3;
  }

  function validateDiscardCaptureIds(captureIds: readonly string[]): void {
    if (captureIds.length < 1 || captureIds.length > 3) {
      throw new TypeError("discard batch must contain between 1 and 3 captures");
    }
    const uniqueCaptureIds = new Set<string>();
    for (const captureId of captureIds) {
      if (captureId.trim().length === 0 || captureId !== captureId.trim()) {
        throw new TypeError("captureId must be a canonical non-empty string");
      }
      if (uniqueCaptureIds.has(captureId)) {
        throw new TypeError("discard batch must not repeat captureIds");
      }
      uniqueCaptureIds.add(captureId);
    }
  }

  function buildDiscard(
    captureId: string,
    timestamp: Date,
    coordinate: EventCoordinate,
  ): CaptureDiscardedEvent {
    return {
      ...timestampedEventFields(timestamp, coordinate),
      kind: "capture_discarded",
      captureId,
      payload: { reason: "undo" },
    };
  }

  return {
    async createCapture(command) {
      validateCaptureCommand(command);
      const eventCount = captureEventCount(command);
      const timestamp = options.now();
      const coordinates = await reserve(timestamp, eventCount);
      return buildCapture(
        command,
        createCaptureDependencies(timestamp, coordinates),
      );
    },
    async createCaptureBatch(commands) {
      if (commands.length < 1 || commands.length > 3) {
        throw new TypeError("capture batch must contain between 1 and 3 commands");
      }
      for (const command of commands) {
        validateCaptureCommand(command);
      }

      const eventCounts = commands.map(captureEventCount);
      const totalEventCount = eventCounts.reduce(
        (total, eventCount) => total + eventCount,
        0,
      );
      const timestamp = options.now();
      const coordinates = await reserve(timestamp, totalEventCount);
      const transactions: CaptureTransaction[] = [];
      let coordinateOffset = 0;

      for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index]!;
        const eventCount = eventCounts[index]!;
        const commandCoordinates = coordinates.slice(
          coordinateOffset,
          coordinateOffset + eventCount,
        );
        coordinateOffset += eventCount;
        transactions.push(
          await buildCapture(
            command,
            createCaptureDependencies(timestamp, commandCoordinates),
          ),
        );
      }

      return transactions;
    },
    async createVerification(itemId, channel, result) {
      const timestamp = options.now();
      const [coordinate] = await reserve(timestamp, 1);
      return {
        ...timestampedEventFields(timestamp, coordinate!),
        kind: "verification_observed",
        itemId,
        payload: {
          channel,
          result,
          probeSource: "review",
          immediateRetest: false,
        },
      };
    },
    async createDiscard(captureId) {
      validateDiscardCaptureIds([captureId]);
      const timestamp = options.now();
      const [coordinate] = await reserve(timestamp, 1);
      return buildDiscard(captureId, timestamp, coordinate!);
    },
    async createDiscardBatch(captureIds) {
      validateDiscardCaptureIds(captureIds);
      const timestamp = options.now();
      const coordinates = await reserve(timestamp, captureIds.length);
      return captureIds.map((captureId, index) =>
        buildDiscard(captureId, timestamp, coordinates[index]!),
      );
    },
  };
}
