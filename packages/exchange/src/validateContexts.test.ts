import { serializeContextHashInput } from "@tenjin/core";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import {
  validateContexts,
  type ContextEntries,
  type Sha256Hex,
} from "./validateContexts.js";

/**
 * Deterministic test digest for comparison-path coverage only. This is NOT
 * SHA-256. Production digest wiring is proven by the apps/web integration test.
 */
const fakeSha256Hex: Sha256Hex = async (bytes) => {
  let state = 0x811c9dc5;
  for (const byte of bytes) {
    state = Math.imul(state ^ byte, 0x01000193) >>> 0;
  }

  const words: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    state = Math.imul(state ^ bytes.byteLength ^ index, 0x01000193) >>> 0;
    words.push(state.toString(16).padStart(8, "0"));
  }
  return words.join("");
};

interface TestImageMetadata {
  readonly mediaType: string;
  readonly name: unknown;
  readonly byteLength: unknown;
  readonly sha256: unknown;
}

interface TestContextMetadata {
  readonly hash: unknown;
  readonly original: unknown;
  readonly focus?: unknown;
  readonly corrected?: unknown;
  readonly answer?: unknown;
  readonly image?: unknown;
  readonly createdAt: unknown;
}

interface ContextFixture {
  readonly entryHash: string;
  readonly metadata: TestContextMetadata;
  readonly imageBytes?: Uint8Array;
}

async function contextFixture(options: {
  readonly withImage?: boolean;
  readonly original?: string;
  readonly focus?: string | undefined;
  readonly corrected?: string | undefined;
  readonly answer?: string | undefined;
  readonly bytes?: Uint8Array;
} = {}): Promise<ContextFixture> {
  const original = options.original ?? "大丈夫、手は打ったから。";
  const focus = options.focus;
  const corrected = options.corrected;
  const answer = Object.hasOwn(options, "answer")
    ? options.answer
    : "已经提前采取措施了。";
  const imageBytes = options.withImage
    ? (options.bytes ?? new Uint8Array([1, 2, 3, 4]))
    : undefined;
  const imageSha256 =
    imageBytes === undefined ? undefined : await fakeSha256Hex(imageBytes);
  const entryHash = await fakeSha256Hex(
    strToU8(
      serializeContextHashInput({
        original,
        ...(focus === undefined ? {} : { focus }),
        ...(corrected === undefined ? {} : { corrected }),
        ...(answer === undefined ? {} : { answer }),
        ...(imageSha256 === undefined ? {} : { imageSha256 }),
      }),
    ),
  );

  const image: TestImageMetadata | undefined =
    imageBytes === undefined
      ? undefined
      : {
          mediaType: "image/png",
          name: "p5r.png",
          byteLength: imageBytes.byteLength,
          sha256: imageSha256,
        };

  return {
    entryHash,
    metadata: {
      hash: `sha256:${entryHash}`,
      original,
      ...(focus === undefined ? {} : { focus }),
      ...(corrected === undefined ? {} : { corrected }),
      ...(answer === undefined ? {} : { answer }),
      ...(image === undefined ? {} : { image }),
      createdAt: "2026-08-10T12:34:56.000Z",
    },
    ...(imageBytes === undefined ? {} : { imageBytes }),
  };
}

function entriesFor(
  fixture: ContextFixture,
  metadata: unknown = fixture.metadata,
  imageEntries: ReadonlyMap<string, Uint8Array> =
    fixture.imageBytes === undefined
      ? new Map<string, Uint8Array>()
      : new Map([[fixture.entryHash, fixture.imageBytes]]),
): ContextEntries {
  return {
    contextJsonByHash: new Map([
      [fixture.entryHash, JSON.stringify(metadata)],
    ]),
    contextImageByHash: imageEntries,
  };
}

describe("validateContexts", () => {
  it("v2 preserves focus and includes it in context identity", async () => {
    const fixture = await contextFixture({ focus: "focused chunk" });

    await expect(
      validateContexts(entriesFor(fixture), fakeSha256Hex, 2),
    ).resolves.toEqual([fixture.metadata]);
  });

  it("v1 rejects focus instead of silently widening the legacy schema", async () => {
    const fixture = await contextFixture({ focus: "focused chunk" });

    await expect(
      validateContexts(entriesFor(fixture), fakeSha256Hex, 1),
    ).rejects.toThrow(/unknown context field.*focus/i);
  });

  it("returns a validated context without optional fields", async () => {
    const fixture = await contextFixture({ answer: undefined });

    await expect(
      validateContexts(entriesFor(fixture), fakeSha256Hex),
    ).resolves.toEqual([
      {
        hash: `sha256:${fixture.entryHash}`,
        original: "大丈夫、手は打ったから。",
        createdAt: "2026-08-10T12:34:56.000Z",
      },
    ]);
  });

  it("preserves every supported field and carries image bytes, not a Blob", async () => {
    const fixture = await contextFixture({
      withImage: true,
      corrected: "手を打っておいた。",
    });

    await expect(
      validateContexts(entriesFor(fixture), fakeSha256Hex),
    ).resolves.toEqual([
      {
        ...fixture.metadata,
        image: {
          ...(fixture.metadata.image as TestImageMetadata),
          bytes: fixture.imageBytes,
        },
      },
    ]);
  });

  it.each([
    ["missing prefix", "a".repeat(64)],
    ["too short", "sha256:aa"],
    ["uppercase", `sha256:${"A".repeat(64)}`],
  ])("rejects a context hash with %s", async (_name, hash) => {
    const fixture = await contextFixture();
    const metadata = { ...fixture.metadata, hash };

    await expect(
      validateContexts(entriesFor(fixture, metadata), fakeSha256Hex),
    ).rejects.toThrow(/context hash.*64 lowercase/i);
  });

  it("requires the declared context hash to equal the metadata entry name", async () => {
    const fixture = await contextFixture();
    const metadata = {
      ...fixture.metadata,
      hash: `sha256:${"e".repeat(64)}`,
    };

    await expect(
      validateContexts(entriesFor(fixture, metadata), fakeSha256Hex),
    ).rejects.toThrow(/entry name/i);
  });

  it("rejects a context metadata entry key that is not 64 lowercase hex", async () => {
    const fixture = await contextFixture();
    const entries: ContextEntries = {
      contextJsonByHash: new Map([
        ["A".repeat(64), JSON.stringify(fixture.metadata)],
      ]),
      contextImageByHash: new Map(),
    };

    await expect(validateContexts(entries, fakeSha256Hex)).rejects.toThrow(
      /context entry name.*64 lowercase/i,
    );
  });

  it.each([
    ["non-string", 7],
    ["blank", " \t "],
  ])("rejects an original that is %s", async (_name, original) => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, original }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/original/i);
  });

  it.each([
    ["non-string", 7],
    ["blank", " \t "],
  ])("rejects a present corrected value that is %s", async (_name, corrected) => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, corrected }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/corrected/i);
  });

  it.each([
    ["non-string", 7],
    ["blank", " \t "],
  ])("rejects a present answer value that is %s", async (_name, answer) => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, answer }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/answer/i);
  });

  it.each([
    ["unparseable", "today"],
    ["non-canonical", "2026-08-10T12:34:56Z"],
    ["non-string", 1],
  ])("rejects a createdAt value that is %s", async (_name, createdAt) => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, createdAt }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/createdAt/i);
  });

  it.each(["image/jpeg", "image/png", "image/heic", "image/heif"])(
    "accepts supported mediaType %s",
    async (mediaType) => {
      const fixture = await contextFixture({ withImage: true });
      const image = {
        ...(fixture.metadata.image as TestImageMetadata),
        mediaType,
      };

      await expect(
        validateContexts(
          entriesFor(fixture, { ...fixture.metadata, image }),
          fakeSha256Hex,
        ),
      ).resolves.toHaveLength(1);
    },
  );

  it.each([
    ["one-byte minimum", 1],
    ["exact 20 MiB maximum", 20 * 1024 * 1024],
  ])("accepts the %s image boundary", async (_name, byteLength) => {
    const fixture = await contextFixture({
      withImage: true,
      bytes: new Uint8Array(byteLength),
    });

    const contexts = await validateContexts(
      entriesFor(fixture),
      fakeSha256Hex,
    );
    expect(contexts[0]?.image?.byteLength).toBe(byteLength);
    expect(contexts[0]?.image?.bytes.byteLength).toBe(byteLength);
  });

  it("rejects an unsupported image mediaType", async () => {
    const fixture = await contextFixture({ withImage: true });
    const image = {
      ...(fixture.metadata.image as TestImageMetadata),
      mediaType: "image/gif",
    };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/mediaType.*supported/i);
  });

  it.each([
    ["non-string", 9],
    ["blank", " \t "],
  ])("rejects an image name that is %s", async (_name, name) => {
    const fixture = await contextFixture({ withImage: true });
    const image = { ...(fixture.metadata.image as TestImageMetadata), name };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/image name/i);
  });

  it.each([
    ["zero", 0],
    ["over 20 MiB", 20 * 1024 * 1024 + 1],
    ["fractional", 1.5],
    ["non-number", "4"],
  ])("rejects an image byteLength that is %s", async (_name, byteLength) => {
    const fixture = await contextFixture({ withImage: true });
    const image = {
      ...(fixture.metadata.image as TestImageMetadata),
      byteLength,
    };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/byteLength.*1 byte.*20 MiB/i);
  });

  it("requires byteLength to equal the actual image entry length", async () => {
    const fixture = await contextFixture({ withImage: true });
    const image = {
      ...(fixture.metadata.image as TestImageMetadata),
      byteLength: 5,
    };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/declares 5 bytes.*carries 4/i);
  });

  it.each([
    ["prefixed", `sha256:${"a".repeat(64)}`],
    ["uppercase", "A".repeat(64)],
    ["short", "aa"],
  ])("rejects an image digest that is %s", async (_name, sha256) => {
    const fixture = await contextFixture({ withImage: true });
    const image = { ...(fixture.metadata.image as TestImageMetadata), sha256 };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/image sha256.*64 lowercase/i);
  });

  it("recomputes the image digest from the actual entry bytes", async () => {
    const fixture = await contextFixture({ withImage: true });
    const changedBytes = new Uint8Array([1, 2, 3, 5]);

    await expect(
      validateContexts(
        entriesFor(
          fixture,
          fixture.metadata,
          new Map([[fixture.entryHash, changedBytes]]),
        ),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/image sha256.*actual bytes/i);
  });

  it("recomputes the context hash even when changed image bytes and image digest agree", async () => {
    const fixture = await contextFixture({ withImage: true });
    const changedBytes = new Uint8Array([1, 2, 3, 5]);
    const changedImageSha256 = await fakeSha256Hex(changedBytes);
    const image = {
      ...(fixture.metadata.image as TestImageMetadata),
      sha256: changedImageSha256,
    };

    await expect(
      validateContexts(
        entriesFor(
          fixture,
          { ...fixture.metadata, image },
          new Map([[fixture.entryHash, changedBytes]]),
        ),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/context sha256.*serialized content/i);
  });

  it("rejects an image declaration without a matching .image entry", async () => {
    const fixture = await contextFixture({ withImage: true });

    await expect(
      validateContexts(
        entriesFor(
          fixture,
          fixture.metadata,
          new Map<string, Uint8Array>(),
        ),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/image entry.*missing/i);
  });

  it("rejects an orphan .image entry when metadata does not declare image", async () => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(
          fixture,
          fixture.metadata,
          new Map([[fixture.entryHash, new Uint8Array([1])]]),
        ),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/orphan image entry/i);
  });

  it("rejects an orphan image entry key that is not 64 lowercase hex", async () => {
    const entries: ContextEntries = {
      contextJsonByHash: new Map(),
      contextImageByHash: new Map([
        ["A".repeat(64), new Uint8Array([1])],
      ]),
    };

    await expect(validateContexts(entries, fakeSha256Hex)).rejects.toThrow(
      /image entry name.*64 lowercase/i,
    );
  });

  it("rejects unknown context fields", async () => {
    const fixture = await contextFixture();

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, futureField: true }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/unknown context field.*futureField/i);
  });

  it("rejects unknown image fields", async () => {
    const fixture = await contextFixture({ withImage: true });
    const image = {
      ...(fixture.metadata.image as TestImageMetadata),
      exifOrientation: 1,
    };

    await expect(
      validateContexts(
        entriesFor(fixture, { ...fixture.metadata, image }),
        fakeSha256Hex,
      ),
    ).rejects.toThrow(/unknown image field.*exifOrientation/i);
  });

  it("checks that constructing a Blob preserves mediaType exactly", async () => {
    const fixture = await contextFixture({ withImage: true });
    const hadBlob = Object.hasOwn(globalThis, "Blob");
    const originalBlob = Reflect.get(globalThis, "Blob");

    class NormalisingBlob {
      readonly size: number;
      readonly type = "";

      constructor(parts: readonly Uint8Array[]) {
        this.size = parts.reduce((sum, part) => sum + part.byteLength, 0);
      }
    }

    Reflect.set(globalThis, "Blob", NormalisingBlob);
    try {
      await expect(
        validateContexts(entriesFor(fixture), fakeSha256Hex),
      ).rejects.toThrow(/Blob type.*mediaType/i);
    } finally {
      if (hadBlob) {
        Reflect.set(globalThis, "Blob", originalBlob);
      } else {
        Reflect.deleteProperty(globalThis, "Blob");
      }
    }
  });

  it("rejects non-object metadata and malformed JSON", async () => {
    const fixture = await contextFixture();
    await expect(
      validateContexts(entriesFor(fixture, []), fakeSha256Hex),
    ).rejects.toThrow(/context .* metadata.*object/i);

    const malformed: ContextEntries = {
      contextJsonByHash: new Map([[fixture.entryHash, "{"]]),
      contextImageByHash: new Map(),
    };
    await expect(validateContexts(malformed, fakeSha256Hex)).rejects.toThrow(
      /valid JSON/i,
    );
  });

  it("rejects a digest dependency that violates the Sha256Hex contract", async () => {
    const fixture = await contextFixture();
    const invalidDigest: Sha256Hex = async () => "ABC";

    await expect(
      validateContexts(entriesFor(fixture), invalidDigest),
    ).rejects.toThrow(/digest function.*64 lowercase/i);
  });
});
