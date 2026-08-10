import { strToU8, zipSync } from "fflate";

interface StoredEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly declaredSize?: number;
  readonly centralExtra?: Uint8Array;
  readonly centralCompressedSize?: number;
  readonly centralUncompressedSize?: number;
  readonly diskNumberStart?: number;
  readonly localOffset?: number;
  readonly localBytes?: Uint8Array;
}

const EMPTY = new Uint8Array();
const UTF8_FLAG = 0x0800;

function ascii(value: string): Uint8Array {
  return strToU8(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function setU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function setU64(bytes: Uint8Array, offset: number, value: number): void {
  setU32(bytes, offset, value);
  setU32(bytes, offset + 4, 0);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localRecord(
  name: string,
  data: Uint8Array,
  declaredSize = data.byteLength,
): Uint8Array {
  const filename = ascii(name);
  const header = new Uint8Array(30);
  setU32(header, 0, 0x04034b50);
  setU16(header, 4, 20);
  setU16(header, 6, UTF8_FLAG);
  setU16(header, 8, 0);
  setU32(header, 14, crc32(data));
  setU32(header, 18, data.byteLength);
  setU32(header, 22, declaredSize);
  setU16(header, 26, filename.byteLength);
  return concat([header, filename, data]);
}

function centralRecord(entry: StoredEntry, offset: number): Uint8Array {
  const filename = ascii(entry.name);
  const extra = entry.centralExtra ?? EMPTY;
  const header = new Uint8Array(46);
  setU32(header, 0, 0x02014b50);
  setU16(header, 4, 20);
  setU16(header, 6, 20);
  setU16(header, 8, UTF8_FLAG);
  setU16(header, 10, 0);
  setU32(header, 16, crc32(entry.data));
  setU32(
    header,
    20,
    entry.centralCompressedSize ?? entry.data.byteLength,
  );
  setU32(
    header,
    24,
    entry.centralUncompressedSize ??
      entry.declaredSize ??
      entry.data.byteLength,
  );
  setU16(header, 28, filename.byteLength);
  setU16(header, 30, extra.byteLength);
  setU16(header, 34, entry.diskNumberStart ?? 0);
  setU32(header, 42, entry.localOffset ?? offset);
  return concat([header, filename, extra]);
}

function endRecord(
  entries: number,
  centralSize: number,
  centralOffset: number,
  comment = EMPTY,
): Uint8Array {
  const record = new Uint8Array(22);
  setU32(record, 0, 0x06054b50);
  setU16(record, 8, entries);
  setU16(record, 10, entries);
  setU32(record, 12, centralSize);
  setU32(record, 16, centralOffset);
  setU16(record, 20, comment.byteLength);
  return concat([record, comment]);
}

function storedZip(
  entries: readonly StoredEntry[],
  comment = EMPTY,
): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    offsets.push(offset);
    const local =
      entry.localBytes ??
      localRecord(entry.name, entry.data, entry.declaredSize);
    localChunks.push(local);
    offset += local.byteLength;
  }
  const centralChunks = entries.map((entry, index) =>
    centralRecord(entry, offsets[index] ?? 0),
  );
  const central = concat(centralChunks);
  return concat([
    ...localChunks,
    central,
    endRecord(entries.length, central.byteLength, offset, comment),
  ]);
}

function findSignature(bytes: Uint8Array, signature: number): number {
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (
      bytes[offset] === (signature & 0xff) &&
      bytes[offset + 1] === ((signature >>> 8) & 0xff) &&
      bytes[offset + 2] === ((signature >>> 16) & 0xff) &&
      bytes[offset + 3] === ((signature >>> 24) & 0xff)
    ) {
      return offset;
    }
  }
  throw new Error(`ZIP fixture signature ${signature.toString(16)} not found`);
}

function filenameMismatchFixture(): Uint8Array {
  const bytes = storedZip([{ name: "events.jsonl", data: ascii("ok\n") }]);
  bytes[30] = "E".charCodeAt(0);
  return bytes;
}

function crcMismatchFixture(): Uint8Array {
  const original = ascii(
    '{"type":"item_created","payload":{"display":{"original":"alpha"}}}\n',
  );
  const bytes = storedZip([{ name: "events.jsonl", data: original }]);
  const dataOffset = 30 + ascii("events.jsonl").byteLength;
  const alphaOffset = findSignature(original, 0x68706c61);
  bytes[dataOffset + alphaOffset] = "b".charCodeAt(0);
  bytes[dataOffset + alphaOffset + 1] = "r".charCodeAt(0);
  bytes[dataOffset + alphaOffset + 2] = "a".charCodeAt(0);
  bytes[dataOffset + alphaOffset + 3] = "v".charCodeAt(0);
  bytes[dataOffset + alphaOffset + 4] = "o".charCodeAt(0);
  return bytes;
}

function overlapFixture(): Uint8Array {
  const nestedData = ascii("B");
  const nestedLocal = localRecord("b", nestedData);
  const prefix = ascii("prefix");
  const outerData = concat([prefix, nestedLocal]);
  const outerLocal = localRecord("a", outerData);
  const nestedOffset = 30 + ascii("a").byteLength + prefix.byteLength;
  return storedZip([
    { name: "a", data: outerData, localBytes: outerLocal },
    {
      name: "b",
      data: nestedData,
      localBytes: EMPTY,
      localOffset: nestedOffset,
    },
  ]);
}

function patchFlags(bytes: Uint8Array, flag: number): Uint8Array {
  const result = bytes.slice();
  const central = findSignature(result, 0x02014b50);
  setU16(result, 6, UTF8_FLAG | flag);
  setU16(result, central + 8, UTF8_FLAG | flag);
  return result;
}

function unsupportedCompressionFixture(): Uint8Array {
  const result = storedZip([{ name: "x", data: ascii("x") }]);
  const central = findSignature(result, 0x02014b50);
  setU16(result, 8, 99);
  setU16(result, central + 10, 99);
  return result;
}

function archiveMultiDiskFixture(): Uint8Array {
  const result = storedZip([{ name: "x", data: ascii("x") }]);
  const eocd = findSignature(result, 0x06054b50);
  setU16(result, eocd + 4, 1);
  setU16(result, eocd + 6, 1);
  return result;
}

function zip64Extra(uncompressedSize: number, compressedSize: number): Uint8Array {
  const extra = new Uint8Array(20);
  setU16(extra, 0, 0x0001);
  setU16(extra, 2, 16);
  setU64(extra, 4, uncompressedSize);
  setU64(extra, 12, compressedSize);
  return extra;
}

function zip64ArchiveFixture(): Uint8Array {
  const ordinary = storedZip([{ name: "x", data: ascii("x") }]);
  const eocd = findSignature(ordinary, 0x06054b50);
  const zip64 = new Uint8Array(56);
  setU32(zip64, 0, 0x06064b50);
  setU64(zip64, 4, 44);
  setU16(zip64, 12, 45);
  setU16(zip64, 14, 45);
  setU64(zip64, 24, 1);
  setU64(zip64, 32, 1);
  const centralOffset = findSignature(ordinary, 0x02014b50);
  setU64(zip64, 40, eocd - centralOffset);
  setU64(zip64, 48, centralOffset);

  const locator = new Uint8Array(20);
  setU32(locator, 0, 0x07064b50);
  setU64(locator, 8, eocd);
  setU32(locator, 16, 1);
  return concat([ordinary.subarray(0, eocd), zip64, locator, ordinary.subarray(eocd)]);
}

function zip64ArchiveSentinelFixture(): Uint8Array {
  const result = storedZip([{ name: "x", data: ascii("x") }]);
  const eocd = findSignature(result, 0x06054b50);
  setU16(result, eocd + 8, 0xffff);
  setU16(result, eocd + 10, 0xffff);
  setU32(result, eocd + 12, 0xffffffff);
  setU32(result, eocd + 16, 0xffffffff);
  return result;
}

function magicBytesFixture(): Uint8Array {
  return storedZip(
    [
      {
        name: "magic.bin",
        data: new Uint8Array([0x50, 0x4b, 0x06, 0x06, 0x50, 0x4b, 0x06, 0x07]),
      },
    ],
    new Uint8Array([0x50, 0x4b, 0x06, 0x07, 0x50, 0x4b, 0x06, 0x06]),
  );
}

const VALID_PAYLOAD = ascii("valid payload");
const BALANCED_PAYLOAD = ascii("ok\n");

const FIXTURES = {
  valid: storedZip([{ name: "valid.txt", data: VALID_PAYLOAD }]),
  filenameMismatch: filenameMismatchFixture(),
  crcMismatch: crcMismatchFixture(),
  overlappingEntries: overlapFixture(),
  encrypted: patchFlags(
    storedZip([{ name: "secret", data: ascii("secret") }]),
    0x0001,
  ),
  unsupportedCompression: unsupportedCompressionFixture(),
  archiveMultiDisk: archiveMultiDiskFixture(),
  entryMultiDisk: storedZip([
    { name: "x", data: ascii("x"), diskNumberStart: 1 },
  ]),
  zip64Entry: storedZip([
    {
      name: "x",
      data: ascii("x"),
      centralExtra: zip64Extra(1, 1),
      centralCompressedSize: 0xffffffff,
      centralUncompressedSize: 0xffffffff,
    },
  ]),
  zip64Archive: zip64ArchiveFixture(),
  zip64ArchiveSentinels: zip64ArchiveSentinelFixture(),
  magicBytesInPayloadAndComment: magicBytesFixture(),
  actualEntryOverflow: storedZip([
    { name: "events.jsonl", data: new Uint8Array(33), declaredSize: 32 },
  ]),
  actualPackageOverflow: storedZip([
    { name: "manifest.json", data: new Uint8Array(20) },
    { name: "events.jsonl", data: new Uint8Array(21), declaredSize: 20 },
  ]),
} as const;

function copyFixtures(): typeof FIXTURES {
  return Object.fromEntries(
    Object.entries(FIXTURES).map(([name, bytes]) => [name, bytes.slice()]),
  ) as unknown as typeof FIXTURES;
}

/** Shared byte fixtures used by the Node Gate and the later browser probe. */
export const ZIP_PROBE_FIXTURES: Readonly<typeof FIXTURES> = Object.freeze(
  copyFixtures(),
);

export const ZIP_PROBE_EXPECTED = Object.freeze({
  validPayload: VALID_PAYLOAD.slice(),
  balancedPayload: BALANCED_PAYLOAD.slice(),
});

let maxEntriesFixture: Uint8Array | undefined;

/** Lazy because eagerly allocating 65,535 entries would penalise every import. */
export function createNonZip64MaxEntriesFixture(): Uint8Array {
  if (maxEntriesFixture === undefined) {
    const entries: Record<string, Uint8Array> = Object.create(null) as Record<
      string,
      Uint8Array
    >;
    for (let index = 0; index < 65_535; index += 1) {
      entries[`e${index.toString(16).padStart(4, "0")}`] = EMPTY;
    }
    maxEntriesFixture = zipSync(entries, { level: 0 });
  }
  return maxEntriesFixture.slice();
}
