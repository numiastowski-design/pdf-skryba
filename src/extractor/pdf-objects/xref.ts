/** The cross-reference section of a PDF and its trailer, chain of incremental updates included — a classic TABLE
 *  or a cross-reference STREAM (ISO 32000-1:2008 §7.5.4 table, §7.5.5 `startxref` and file trailer, §7.5.6
 *  incremental updates, §7.5.8 cross-reference streams, §7.5.8.4 hybrid files).
 *  Decides: which `startxref` is read (the LAST one of the file's tail), where one object's bytes are said to be,
 *  that the NEWEST section wins for an object and for a trailer key, that a free entry hides an older placement,
 *  and every refusal — a chain that loops or runs too long, an offset that is not an integer inside the file, a
 *  table whose shape is not the one §7.5.4 fixes. Never a reconstruction: a table that does not read is refused.
 *  NOT here: whether the object FOUND at an offset carries the expected number (the document layer checks that,
 *  which is how a stale table shows), the MEMBERS of an object stream (`streams.ts`), the lexer and the objects
 *  themselves (`parse.ts`).
 *  Called by: the document layer (`document.ts`), and `xref.test.ts`.
 *
 *  ITS OWN SCANNER, on purpose. A cross-reference table is not general PDF syntax: §7.5.4 allows digits, single
 *  spaces, end-of-line markers and two keywords, and no comment. Twenty lines of scanner read exactly that
 *  grammar; borrowing the lexer of `parse.ts` would read MORE than the clause allows. The trailer dictionary,
 *  which IS general syntax, is read by `parseValue`. */

import {
  MAX_DOCUMENT_BYTES,
  MAX_XREF_ENTRIES,
  MAX_XREF_FIELD_BYTES,
  MAX_XREF_SECTIONS,
  STARTXREF_SEARCH_BYTES,
} from "./bounds";
import type { PdfDict, PdfValue } from "./objects";
import { parseIndirectObject, parseValue } from "./parse";
import { PdfObjectsRefusal } from "./refusal";
import { decodeStream } from "./streams";

/** Where one object is: at a byte offset of the file, or inside an object stream (§7.5.7, filled by slice A3). */
export type XrefEntry =
  | { readonly kind: "offset"; readonly offset: number; readonly gen: number }
  | { readonly kind: "compressed"; readonly container: number; readonly index: number };

export interface Xref {
  /** In-use objects only, by object number. A free object is absent. */
  readonly entries: ReadonlyMap<number, XrefEntry>;
  /** The sections' trailers merged, the newest winning key by key (§7.5.6). */
  readonly trailer: PdfDict;
}

/** §7.5.4: the smallest an entry can be written, `0000000000 00000 n` plus one end-of-line byte. */
const MIN_ENTRY_BYTES = 19;
/** Longest token this grammar can hold: a ten-digit offset. Anything longer is not this grammar.
 *  Exported so that its test can make it BITE with its real value (31/10/2026: imported from the
 *  wrong module, it was `undefined` and the test passed for nothing). */
export const MAX_TABLE_TOKEN_BYTES = 32;

const STARTXREF = "startxref";
const DIGITS = /^\d+$/;

const NUL = 0x00;
const HT = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SP = 0x20;

const isTableSpace = (byte: number): boolean =>
  byte === SP || byte === LF || byte === CR || byte === HT || byte === FF || byte === NUL;

const skipTableSpace = (bytes: Uint8Array, from: number): number => {
  let at = from;
  while (at < bytes.length && isTableSpace(bytes[at] as number)) at += 1;
  return at;
};

interface Token {
  readonly text: string;
  /** Offset just past the token. */
  readonly end: number;
}

/** The next run of non-space bytes, as latin1 text; `undefined` at the end of the bytes or past the token ceiling. */
function tableToken(bytes: Uint8Array, from: number): Token | undefined {
  const start = skipTableSpace(bytes, from);
  let at = start;
  while (at < bytes.length && !isTableSpace(bytes[at] as number)) {
    at += 1;
    if (at - start > MAX_TABLE_TOKEN_BYTES) return undefined;
  }
  if (at === start) return undefined;
  return { text: Buffer.from(bytes.subarray(start, at)).toString("latin1"), end: at };
}

/** The token at `from`, refused when absent. */
function expectToken(bytes: Uint8Array, from: number, reason: "xref-syntax" | "xref-offset"): Token {
  const token = tableToken(bytes, from);
  if (token === undefined) throw new PdfObjectsRefusal(reason);
  return token;
}

/** A non-negative integer token, refused when it is anything else. */
function expectInteger(bytes: Uint8Array, from: number, reason: "xref-syntax" | "xref-offset"): Token {
  const token = expectToken(bytes, from, reason);
  if (!DIGITS.test(token.text)) throw new PdfObjectsRefusal(reason);
  return token;
}

/** §7.5.5: the offset the LAST `startxref` of the file's tail gives. */
function lastStartxref(bytes: Uint8Array): number {
  const from = Math.max(0, bytes.length - STARTXREF_SEARCH_BYTES);
  const tail = Buffer.from(bytes.subarray(from)).toString("latin1");
  const at = tail.lastIndexOf(STARTXREF);
  if (at < 0) throw new PdfObjectsRefusal("startxref-missing");
  const offset = Number(expectInteger(bytes, from + at + STARTXREF.length, "xref-offset").text);
  if (offset >= bytes.length) throw new PdfObjectsRefusal("xref-offset");
  return offset;
}

/** A free entry is kept while sections are merged, so that it can HIDE an older placement, then dropped. */
type MergedEntry = XrefEntry | { readonly kind: "free" };

interface Section {
  readonly entries: ReadonlyMap<number, MergedEntry>;
  readonly trailer: PdfDict;
}

/** What reading the references MAKES the document's cumulative budget PAY: the bytes it decompresses.
 *  🔴 WHY IT TAKES IT AS A PARAMETER (security review of 31/10/2026): `readXref` runs BEFORE the
 *  document exists, hence before its budget — and `MAX_DOCUMENT_BYTES` nevertheless claimed to bound the chain of
 *  sections. It did not bound it: each of the 64 sections could inflate 64 MB without a byte being
 *  counted. The budget therefore comes down here, and the document passes it ITS OWN so that the two counts make
 *  only one. */
export type SpendBytes = (bytes: number) => void;

/** §7.5.4: `xref`, then subsections of `start count` and their entries, then `trailer` and its dictionary. */
function readSection(bytes: Uint8Array, offset: number, spend: SpendBytes): Section {
  const keyword = tableToken(bytes, offset);
  // A modern file puts a cross-reference STREAM where the table used to be (§7.5.8).
  if (keyword?.text !== "xref") return readStreamSection(bytes, offset, spend);

  const entries = new Map<number, MergedEntry>();
  let at = keyword.end;
  for (;;) {
    const head = expectToken(bytes, at, "xref-syntax");
    if (head.text === "trailer") {
      const { value } = parseValue(bytes, head.end);
      if (value.kind !== "dict") throw new PdfObjectsRefusal("xref-syntax");
      return { entries, trailer: value.entries };
    }
    if (!DIGITS.test(head.text)) throw new PdfObjectsRefusal("xref-syntax");
    const count = expectInteger(bytes, head.end, "xref-syntax");
    at = readSubsection(bytes, Number(head.text), Number(count.text), count.end, entries);
  }
}

/** One subsection's `count` entries, read from `at`. Returns where to go on. */
function readSubsection(
  bytes: Uint8Array,
  first: number,
  count: number,
  from: number,
  entries: Map<number, MergedEntry>,
): number {
  // Bounded BEFORE the loop: a count bigger than the bytes left cannot be honest, whatever it claims.
  if (count > (bytes.length - from) / MIN_ENTRY_BYTES) throw new PdfObjectsRefusal("xref-syntax");
  if (entries.size + count > MAX_XREF_ENTRIES) throw new PdfObjectsRefusal("xref-too-large");

  let at = from;
  for (let i = 0; i < count; i += 1) {
    const read = readEntry(bytes, at);
    const num = first + i;
    // First section to place an object wins: the chain is walked newest first (§7.5.6).
    if (!entries.has(num)) entries.set(num, read.entry);
    at = read.end;
  }
  return at;
}

/** §7.5.4: one entry, `nnnnnnnnnn ggggg n` or `… f`, read by token rather than by its twenty bytes. */
function readEntry(bytes: Uint8Array, from: number): { entry: MergedEntry; end: number } {
  const offset = expectInteger(bytes, from, "xref-syntax");
  const gen = expectInteger(bytes, offset.end, "xref-syntax");
  const type = expectToken(bytes, gen.end, "xref-syntax");
  if (type.text !== "n" && type.text !== "f") throw new PdfObjectsRefusal("xref-syntax");
  const entry: MergedEntry =
    type.text === "f" ? { kind: "free" } : { kind: "offset", offset: Number(offset.text), gen: Number(gen.text) };
  return { entry, end: type.end };
}

/** A big-endian unsigned integer on `width` bytes; a width of 0 means "take the default" (§7.5.8.2). */
function bigEndian(data: Uint8Array, from: number, width: number, fallback: number): number {
  if (width === 0) return fallback;
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + (data[from + i] as number);
  return value;
}

/** §7.5.8.2: `/W`, exactly three field widths, each small enough to mean something. */
function fieldWidths(dict: PdfDict): readonly [number, number, number] {
  const w: PdfValue | undefined = dict.get("W");
  if (w?.kind !== "array" || w.items.length !== 3) throw new PdfObjectsRefusal("xref-stream");
  const widths = w.items.map((item) => {
    if (
      item.kind !== "number" ||
      !Number.isInteger(item.value) ||
      item.value < 0 ||
      item.value > MAX_XREF_FIELD_BYTES
    ) {
      throw new PdfObjectsRefusal("xref-stream");
    }
    return item.value;
  });
  return [widths[0] as number, widths[1] as number, widths[2] as number];
}

/** A non-negative integer of a cross-reference stream's dictionary; anything else refuses the section. */
function wholeNumber(value: PdfValue | undefined): number {
  if (value?.kind !== "number" || !Number.isInteger(value.value) || value.value < 0)
    throw new PdfObjectsRefusal("xref-stream");
  return value.value;
}

/** §7.5.8.2: `/Index`, pairs of first object number and count; its default is `[0 Size]`. */
function indexRanges(dict: PdfDict): readonly (readonly [number, number])[] {
  const index: PdfValue | undefined = dict.get("Index");
  if (index === undefined) return [[0, wholeNumber(dict.get("Size"))]];
  if (index.kind !== "array" || index.items.length === 0 || index.items.length % 2 !== 0)
    throw new PdfObjectsRefusal("xref-stream");

  const ranges: (readonly [number, number])[] = [];
  for (let i = 0; i < index.items.length; i += 2) {
    ranges.push([wholeNumber(index.items[i]), wholeNumber(index.items[i + 1])]);
  }
  return ranges;
}

/** §7.5.8: the cross-reference STREAM at `offset`. Its own dictionary IS the trailer (§7.5.8.2). */
function readStreamSection(bytes: Uint8Array, offset: number, spend: SpendBytes): Section {
  let object;
  try {
    // An indirect `/Length` cannot be resolved here: resolving it would need the very section being read.
    object = parseIndirectObject(bytes, offset, () => undefined);
  } catch {
    // Whatever is at that offset, it is not a cross-reference section.
    throw new PdfObjectsRefusal("xref-offset");
  }
  const stream = object.value;
  if (stream.kind !== "stream") throw new PdfObjectsRefusal("xref-offset");
  const type: PdfValue | undefined = stream.dict.get("Type");
  if (type?.kind !== "name" || type.value !== "XRef") throw new PdfObjectsRefusal("xref-stream");

  const { widths, rowBytes, ranges, total } = streamShape(stream.dict);
  const data = decodeStream(bytes, stream);
  // Paid BEFORE being read: it is the decompression that costs, and a section that inflates must be counted even if
  // its shape makes it refused on the next line.
  spend(data.length);
  if (total * rowBytes > data.length) throw new PdfObjectsRefusal("xref-stream");

  const entries = new Map<number, MergedEntry>();
  let at = 0;
  for (const [first, count] of ranges) {
    for (let i = 0; i < count; i += 1) {
      const num = first + i;
      if (!entries.has(num)) entries.set(num, streamEntry(data, at, widths));
      at += rowBytes;
    }
  }
  return { entries, trailer: stream.dict };
}

/** §7.5.8.2: what the dictionary of a cross-reference stream says of its rows, all checked before a byte is read. */
function streamShape(dict: PdfDict): {
  widths: readonly [number, number, number];
  rowBytes: number;
  ranges: readonly (readonly [number, number])[];
  total: number;
} {
  const widths = fieldWidths(dict);
  const rowBytes = widths[0] + widths[1] + widths[2];
  if (rowBytes === 0) throw new PdfObjectsRefusal("xref-stream");
  const ranges = indexRanges(dict);
  const total = ranges.reduce((sum, [, count]) => sum + count, 0);
  if (total > MAX_XREF_ENTRIES) throw new PdfObjectsRefusal("xref-too-large");
  return { widths, rowBytes, ranges, total };
}

/** §7.5.8.3: one row of a cross-reference stream — its type, then two fields whose meaning the type gives. */
function streamEntry(data: Uint8Array, at: number, [w0, w1, w2]: readonly [number, number, number]): MergedEntry {
  // A width of 0 for the type field means type 1, the only default the clause gives.
  const kind = bigEndian(data, at, w0, 1);
  const second = bigEndian(data, at + w0, w1, 0);
  const third = bigEndian(data, at + w0 + w1, w2, 0);
  if (kind === 1) return { kind: "offset", offset: second, gen: third };
  if (kind === 2) return { kind: "compressed", container: second, index: third };
  // Type 0 is a free object; any OTHER type stands for the null object, which is the same thing for us: the
  // object is not there, and it hides an older placement.
  return { kind: "free" };
}

/** §7.5.8.4: a hybrid file's classic table points at a stream that holds the compressed objects it cannot name. */
function hybridOffset(trailer: PdfDict, bytes: Uint8Array): number | undefined {
  const stm: PdfValue | undefined = trailer.get("XRefStm");
  if (stm === undefined) return undefined;
  if (stm.kind !== "number" || !Number.isInteger(stm.value) || stm.value < 0 || stm.value >= bytes.length) {
    throw new PdfObjectsRefusal("xref-offset");
  }
  return stm.value;
}

/** §7.5.6: the previous section's offset, checked to be an integer inside the file. */
function prevOffset(trailer: PdfDict, bytes: Uint8Array): number | undefined {
  const prev: PdfValue | undefined = trailer.get("Prev");
  if (prev === undefined) return undefined;
  if (prev.kind !== "number" || !Number.isInteger(prev.value) || prev.value < 0 || prev.value >= bytes.length) {
    throw new PdfObjectsRefusal("xref-offset");
  }
  return prev.value;
}

/** The newest placement of an object wins, and the ceiling of `bounds.ts` is held for the WHOLE chain — which is
 *  what it says it is, and what sixty-four sections would otherwise defeat one section at a time (review of
 *  31/10/2026). */
function mergeInto(merged: Map<number, MergedEntry>, entries: ReadonlyMap<number, MergedEntry>): void {
  for (const [num, entry] of entries) {
    if (merged.has(num)) continue;
    if (merged.size >= MAX_XREF_ENTRIES) throw new PdfObjectsRefusal("xref-too-large");
    merged.set(num, entry);
  }
}

/** §7.5.8.4: in a hybrid file, the classic table marks the compressed objects FREE — so that a PDF 1.4 reader
 *  sees them as absent — and the `/XRefStm` says where they really are. A reader that understands streams must
 *  therefore let the stream OVERRIDE the free entries of its own section, which is the whole point of the entry.
 *  🔴 First version (31/10/2026): the stream was merged after the table with the "first wins" rule,
 *  so it NEVER brought anything — the objects it describes are precisely those the table says are free.
 *  Dead support, found by the third review, and which none of the 304 files measured could reveal: the
 *  corpus holds no hybrid file. */
function withHybrid(
  bytes: Uint8Array,
  trailer: PdfDict,
  section: ReadonlyMap<number, MergedEntry>,
  visited: Set<number>,
  spend: SpendBytes,
): ReadonlyMap<number, MergedEntry> {
  const hybrid = hybridOffset(trailer, bytes);
  if (hybrid === undefined || visited.has(hybrid)) return section;
  visited.add(hybrid);

  const entries = new Map(section);
  for (const [num, entry] of readStreamSection(bytes, hybrid, spend).entries) {
    const placed = entries.get(num);
    // The table's own placements win; what it marks free is what the stream is there to supply.
    if (placed === undefined || placed.kind === "free") entries.set(num, entry);
  }
  return entries;
}

/** A budget of our own, when the caller gives none: there is NO path without a budget, that is the whole point
 *  of the fix. The document passes its own, which also counts everything else. */
const ownBudget = (): SpendBytes => {
  let spent = 0;
  return (bytes: number): void => {
    spent += bytes;
    if (spent > MAX_DOCUMENT_BYTES) throw new PdfObjectsRefusal("document-too-large");
  };
};

/** The whole chain, newest section first. */
export function readXref(bytes: Uint8Array, spend: SpendBytes = ownBudget()): Xref {
  const merged = new Map<number, MergedEntry>();
  const trailer = new Map<string, PdfValue>();
  const visited = new Set<number>();

  let offset: number | undefined = lastStartxref(bytes);
  while (offset !== undefined) {
    if (visited.size >= MAX_XREF_SECTIONS) throw new PdfObjectsRefusal("xref-chain");
    if (visited.has(offset)) throw new PdfObjectsRefusal("xref-chain");
    visited.add(offset);

    const read = readSection(bytes, offset, spend);
    // The hybrid stream of THIS section is folded in before the section is merged (§7.5.8.4), its dictionary
    // bringing no trailer key.
    mergeInto(merged, withHybrid(bytes, read.trailer, read.entries, visited, spend));
    for (const [key, value] of read.trailer) if (!trailer.has(key)) trailer.set(key, value);
    offset = prevOffset(read.trailer, bytes);
  }

  const entries = new Map<number, XrefEntry>();
  for (const [num, entry] of merged) if (entry.kind !== "free") entries.set(num, entry);
  return { entries, trailer };
}
