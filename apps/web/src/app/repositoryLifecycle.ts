export function installRepositoryLifecycle(
  target: EventTarget,
  close: () => void,
): () => void {
  const handlePageHide: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted !== true) {
      close();
    }
  };

  target.addEventListener("pagehide", handlePageHide);
  return () => {
    target.removeEventListener("pagehide", handlePageHide);
  };
}
