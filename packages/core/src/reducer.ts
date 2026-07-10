import type { Event, LearningChannel } from "./events.js";

export type ChannelState = "untracked" | "unstable" | "stable";

export interface ChannelView {
  readonly state: ChannelState;
  readonly validPassDates: readonly string[];
  readonly lastVerifiedAt?: string;
  readonly lastEvidenceAt?: string;
  readonly atRiskSince?: string;
}

export interface ItemView {
  readonly itemId: string;
  readonly display: string;
  readonly identityKey: string;
  readonly targetChannels: readonly LearningChannel[];
  readonly channels: Readonly<Record<LearningChannel, ChannelView>>;
  readonly evidenceCount: number;
  readonly lastOccurredAt: string;
}

export interface LedgerView {
  readonly items: readonly ItemView[];
  readonly itemById: ReadonlyMap<string, ItemView>;
}

interface MutableChannelView {
  state: ChannelState;
  validPassDates: string[];
  lastVerifiedAt?: string;
  lastEvidenceAt?: string;
  atRiskSince?: string;
}

interface MutableItemView {
  itemId: string;
  display: string;
  identityKey: string;
  targetChannels: readonly LearningChannel[];
  channels: Record<LearningChannel, MutableChannelView>;
  evidenceCount: number;
  lastOccurredAt: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvents(left: Event, right: Event): number {
  return (
    compareNumbers(left.hlc.wallTime, right.hlc.wallTime) ||
    compareNumbers(left.hlc.counter, right.hlc.counter) ||
    compareStrings(left.deviceId, right.deviceId) ||
    compareNumbers(left.seq, right.seq) ||
    compareStrings(left.eventId, right.eventId)
  );
}

function makeChannel(state: ChannelState): MutableChannelView {
  return { state, validPassDates: [] };
}

function makeItem(event: Extract<Event, { kind: "item_created" }>): MutableItemView {
  const targets = new Set(event.payload.targetChannels);
  return {
    itemId: event.itemId,
    display: event.payload.display,
    identityKey: event.payload.identityKey,
    targetChannels: [...event.payload.targetChannels],
    channels: {
      R: makeChannel(targets.has("R") ? "unstable" : "untracked"),
      L: makeChannel(targets.has("L") ? "unstable" : "untracked"),
      P: makeChannel(targets.has("P") ? "unstable" : "untracked"),
    },
    evidenceCount: 0,
    lastOccurredAt: event.occurredAt,
  };
}

function observationChannel(event: Event): LearningChannel | undefined {
  switch (event.kind) {
    case "lookup_observed":
      return "R";
    case "listening_miss_observed":
      return "L";
    case "production_correction_observed":
      return "P";
    default:
      return undefined;
  }
}

const MINIMUM_PROMOTION_SPAN_MS = 7 * 24 * 60 * 60 * 1_000;
const MAXIMUM_BACKFILL_DELAY_MS = 24 * 60 * 60 * 1_000;
const STABLE_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function updateLastOccurredAt(
  item: MutableItemView,
  occurredAt: string,
): void {
  if (occurredAt > item.lastOccurredAt) {
    item.lastOccurredAt = occurredAt;
  }
}

function applyVerification(
  item: MutableItemView,
  event: Extract<Event, { kind: "verification_observed" }>,
): void {
  const channel = item.channels[event.payload.channel];
  channel.lastVerifiedAt = event.occurredAt;
  channel.lastEvidenceAt = event.occurredAt;
  item.evidenceCount += 1;
  updateLastOccurredAt(item, event.occurredAt);

  if (channel.state === "untracked" || event.payload.result === "hesitant") {
    return;
  }

  if (event.payload.result === "fail") {
    if (channel.state === "stable") {
      const previousFailure = channel.atRiskSince;
      if (previousFailure !== undefined) {
        const elapsed =
          Date.parse(event.occurredAt) - Date.parse(previousFailure);
        if (elapsed >= 0 && elapsed <= STABLE_FAILURE_WINDOW_MS) {
          channel.state = "unstable";
          channel.validPassDates = [];
          channel.atRiskSince = event.occurredAt;
          return;
        }
      }

      channel.atRiskSince = event.occurredAt;
      return;
    }

    channel.validPassDates = [];
    channel.atRiskSince = event.occurredAt;
    return;
  }

  if (
    event.payload.immediateRetest ||
    Date.parse(event.recordedAt) - Date.parse(event.occurredAt) >
      MAXIMUM_BACKFILL_DELAY_MS
  ) {
    return;
  }

  if (channel.state === "stable") {
    delete channel.atRiskSince;
  }

  const passDate = event.occurredAt.slice(0, 10);
  if (!channel.validPassDates.includes(passDate)) {
    channel.validPassDates = [...channel.validPassDates, passDate].sort(
      compareStrings,
    );
  }

  const firstDate = channel.validPassDates[0];
  const latestDate = channel.validPassDates.at(-1);
  if (
    channel.validPassDates.length >= 3 &&
    firstDate !== undefined &&
    latestDate !== undefined &&
    Date.parse(`${latestDate}T00:00:00.000Z`) -
      Date.parse(`${firstDate}T00:00:00.000Z`) >=
      MINIMUM_PROMOTION_SPAN_MS
  ) {
    channel.state = "stable";
    delete channel.atRiskSince;
  }
}

function isDiscardableCaptureEvent(
  event: Event,
): event is Exclude<
  Event,
  Extract<Event, { kind: "capture_discarded" | "verification_observed" }>
> {
  return (
    event.kind === "capture_created" ||
    event.kind === "item_created" ||
    event.kind === "lookup_observed" ||
    event.kind === "listening_miss_observed" ||
    event.kind === "production_correction_observed"
  );
}

export function deriveLedger(events: readonly Event[]): LedgerView {
  const itemById = new Map<string, MutableItemView>();
  const seenEventIds = new Set<string>();
  const discardedCaptureIds = new Set(
    events
      .filter(
        (event): event is Extract<Event, { kind: "capture_discarded" }> =>
          event.kind === "capture_discarded",
      )
      .map((event) => event.captureId),
  );

  for (const event of [...events].sort(compareEvents)) {
    if (seenEventIds.has(event.eventId)) {
      continue;
    }
    seenEventIds.add(event.eventId);

    if (
      isDiscardableCaptureEvent(event) &&
      discardedCaptureIds.has(event.captureId)
    ) {
      continue;
    }

    if (event.kind === "item_created") {
      if (!itemById.has(event.itemId)) {
        itemById.set(event.itemId, makeItem(event));
      }
      continue;
    }

    if (event.kind === "verification_observed") {
      const item = itemById.get(event.itemId);
      if (item !== undefined) {
        applyVerification(item, event);
      }
      continue;
    }

    const channel = observationChannel(event);
    if (channel === undefined || event.itemId === undefined) {
      continue;
    }

    const item = itemById.get(event.itemId);
    if (item === undefined) {
      continue;
    }

    const channelView = item.channels[channel];
    channelView.state = "unstable";
    channelView.validPassDates = [];
    channelView.lastEvidenceAt = event.occurredAt;
    item.evidenceCount += 1;
    updateLastOccurredAt(item, event.occurredAt);
  }

  const items: readonly ItemView[] = [...itemById.values()].sort((left, right) =>
    compareStrings(left.itemId, right.itemId),
  );
  return {
    items,
    itemById: new Map(items.map((item) => [item.itemId, item])),
  };
}
