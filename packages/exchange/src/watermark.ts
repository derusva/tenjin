import type { Event, HybridLogicalClock } from "@tenjin/core";

export interface LedgerWatermark {
  readonly maxSeqByDevice: Readonly<Record<string, number>>;
  readonly maxHlc: HybridLogicalClock;
}

export function compareHlc(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  if (left.wallTime !== right.wallTime) {
    return left.wallTime < right.wallTime ? -1 : 1;
  }
  if (left.counter !== right.counter) {
    return left.counter < right.counter ? -1 : 1;
  }
  return 0;
}

/**
 * Derives the exchange watermark from the event set alone. Deliberately does
 * not read the clock store: a failed append can leave the allocator above what
 * the ledger actually holds, and the watermark must only claim held events.
 */
export function deriveWatermark(events: readonly Event[]): LedgerWatermark {
  const maxSeqEntries = new Map<string, number>();
  let maxHlc: HybridLogicalClock = { wallTime: 0, counter: 0 };

  for (const event of events) {
    const current = maxSeqEntries.get(event.deviceId);
    if (current === undefined || event.seq > current) {
      maxSeqEntries.set(event.deviceId, event.seq);
    }
    if (compareHlc(event.hlc, maxHlc) > 0) {
      maxHlc = { wallTime: event.hlc.wallTime, counter: event.hlc.counter };
    }
  }

  return {
    maxSeqByDevice: Object.fromEntries(maxSeqEntries),
    maxHlc,
  };
}
