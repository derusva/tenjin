export interface RepositoryLifecycle {
  readonly enterReadOnly?: () => void | Promise<void>;
  readonly close: () => void | Promise<void>;
  readonly releaseSharedLock?: () => void | Promise<void>;
}

export async function closeRepositoryLifecycle(
  lifecycle: RepositoryLifecycle,
): Promise<void> {
  await lifecycle.enterReadOnly?.();
  try {
    await lifecycle.close();
  } finally {
    await lifecycle.releaseSharedLock?.();
  }
}

export function installRepositoryLifecycle(
  target: EventTarget,
  lifecycle: RepositoryLifecycle | (() => void),
): () => void {
  const close = typeof lifecycle === "function" ? lifecycle : lifecycle.close;
  const handlePageHide: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted !== true) {
      if (typeof lifecycle === "function") {
        close();
      } else {
        void closeRepositoryLifecycle(lifecycle).catch(() => undefined);
      }
    }
  };

  target.addEventListener("pagehide", handlePageHide);
  return () => {
    target.removeEventListener("pagehide", handlePageHide);
  };
}
