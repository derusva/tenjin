import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { Event } from "@tenjin/core";
import { exportLedgerPackage } from "./exportPackage.js";
import type { ExportContext } from "./exportPackage.js";
import { scanPackagePlaintext } from "./inspectPackage.js";
import { PACKAGE_LIMITS } from "./limits.js";

/**
 * The timezone-invariance test has to switch the process timezone, and that is
 * the only Node global this package touches. `@tenjin/exchange` deliberately
 * ships without `@types/node` - it must stay free of both DOM and Node runtime
 * dependencies - so the one global the tests need is declared narrowly here
 * rather than by pulling the whole Node typings into the package.
 */
declare const process: { env: { TZ?: string | undefined } };

const SENTINEL_SOURCE = "SENTINEL_SOURCE_TEXT";
const SENTINEL_ANSWER = "SENTINEL_ANSWER_TEXT";

/**
 * Digests shaped exactly like production, because a fixture that is not is a
 * fixture that cannot catch a shape bug. The two shapes differ on purpose:
 *
 * - a context hash is `sha256:` + exactly 64 lowercase hex (ledgerRuntime.ts
 *   `hashContext` returns `` `sha256:${hexadecimal.toLowerCase()}` ``);
 * - an image digest is a BARE 64-hex string, no prefix (repository.ts checks
 *   it against /^[a-f0-9]{64}$/ and compares it to a raw crypto.subtle digest).
 *
 * These particular values are real SHA-256 digests of arbitrary strings; only
 * their shape is load-bearing. The previous fixtures were `sha256:aa` and
 * `sha256:bb`, wrong on both length and - for the image - prefix, which is why
 * the exporter could accept a 2-character hash unnoticed.
 */
const SECRET_HEX =
  "fa1602c2b2c815e0f9f5d01ce0fbd79b879fe65b6e310e2d99e1b61d3d35ad30";
const SECRET_HASH = `sha256:${SECRET_HEX}`;
const SECRET_IMAGE_SHA256 =
  "96197a8bb6129814161a81b933c8d9687e6073ff5e2582656879244b12866e68";
const IMAGE_ONLY_HEX =
  "ee8c102fa514835908805bc0ad4f0bfcf11b260eaa6c840089f3fb64d3e5d022";
const IMAGE_ONLY_HASH = `sha256:${IMAGE_ONLY_HEX}`;
const IMAGE_ONLY_SHA256 =
  "546fca8acd597339971efe464e2e41589e0993ba68a445339247939f6d68cd20";

function captureEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "capture_created",
    captureId: `capture-${seq}`,
    contextHash: SECRET_HASH,
    payload: { captureType: "lookup" },
  } as Event;
}

/**
 * A real item_created, not a stripped-down stub. createCapture.ts:165 puts the
 * whole source text into payload.display, so this is what production data
 * actually looks like - and it is the reason the abstract mode is deferred.
 */
function itemCreatedEvent(seq: number, wallTime: number): Event {
  return {
    schemaVersion: 1,
    eventId: `device-a:${seq}`,
    deviceId: "device-a",
    seq,
    hlc: { wallTime, counter: 0 },
    occurredAt: "2026-08-05T00:00:00.000Z",
    recordedAt: "2026-08-05T00:00:00.000Z",
    kind: "item_created",
    captureId: "capture-1",
    itemId: "item-1",
    payload: {
      display: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      identityKey: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
      targetChannels: ["R"],
    },
  } as Event;
}

const secretContext: ExportContext = {
  hash: SECRET_HASH,
  original: `${SENTINEL_SOURCE}_大丈夫、手は打ったから。`,
  answer: `${SENTINEL_ANSWER}_提前采取措施`,
  createdAt: "2026-08-05T00:00:00.000Z",
  image: {
    mediaType: "image/png",
    name: "shot.png",
    byteLength: 4,
    sha256: SECRET_IMAGE_SHA256,
    bytes: new Uint8Array([1, 2, 3, 4]),
  },
};

function imageOnlyContext(bytes: Uint8Array): ExportContext {
  return {
    hash: IMAGE_ONLY_HASH,
    original: "unrelated",
    createdAt: "2026-08-05T00:00:00.000Z",
    image: {
      mediaType: "image/png",
      name: "raw.png",
      byteLength: bytes.byteLength,
      sha256: IMAGE_ONLY_SHA256,
      bytes,
    },
  };
}

const input = {
  events: [itemCreatedEvent(2, 20), captureEvent(1, 10)],
  contexts: [secretContext],
  importReceipts: [],
  mode: "full-backup" as const,
  exportedByDeviceId: "device-a",
  exportedAt: "2026-08-05T12:00:00.000Z",
};

const RECEIPT_DIGEST_A = `sha256:${"a".repeat(64)}`;
const RECEIPT_DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("exportLedgerPackage", () => {
  it("writes the four fixed v2 entries, including an empty receipt array", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain("manifest.json");
    expect(Object.keys(entries)).toContain("events.jsonl");
    expect(Object.keys(entries)).toContain("redactions.jsonl");
    expect(Object.keys(entries)).toContain("import-receipts.json");
    expect(strFromU8(entries["redactions.jsonl"]!)).toBe("");
    expect(strFromU8(entries["import-receipts.json"]!)).toBe("[]");
  });

  it("serialises events in canonical order, one per line", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const lines = strFromU8(entries["events.jsonl"]!).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).eventId).toBe("device-a:1");
    expect(JSON.parse(lines[1]!).eventId).toBe("device-a:2");
  });

  it("carries contexts and raw image bytes", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    expect(Object.keys(entries)).toContain(`contexts/${SECRET_HEX}.json`);
    expect(entries[`contexts/${SECRET_HEX}.image`]).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    const stored = JSON.parse(
      strFromU8(entries[`contexts/${SECRET_HEX}.json`]!),
    );
    expect(stored.hash).toBe(SECRET_HASH);
    expect(stored.image.sha256).toBe(SECRET_IMAGE_SHA256);
    expect(stored.image.bytes).toBeUndefined();
  });

  it("reports the real context count in the manifest", () => {
    const entries = unzipSync(exportLedgerPackage(input));
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(manifest.contextCount).toBe(1);
    expect(manifest.eventCount).toBe(2);
    expect(manifest.mode).toBe("full-backup");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.importReceiptCount).toBe(0);
    expect(manifest.foldExternalState).toEqual(["importReceipts"]);
  });

  it("sorts receipts by digest without reordering their captureIds", () => {
    const entries = unzipSync(
      exportLedgerPackage({
        ...input,
        events: [...input.events, captureEvent(3, 30)],
        importReceipts: [
          {
            digest: RECEIPT_DIGEST_B,
            importedAt: "2026-08-05T11:00:00.000Z",
            captureIds: ["capture-1"],
          },
          {
            digest: RECEIPT_DIGEST_A,
            importedAt: "2026-08-05T10:00:00.000Z",
            captureIds: ["capture-3", "capture-1"],
          },
        ],
      }),
    );
    expect(JSON.parse(strFromU8(entries["import-receipts.json"]!))).toEqual([
      {
        captureIds: ["capture-3", "capture-1"],
        digest: RECEIPT_DIGEST_A,
        importedAt: "2026-08-05T10:00:00.000Z",
      },
      {
        captureIds: ["capture-1"],
        digest: RECEIPT_DIGEST_B,
        importedAt: "2026-08-05T11:00:00.000Z",
      },
    ]);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(manifest.importReceiptCount).toBe(2);
  });

  it("produces byte-identical output for the same input", () => {
    expect(exportLedgerPackage(input)).toEqual(exportLedgerPackage(input));
  });

  it("produces byte-identical output when the input arrays are shuffled", () => {
    const forward = exportLedgerPackage(input);
    const shuffled = exportLedgerPackage({
      ...input,
      events: [...input.events].reverse(),
    });
    expect(shuffled).toEqual(forward);
  });

  it("encodes the fixed 1980-01-01 12:00 DOS timestamp into the package bytes", () => {
    const bytes = exportLedgerPackage(input);
    const readU16 = (offset: number): number =>
      bytes[offset]! | (bytes[offset + 1]! << 8);

    // A zip begins with its first local file header, whose layout is:
    // 0-3 signature "PK\x03\x04", 4-5 version needed, 6-7 flags,
    // 8-9 method, 10-11 last-mod time, 12-13 last-mod date. Every multi-byte
    // field is little-endian. Asserting the signature first proves the two
    // offsets below really are being read out of a header.
    expect(readU16(0)).toBe(0x4b50);
    expect(readU16(2)).toBe(0x0403);

    // Computed, not copied out of the output: a hardcoded hex literal would be
    // whatever the implementation happened to emit on the day it was written.
    const expectedDosDate = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
    const expectedDosTime = (12 << 11) | (0 << 5) | (0 >> 1); // 12:00:00
    expect(readU16(10)).toBe(expectedDosTime);
    expect(readU16(12)).toBe(expectedDosDate);
  });

  it("encodes identical bytes in every timezone", () => {
    // A Date is an absolute instant, but fflate encodes the DOS fields with
    // LOCAL calendar getters. A Date built once, at module load, therefore
    // encodes differently depending on where the process is running - and
    // westward of the construction zone it reads back as 1979 and the export
    // throws outright. Building it per export makes construction and encoding
    // happen in one timezone, so they cancel.
    const zones = ["UTC", "America/Los_Angeles", "Asia/Tokyo"];
    const originalTz = process.env.TZ;
    // Restoring by `delete process.env.TZ` does NOT bring the system zone back
    // in this runtime - measured: the process stayed westward and every later
    // export in the file then threw. So capture the resolved zone name while it
    // is still untouched and restore it by name.
    const systemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const baselineOffset = new Date(2020, 0, 1).getTimezoneOffset();
    const offsets: number[] = [];
    const packages: Uint8Array[] = [];
    try {
      for (const zone of zones) {
        process.env.TZ = zone;
        offsets.push(new Date(2020, 0, 1).getTimezoneOffset());
        packages.push(exportLedgerPackage(input));
      }
    } finally {
      // Write the resolved system zone back first - that is what actually
      // refreshes the cached zone. Only then restore the variable itself to
      // exactly what it was: on a machine where TZ was never set, leaving it
      // defined would quietly change the environment for every later test,
      // and an offset check cannot see that because the zone would be right.
      process.env.TZ = systemZone;
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }

    // Prove the cleanup worked on both axes: the effective zone is back, and
    // the variable itself is exactly what it was.
    expect(new Date(2020, 0, 1).getTimezoneOffset()).toBe(baselineOffset);
    expect(process.env.TZ).toBe(originalTz);

    // Guard the guard. On a platform that ignored process.env.TZ every export
    // would run in one timezone and the comparison below would hold
    // unconditionally - an always-PASS check proving nothing.
    expect(new Set(offsets).size).toBe(zones.length);
    expect(packages).toHaveLength(zones.length);
    expect(packages[0]!.byteLength).toBeGreaterThan(0);
    expect(packages[1]!).toEqual(packages[0]!);
    expect(packages[2]!).toEqual(packages[0]!);
  });

  it("does not read a live clock between two exports", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
      const first = exportLedgerPackage(input);
      // More than two seconds on purpose: DOS timestamps have 2-second
      // resolution, so a shorter gap could not tell a clock read apart from a
      // constant.
      vi.advanceTimersByTime(3_000);
      const second = exportLedgerPackage(input);
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries every field of a full context record through unchanged", () => {
    // The metadata is built from an explicit whitelist rather than a spread, so
    // this is the guard that the whitelist did not quietly forget an optional
    // field. `corrected` is the one most easily lost: it is absent from the
    // lookup fixture above.
    const entries = unzipSync(
      exportLedgerPackage({
        ...input,
        contexts: [{ ...secretContext, corrected: "corrected text" }],
      }),
    );
    const stored: unknown = JSON.parse(
      strFromU8(entries[`contexts/${SECRET_HEX}.json`]!),
    );
    expect(stored).toEqual({
      hash: secretContext.hash,
      original: secretContext.original,
      corrected: "corrected text",
      answer: secretContext.answer,
      createdAt: secretContext.createdAt,
      image: {
        mediaType: "image/png",
        name: "shot.png",
        byteLength: 4,
        sha256: secretContext.image!.sha256,
      },
    });
  });

  it("rejects fields outside the closed v2 context shape", () => {
    // The writer enumerates the active schema fields instead of spreading an
    // object. Dropping a future field would make a backup look successful while
    // silently losing state.
    const withUnknown = { ...secretContext, focus: "手を打つ", futureField: 1 };
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [withUnknown] }),
    ).toThrow(TypeError);
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [withUnknown] }),
    ).toThrow(/futureField/);
  });

  it("preserves focus in v2 context metadata", () => {
    const entries = unzipSync(
      exportLedgerPackage({
        ...input,
        contexts: [{ ...secretContext, focus: "focused chunk" }],
      }),
    );
    const stored = JSON.parse(
      strFromU8(entries[`contexts/${SECRET_HEX}.json`]!),
    );
    expect(stored.focus).toBe("focused chunk");
  });

  it("rejects unknown context image fields as well", () => {
    // Same defect, one level down: the image metadata was spread too.
    const withUnknownImage = {
      ...secretContext,
      image: { ...secretContext.image!, exifOrientation: 6 },
    };
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [withUnknownImage] }),
    ).toThrow(/exifOrientation/);
  });

  it("rejects an image whose declared byteLength disagrees with its bytes", () => {
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [
          {
            ...secretContext,
            image: { ...secretContext.image!, byteLength: 99 },
          },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("rejects a context hash without the expected sha256 prefix", () => {
    expect(() =>
      exportLedgerPackage({ ...input, contexts: [{ ...secretContext, hash: "aa" }] }),
    ).toThrow(TypeError);
  });

  it("rejects duplicate context hashes instead of silently collapsing them", () => {
    // Contexts are content-addressed and the IndexedDB `contexts` store is
    // keyed by hash, so a caller can never legitimately produce two entries
    // sharing one hash - a duplicate means an upstream bug.
    //
    // Absorbing it silently is worse than failing: the two entries collapse
    // onto one zip key while contextCount still counts the input array, so the
    // manifest claims more contexts than the package holds and a restorer that
    // cross-checks the two would judge a valid-looking package corrupt.
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [secretContext, { ...secretContext, original: "different" }],
      }),
    ).toThrow(TypeError);
  });

  it("names the duplicated hash when it rejects one", () => {
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [secretContext, { ...secretContext, original: "different" }],
      }),
    ).toThrow(SECRET_HASH);
  });

  it("rejects a context hash that is not sha256 plus 64 lowercase hex", () => {
    // `sha256:aa` is well-formed by prefix and by alphabet, and it is exactly
    // what this suite used as a fixture until now - the exporter took it, and
    // named a zip entry `contexts/aa.json` after it. A digest of the wrong
    // length is not a digest; in a content-addressed layer accepting one means
    // accepting an identity nothing else in the system could ever produce.
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [{ ...secretContext, hash: "sha256:aa" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [{ ...secretContext, hash: "sha256:aa" }],
      }),
    ).toThrow("sha256:aa");
  });

  it("rejects an image digest carrying a sha256: prefix", () => {
    // The two digests are deliberately shaped differently. repository.ts
    // compares `image.sha256` against a bare crypto.subtle hex digest, so a
    // prefixed value could never match the bytes it claims to describe - it
    // would sail through export and fail verification on restore.
    const prefixed = `sha256:${SECRET_IMAGE_SHA256}`;
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [
          {
            ...secretContext,
            image: { ...secretContext.image!, sha256: prefixed },
          },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      exportLedgerPackage({
        ...input,
        contexts: [
          {
            ...secretContext,
            image: { ...secretContext.image!, sha256: prefixed },
          },
        ],
      }),
    ).toThrow(prefixed);
  });

  it("rejects event and context count overflow before calling the zip encoder", () => {
    const zip = vi.fn(() => new Uint8Array());
    const dependencies = { zip };

    expect(() =>
      exportLedgerPackage(
        {
          ...input,
          events: new Array<Event>(PACKAGE_LIMITS.events + 1).fill(
            input.events[0]!,
          ),
        },
        dependencies,
      ),
    ).toThrow(/eventCount/);
    expect(() =>
      exportLedgerPackage(
        {
          ...input,
          contexts: new Array<ExportContext>(PACKAGE_LIMITS.contexts + 1).fill(
            secretContext,
          ),
        },
        dependencies,
      ),
    ).toThrow(/contextCount/);
    expect(zip).not.toHaveBeenCalled();
  });

  it("rejects an oversized image entry before calling the zip encoder", () => {
    const byteLength = PACKAGE_LIMITS.imageEntryBytes + 1;
    const bytes = { byteLength } as Uint8Array;
    const zip = vi.fn(() => new Uint8Array());

    expect(() =>
      exportLedgerPackage(
        {
          ...input,
          contexts: [
            {
              ...secretContext,
              image: { ...secretContext.image!, byteLength, bytes },
            },
          ],
        },
        { zip },
      ),
    ).toThrow(/image entry limit/);
    expect(zip).not.toHaveBeenCalled();
  });

  it("checks the compressed byte limit after the zip encoder returns", () => {
    const oversized = {
      byteLength: PACKAGE_LIMITS.compressedBytes + 1,
    } as Uint8Array;
    const zip = vi.fn(() => oversized);

    expect(() => exportLedgerPackage(input, { zip })).toThrow(
      /compressed package byteLength/,
    );
    expect(zip).toHaveBeenCalledOnce();
  });
});

describe("scanPackagePlaintext (positive control)", () => {
  // These assertions are deliberately POSITIVE. A full backup is supposed to
  // carry every byte of the ledger, so there is nothing to prove absent here.
  // What must be proved is that the scanner can actually see through the zip -
  // otherwise the future "an abstract package contains no source text"
  // assertion would pass even when the text is present.

  it("finds text stored inside a context entry", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).toContain(SENTINEL_ANSWER);
  });

  it("finds text stored inside an event payload", () => {
    // This is the exact leak that defers the abstract mode: createCapture.ts
    // writes the whole source text into item_created.payload.display, so the
    // sentence lives in events.jsonl, not only in contexts/.
    const eventsOnly = { ...input, contexts: [] };
    const haystack = scanPackagePlaintext(exportLedgerPackage(eventsOnly));
    expect(haystack).toContain(SENTINEL_SOURCE);
  });

  it("would not find text that is genuinely absent", () => {
    const haystack = scanPackagePlaintext(exportLedgerPackage(input));
    expect(haystack).not.toContain("SENTINEL_NEVER_WRITTEN");
  });

  it("finds an ascii marker surrounded by bytes that are not valid utf-8", () => {
    // Real PNG magic followed by lone continuation bytes, so the entry is
    // genuinely not valid UTF-8. This guards that image entries are scanned at
    // all, and that rendering them cannot throw.
    //
    // It deliberately does NOT claim to guard the latin1 rendering: TextDecoder
    // resynchronises after invalid bytes, and ASCII bytes (0x00-0x7f) can never
    // be consumed as UTF-8 continuation bytes (0x80-0xbf), so an ASCII marker
    // survives the UTF-8 pass regardless. Measured: this test still passes with
    // the latin1 rendering deleted. The next test is the one that pins it.
    const marker = "MARKER_IN_IMAGE";
    const raw = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80, 0x80,
      ...[...marker].map((character) => character.charCodeAt(0)),
    ]);
    const haystack = scanPackagePlaintext(
      exportLedgerPackage({ ...input, contexts: [imageOnlyContext(raw)] }),
    );
    expect(haystack).toContain(marker);
  });

  it("finds a non-ascii latin1 marker that the utf-8 rendering destroys", () => {
    // This is what actually pins the latin1 rendering. The byte 0xe9 spells
    // U+00E9 in latin1 but is invalid UTF-8, so the UTF-8 pass turns it into
    // replacement characters and only the latin1 pass can still see it.
    // Verified by deleting the latin1 rendering: this test goes red and the
    // ASCII one above stays green.
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xe9, 0xe9, 0xe9, 0xe9]);
    const haystack = scanPackagePlaintext(
      exportLedgerPackage({ ...input, contexts: [imageOnlyContext(raw)] }),
    );
    expect(haystack).toContain("éééé");
  });

  it("does not depend on the raw zip bytes containing the plaintext", () => {
    // Guards the whole approach: scanning the compressed bytes is an
    // always-PASS check, because deflate hides the plaintext.
    const bytes = exportLedgerPackage(input);
    expect(strFromU8(bytes, true)).not.toContain(SENTINEL_ANSWER);
    expect(scanPackagePlaintext(bytes)).toContain(SENTINEL_ANSWER);
  });
});
