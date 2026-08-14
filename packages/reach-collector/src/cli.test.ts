import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runReachCli } from "./cli.js";
import { createRawSourceItem } from "./contracts/rawSourceItem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function fixtureWorkspace(
  sourceIds: readonly string[] = ["fixture.social"],
): Promise<{
  readonly root: string;
  readonly configPath: string;
  readonly dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tenjin-reach-cli-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "data");
  const configPath = join(root, "reach.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schema: "tenjin.reach-config/v1",
      dataDir,
      sources: sourceIds.map((id) => ({
          id,
          kind: "fixture",
          accountScope: "test",
          path: "unused.json",
        })),
    }),
  );
  return { root, configPath, dataDir };
}

function capture(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly options: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

const rawItem = createRawSourceItem({
  sourceId: "fixture.social",
  accountScope: "test",
  platform: "fixture",
  externalId: "saved-1",
  canonicalUrl: "https://example.test/saved-1",
  interaction: "bookmark",
  content: {
    kind: "post",
    text: "大丈夫、手は打ったから。あとは結果を待つしかない。",
  },
  backend: { name: "fixture", version: "test" },
});

describe("tenjin-reach CLI", () => {
  it("writes stable machine-readable errors to stderr", async () => {
    const output = capture();
    const exitCode = await runReachCli(["--json", "unknown"], output.options);

    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toEqual({
      ok: false,
      error: {
        code: "REACH_CLI_UNKNOWN_COMMAND",
        message: "Unknown command: unknown",
      },
    });
  });

  it("redacts credential headers and structured fields from errors", async () => {
    const workspace = await fixtureWorkspace();
    const secrets = [
      "topsecret",
      "mixed-case-secret",
      "cookie-secret",
      "token-secret",
      "api-key-secret",
      "named-secret",
      "password-secret",
      "plain-token-secret",
    ];
    const upstreamError = Object.assign(
      new Error(
        [
          `Authorization: Bearer ${secrets[0]}`,
          `aUtHoRiZaTiOn  :   bEaReR    ${secrets[1]}`,
          JSON.stringify({
            cookie: secrets[2],
            token: secrets[3],
            apiKey: secrets[4],
            secret: secrets[5],
            password: secrets[6],
          }),
          `TOKEN = '${secrets[7]}'`,
        ].join("\n"),
      ),
      { code: "REACH_UPSTREAM_ERROR" },
    );
    const output = capture();

    expect(
      await runReachCli(
        ["--json", "collect", "--config", workspace.configPath, "--dry-run"],
        {
          ...output.options,
          runtime: {
            collectSource: async () => {
              throw upstreamError;
            },
          },
        },
      ),
    ).toBe(1);
    expect(output.stdout).toEqual([]);

    const errorOutput = JSON.parse(output.stderr.join("")) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(errorOutput.error.code).toBe("REACH_UPSTREAM_ERROR");
    expect(errorOutput.error.message).toContain(
      "Authorization: Bearer [REDACTED]",
    );
    expect(errorOutput.error.message).toContain('"cookie":"[REDACTED]"');
    expect(errorOutput.error.message).toContain('"apiKey":"[REDACTED]"');
    expect(errorOutput.error.message).toContain("TOKEN = [REDACTED]");
    for (const secret of secrets) {
      expect(output.stderr.join("")).not.toContain(secret);
    }
  });

  it("keeps dry runs side-effect free, then persists a locked collection", async () => {
    const workspace = await fixtureWorkspace();
    const runtime = {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      collectSource: async () => ({
        sourceId: "fixture.social",
        status: "collected" as const,
        items: [rawItem],
      }),
    };

    const dryOutput = capture();
    expect(
      await runReachCli(
        ["--json", "collect", "--config", workspace.configPath, "--dry-run"],
        { ...dryOutput.options, runtime },
      ),
    ).toBe(0);
    expect(JSON.parse(dryOutput.stdout.join(""))).toMatchObject({
      ok: true,
      command: "collect",
      dryRun: true,
      newItemCount: 1,
    });
    await expect(access(join(workspace.dataDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const liveOutput = capture();
    expect(
      await runReachCli(
        ["--json", "collect", "--config", workspace.configPath],
        { ...liveOutput.options, runtime },
      ),
    ).toBe(0);
    expect(JSON.parse(liveOutput.stdout.join(""))).toMatchObject({
      ok: true,
      command: "collect",
      dryRun: false,
      newItemCount: 1,
    });
    const state = JSON.parse(
      await readFile(join(workspace.dataDir, "state.json"), "utf8"),
    ) as { readonly revisions: Readonly<Record<string, unknown>> };
    expect(Object.keys(state.revisions)).toEqual([rawItem.itemKey]);
  });

  it("prepares bound teaching excerpts and compiles a Coach transfer", async () => {
    const workspace = await fixtureWorkspace();
    const runtime = {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      collectSource: async () => ({
        sourceId: "fixture.social",
        status: "collected" as const,
        items: [rawItem],
      }),
    };
    const collectOutput = capture();
    expect(
      await runReachCli(
        ["collect", "--config", workspace.configPath],
        { ...collectOutput.options, runtime },
      ),
    ).toBe(0);

    const requestPath = join(workspace.root, "request.json");
    const prepareOutput = capture();
    expect(
      await runReachCli(
        [
          "--json",
          "teaching",
          "prepare",
          "--config",
          workspace.configPath,
          "--out",
          requestPath,
        ],
        prepareOutput.options,
      ),
    ).toBe(0);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      readonly excerpts: readonly { readonly excerptId: string }[];
    };
    expect(request.excerpts).toHaveLength(2);

    const resultPath = join(workspace.root, "generation.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        schema: "tenjin.reach-generation-result/v1",
        items: [
          {
            excerptId: request.excerpts[0]!.excerptId,
            type: "lookup",
            focus: "手を打つ",
            answer: "读音：てをうつ。这里表示预先采取措施。",
          },
        ],
      }),
    );
    const transferPath = join(workspace.root, "transfer.json");
    const sourcesPath = join(workspace.root, "sources.json");
    const compileOutput = capture();
    expect(
      await runReachCli(
        [
          "--json",
          "teaching",
          "compile",
          "--request",
          requestPath,
          "--result",
          resultPath,
          "--out",
          transferPath,
          "--sources-out",
          sourcesPath,
        ],
        compileOutput.options,
      ),
    ).toBe(0);
    expect(JSON.parse(compileOutput.stdout.join(""))).toMatchObject({
      ok: true,
      command: "teaching.compile",
      itemCount: 1,
    });
    expect(JSON.parse(await readFile(transferPath, "utf8"))).toMatchObject({
      schema: "tenjin.coach-transfer/v1",
      items: [{ focus: "手を打つ" }],
    });
    expect(JSON.parse(await readFile(sourcesPath, "utf8"))).toMatchObject({
      schema: "tenjin.reach-transfer-sources/v1",
    });
  });

  it("prepares a shared raw revision through any source that observed it", async () => {
    const workspace = await fixtureWorkspace([
      "fixture.zeta",
      "fixture.alpha",
    ]);
    const bySource = new Map([
      [
        "fixture.zeta",
        createRawSourceItem({ ...rawItem, sourceId: "fixture.zeta" }),
      ],
      [
        "fixture.alpha",
        createRawSourceItem({ ...rawItem, sourceId: "fixture.alpha" }),
      ],
    ]);
    const collectOutput = capture();
    expect(
      await runReachCli(
        ["--json", "collect", "--config", workspace.configPath],
        {
          ...collectOutput.options,
          runtime: {
            now: () => new Date("2026-08-12T12:00:00.000Z"),
            collectSource: async (source: { readonly id: string }) => ({
              sourceId: source.id,
              status: "collected" as const,
              items: [bySource.get(source.id)!],
            }),
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(collectOutput.stdout.join(""))).toMatchObject({
      ok: true,
      newItemCount: 1,
    });

    const state = JSON.parse(
      await readFile(join(workspace.dataDir, "state.json"), "utf8"),
    ) as {
      readonly revisions: Readonly<
        Record<string, { readonly sourceIds: readonly string[] }>
      >;
    };
    expect(state.revisions[rawItem.itemKey]?.sourceIds).toEqual([
      "fixture.alpha",
      "fixture.zeta",
    ]);

    const requestPath = join(workspace.root, "alpha-request.json");
    const prepareOutput = capture();
    expect(
      await runReachCli(
        [
          "--json",
          "teaching",
          "prepare",
          "--config",
          workspace.configPath,
          "--source",
          "fixture.alpha",
          "--out",
          requestPath,
        ],
        prepareOutput.options,
      ),
    ).toBe(0);
    expect(JSON.parse(prepareOutput.stdout.join(""))).toMatchObject({
      ok: true,
      sourceItemCount: 1,
    });
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      readonly excerpts: readonly { readonly sourceId: string }[];
    };
    expect(request.excerpts.length).toBeGreaterThan(0);
    expect(new Set(request.excerpts.map((excerpt) => excerpt.sourceId))).toEqual(
      new Set(["fixture.zeta"]),
    );
  });
});
