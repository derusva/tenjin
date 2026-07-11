import {
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

export interface LedgerRuntime {
  createCapture(command: CaptureCommand): Promise<CaptureTransaction>;
  createVerification(
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ): Promise<VerificationObservedEvent>;
  createDiscard(captureId: string): Promise<CaptureDiscardedEvent>;
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
        const input =
          context.corrected === undefined
            ? { original: context.original }
            : { original: context.original, corrected: context.corrected };
        const hexadecimal = await options.digest(JSON.stringify(input));
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

  return {
    async createCapture(command) {
      if (command.original.trim().length === 0) {
        throw new TypeError("original must be a non-empty string");
      }
      const eventCount =
        command.type === "production_correction" &&
        !command.corrected?.trim()
          ? 1
          : 3;
      const timestamp = options.now();
      const coordinates = await reserve(timestamp, eventCount);
      return buildCapture(
        command,
        createCaptureDependencies(timestamp, coordinates),
      );
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
      const timestamp = options.now();
      const [coordinate] = await reserve(timestamp, 1);
      return {
        ...timestampedEventFields(timestamp, coordinate!),
        kind: "capture_discarded",
        captureId,
        payload: { reason: "undo" },
      };
    },
  };
}
