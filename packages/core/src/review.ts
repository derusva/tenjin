import type { LearningChannel } from "./events.js";
import type { ItemView, LedgerView } from "./reducer.js";

export type EvidenceReason = "recent-failure" | "unstable" | "stable-check";

export interface ReviewItem {
  readonly itemId: string;
  readonly channel: LearningChannel;
  readonly reason: EvidenceReason;
  readonly item: ItemView;
}

interface Candidate extends ReviewItem {
  readonly lastVerifiedAt: string | undefined;
}

const CHANNELS = ["R", "L", "P"] as const;
const CHANNEL_ORDER: Readonly<Record<LearningChannel, number>> = {
  R: 0,
  L: 1,
  P: 2,
};
const RECENT_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.lastVerifiedAt === undefined && right.lastVerifiedAt !== undefined) {
    return -1;
  }
  if (left.lastVerifiedAt !== undefined && right.lastVerifiedAt === undefined) {
    return 1;
  }
  if (
    left.lastVerifiedAt !== undefined &&
    right.lastVerifiedAt !== undefined
  ) {
    const byVerification = compareStrings(
      left.lastVerifiedAt,
      right.lastVerifiedAt,
    );
    if (byVerification !== 0) {
      return byVerification;
    }
  }

  return (
    compareStrings(left.itemId, right.itemId) ||
    CHANNEL_ORDER[left.channel] - CHANNEL_ORDER[right.channel]
  );
}

function newestOccurredAt(view: LedgerView): string | undefined {
  let newest: string | undefined;
  for (const item of view.items) {
    if (newest === undefined || item.lastOccurredAt > newest) {
      newest = item.lastOccurredAt;
    }
  }
  return newest;
}

function isRecentFailure(
  lastFailureAt: string | undefined,
  newest: string | undefined,
): boolean {
  if (lastFailureAt === undefined || newest === undefined) {
    return false;
  }

  const age = Date.parse(newest) - Date.parse(lastFailureAt);
  return age >= 0 && age <= RECENT_FAILURE_WINDOW_MS;
}

export function selectReviewItems(
  view: LedgerView,
  budget: number,
): ReviewItem[] {
  if (budget <= 0) {
    return [];
  }

  const recentFailures: Candidate[] = [];
  const unstable: Candidate[] = [];
  const stable: Candidate[] = [];
  const newest = newestOccurredAt(view);

  for (const item of view.items) {
    for (const channel of CHANNELS) {
      const channelView = item.channels[channel];
      if (channelView.state === "untracked") {
        continue;
      }

      let reason: EvidenceReason;
      let tier: Candidate[];
      if (isRecentFailure(channelView.lastFailureAt, newest)) {
        reason = "recent-failure";
        tier = recentFailures;
      } else if (channelView.state === "unstable") {
        reason = "unstable";
        tier = unstable;
      } else {
        reason = "stable-check";
        tier = stable;
      }

      tier.push({
        itemId: item.itemId,
        channel,
        reason,
        item,
        lastVerifiedAt: channelView.lastVerifiedAt,
      });
    }
  }

  recentFailures.sort(compareCandidates);
  unstable.sort(compareCandidates);
  stable.sort(compareCandidates);

  return [...recentFailures, ...unstable, ...stable.slice(0, 1)]
    .slice(0, Math.floor(budget))
    .map(({ itemId, channel, reason, item }) => ({
      itemId,
      channel,
      reason,
      item,
    }));
}
