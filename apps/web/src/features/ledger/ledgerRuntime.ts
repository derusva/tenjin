import {
  type CaptureDiscardedEvent,
  type Event,
  type HybridLogicalClock,
  type LearningChannel,
  type VerificationObservedEvent,
} from "@tenjin/core";

import {
  createCapture as buildCapture,
  type CaptureCommand,
  type CaptureDependencies,
  type CaptureTransaction,
} from "../capture/createCapture.js";

export interface LedgerRuntimeOptions {
  readonly deviceId: string;
  readonly existingEvents: readonly Event[];
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
  ): VerificationObservedEvent;
  createDiscard(captureId: string): CaptureDiscardedEvent;
}

function compareHlc(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  return left.wallTime - right.wallTime || left.counter - right.counter;
}

export function createLedgerRuntime(
  options: LedgerRuntimeOptions,
): LedgerRuntime {
  const deviceId = options.deviceId.trim();
  if (deviceId.length === 0) {
    throw new TypeError("deviceId must be a non-empty string");
  }

  let sequence = options.existingEvents.reduce(
    (maximum, event) =>
      event.deviceId === deviceId ? Math.max(maximum, event.seq) : maximum,
    0,
  );
  let lastHlc = options.existingEvents.reduce<
    HybridLogicalClock | undefined
  >(
    (maximum, event) =>
      maximum === undefined || compareHlc(event.hlc, maximum) > 0
        ? event.hlc
        : maximum,
    undefined,
  );

  function advance(physicalTime: number) {
    sequence += 1;
    if (lastHlc === undefined || physicalTime > lastHlc.wallTime) {
      lastHlc = { wallTime: physicalTime, counter: 0 };
    } else {
      lastHlc = {
        wallTime: lastHlc.wallTime,
        counter: lastHlc.counter + 1,
      };
    }
    return { seq: sequence, hlc: lastHlc };
  }

  function timestampedEventFields(timestamp: Date) {
    const { seq, hlc } = advance(timestamp.getTime());
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

  function createCaptureDependencies(): CaptureDependencies {
    let captureTime: Date | undefined;
    let issuedSequence: number | undefined;

    return {
      deviceId,
      now() {
        captureTime = options.now();
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
        const timestamp = captureTime ?? options.now();
        const next = advance(timestamp.getTime());
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

  return {
    createCapture(command) {
      return buildCapture(command, createCaptureDependencies());
    },
    createVerification(itemId, channel, result) {
      return {
        ...timestampedEventFields(options.now()),
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
    createDiscard(captureId) {
      return {
        ...timestampedEventFields(options.now()),
        kind: "capture_discarded",
        captureId,
        payload: { reason: "undo" },
      };
    },
  };
}
