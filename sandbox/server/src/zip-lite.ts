/**
 * Minimal ZIP read/rewrite built on Node's zlib, used to neutralise a
 * spreadsheet's stored scroll position before a single-page PDF export.
 *
 * Why this exists rather than a zip dependency: the only mutation needed is to
 * drop `<sheetViews>` from worksheet XML parts. Pulling in a general-purpose
 * archive library to do that would add supply-chain surface for a preview
 * nicety, and the container has no `zip`/`unzip` binaries either.
 *
 * Uses `inflateRawSync`/`deflateRawSync` (not the plain zlib variants): ZIP's
 * deflate entries are raw DEFLATE streams with no zlib header/checksum wrapper.
 * The `node:zlib` import also keeps this typecheckable under the standard
 * TypeScript lib set (Bun's global inflate/deflate are not in `@types`).
 *
 * Scope is deliberately narrow — enough of the format to round-trip an OOXML
 * package produced by Excel/LibreOffice:
 *  - store (method 0) and deflate (method 8) only
 *  - no ZIP64, no encryption, no multi-disk archives
 *  - bounded entry count and decompressed bytes; this is a best-effort preview
 *    transformation, never a reason to inflate an attacker-controlled archive
 *    until the server exhausts its memory
 * Anything outside that surfaces as an error so the caller can fall back to
 * converting the untouched original.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Flag bit 3: sizes are in a trailing data descriptor, not the local header. */
const FLAG_DATA_DESCRIPTOR = 0x0008;

/**
 * Limits for the optional spreadsheet view-reset transform.
 *
 * The route already limits the compressed office document to 50 MiB, but
 * worksheet XML is highly repetitive and can inflate by hundreds of times.
 * A normal 3.2 MiB .xlsx observed during validation expands to 23.9 MiB, so
 * the 64 MiB per-entry and 128 MiB aggregate budgets leave ordinary workbooks
 * room while making a compressed 50 MiB archive unable to claim gigabytes of
 * process memory. If a file exceeds these limits, the caller converts the
 * untouched original instead of applying the view-reset enhancement.
 */
const DEFAULT_ZIP_READ_LIMITS = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
} as const;

export type ZipReadLimits = Partial<typeof DEFAULT_ZIP_READ_LIMITS>;

export type ZipEntry = {
  name: string;
  /** Uncompressed contents. */
  data: Buffer;
  /** Compression method to use when writing this entry back out. */
  method: number;
  flags: number;
  lastModTime: number;
  lastModDate: number;
};

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD is 22 bytes plus an optional comment, so scan backwards from the
  // earliest position it could start at.
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error("zip: end-of-central-directory record not found");
}

/** Read every entry of a ZIP archive, decompressing as needed. */
export function readZipEntries(buf: Buffer, limits: ZipReadLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_ZIP_READ_LIMITS.maxEntries;
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_ZIP_READ_LIMITS.maxEntryBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_ZIP_READ_LIMITS.maxTotalBytes;

  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("zip: maxEntries must be a positive integer");
  }
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0) {
    throw new Error("zip: maxEntryBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("zip: maxTotalBytes must be a positive integer");
  }

  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  if (entryCount > maxEntries) {
    throw new Error(`zip: entry count ${entryCount} exceeds limit ${maxEntries}`);
  }
  let cursor = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL_DIR) {
      throw new Error("zip: malformed central directory");
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const lastModTime = buf.readUInt16LE(cursor + 12);
    const lastModDate = buf.readUInt16LE(cursor + 14);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("zip: ZIP64 entries are not supported");
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`zip: entry ${name} exceeds uncompressed limit ${maxEntryBytes}`);
    }
    if (uncompressedSize > maxTotalBytes - declaredTotalBytes) {
      throw new Error(`zip: total uncompressed size exceeds limit ${maxTotalBytes}`);
    }
    declaredTotalBytes += uncompressedSize;
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new Error(`zip: unsupported compression method ${method}`);
    }

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL_FILE) {
      throw new Error("zip: malformed local file header");
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart > buf.length || compressedSize > buf.length - dataStart) {
      throw new Error(`zip: entry ${name} data is outside the archive`);
    }
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    // Do not trust the central-directory size alone: a malicious archive can
    // declare a small uncompressed size while its DEFLATE stream expands much
    // further. maxOutputLength constrains the actual allocation in zlib.
    const remainingTotalBytes = maxTotalBytes - actualTotalBytes;
    const maxOutputLength = Math.min(maxEntryBytes, remainingTotalBytes);
    let data: Buffer;
    try {
      data =
        method === METHOD_STORE
          ? Buffer.from(raw)
          : inflateRawSync(raw, { maxOutputLength });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new Error(`zip: entry ${name} exceeds decompression limit ${maxOutputLength}`);
      }
      throw error;
    }
    if (data.byteLength > maxEntryBytes || data.byteLength > remainingTotalBytes) {
      throw new Error(`zip: entry ${name} exceeds decompression limit ${maxOutputLength}`);
    }
    actualTotalBytes += data.byteLength;

    entries.push({
      name,
      data,
      method,
      // Sizes are taken from the central directory, so a trailing data
      // descriptor is redundant; clear the bit when writing back out.
      flags: flags & ~FLAG_DATA_DESCRIPTOR,
      lastModTime,
      lastModDate,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Write entries back out as a ZIP archive.
 *
 * Entries are emitted in the order given, each with its own local header, and
 * followed by a central directory. Deflated entries are recompressed, so the
 * output is byte-identical in structure but not necessarily in size.
 */
export function writeZipEntries(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const payload =
      entry.method === METHOD_STORE
        ? entry.data
        : deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(SIG_LOCAL_FILE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(entry.flags, 6);
    localHeader.writeUInt16LE(entry.method, 8);
    localHeader.writeUInt16LE(entry.lastModTime, 10);
    localHeader.writeUInt16LE(entry.lastModDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // no extra field
    localChunks.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIG_CENTRAL_DIR, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(entry.flags, 8);
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt16LE(entry.lastModTime, 12);
    centralHeader.writeUInt16LE(entry.lastModDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}
