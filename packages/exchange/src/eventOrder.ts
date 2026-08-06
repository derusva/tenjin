import type { Event } from "@tenjin/core";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The canonical total order over events, matching the ledger fold order in
 * packages/core/src/reducer.ts. Exports must be byte-stable, so this order is
 * applied before serialisation.
 */
export function compareEventsCanonically(left: Event, right: Event): number {
  return (
    compareNumbers(left.hlc.wallTime, right.hlc.wallTime) ||
    compareNumbers(left.hlc.counter, right.hlc.counter) ||
    compareStrings(left.deviceId, right.deviceId) ||
    compareNumbers(left.seq, right.seq) ||
    compareStrings(left.eventId, right.eventId)
  );
}

export function sortEventsCanonically(
  events: readonly Event[],
): readonly Event[] {
  return [...events].sort(compareEventsCanonically);
}
