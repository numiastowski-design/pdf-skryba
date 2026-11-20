/** The `/ToUnicode` CMap of a font: what TEXT each glyph code paints (ISO 32000-1:2008 §9.10.3, and §9.7.5-9.7.6
 *  for a CMap's syntax).
 *  Decides: that a `bfrange` with a plain destination increments its LAST UTF-16 unit across the range (§9.10.3,
 *  Table 118) and that one with an array takes one destination per code; that a destination is UTF-16BE, so a
 *  surrogate pair is the ONE character it spells; and every refusal — a block that never ends, a pair that is
 *  not two hexadecimal strings, a range read backwards, an array shorter than its range, a code wider than four
 *  bytes, or more codes than the ceiling allows.
 *  WHY IT EXISTS: it is the first half of what pdf.js did for us until its removal (1/11/2026). `/ToUnicode` is the AUTHORITATIVE answer
 *  to "what does this code mean", and it covers 27.8% of the bytes painted by our corpus (measured on
 *  31/10/2026, `tools/poc/font-census.ts`). The other 72 % come from glyph NAMES, which is the next slice.
 *  NOT here: the glyph names and their table (next slice), the widths, the font programs — and nothing of pdf.js.
 *  Called by: the POC's tools (`tools/poc/`), and `to-unicode.test.ts`.
 *
 *  ITS OWN SCANNER, like `pdf-objects/xref.ts`: a CMap is PostScript, not PDF syntax. What this clause needs of
 *  it is three shapes — a hexadecimal string, an array of them, and a keyword — so twenty lines read exactly
 *  that. Borrowing the content-stream reader would cap the operands at 64 and refuse a real `bfchar` block. */

import { PdfObjectsRefusal } from "../pdf-objects/refusal";
import { MAX_CMAP_TOKEN_BYTES, MAX_TOUNICODE_ENTRIES, MAX_TOUNICODE_PLACED, MAX_TOUNICODE_UNITS } from "./bounds";
import { isRealCharacter } from "./names";

const LT = 0x3c;
const GT = 0x3e;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;

const refuse = (): never => {
  throw new PdfObjectsRefusal("to-unicode");
};

/** §7.3.4.3: the bytes of a hexadecimal string, and where it ends. Four bytes at most — §9.7.6.2 caps a code
 *  there, and a destination longer than that is capped by its own ceiling. */
function hexAt(data: Uint8Array, from: number): { bytes: number[]; end: number } | undefined {
  if (data[from] !== LT) return undefined;
  const bytes: number[] = [];
  let half = -1;
  for (let at = from + 1; at < data.length; at += 1) {
    const byte = data[at] as number;
    if (byte === GT) {
      if (half >= 0) bytes.push(half * 16);
      return { bytes, end: at + 1 };
    }
    if (isSpace(byte)) continue;
    half = takeNibble(bytes, half, byte);
  }
  return refuse();
}

/** One hexadecimal digit of a string: it either becomes the pending high nibble (returned) or completes a byte
 *  (pushed, and -1 returned). */
function takeNibble(bytes: number[], half: number, byte: number): number {
  const digit = hexDigit(byte);
  if (digit < 0) return refuse();
  if (half < 0) return digit;
  bytes.push(half * 16 + digit);
  if (bytes.length > MAX_TOUNICODE_UNITS * 2) return refuse();
  return -1;
}

const hexDigit = (byte: number): number => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
};

/** The next token: a hexadecimal string, an array of them, a keyword, or nothing left. */
type Token =
  | { kind: "hex"; bytes: number[]; end: number }
  | { kind: "array"; items: number[][]; end: number }
  | { kind: "word"; text: string; end: number }
  | { kind: "end" };

function skipSpaces(data: Uint8Array, from: number): number {
  let at = from;
  while (at < data.length && isSpace(data[at] as number)) at += 1;
  return at;
}

/** The array token whose `[` is at `at`: hexadecimal strings up to the closing `]`. */
function arrayTokenAt(data: Uint8Array, at: number): Token {
  const items: number[][] = [];
  let cursor = at + 1;
  for (;;) {
    cursor = skipSpaces(data, cursor);
    if (cursor >= data.length) return refuse();
    if (data[cursor] === RBRACKET) return { kind: "array", items, end: cursor + 1 };
    const hex = hexAt(data, cursor) ?? refuse();
    items.push(hex.bytes);
    if (items.length > MAX_TOUNICODE_ENTRIES) return refuse();
    cursor = hex.end;
  }
}

/** The keyword token starting at `at`. */
function wordTokenAt(data: Uint8Array, at: number): Token {
  let end = at;
  while (end < data.length && !isSpace(data[end] as number) && data[end] !== LT && data[end] !== LBRACKET) {
    end += 1;
    // Capped like the three other scanners of the reader (`bounds.ts#MAX_CMAP_TOKEN_BYTES`): without it, binary
    // bytes arriving here cost a copy and a string the size of the whole stream.
    if (end - at > MAX_CMAP_TOKEN_BYTES) return refuse();
  }
  if (end === at) end += 1; // a byte that is nothing of the above: skipped as one token
  return { kind: "word", text: Buffer.from(data.subarray(at, end)).toString("latin1"), end };
}

function tokenAt(data: Uint8Array, from: number): Token {
  const at = skipSpaces(data, from);
  if (at >= data.length) return { kind: "end" };

  // `<<` opens a DICTIONARY, not a hexadecimal string: the header of every CMap carries one
  // (`/CIDSystemInfo << /Registry (Adobe) … >>`), and reading it as hexadecimal refused everything (31/10/2026).
  if (data[at] === LT && data[at + 1] === LT) return { kind: "word", text: "<<", end: at + 2 };
  if (data[at] === GT && data[at + 1] === GT) return { kind: "word", text: ">>", end: at + 2 };
  if (data[at] === LT) {
    const hex = hexAt(data, at) ?? refuse();
    return { kind: "hex", bytes: hex.bytes, end: hex.end };
  }
  if (data[at] === LBRACKET) return arrayTokenAt(data, at);
  return wordTokenAt(data, at);
}

/** A code, big-endian on at most four bytes (§9.7.6.2). */
function codeOf(bytes: readonly number[]): number {
  if (bytes.length === 0 || bytes.length > 4) return refuse();
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** §9.10.3: the UTF-16 UNITS of a destination. An odd length is a one-byte destination, which real
 *  producers write for Latin. */
function unitsOf(bytes: readonly number[]): number[] {
  if (bytes.length % 2 !== 0) return [...bytes];
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) units.push((bytes[i] as number) * 256 + (bytes[i + 1] as number));
  return units;
}

/** The text of a destination SHIFTED by `step` (§9.10.3, Table 118: a range increments the LAST unit).
 *  🔴 THE SHIFT IS DONE ON THE UNITS, AND THE FILTER APPLIES TO THE FINAL VALUE (31/10/2026). The earlier version
 *  first rendered the text of the FIRST code, then incremented that STRING. When the first was
 *  refused — a range `<0000> <00ff> <0000>`, which a DejaVuSans export writes —, it started from the empty string
 *  and the 256 codes of the range stayed empty: 1,140 glyphs out of 1,158 lost on page 1 of a real safedocs,
 *  and it was the full `check` that said so, not the corpus. */
function textOfUnits(units: readonly number[], step: number): Declared {
  if (units.length === 0) return { text: "", raw: "" };
  if (units.length > MAX_TOUNICODE_UNITS) return refuse();
  const shifted = [...units];
  const last = shifted.length - 1;
  shifted[last] = ((shifted[last] as number) + step) & 0xffff;
  // 🔴 THE SAME CRITERION AS THE GLYPH NAMES (`medium` review of 31/10/2026): `names.ts` refuses U+0000 and the
  // surrogate half-pairs, and this half let them through — a `/ToUnicode` that says `<0000>` or
  // `<D835>` made a NUL or an invalid character travel to the page, and its answer TAKES PRECEDENCE over the glyph name
  // that could have answered. Two files that decide the same thing must decide it the same way.
  const raw = String.fromCharCode(...shifted);
  return isWellFormed(shifted) ? { text: raw, raw } : { text: "", raw };
}

/** The text of a destination, without shift — the form used by `bfchar` and the array variant. */
const textOf = (bytes: readonly number[]): Declared => textOfUnits(unitsOf(bytes), 0);

/** §9.10.3: a destination is UTF-16BE, so every high half-pair must be FOLLOWED by a low one.
 *  🔴 WHY ON PAIRING AND NOT ON LENGTH (security review of 31/10/2026): the first version of
 *  this guard only looked at ONE-unit destinations, so `<0041D800>` or `<D800D800>` got through — and
 *  `String.fromCharCode` emitted invalid UTF-16 up to the page, which `names.ts` forbids. A COMPLETE
 *  pair remains legitimate: it spells a real character. */
/** ⚠️ WRITTEN LIMIT, MEASURED, NOT FIXED (31/10/2026). A producer can write the UTF-16 UNITS as CIDs:
 *  an emoji then occupies TWO consecutive painted codes (`0xD83D` then `0xDC00`), and its identity CMap gives
 *  each an isolated half-pair. We reject both, so the emoji is LOST; pdf.js rendered the first
 *  as an astral character and the second as another, invented one (U+B0000, U+38C00 — code points that nothing
 *  carries). Both readings are therefore wrong, and neither loses a WORD.
 *  Cost measured on 415 real files: 10 glyphs, all in one third-party PDF of the measurement corpus (safedocs 0000340).
 *  Fixing it would require pairing the half-pairs of two NEIGHBOURING codes, which is decided in
 *  `extractor/pdf-glyph-source.ts` (it sees the sequence of codes) and not here (which sees a single code). It is a new
 *  capability, not a fix, and it was not added on the eve of a deployment. */
function isWellFormed(units: readonly number[]): boolean {
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i] as number;
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (isHigh) {
      const next = units[i + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return false;
      i += 1; // the low half belongs to this pair and is not judged alone
      continue;
    }
    // A low half met outside a pair is an isolated half; otherwise, the criterion common to both files.
    if (isLow || !isRealCharacter(unit)) return false;
  }
  return true;
}

function readBfChar(data: Uint8Array, from: number, state: Placing): number {
  let at = from;
  for (;;) {
    const first = tokenAt(data, at);
    if (first.kind === "end") return refuse();
    if (first.kind === "word") return first.text === "endbfchar" ? first.end : refuse();
    if (first.kind !== "hex") return refuse();
    const second = tokenAt(data, first.end);
    if (second.kind !== "hex") return refuse();
    place(state, codeOf(first.bytes), textOf(second.bytes));
    at = second.end;
  }
}

function readBfRange(data: Uint8Array, from: number, state: Placing): number {
  let at = from;
  for (;;) {
    const low = tokenAt(data, at);
    if (low.kind === "end") return refuse();
    if (low.kind === "word") return low.text === "endbfrange" ? low.end : refuse();
    if (low.kind !== "hex") return refuse();
    const high = tokenAt(data, low.end);
    if (high.kind !== "hex") return refuse();
    const destination = tokenAt(data, high.end);

    const first = codeOf(low.bytes);
    const last = codeOf(high.bytes);
    if (last < first || last - first + 1 > MAX_TOUNICODE_ENTRIES) return refuse();

    at = placeRange(state, destination, first, last);
  }
}

/** Places the codes `first..last` from a range's destination (an array: one text per code; a hexadecimal string:
 *  shifted per code) and returns where the destination ends. */
function placeRange(state: Placing, destination: Token, first: number, last: number): number {
  if (destination.kind === "array") {
    if (destination.items.length < last - first + 1) return refuse();
    for (let code = first; code <= last; code += 1)
      place(state, code, textOf(destination.items[code - first] as number[]));
    return destination.end;
  }
  if (destination.kind !== "hex") return refuse();
  // The units once for the whole range, then the shift and the filter code by code.
  const units = unitsOf(destination.bytes);
  for (let code = first; code <= last; code += 1) place(state, code, textOfUnits(units, code - first));
  return destination.end;
}

/** 🔴 THE WORK IS BOUNDED, not only the table (security review of 31/10/2026). The per-range ceiling did not
 *  bound the NUMBER of ranges: `<0000> <FFFF> <0041>` fits in twenty bytes and places 65,536 codes, and a
 *  100 KB CMap that repeats it demanded 3 × 10⁸ iterations — about a hundred seconds for a tiny file.
 *  The budget therefore counts the codes PLACED, redefinitions included, and refuses beyond it. */
/** What a destination is worth: the text we PUBLISH, and what the file DECLARES. The two differ only
 *  when the filter refused (a U+0000, an isolated surrogate half-pair). */
interface Declared {
  readonly text: string;
  readonly raw: string;
}

interface Placing {
  readonly into: Map<number, string>;
  /** 🔴 WHAT THE FILE DECLARES WHERE WE REFUSE TO PUBLISH IT (31/10/2026: "we have to do it
   *  ourselves", for emojis). A producer can write the UTF-16 units as CIDs: an emoji then occupies two
   *  neighbouring painted codes, and each carries an isolated half-pair that the filter rightly rejects, taken alone.
   *  It is `extractor/pdf-glyph-source.ts` that PAIRS them, because only it sees the sequence of painted codes.
   *  Small by construction — we only enter here for a refused code — and bounded by the same budget as the rest. */
  readonly rejected: Map<number, string>;
  placed: number;
}

function place(state: Placing, code: number, declared: Declared): void {
  state.placed += 1;
  if (state.placed > MAX_TOUNICODE_PLACED) refuse();
  if (state.into.size >= MAX_TOUNICODE_ENTRIES && !state.into.has(code)) refuse();
  state.into.set(code, declared.text);
  if (declared.text === "" && declared.raw !== "") state.rejected.set(code, declared.raw);
}

/** What a `/ToUnicode` CMap says: the publishable text of each code, and what it DECLARES where we refuse to
 *  publish. A CMap that maps nothing yields two empty tables, which is not an error: a font may
 *  carry a `/ToUnicode` that says nothing useful. */
export interface ToUnicode {
  readonly text: ReadonlyMap<number, string>;
  readonly rejected: ReadonlyMap<number, string>;
}

export function readToUnicode(data: Uint8Array): ToUnicode {
  const state: Placing = { into: new Map<number, string>(), rejected: new Map<number, string>(), placed: 0 };
  let at = 0;
  while (at < data.length) {
    const token = tokenAt(data, at);
    if (token.kind === "end") break;
    if (token.kind !== "word") {
      at = token.end;
      continue;
    }
    if (token.text === "beginbfchar") at = readBfChar(data, token.end, state);
    else if (token.text === "beginbfrange") at = readBfRange(data, token.end, state);
    else at = token.end;
  }
  return { text: state.into, rejected: state.rejected };
}
