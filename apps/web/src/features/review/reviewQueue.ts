import {
  selectReviewItems,
  type ChannelView,
  type Event,
  type LedgerView,
  type LearningChannel,
  type ReviewItem,
} from "@tenjin/core";
import type {
  ContextRecord,
  LedgerSnapshot,
} from "@tenjin/storage-indexeddb";

export interface ReviewReveal {
  readonly label: string;
  readonly text: string;
}

export interface ReviewPresentation extends ReviewItem {
  readonly prompt: string;
  readonly reveal: ReviewReveal | undefined;
}

interface ReviewMaterial {
  readonly prompt: string;
  readonly reveal: ReviewReveal | undefined;
}

type ReviewMaterialsByChannel = Partial<
  Record<LearningChannel, ReviewMaterial>
>;

type ReviewMaterialsByItem = ReadonlyMap<
  string,
  Readonly<ReviewMaterialsByChannel>
>;

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

function contextByHash(
  contexts: readonly ContextRecord[],
): ReadonlyMap<string, ContextRecord> {
  return new Map(contexts.map((context) => [context.hash, context]));
}

function collectReviewMaterials(
  snapshot: LedgerSnapshot,
): ReviewMaterialsByItem {
  const discardedCaptureIds = new Set(
    snapshot.events
      .filter((event) => event.kind === "capture_discarded")
      .map((event) => event.captureId),
  );
  const contexts = contextByHash(snapshot.contexts);
  const captureById = new Map<
    string,
    Extract<Event, { kind: "capture_created" }>
  >();
  const materialByItemId = new Map<string, ReviewMaterialsByChannel>();

  function addMaterial(
    itemId: string,
    channel: LearningChannel,
    material: ReviewMaterial,
  ) {
    const existing = materialByItemId.get(itemId);
    if (existing?.[channel] !== undefined) {
      return;
    }
    if (existing === undefined) {
      materialByItemId.set(itemId, { [channel]: material });
    } else {
      existing[channel] = material;
    }
  }

  for (const event of [...snapshot.events].sort(compareEvents)) {
    if (
      event.kind === "capture_created" &&
      !discardedCaptureIds.has(event.captureId) &&
      !captureById.has(event.captureId)
    ) {
      captureById.set(event.captureId, event);
      continue;
    }

    if (
      event.kind !== "item_created" ||
      discardedCaptureIds.has(event.captureId)
    ) {
      continue;
    }

    const capture = captureById.get(event.captureId);
    if (capture === undefined) {
      continue;
    }
    const context = contexts.get(capture.contextHash);
    if (context === undefined) {
      continue;
    }

    if (
      capture.payload.captureType === "listening_miss" &&
      event.payload.targetChannels.includes("L")
    ) {
      addMaterial(event.itemId, "L", {
        prompt: context.original,
        reveal: undefined,
      });
      continue;
    }

    if (
      capture.payload.captureType === "production_correction" &&
      event.payload.targetChannels.includes("P") &&
      context.corrected !== undefined
    ) {
      addMaterial(event.itemId, "P", {
        prompt: context.original,
        reveal: {
          label: "纠正后的表达",
          text: context.corrected,
        },
      });
    }
  }

  return materialByItemId;
}

function hideUnreviewableChannel(
  channel: ChannelView,
  material: ReviewMaterial | undefined,
): ChannelView {
  return material === undefined ? { ...channel, state: "untracked" } : channel;
}

export function buildReviewQueue(
  view: LedgerView,
  snapshot: LedgerSnapshot,
  budget: number,
): ReviewPresentation[] {
  const materialByItemId = collectReviewMaterials(snapshot);
  const items = view.items.map((item) => {
    const materials = materialByItemId.get(item.itemId);
    return {
      ...item,
      channels: {
        R: hideUnreviewableChannel(item.channels.R, materials?.R),
        L: hideUnreviewableChannel(item.channels.L, materials?.L),
        P: hideUnreviewableChannel(item.channels.P, materials?.P),
      },
    };
  });
  const eligibleView: LedgerView = {
    items,
    itemById: new Map(items.map((item) => [item.itemId, item])),
  };

  return selectReviewItems(eligibleView, budget).flatMap(
    (reviewItem): ReviewPresentation[] => {
      const material =
        materialByItemId.get(reviewItem.itemId)?.[reviewItem.channel];
      return material === undefined
        ? []
        : [
            {
              ...reviewItem,
              prompt: material.prompt,
              reveal: material.reveal,
            },
          ];
    },
  );
}
