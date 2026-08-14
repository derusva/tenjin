import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  COLLECTOR_STATE_SCHEMA,
  recordSourceSuccess,
} from "../contracts/collectorState.js";
import {
  defaultReachDataDir,
  FileStateStore,
  JsonFileError,
  readJsonFile,
  writeJsonAtomic,
} from "./fileStore.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tenjin-reach-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
describe("defaultReachDataDir", () => {
  it("uses LOCALAPPDATA on Windows, never the working directory", () => {
    expect(
      defaultReachDataDir({
        platform: "win32",
        environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        homeDirectory: "C:\\Users\\test",
      }),
    ).toBe(resolve("C:\\Users\\test\\AppData\\Local", "Tenjin", "reach-collector"));
  });

  it("uses a hidden home directory elsewhere", () => {
    expect(
      defaultReachDataDir({
        platform: "linux",
        environment: {},
        homeDirectory: "/home/test",
      }),
    ).toBe(resolve("/home/test", ".tenjin", "reach-collector"));
  });
});

describe("atomic JSON and FileStateStore", () => {
  it("writes canonical JSON and replaces the complete target", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "state.json");
    await writeJsonAtomic(path, { z: 1, a: { y: true } });
    expect(await readFile(path, "utf8")).toBe('{"a":{"y":true},"z":1}\n');
    expect(await readJsonFile(path)).toEqual({ a: { y: true }, z: 1 });
  });

  it("returns a new state when absent, then persists an updated state", async () => {
    const dataDir = await temporaryDirectory();
    const store = new FileStateStore({ dataDir });
    expect(await store.load()).toEqual({
      schema: COLLECTOR_STATE_SCHEMA,
      sources: {},
      revisions: {},
    });
    const updated = await store.update((state) =>
      recordSourceSuccess(state, "note.saved", "2026-08-12T01:02:03.000Z", "next"),
    );
    expect(updated.sources["note.saved"]).toEqual({
      cursor: "next",
      lastSuccessAt: "2026-08-12T01:02:03.000Z",
    });
    expect(await store.load()).toEqual(updated);
  });

  it("fails closed on invalid or oversized JSON", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "bad.json");
    await writeFile(path, "{", "utf8");
    await expect(readJsonFile(path)).rejects.toMatchObject({
      code: "REACH_JSON_FILE_INVALID",
    });
    await writeFile(path, "{}", "utf8");
    await expect(readJsonFile(path, 1)).rejects.toBeInstanceOf(JsonFileError);
  });
});
