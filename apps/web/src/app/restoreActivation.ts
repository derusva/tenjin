/**
 * The activation boundary around an atomic ledger restore.
 *
 * This module deliberately has no browser or IndexedDB imports.  The host owns
 * Web Locks, storage adapters, package decoding, and repository construction;
 * this state machine owns the order in which those capabilities may be used.
 */

export const RESTORE_STORE_NAMES = [
  "events",
  "contexts",
  "clock",
  "importReceipts",
] as const;

export type RestoreStoreName = (typeof RESTORE_STORE_NAMES)[number];

export interface RestoreStorageState {
  readonly events: number;
  readonly contexts: number;
  readonly clock: number;
  readonly importReceipts: number;
  readonly restoreCommit: unknown | undefined;
}

export interface RestoreCommitMarker {
  readonly key: "restore-commit";
  readonly type: "restore-commit";
  readonly newDeviceId: string;
  readonly committedAt: string;
}

/** A restore-only capability; it intentionally exposes no normal write APIs. */
export interface RestoreOnlyRepository<TPlan> {
  inspectRestoreStorageState(): Promise<RestoreStorageState>;
  restoreLedger(plan: TPlan, newDeviceId: string): Promise<void>;
  close(): void;
}

/** The pending slot is separate from the formal device identity on purpose. */
export interface PendingRestoreStorage {
  read(): string | null;
  write(deviceId: string): void;
  remove(): void;
}

/** Promotion is the only formal-identity operation this state machine permits. */
export interface FormalDeviceIdStorage {
  write(deviceId: string): void;
}

export interface ExclusiveRestoreLock {
  withExclusive<T>(callback: () => Promise<T>): Promise<T>;
}

export interface RestoreActivationDependencies<TPackage, TPlan> {
  readonly pendingStorage: PendingRestoreStorage;
  readonly deviceIdStorage: FormalDeviceIdStorage;
  readonly generateDeviceId: () => string;
  readonly openRestoreRepository: () => Promise<RestoreOnlyRepository<TPlan>>;
  readonly readPackage: (bytes: Uint8Array) => Promise<TPackage>;
  readonly buildPlan: (
    source: TPackage,
    digest: (bytes: Uint8Array) => Promise<string>,
  ) => Promise<TPlan>;
  readonly digest: (bytes: Uint8Array) => Promise<string>;
  readonly reload: () => void;
  readonly lock: ExclusiveRestoreLock;
}

export type RestoreActivationState =
  | { readonly kind: "normal" }
  | { readonly kind: "pending-empty"; readonly pendingDeviceId: string }
  | { readonly kind: "pending-committed"; readonly pendingDeviceId: string }
  | {
      readonly kind: "corrupt";
      readonly reason:
        | "pending-device-id-invalid"
        | "restore-marker-invalid"
        | "restore-marker-device-id-mismatch"
        | "restore-commit-incomplete"
        | "restore-data-without-marker"
        | "restore-storage-state-invalid";
    };

export type RestoreAttemptResult =
  | RestoreActivationState
  | { readonly kind: "restore-target-not-empty" }
  | { readonly kind: "restored"; readonly pendingDeviceId: string };

export type RestoreCancelResult =
  | { readonly kind: "normal" }
  | { readonly kind: "cancelled"; readonly pendingDeviceId: string }
  | Exclude<RestoreActivationState, { readonly kind: "normal" | "pending-empty" }>;

function isCanonicalDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim()
  );
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isRestoreCommitMarker(value: unknown): value is RestoreCommitMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== "key" &&
        key !== "type" &&
        key !== "newDeviceId" &&
        key !== "committedAt",
    )
  ) {
    return false;
  }
  return (
    record.key === "restore-commit" &&
    record.type === "restore-commit" &&
    isCanonicalDeviceId(record.newDeviceId) &&
    isCanonicalUtcTimestamp(record.committedAt)
  );
}

function isValidStorageState(value: RestoreStorageState): boolean {
  return RESTORE_STORE_NAMES.every((store) => {
    const count = value[store];
    return Number.isSafeInteger(count) && count >= 0;
  });
}

function isEmptyStorageState(value: RestoreStorageState): boolean {
  return RESTORE_STORE_NAMES.every((store) => value[store] === 0);
}

async function inspectPendingState<TPlan>(
  pendingDeviceId: string,
  repository: RestoreOnlyRepository<TPlan>,
): Promise<Exclude<RestoreActivationState, { readonly kind: "normal" }>> {
  if (!isCanonicalDeviceId(pendingDeviceId)) {
    return { kind: "corrupt", reason: "pending-device-id-invalid" };
  }

  let storageState: RestoreStorageState;
  try {
    storageState = await repository.inspectRestoreStorageState();
  } catch {
    return { kind: "corrupt", reason: "restore-storage-state-invalid" };
  }
  if (!isValidStorageState(storageState)) {
    return { kind: "corrupt", reason: "restore-storage-state-invalid" };
  }
  const marker = storageState.restoreCommit;
  if (marker === undefined) {
    return isEmptyStorageState(storageState)
      ? { kind: "pending-empty", pendingDeviceId }
      : { kind: "corrupt", reason: "restore-data-without-marker" };
  }
  if (!isRestoreCommitMarker(marker)) {
    return { kind: "corrupt", reason: "restore-marker-invalid" };
  }
  if (marker.newDeviceId !== pendingDeviceId) {
    return { kind: "corrupt", reason: "restore-marker-device-id-mismatch" };
  }
  // Every successful restore atomically writes both global-hlc and this marker.
  // A lone marker cannot authorize a formal identity after partial data loss.
  if (storageState.clock < 2) {
    return { kind: "corrupt", reason: "restore-commit-incomplete" };
  }
  return { kind: "pending-committed", pendingDeviceId };
}

async function withRestoreRepository<TPlan, TResult>(
  openRestoreRepository: () => Promise<RestoreOnlyRepository<TPlan>>,
  callback: (repository: RestoreOnlyRepository<TPlan>) => Promise<TResult>,
): Promise<TResult> {
  const repository = await openRestoreRepository();
  try {
    return await callback(repository);
  } finally {
    repository.close();
  }
}

async function inspectActivationState<TPackage, TPlan>(
  dependencies: RestoreActivationDependencies<TPackage, TPlan>,
): Promise<RestoreActivationState> {
  const pendingDeviceId = dependencies.pendingStorage.read();
  if (pendingDeviceId === null) return { kind: "normal" };
  return withRestoreRepository(dependencies.openRestoreRepository, (repository) =>
    inspectPendingState(pendingDeviceId, repository),
  );
}

async function inspectEmptyRestoreTarget<TPlan>(
  openRestoreRepository: () => Promise<RestoreOnlyRepository<TPlan>>,
): Promise<
  | { readonly kind: "empty" }
  | { readonly kind: "restore-target-not-empty" }
  | { readonly kind: "corrupt"; readonly reason: "restore-storage-state-invalid" }
> {
  return withRestoreRepository(openRestoreRepository, async (repository) => {
    let storageState: RestoreStorageState;
    try {
      storageState = await repository.inspectRestoreStorageState();
    } catch {
      return { kind: "corrupt", reason: "restore-storage-state-invalid" };
    }
    if (!isValidStorageState(storageState)) {
      return { kind: "corrupt", reason: "restore-storage-state-invalid" };
    }
    return isEmptyStorageState(storageState)
      ? { kind: "empty" }
      : { kind: "restore-target-not-empty" };
  });
}

function promoteCommitted<TPackage, TPlan>(
  dependencies: RestoreActivationDependencies<TPackage, TPlan>,
  pendingDeviceId: string,
): { readonly kind: "pending-committed"; readonly pendingDeviceId: string } {
  dependencies.deviceIdStorage.write(pendingDeviceId);
  dependencies.pendingStorage.remove();
  dependencies.reload();
  return { kind: "pending-committed", pendingDeviceId };
}

/**
 * Bootstrap entry point.  It is safe to call before a formal device identity
 * exists: it never reads or generates one.  A committed recovery is promoted;
 * every other pending state remains write-blocking for the host to render.
 */
export async function bootstrapRestoreActivation<TPackage, TPlan>(
  dependencies: RestoreActivationDependencies<TPackage, TPlan>,
): Promise<RestoreActivationState> {
  return dependencies.lock.withExclusive(async () => {
    const state = await inspectActivationState(dependencies);
    if (state.kind !== "pending-committed") return state;
    return promoteCommitted(dependencies, state.pendingDeviceId);
  });
}

/**
 * Restores only into a provably empty four-store ledger.  Once pending is
 * durable, every failure intentionally leaves it in place for a same-id retry
 * or explicit cancellation; this function never falls back to a new identity.
 */
export async function restoreWithActivation<TPackage, TPlan>(
  dependencies: RestoreActivationDependencies<TPackage, TPlan>,
  packageBytes: Uint8Array,
): Promise<RestoreAttemptResult> {
  return dependencies.lock.withExclusive(async () => {
    const currentState = await inspectActivationState(dependencies);
    if (currentState.kind === "pending-committed") {
      return promoteCommitted(dependencies, currentState.pendingDeviceId);
    }
    if (currentState.kind === "corrupt") return currentState;

    let pendingDeviceId: string;
    if (currentState.kind === "pending-empty") {
      pendingDeviceId = currentState.pendingDeviceId;
    } else {
      const targetState = await inspectEmptyRestoreTarget(
        dependencies.openRestoreRepository,
      );
      if (targetState.kind !== "empty") return targetState;
      const generatedDeviceId = dependencies.generateDeviceId();
      if (!isCanonicalDeviceId(generatedDeviceId)) {
        throw new TypeError("generated restore deviceId must be canonical");
      }
      dependencies.pendingStorage.write(generatedDeviceId);
      if (dependencies.pendingStorage.read() !== generatedDeviceId) {
        throw new Error("pending restore deviceId did not persist");
      }
      pendingDeviceId = generatedDeviceId;
    }

    const source = await dependencies.readPackage(packageBytes);
    const plan = await dependencies.buildPlan(source, dependencies.digest);
    await withRestoreRepository(dependencies.openRestoreRepository, async (repository) => {
      await repository.restoreLedger(plan, pendingDeviceId);
    });

    const committedState = await inspectActivationState(dependencies);
    if (committedState.kind !== "pending-committed") {
      throw new Error("restore completed without a matching durable commit marker");
    }
    promoteCommitted(dependencies, pendingDeviceId);
    return { kind: "restored", pendingDeviceId };
  });
}

/** Explicitly abandons only a retryable, still-empty recovery. */
export async function cancelPendingRestoreActivation<TPackage, TPlan>(
  dependencies: RestoreActivationDependencies<TPackage, TPlan>,
): Promise<RestoreCancelResult> {
  return dependencies.lock.withExclusive(async () => {
    const state = await inspectActivationState(dependencies);
    if (state.kind === "normal") return state;
    if (state.kind !== "pending-empty") return state;
    dependencies.pendingStorage.remove();
    return { kind: "cancelled", pendingDeviceId: state.pendingDeviceId };
  });
}
