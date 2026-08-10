import { validateEvent, type Event } from "@tenjin/core";

import { compareEventsCanonically } from "./eventOrder.js";

type EventComparator = (left: Event, right: Event) => number;

function parseEventLines(eventsJsonl: string): readonly unknown[] {
  const lines = eventsJsonl.split(/\r?\n/u);
  let lastContentIndex = lines.length - 1;
  while (lastContentIndex >= 0 && lines[lastContentIndex] === "") {
    lastContentIndex -= 1;
  }

  for (let index = 0; index <= lastContentIndex; index += 1) {
    if (lines[index] === "") {
      throw new TypeError(
        `events.jsonl has an empty line in the middle at line ${index + 1}`,
      );
    }
  }

  const parsed: unknown[] = [];
  const invalidLines: number[] = [];
  for (let index = 0; index <= lastContentIndex; index += 1) {
    try {
      parsed.push(JSON.parse(lines[index]!) as unknown);
    } catch {
      invalidLines.push(index + 1);
    }
  }
  if (invalidLines.length > 0) {
    throw new TypeError(
      `events.jsonl must contain valid JSON; invalid line(s): ${invalidLines.join(", ")}`,
    );
  }
  return parsed;
}

function validateAllEventShapes(parsed: readonly unknown[]): readonly Event[] {
  const events: Event[] = [];
  const errors: string[] = [];

  parsed.forEach((candidate, index) => {
    const result = validateEvent(candidate);
    if (!result.valid) {
      errors.push(
        `line ${index + 1}: ${result.errors
          .map(({ field, message }) => `${field}: ${message}`)
          .join("; ")}`,
      );
      return;
    }
    events.push(result.value);
  });

  if (errors.length > 0) {
    throw new TypeError(`invalid event shape: ${errors.join(" | ")}`);
  }
  return events;
}

function validateCrossRecordInvariants(
  events: readonly Event[],
  availableContextHashes: ReadonlySet<string>,
): void {
  const errors: string[] = [];
  const seenEventIds = new Set<string>();
  const seenSeqByDevice = new Map<string, Set<number>>();
  const lastSeqByDevice = new Map<string, number>();

  for (const event of events) {
    if (event.deviceId !== event.deviceId.trim()) {
      errors.push(
        `deviceId must be canonical without surrounding whitespace: ${JSON.stringify(event.deviceId)}`,
      );
    }
    if (event.eventId !== event.eventId.trim()) {
      errors.push(
        `eventId must be canonical without surrounding whitespace: ${JSON.stringify(event.eventId)}`,
      );
    }

    const expectedEventId = `${event.deviceId}:${event.seq}`;
    if (event.eventId !== expectedEventId) {
      errors.push(
        `eventId must equal deviceId:seq; expected ${JSON.stringify(expectedEventId)}, received ${JSON.stringify(event.eventId)}`,
      );
    }

    if (seenEventIds.has(event.eventId)) {
      errors.push(`duplicate eventId: ${event.eventId}`);
    } else {
      seenEventIds.add(event.eventId);
    }

    let seenSequences = seenSeqByDevice.get(event.deviceId);
    if (seenSequences === undefined) {
      seenSequences = new Set<number>();
      seenSeqByDevice.set(event.deviceId, seenSequences);
    }
    if (seenSequences.has(event.seq)) {
      errors.push(
        `duplicate deviceId,seq coordinate: ${event.deviceId},${event.seq}`,
      );
    } else {
      seenSequences.add(event.seq);
    }

    const previousSequence = lastSeqByDevice.get(event.deviceId);
    if (previousSequence !== undefined && event.seq <= previousSequence) {
      errors.push(
        `seq must strictly increase for device ${event.deviceId}; ${event.seq} follows ${previousSequence}`,
      );
    }
    lastSeqByDevice.set(event.deviceId, event.seq);

    if (Date.parse(event.occurredAt) > Date.parse(event.recordedAt)) {
      errors.push(
        `occurredAt must not be later than recordedAt for ${event.eventId}`,
      );
    }
  }

  const captureIds = new Set(
    events
      .filter(
        (event): event is Extract<Event, { kind: "capture_created" }> =>
          event.kind === "capture_created",
      )
      .map((event) => event.captureId),
  );
  const discardedCaptureIds = new Set(
    events
      .filter(
        (event): event is Extract<Event, { kind: "capture_discarded" }> =>
          event.kind === "capture_discarded",
      )
      .map((event) => event.captureId),
  );

  for (const event of events) {
    if (event.kind === "item_created" && !captureIds.has(event.captureId)) {
      errors.push(
        `item_created ${event.eventId} captureId ${event.captureId} does not resolve to capture_created`,
      );
    }
    if (
      event.kind === "capture_created" &&
      !discardedCaptureIds.has(event.captureId) &&
      !availableContextHashes.has(event.contextHash)
    ) {
      errors.push(
        `active capture ${event.captureId} requires context ${event.contextHash}`,
      );
    }
  }

  // Contexts without an active capture are accepted. appendDiscard can delete
  // the final active reference while a GC race leaves another context behind;
  // absence of a reference is not proof of package corruption.

  if (errors.length > 0) {
    throw new TypeError(`invalid events: ${errors.join("; ")}`);
  }
}

function validateEventsWithComparator(
  eventsJsonl: string,
  availableContextHashes: ReadonlySet<string>,
  comparator: EventComparator,
): readonly Event[] {
  const parsed = parseEventLines(eventsJsonl);
  const shapedEvents = validateAllEventShapes(parsed);
  const sortedEvents = [...shapedEvents].sort(comparator);
  validateCrossRecordInvariants(sortedEvents, availableContextHashes);
  return sortedEvents;
}

export function validateEvents(
  eventsJsonl: string,
  availableContextHashes: ReadonlySet<string>,
): readonly Event[] {
  return validateEventsWithComparator(
    eventsJsonl,
    availableContextHashes,
    compareEventsCanonically,
  );
}

/** Package-internal test seam; deliberately not exported from index.ts. */
export function validateEventsForTest(
  eventsJsonl: string,
  availableContextHashes: ReadonlySet<string>,
  comparator: EventComparator,
): readonly Event[] {
  return validateEventsWithComparator(
    eventsJsonl,
    availableContextHashes,
    comparator,
  );
}
