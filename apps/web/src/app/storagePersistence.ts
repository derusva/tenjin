export type StoragePersistenceStatus =
  | "persisted"
  | "best-effort"
  | "unsupported";

export async function requestStoragePersistence(): Promise<StoragePersistenceStatus> {
  if (navigator.storage?.persist === undefined) {
    return "unsupported";
  }

  try {
    return (await navigator.storage.persist()) ? "persisted" : "best-effort";
  } catch {
    return "best-effort";
  }
}
