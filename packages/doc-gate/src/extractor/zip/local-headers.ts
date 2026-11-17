/** Each entry's local file header, read without jszip and checked against its
 *  central directory record: name, compression method, declared sizes, and
 *  where the entry's data starts — refused when the two records disagree.
 *  NOT here: inflation and its ceilings (`zip/zip-package.ts`), the CRC, the
 *  data descriptor's content.
 *  Called by: `zip/zip-package.ts` (and so `ooxml/package.ts`),
 *  `zip/local-headers.test.ts` and the differential fuzz. */

import {
  CD_RECORD_MIN_SIZE,
  readCentralDirectory,
  refuse,
  SAT32,
  type CentralDirectoryEntry,
} from "./central-directory";

/**
 * WHAT IS READ, AND FROM WHERE (PKWARE APPNOTE 6.3.9). `readCentralDirectory`
 * validates the end records and every central record first; this module then
 * walks the same records again for the fields slice 1 does not return, and
 * follows each one's local header offset to its local file header (§4.3.7).
 *
 * jszip extracts with the name of the LOCAL header (`zipEntry.js#readLocalPart`)
 * while slice 1 lists the CENTRAL one. Two readings of the same entry must
 * agree, else we abstain: the raw name bytes must be identical, and so must
 * the method, bit 3 of the flags, and the sizes. With bit 3 set (§4.4.4) the
 * local CRC and sizes are zero and the real ones follow the data in a data
 * descriptor (§4.3.9): the sizes are then not compared, the central ones are
 * kept, and the descriptor itself is not read.
 *
 * Every offset and length is checked against the bytes actually present
 * before it is used: a local header, its name and extra field, and the entry's
 * compressed data must all end before the central directory begins. Refusals
 * are our literals; no name and no byte of the archive is ever echoed.
 */

export interface LocalEntry extends CentralDirectoryEntry {
  /** 0 (stored) or 8 (deflated): the only two jszip reads. */
  readonly method: number;
  readonly compressedSize: number;
  /** As DECLARED: a ceiling must count the bytes actually inflated instead. */
  readonly uncompressedSize: number;
  /** Where the compressed bytes start; they span `compressedSize` bytes. */
  readonly dataOffset: number;
  readonly hasDataDescriptor: boolean;
}

export interface LocalDirectory {
  readonly entries: readonly LocalEntry[];
  readonly count: number;
}

const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_MIN_SIZE = 30;
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** The refusal of the overlapping-entries bomb: the one structural refusal that is hostile, not damage (`extractor/attachment-safety.ts`). */
export const ENTRIES_OVERLAP_REASON = "entries overlap";

const MISMATCH = "local header does not match the central directory";

/** A little-endian 64-bit field; past 2^53 it is no usable offset or size. */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse("declared size too large");
  return Number(value);
}

/** The data of the zip64 extended information field (§4.5.3) inside the
 *  extra field [start, end), or undefined. A block that does not fit ends the
 *  walk: the field is then missing, never read past `end`. */
function zip64Extra(view: DataView, start: number, end: number): { at: number; size: number } | undefined {
  let at = start;
  while (at + 4 <= end) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (at + 4 + size > end) return undefined;
    if (id === ZIP64_EXTRA_ID) return { at: at + 4, size };
    at += 4 + size;
  }
  return undefined;
}

function sameBytes(bytes: Uint8Array, a: number, b: number, length: number): boolean {
  for (let i = 0; i < length; i++) if (bytes[a + i] !== bytes[b + i]) return false;
  return true;
}

export function readLocalHeaders(bytes: Uint8Array): LocalDirectory {
  const directory = readCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cdStart = directory.offset;

  const entries: LocalEntry[] = [];
  /** [local header start, data end) of each entry, to refuse overlaps once all are read. */
  const spans: [number, number][] = [];
  let at = cdStart;
  for (const entry of directory.entries) {
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    let compressedSize = view.getUint32(at + 20, true);
    let uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let localAt = view.getUint32(at + 42, true);
    const nameAt = at + CD_RECORD_MIN_SIZE;

    // §4.5.3: only the saturated fields appear, in this fixed order.
    if (uncompressedSize === SAT32 || compressedSize === SAT32 || localAt === SAT32) {
      const extra = zip64Extra(view, nameAt + nameLength, nameAt + nameLength + extraLength);
      const needed = [uncompressedSize, compressedSize, localAt].filter((v) => v === SAT32).length * 8;
      if (!extra || extra.size < needed) throw refuse("zip64 extra field missing");
      let field = extra.at;
      if (uncompressedSize === SAT32) {
        uncompressedSize = u64(view, field);
        field += 8;
      }
      if (compressedSize === SAT32) {
        compressedSize = u64(view, field);
        field += 8;
      }
      if (localAt === SAT32) localAt = u64(view, field);
    }

    if (localAt + LOCAL_MIN_SIZE > cdStart) throw refuse("local header out of bounds");
    if (view.getUint32(localAt, true) !== LOCAL_SIGNATURE) throw refuse("bad local header signature");
    const localFlags = view.getUint16(localAt + 6, true);
    const localMethod = view.getUint16(localAt + 8, true);
    let localCompressed = view.getUint32(localAt + 18, true);
    let localUncompressed = view.getUint32(localAt + 22, true);
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const localNameAt = localAt + LOCAL_MIN_SIZE;
    const dataOffset = localNameAt + localNameLength + localExtraLength;
    if (dataOffset > cdStart) throw refuse("local header out of bounds");

    if (localNameLength !== nameLength || !sameBytes(bytes, localNameAt, nameAt, nameLength)) {
      throw refuse("local header name does not match the central directory");
    }
    if (localMethod !== method) throw refuse(MISMATCH);
    if ((localFlags & FLAG_DATA_DESCRIPTOR) !== (flags & FLAG_DATA_DESCRIPTOR)) throw refuse(MISMATCH);
    // jszip reads stored and deflated only and refuses any other method
    // (`local-headers.test.ts` holds that agreement on the same archive).
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) throw refuse("unsupported compression method");

    const hasDataDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (!hasDataDescriptor) {
      // Read as uncompressed then compressed size, both present: §4.5.3, « This
      // entry in the Local header MUST include BOTH original and compressed file
      // size fields » (APPNOTE 6.3.10, read 05/10/2026; no versioned document is
      // zip64). A shorter field is refused, never read past.
      if (localCompressed === SAT32 || localUncompressed === SAT32) {
        const extra = zip64Extra(view, localNameAt + localNameLength, dataOffset);
        if (!extra || extra.size < 16) throw refuse("zip64 extra field missing");
        localUncompressed = u64(view, extra.at);
        localCompressed = u64(view, extra.at + 8);
      }
      if (localCompressed !== compressedSize || localUncompressed !== uncompressedSize) throw refuse(MISMATCH);
    }
    if (dataOffset + compressedSize > cdStart) throw refuse("entry data out of bounds");

    entries.push({ ...entry, method, compressedSize, uncompressedSize, dataOffset, hasDataDescriptor });
    spans.push([localAt, dataOffset + compressedSize]);
    at = nameAt + nameLength + extraLength + commentLength;
  }
  // Two entries sharing bytes is the overlapping-entries bomb (Fifield 2019; Info-ZIP UnZip refuses it, CVE-2019-13232):
  // N central records over one compressed kernel inflate N times. No writer of a real document does it; jszip does not
  // check it. Sorted once: O(n log n).
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) throw refuse(ENTRIES_OVERLAP_REASON);
  }
  return { entries, count: entries.length };
}
