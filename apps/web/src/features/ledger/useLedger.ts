import {
  deriveLedger,
  type CaptureCreatedEvent,
  type LedgerView,
  type LearningChannel,
} from "@tenjin/core";
import type {
  ContextRecord,
  LedgerRepository,
  LedgerSnapshot,
} from "@tenjin/storage-indexeddb";
import { useEffect, useRef, useState } from "react";

import type { CaptureCommand } from "../capture/createCapture.js";
import {
  buildReviewQueue,
  type ReviewPresentation,
} from "../review/reviewQueue.js";
import type {
  LedgerRuntime,
  VerificationResult,
} from "./ledgerRuntime.js";

export type LedgerStatus = "loading" | "ready" | "error";

export interface RecentEntry {
  readonly captureId: string;
  readonly contextHash: string;
  readonly occurredAt: string;
  readonly context: ContextRecord;
  readonly display?: string;
}

export interface SaveCaptureResult {
  readonly captureId: string;
  readonly contextHash: string;
}

export interface UseLedgerOptions {
  readonly repository: LedgerRepository;
  readonly runtime: LedgerRuntime;
}

export interface UseLedgerResult {
  readonly status: LedgerStatus;
  readonly error: string | undefined;
  readonly view: LedgerView;
  readonly snapshot: LedgerSnapshot;
  readonly reviewItems: readonly ReviewPresentation[];
  readonly recentEntries: readonly RecentEntry[];
  retryRead(): Promise<void>;
  saveCapture(command: CaptureCommand): Promise<SaveCaptureResult>;
  answerReview(
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ): Promise<void>;
  discardCapture(captureId: string, contextHash: string): Promise<void>;
}

const EMPTY_SNAPSHOT: LedgerSnapshot = { events: [], contexts: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取本地记录失败";
}

function selectRecentEntries(snapshot: LedgerSnapshot): RecentEntry[] {
  const discardedCaptureIds = new Set(
    snapshot.events
      .filter((event) => event.kind === "capture_discarded")
      .map((event) => event.captureId),
  );
  const contexts = new Map(
    snapshot.contexts.map((context) => [context.hash, context]),
  );
  const itemDisplays = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.kind === "item_created" && !itemDisplays.has(event.captureId)) {
      itemDisplays.set(event.captureId, event.payload.display);
    }
  }

  return snapshot.events
    .filter(
      (event): event is CaptureCreatedEvent =>
        event.kind === "capture_created" &&
        !discardedCaptureIds.has(event.captureId),
    )
    .flatMap((event): RecentEntry[] => {
      const context = contexts.get(event.contextHash);
      if (context === undefined) {
        return [];
      }
      const display = itemDisplays.get(event.captureId);
      return [
        {
          captureId: event.captureId,
          contextHash: event.contextHash,
          occurredAt: event.occurredAt,
          context,
          ...(display === undefined ? {} : { display }),
        },
      ];
    })
    .sort(
      (left, right) =>
        (left.occurredAt < right.occurredAt
          ? 1
          : left.occurredAt > right.occurredAt
            ? -1
            : 0) ||
        (left.captureId < right.captureId
          ? 1
          : left.captureId > right.captureId
            ? -1
            : 0),
    )
    .slice(0, 3);
}

export function useLedger({
  repository,
  runtime,
}: UseLedgerOptions): UseLedgerResult {
  const [status, setStatus] = useState<LedgerStatus>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot>(EMPTY_SNAPSHOT);
  const mounted = useRef(false);
  const hasSuccessfulSnapshot = useRef(false);
  const latestRefresh = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const refresh = ++latestRefresh.current;

    void repository.readSnapshot().then(
      (nextSnapshot) => {
        if (mounted.current && refresh === latestRefresh.current) {
          hasSuccessfulSnapshot.current = true;
          setSnapshot(nextSnapshot);
          setError(undefined);
          setStatus("ready");
        }
      },
      (readError: unknown) => {
        if (mounted.current && refresh === latestRefresh.current) {
          setError(errorMessage(readError));
          setStatus("error");
        }
      },
    );

    return () => {
      mounted.current = false;
      latestRefresh.current += 1;
    };
  }, [repository]);

  async function refresh(): Promise<void> {
    const refresh = ++latestRefresh.current;
    try {
      const nextSnapshot = await repository.readSnapshot();
      if (mounted.current && refresh === latestRefresh.current) {
        hasSuccessfulSnapshot.current = true;
        setSnapshot(nextSnapshot);
        setError(undefined);
        setStatus("ready");
      }
    } catch (readError) {
      if (mounted.current && refresh === latestRefresh.current) {
        setError(errorMessage(readError));
        setStatus(hasSuccessfulSnapshot.current ? "ready" : "error");
      }
    }
  }

  async function retryRead(): Promise<void> {
    if (!hasSuccessfulSnapshot.current && mounted.current) {
      setStatus("loading");
    }
    await refresh();
  }

  async function saveCapture(
    command: CaptureCommand,
  ): Promise<SaveCaptureResult> {
    const transaction = await runtime.createCapture(command);
    await repository.appendCapture(transaction.events, transaction.context);
    await refresh();
    const capture = transaction.events.find(
      (event) => event.kind === "capture_created",
    );
    if (capture === undefined) {
      throw new Error("capture transaction is missing capture_created");
    }
    return {
      captureId: capture.captureId,
      contextHash: capture.contextHash,
    };
  }

  async function answerReview(
    itemId: string,
    channel: LearningChannel,
    result: VerificationResult,
  ): Promise<void> {
    const event = await runtime.createVerification(itemId, channel, result);
    await repository.appendEvents([event]);
    await refresh();
  }

  async function discardCapture(
    captureId: string,
    contextHash: string,
  ): Promise<void> {
    const event = await runtime.createDiscard(captureId);
    await repository.appendDiscard(event, contextHash);
    await refresh();
  }

  const view = deriveLedger(snapshot.events);
  return {
    status,
    error,
    view,
    snapshot,
    reviewItems: buildReviewQueue(view, snapshot, 5),
    recentEntries: selectRecentEntries(snapshot),
    retryRead,
    saveCapture,
    answerReview,
    discardCapture,
  };
}
