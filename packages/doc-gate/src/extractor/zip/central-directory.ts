/** The central directory of a ZIP archive, read without jszip: every entry's
 *  name and directory flag, in central directory order, and their count —
 *  refused when the end records and the records disagree.
 *  NOT here: local headers (`zip/local-headers.ts`), inflation and its
 *  ceilings (`zip/zip-package.ts`), nor what
 *  a name means to OPC (`ooxml/package.ts`).
 *  Called by: `zip/local-headers.ts` (and so the whole zip reader of
 *  `ooxml/package.ts`), `zip/central-directory.test.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";

/**
 * WHAT IS READ, AND FROM WHERE (PKWARE APPNOTE 6.3.9). The end of central
 * directory record (§4.3.16) is searched backwards from the end of the bytes;
 * when one of its fields is saturated (0xFFFF / 0xFFFFFFFF) the real values
 * live in the zip64 end record (§4.3.14), found through the zip64 locator
 * (§4.3.15) that sits right before the EOCD. The central directory records
 * (§4.3.12) are then walked one by one.
 *
 * Every size comes from the declared fields but is checked against the bytes
 * actually present BEFORE it is used: a declared count needs 46 bytes per
 * record inside the declared directory, the directory must lie inside the
 * bytes and end exactly where the end records begin, and each record's
 * variable fields must end inside the directory. Every refusal is one of our
 * literals: no name, no comment, no byte of the archive is ever echoed.
 *
 * Where jszip is lenient this reader refuses (two readings must agree, else
 * we abstain): fewer records than declared (jszip keeps what it found), a
 * directory not ending at the end records (jszip shifts its origin for
 * prepended data), two end records that both close the bytes, two records
 * that resolve to the same name (jszip keeps the last one), and a name that
 * is not a plain relative path (jszip rewrites it, see `isUnsafeName`).
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
/** Fixed part of the zip64 end record, signature and size field included. */
const ZIP64_EOCD_MIN_SIZE = 56;
const CD_RECORD_SIGNATURE = 0x02014b50;
/** Fixed part of a central directory record (also walked by `local-headers.ts`). */
export const CD_RECORD_MIN_SIZE = 46;

const FLAG_ENCRYPTED = 1 << 0; // §4.4.4 bit 0
/** FILE_ATTRIBUTE_DIRECTORY, in the low byte of the external attributes. */
const MSDOS_DIRECTORY = 0x10;
const MADE_BY_UNIX = 3;
/** S_IFDIR in the high 16 bits written by UNIX hosts. Same test as jszip
 *  (`object.js`: `unixPermissions & 0x4000`). */
const UNIX_DIRECTORY = 0x4000;

const SAT16 = 0xffff;
/** A 32-bit field saturated to 0xffffffff: the real value is in the zip64 extra field. */
export const SAT32 = 0xffffffff;

export interface CentralDirectoryEntry {
  /** The name as the archive spells it; a directory's always ends in `/`. */
  readonly name: string;
  readonly dir: boolean;
}

export interface CentralDirectory {
  readonly entries: readonly CentralDirectoryEntry[];
  readonly count: number;
  /** Where the central directory starts (zip64 rule applied): local headers and data must end before it. */
  readonly offset: number;
}

export const refuse = (reason: string): ReaderError => new ReaderError("EXTRACT_FAILED", `zip: ${reason}`);

interface Directory {
  disk: number;
  cdDisk: number;
  entriesOnDisk: number;
  entries: number;
  size: number;
  offset: number;
  /** Where the end records begin: the central directory must end here. */
  endsAt: number;
}

/** A little-endian 64-bit field, or undefined past 2^53 (never rounded). */
function u64(view: DataView, at: number): number | undefined {
  const value = view.getBigUint64(at, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/** The one EOCD whose comment closes the bytes exactly. Two such records
 *  (a fake one inside the comment) cannot be told apart: refused. */
function findEocd(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  let found: number | undefined;
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_SIZE + view.getUint16(at + 20, true) !== view.byteLength) continue;
    if (found !== undefined) throw refuse("ambiguous end of central directory record");
    found = at;
  }
  if (found === undefined) throw refuse("no end of central directory record");
  return found;
}

function readZip64(view: DataView, eocdAt: number): Directory {
  const locatorAt = eocdAt - ZIP64_LOCATOR_SIZE;
  if (locatorAt < 0 || view.getUint32(locatorAt, true) !== ZIP64_LOCATOR_SIGNATURE) {
    throw refuse("zip64 end record not found");
  }
  if (view.getUint32(locatorAt + 4, true) !== 0 || view.getUint32(locatorAt + 16, true) !== 1) {
    throw refuse("multi-disk archives are not supported");
  }
  const recordAt = u64(view, locatorAt + 8);
  if (recordAt === undefined || recordAt + ZIP64_EOCD_MIN_SIZE > locatorAt) throw refuse("zip64 end record not found");
  if (view.getUint32(recordAt, true) !== ZIP64_EOCD_SIGNATURE) throw refuse("zip64 end record not found");
  // §4.3.14.1: the size field excludes its own 12 leading bytes; the record,
  // extensible data included, must end exactly at the locator.
  if (u64(view, recordAt + 4) !== locatorAt - recordAt - 12) throw refuse("zip64 end record not found");
  const entriesOnDisk = u64(view, recordAt + 24);
  const entries = u64(view, recordAt + 32);
  const size = u64(view, recordAt + 40);
  const offset = u64(view, recordAt + 48);
  if (entriesOnDisk === undefined || entries === undefined) throw refuse("declared entry count exceeds the central directory");
  if (size === undefined || offset === undefined) throw refuse("central directory out of bounds");
  return {
    disk: view.getUint32(recordAt + 16, true),
    cdDisk: view.getUint32(recordAt + 20, true),
    entriesOnDisk,
    entries,
    size,
    offset,
    endsAt: recordAt,
  };
}

function readEnd(view: DataView): Directory {
  const at = findEocd(view);
  const end: Directory = {
    disk: view.getUint16(at + 4, true),
    cdDisk: view.getUint16(at + 6, true),
    entriesOnDisk: view.getUint16(at + 8, true),
    entries: view.getUint16(at + 10, true),
    size: view.getUint32(at + 12, true),
    offset: view.getUint32(at + 16, true),
    endsAt: at,
  };
  const saturated =
    end.disk === SAT16 ||
    end.cdDisk === SAT16 ||
    end.entriesOnDisk === SAT16 ||
    end.entries === SAT16 ||
    end.size === SAT32 ||
    end.offset === SAT32;
  return saturated ? readZip64(view, at) : end;
}

const decoder = new TextDecoder("utf-8");

/**
 * A name that is not a plain relative path made of forward-slash segments.
 * APPNOTE §4.4.17.1 asks for a relative path with forward slashes, no drive
 * letter and no leading slash. jszip does not refuse these names: it rewrites
 * them (`utils.resolve` drops `.` and empty segments, pops on `..`), so two
 * readers of the same archive would disagree on which part a name designates.
 * A `..` can also climb out of any folder the name is joined to. Refused, not
 * rewritten. Only a trailing empty segment (a directory's `/`) is allowed.
 */
function isUnsafeName(name: string): boolean {
  if (name.includes("\\") || name.includes("\u0000")) return true;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  const segments = name.split("/");
  return segments.some(
    (segment, i) => segment === "." || segment === ".." || (segment === "" && i !== segments.length - 1),
  );
}

export function readCentralDirectory(bytes: Uint8Array): CentralDirectory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = readEnd(view);
  if (end.disk !== 0 || end.cdDisk !== 0 || end.entriesOnDisk !== end.entries) {
    throw refuse("multi-disk archives are not supported");
  }
  if (end.offset + end.size !== end.endsAt) throw refuse("central directory out of bounds");
  // Bound the count by the bytes present before allocating anything for it.
  if (end.entries > Math.floor(end.size / CD_RECORD_MIN_SIZE)) {
    throw refuse("declared entry count exceeds the central directory");
  }

  const entries: CentralDirectoryEntry[] = [];
  const seen = new Set<string>();
  const cdEnd = end.offset + end.size;
  let at = end.offset;
  while (at < cdEnd) {
    if (entries.length === end.entries) throw refuse("entry count does not match the central directory");
    if (at + CD_RECORD_MIN_SIZE > cdEnd) throw refuse("central directory record out of bounds");
    if (view.getUint32(at, true) !== CD_RECORD_SIGNATURE) throw refuse("bad central directory record signature");
    const madeBy = view.getUint8(at + 5);
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const externalAttributes = view.getUint32(at + 38, true);
    const next = at + CD_RECORD_MIN_SIZE + nameLength + extraLength + commentLength;
    if (next > cdEnd) throw refuse("central directory record out of bounds");
    if (flags & FLAG_ENCRYPTED) throw refuse("encrypted entries are not supported");

    // Always decoded as UTF-8, as jszip does: right when §4.4.4 bit 11 (the
    // language encoding flag) is set, and for ASCII names. With bit 11 unset
    // APPNOTE appendix D says IBM 437, which is not decoded here: a non-ASCII
    // name written that way reads differently than the spec intends.
    const raw = decoder.decode(bytes.subarray(at + CD_RECORD_MIN_SIZE, at + CD_RECORD_MIN_SIZE + nameLength));
    const dir =
      raw.endsWith("/") ||
      (externalAttributes & MSDOS_DIRECTORY) !== 0 ||
      (madeBy === MADE_BY_UNIX && ((externalAttributes >>> 16) & UNIX_DIRECTORY) !== 0);
    const name = dir && !raw.endsWith("/") ? `${raw}/` : raw;
    if (isUnsafeName(name)) throw refuse("unsafe entry name");
    if (seen.has(name)) throw refuse("duplicate entry name");
    seen.add(name);
    entries.push({ name, dir });
    at = next;
  }
  if (entries.length !== end.entries) throw refuse("entry count does not match the central directory");
  return { entries, count: entries.length, offset: end.offset };
}
