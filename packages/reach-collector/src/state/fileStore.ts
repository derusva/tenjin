import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";

import { canonicalJson } from "../contracts/canonicalJson.js";
import {
  createEmptyCollectorState,
  parseCollectorState,
  type CollectorStateV1,
} from "../contracts/collectorState.js";
import {
  withExclusiveLock,
  type AcquireExclusiveLockOptions,
} from "./lock.js";

export type JsonFileErrorCode =
  | "REACH_JSON_FILE_MISSING"
  | "REACH_JSON_FILE_TOO_LARGE"
  | "REACH_JSON_FILE_INVALID";

export class JsonFileError extends Error {
  readonly code: JsonFileErrorCode;
  readonly path: string;

  constructor(code: JsonFileErrorCode, path: string, message: string) {
    super(message);
    this.name = "JsonFileError";
    this.code = code;
    this.path = path;
  }
}
export interface ReachDataDirOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

export interface FileStateStoreOptions {
  readonly dataDir?: string;
  readonly stateFileName?: string;
  readonly maximumBytes?: number;
  readonly lock?: AcquireExclusiveLockOptions;
}

const DEFAULT_MAXIMUM_STATE_BYTES = 8 * 1_024 * 1_024;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function defaultReachDataDir(options: ReachDataDirOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (
    platform === "win32" &&
    typeof environment.LOCALAPPDATA === "string" &&
    environment.LOCALAPPDATA.trim().length > 0
  ) {
    return resolve(environment.LOCALAPPDATA, "Tenjin", "reach-collector");
  }
  return resolve(homeDirectory, ".tenjin", "reach-collector");
}

export async function readJsonFile(
  path: string,
  maximumBytes = DEFAULT_MAXIMUM_STATE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive integer");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new JsonFileError(
        "REACH_JSON_FILE_MISSING",
        path,
        `JSON file does not exist: ${path}`,
      );
    }
    throw error;
  }
  if (bytes.byteLength > maximumBytes) {
    throw new JsonFileError(
      "REACH_JSON_FILE_TOO_LARGE",
      path,
      `JSON file exceeds the ${maximumBytes} byte limit: ${path}`,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new JsonFileError(
      "REACH_JSON_FILE_INVALID",
      path,
      `JSON file is not valid UTF-8 JSON: ${path}`,
    );
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // Preserve the original write failure.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

/** Writes in the target directory, fsyncs, then atomically renames into place. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await closeQuietly(handle);
    await unlinkQuietly(temporaryPath);
    throw error;
  }
}

export class FileStateStore {
  readonly dataDir: string;
  readonly statePath: string;
  readonly lockPath: string;
  private readonly maximumBytes: number;
  private readonly lockOptions: AcquireExclusiveLockOptions;

  constructor(options: FileStateStoreOptions = {}) {
    const stateFileName = options.stateFileName ?? "state.json";
    if (basename(stateFileName) !== stateFileName) {
      throw new Error("stateFileName must not include a directory");
    }
    this.dataDir = resolve(options.dataDir ?? defaultReachDataDir());
    this.statePath = join(this.dataDir, stateFileName);
    this.lockPath = `${this.statePath}.lock`;
    this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_STATE_BYTES;
    this.lockOptions = options.lock ?? {};
  }

  async load(): Promise<CollectorStateV1> {
    try {
      return parseCollectorState(
        await readJsonFile(this.statePath, this.maximumBytes),
      );
    } catch (error) {
      if (
        error instanceof JsonFileError &&
        error.code === "REACH_JSON_FILE_MISSING"
      ) {
        return createEmptyCollectorState();
      }
      throw error;
    }
  }

  async save(state: CollectorStateV1): Promise<void> {
    await writeJsonAtomic(this.statePath, parseCollectorState(state));
  }

  async update(
    action: (
      current: CollectorStateV1,
    ) => CollectorStateV1 | Promise<CollectorStateV1>,
  ): Promise<CollectorStateV1> {
    return withExclusiveLock(
      this.lockPath,
      async () => {
        const next = parseCollectorState(await action(await this.load()));
        await this.save(next);
        return next;
      },
      this.lockOptions,
    );
  }
}
