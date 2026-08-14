import { homedir } from "node:os";
import { join } from "node:path";

import { XMLParser } from "fast-xml-parser";

import type { NoteRssSourceConfig } from "../config.js";
import {
  createRawSourceItem,
  type RawSourceItemV1,
} from "../contracts/index.js";
import {
  runCommand,
  type FixedCommandResult,
  type FixedCommandSpec,
} from "../process/runCommand.js";

export interface NoteRssDependencies {
  readonly fetch: (
    url: string,
    init?: RequestInit,
  ) => Promise<Pick<Response, "ok" | "status" | "text">>;
  readonly pythonExecutable?: string;
  readonly run?: (spec: FixedCommandSpec) => Promise<FixedCommandResult>;
}

const DEFAULT_DEPENDENCIES: NoteRssDependencies = {
  fetch: globalThis.fetch,
  pythonExecutable:
    process.platform === "win32"
      ? join(homedir(), ".agent-reach-venv", "Scripts", "python.exe")
      : "python3",
  run: runCommand,
};

const AGENT_REACH_HTTP_SCRIPT = [
  "import requests,sys",
  "r=requests.get(sys.argv[1],headers={'Accept':sys.argv[2],'User-Agent':'tenjin-reach/0.1'},timeout=30)",
  "r.raise_for_status()",
  "sys.stdout.buffer.write(r.content)",
].join(";");

const WINDOWS_HTTP_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$r=Invoke-WebRequest -Uri $env:TENJIN_REACH_URL -Headers @{Accept=$env:TENJIN_REACH_ACCEPT;'User-Agent'='tenjin-reach/0.1'} -UseBasicParsing -TimeoutSec 30",
  "[Console]::Out.Write($r.Content)",
].join(";");

interface FeedEntry {
  readonly id: string;
  readonly link: string;
  readonly title?: string;
  readonly summary?: string;
  readonly publishedAt?: string;
  readonly author?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  const object = record(value);
  if (object !== undefined) {
    const text = object["#text"] ?? object["@_href"];
    if (typeof text === "string" && text.trim().length > 0) return text.trim();
  }
  return undefined;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function parseEntries(xml: string): readonly FeedEntry[] {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    cdataPropName: "#text",
    trimValues: true,
    processEntities: true,
  }).parse(xml) as unknown;
  const root = record(parsed);
  const rssChannel = record(record(root?.rss)?.channel);
  const atomFeed = record(root?.feed);
  const rawEntries = rssChannel?.item ?? atomFeed?.entry;
  const values = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries === undefined
      ? []
      : [rawEntries];
  return values.flatMap((value): FeedEntry[] => {
    const item = record(value);
    if (item === undefined) return [];
    const link = stringValue(item.link);
    if (link === undefined) return [];
    const id = stringValue(item.guid) ?? stringValue(item.id) ?? link;
    const title = stringValue(item.title);
    const summary = stringValue(
      item["content:encoded"] ?? item.content ?? item.description ?? item.summary,
    );
    const publishedAt = canonicalIso(
      stringValue(item.pubDate ?? item.published ?? item.updated ?? item.date),
    );
    const author = stringValue(
      item["dc:creator"] ?? item.author ?? item.creator,
    );
    return [{
      id,
      link,
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary: stripMarkup(summary) }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(author === undefined ? {} : { author }),
    }];
  });
}

function parseJinaFeed(markdown: string): readonly FeedEntry[] {
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  const pattern = /^#{2,4}\s+\[([^\]]+)\]\((https:\/\/note\.com\/[^)\s]+)\)/gimu;
  for (const match of markdown.matchAll(pattern)) {
    const title = match[1]?.trim();
    const link = match[2]?.trim();
    if (title === undefined || link === undefined || seen.has(link)) continue;
    seen.add(link);
    entries.push({ id: link, link, title, summary: title });
  }
  return entries;
}

async function fetchText(
  url: string,
  dependencies: NoteRssDependencies,
  accept: string,
): Promise<string> {
  let body: string;
  try {
    const response = await dependencies.fetch(url, {
      headers: { Accept: accept, "User-Agent": "tenjin-reach/0.1" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while reading source`);
    }
    body = await response.text();
  } catch (nativeError) {
    const run = dependencies.run ?? DEFAULT_DEPENDENCIES.run!;
    const pythonExecutable =
      dependencies.pythonExecutable ?? DEFAULT_DEPENDENCIES.pythonExecutable!;
    try {
      body = (
        await run({
          executable: pythonExecutable,
          args: ["-c", AGENT_REACH_HTTP_SCRIPT, url, accept],
          timeoutMs: 45_000,
          maxStdoutBytes: 5 * 1024 * 1024,
        })
      ).stdout;
    } catch {
      if (process.platform !== "win32") {
        throw nativeError;
      }
      try {
        body = (
          await run({
            executable: "powershell.exe",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              WINDOWS_HTTP_SCRIPT,
            ],
            environment: {
              TENJIN_REACH_URL: url,
              TENJIN_REACH_ACCEPT: accept,
            },
            timeoutMs: 45_000,
            maxStdoutBytes: 5 * 1024 * 1024,
          })
        ).stdout;
      } catch {
        throw nativeError;
      }
    }
  }
  if (body.trim().length === 0) throw new Error("Source returned an empty body");
  return body;
}

async function noteFullText(
  url: string,
  dependencies: NoteRssDependencies,
): Promise<string | undefined> {
  try {
    const raw = await fetchText(
      `https://r.jina.ai/${url}`,
      dependencies,
      "application/json",
    );
    try {
      const parsed = JSON.parse(raw) as unknown;
      const content = record(record(parsed)?.data)?.content;
      return typeof content === "string" && content.trim().length > 0
        ? content.trim()
        : undefined;
    } catch {
      return raw.trim().length > 0 ? raw.trim() : undefined;
    }
  } catch {
    return undefined;
  }
}

export async function collectNoteRssSource(
  config: NoteRssSourceConfig,
  dependencies: NoteRssDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly RawSourceItemV1[]> {
  let discovered: readonly FeedEntry[];
  try {
    discovered = parseEntries(
      await fetchText(
        config.feedUrl,
        dependencies,
        "application/rss+xml, application/atom+xml, text/xml",
      ),
    );
  } catch {
    discovered = parseJinaFeed(
      await fetchText(
        `https://r.jina.ai/${config.feedUrl}`,
        dependencies,
        "text/plain",
      ),
    );
  }
  const entries = discovered.slice(0, config.limit);
  const results: RawSourceItemV1[] = [];
  for (const entry of entries) {
    const fullText = config.fetchFullText
      ? await noteFullText(entry.link, dependencies)
      : undefined;
    const text = fullText ?? entry.summary ?? entry.title;
    if (text === undefined || text.trim().length === 0) continue;
    results.push(createRawSourceItem({
      sourceId: config.id,
      accountScope: config.accountScope,
      platform: "note",
      externalId: entry.id,
      canonicalUrl: entry.link,
      interaction: "rss_magazine",
      content: {
        kind: "article",
        ...(entry.title === undefined ? {} : { title: entry.title }),
        text,
      },
      backend: { name: "rss-http", version: "1" },
      ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
      ...(entry.author === undefined ? {} : { author: entry.author }),
    }));
  }
  return results;
}
