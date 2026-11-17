/** The CCITT fax image (ITU-T T.4 and T.6, PDF §7.4.6 `CCITTFaxDecode`), decoded to packed bits.
 *  Decides: the bits of each row, in PDF's convention (`BlackIs1` false: a 0 bit is black), and the reading of the
 *  three encodings: K < 0 (Group 4, every row 2D), K = 0 (Group 3, every row 1D), K > 0 (Group 3 mixed, the next bit
 *  tells the row's kind). A short stream leaves the missing rows white.
 *  🔴 Written limits: the Group 3 byte-alignment flag is kept as PDFium keeps it (once a row's alignment bit is found
 *  set, alignment stops for the rest of the stream); a stream past its end is read as zeros.
 *  NOT here: the image dictionary (`/Width`, `/Decode`…: the caller passes the numbers), the image's pixels as a
 *  picture (`extractor/pdf-images.ts`).
 *  Called by: `extractor/pdf-images.ts` (when a CCITT image is read), `ccitt-fax.test.ts`. */
// Copyright 2014 The PDFium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file (see THIRD-PARTY.md, « PDFium »).
//
// Ported to TypeScript from PDFium's core/fxcodec/fax/faxmodule.cpp (the decoding half: FindBit,
// FaxG4FindB1B2, FaxFillBits, FaxGetRun, FaxG4GetRow, FaxSkipEOL, FaxGet1DLine and FaxDecoder). The
// algorithm and its order of operations are kept line for line; only the memory handling changed.

import { FAX_BLACK_RUN_INS, FAX_WHITE_RUN_INS } from "./ccitt-run-tables";

/** PDFium's limit on either side of the image (`kFaxMaxImageDimension`). */
const MAX_DIMENSION = 65535;

/** Bytes of decoded rows we accept for one image: a limit of ours, since 65535 × 65535 pixels is half a gigabyte. */
const MAX_CCITT_BYTES = 64 * 1024 * 1024;

/** Bits of a row in its pitch: PDFium's pitch is 32-bit aligned. */
const pitchOf = (columns: number): number => Math.ceil(columns / 32) * 4;

/** The position of the most significant set bit of a byte, counted from the top: `kOneLeadPos` of PDFium. */
const leadPos = (byte: number): number => Math.clz32(byte) - 24;

/** Parameters of the decoding, as the PDF dictionary gives them (§7.4.6, Table 11). */
export interface CcittOptions {
  /** `K`: < 0 Group 4, 0 Group 3 one-dimensional, > 0 Group 3 mixed. */
  readonly K: number;
  readonly EndOfLine: boolean;
  readonly EncodedByteAlign: boolean;
  readonly BlackIs1: boolean;
  /** `Columns` (default 1728 in the PDF; the caller resolves it). */
  readonly columns: number;
  /** `Rows`: the height. A zero is the image's own height, the caller resolves it. */
  readonly rows: number;
}

/** The decoded image: `rows` rows of `pitch` bytes each, `columns` pixels per row. */
export interface CcittImage {
  readonly columns: number;
  readonly rows: number;
  readonly pitch: number;
  readonly bits: Uint8Array;
}

/** A reader of the stream bit by bit, with PDFium's `NextBit`: the position advances, and past the end a bit is 0. */
class BitReader {
  pos = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly size: number,
  ) {}

  next(): boolean {
    const at = this.pos;
    this.pos += 1;
    const byte = this.bytes[at >> 3] ?? 0;
    return (byte & (1 << (7 - (at % 8)))) !== 0;
  }
}

/** The first position from `start` (below `max`) where a bit equals `bit`, or `max` when there is none. PDFium's `FindBit`. */
function findBit(data: Uint8Array, max: number, start: number, bit: boolean): number {
  if (start >= max) return max;
  const xor = bit ? 0x00 : 0xff;
  let pos = start;
  while (pos < max) {
    const byte = ((data[pos >> 3] ?? 0) ^ xor) & (0xff >> (pos % 8));
    if (byte !== 0) return Math.min((pos & ~7) + leadPos(byte), max);
    pos = (pos & ~7) + 8;
  }
  return max;
}

/** The changing elements b1 and b2 of the reference row, after the position a0 (ITU-T T.4 §4.2.1.3.2). */
function findB1B2(ref: Uint8Array, columns: number, a0: number, a0color: boolean): [number, number] {
  let firstBit = a0 < 0 || ((ref[a0 >> 3] ?? 0) & (1 << (7 - (a0 % 8)))) !== 0;
  let b1 = findBit(ref, columns, a0 + 1, !firstBit);
  if (b1 >= columns) return [columns, columns];
  if (firstBit === !a0color) {
    b1 = findBit(ref, columns, b1 + 1, firstBit);
    firstBit = !firstBit;
  }
  if (b1 >= columns) return [columns, columns];
  const b2 = findBit(ref, columns, b1 + 1, firstBit);
  return [b1, b2];
}

/** Clears the bits of `[startpos, endpos)` in the row (a black run). PDFium subtracts each bit: the same bit clears twice
 *  wraps, and it is kept so. */
function fillBits(dest: Uint8Array, columns: number, startpos: number, endpos: number): void {
  const start = Math.max(startpos, 0);
  const end = Math.min(Math.max(endpos, 0), columns);
  if (start >= end) return;
  const first = start >> 3;
  const last = (end - 1) >> 3;
  const sub = (index: number, bit: number): void => {
    dest[index] = ((dest[index] ?? 0) - bit) & 0xff;
  };
  if (first === last) {
    for (let i = start % 8; i <= (end - 1) % 8; i += 1) sub(first, 1 << (7 - i));
    return;
  }
  for (let i = start % 8; i < 8; i += 1) sub(first, 1 << (7 - i));
  for (let i = 0; i <= (end - 1) % 8; i += 1) sub(last, 1 << (7 - i));
  if (last > first + 1) dest.fill(0, first + 1, last);
}

/** One run length, read with a run-length code table (`FAX_WHITE_RUN_INS` or `FAX_BLACK_RUN_INS`). -1 when no code matches. */
function getRun(table: readonly number[], reader: BitReader): number {
  let code = 0;
  let at = 0;
  for (;;) {
    const count = table[at];
    at += 1;
    if (count === 0xff || count === undefined) return -1;
    if (reader.pos >= reader.size) return -1;
    code <<= 1;
    if (reader.next()) code += 1;
    const end = at + count * 3;
    for (; at < end; at += 3) {
      if (table[at] === code) return (table[at + 1] ?? 0) + (table[at + 2] ?? 0) * 256;
    }
  }
}

/** One two-dimensional coding mode, as read from the bits: a vertical mode with its offset, or a fixed mode. */
type G4Mode =
  | { readonly kind: "vertical"; readonly delta: number }
  | { readonly kind: "horizontal" }
  | { readonly kind: "pass" }
  | { readonly kind: "skip" }
  | { readonly kind: "end" };

const G4_END: G4Mode = { kind: "end" };
const G4_HORIZONTAL: G4Mode = { kind: "horizontal" };
const G4_PASS: G4Mode = { kind: "pass" };
const G4_SKIP: G4Mode = { kind: "skip" };

const atEnd = (reader: BitReader): boolean => reader.pos >= reader.size;

/** The mode codes that start with `000`: pass, the larger vertical offsets, and the extension. */
function readLongMode(reader: BitReader): G4Mode {
  if (atEnd(reader)) return G4_END;
  if (reader.next()) return G4_PASS;
  if (atEnd(reader)) return G4_END;
  const next1 = reader.next();
  if (atEnd(reader)) return G4_END;
  const next2 = reader.next();
  if (next1) return { kind: "vertical", delta: next2 ? 2 : -2 }; // Vertical VR(2), VL(2).
  if (next2) {
    if (atEnd(reader)) return G4_END;
    return { kind: "vertical", delta: reader.next() ? 3 : -3 }; // Vertical VR(3), VL(3).
  }
  if (atEnd(reader)) return G4_END;
  // Extension: a set bit skips three, otherwise the row ends.
  if (reader.next()) {
    reader.pos += 3;
    return G4_SKIP;
  }
  reader.pos += 5;
  return G4_END;
}

/** The next two-dimensional mode code (T.6 Table 1). */
function readG4Mode(reader: BitReader): G4Mode {
  if (reader.next()) return { kind: "vertical", delta: 0 };
  if (atEnd(reader)) return G4_END;
  const bit1 = reader.next();
  if (atEnd(reader)) return G4_END;
  const bit2 = reader.next();
  if (bit1) return { kind: "vertical", delta: bit2 ? 1 : -1 }; // Vertical VR(1), VL(1).
  if (bit2) return G4_HORIZONTAL;
  return readLongMode(reader);
}

/** A whole run: the make-up codes (64 or more) then the terminating code, summed. A failed code counts -1, as PDFium does. */
function readWholeRun(table: readonly number[], reader: BitReader): number {
  let total = 0;
  for (;;) {
    const run = getRun(table, reader);
    total += run;
    if (run < 64) return total;
  }
}

/** Horizontal mode: two runs, a0 to a1 then a1 to a2. Returns a2, or `undefined` when a run is unreadable. */
function readHorizontal(
  reader: BitReader,
  dest: Uint8Array,
  columns: number,
  a0: number,
  a0color: boolean,
): number | undefined {
  let runLen1 = readWholeRun(a0color ? FAX_WHITE_RUN_INS : FAX_BLACK_RUN_INS, reader);
  if (a0 < 0) runLen1 += 1;
  if (runLen1 < 0) return undefined;
  const a1 = a0 + runLen1;
  if (!a0color) fillBits(dest, columns, a0, a1);
  const runLen2 = readWholeRun(a0color ? FAX_BLACK_RUN_INS : FAX_WHITE_RUN_INS, reader);
  if (runLen2 < 0) return undefined;
  const a2 = a1 + runLen2;
  if (a0color) fillBits(dest, columns, a1, a2);
  return a2;
}

/** The position state of a two-dimensional row: the last changing element `a0` and its colour (white is true). */
interface G4State {
  a0: number;
  a0color: boolean;
}

/** The streams a two-dimensional row works on: the bits in, the row out, the reference row above it. */
interface G4Row {
  readonly reader: BitReader;
  readonly dest: Uint8Array;
  readonly ref: Uint8Array;
  readonly columns: number;
}

/** Applies one mode to the row. Returns false when the row is over. */
function applyG4Mode(mode: G4Mode, row: G4Row, state: G4State): boolean {
  const { reader, dest, ref, columns } = row;
  const { a0, a0color } = state;
  const [b1, b2] = findB1B2(ref, columns, a0, a0color);
  switch (mode.kind) {
    case "end":
      return false;
    case "skip":
      return true;
    case "horizontal": {
      const a2 = readHorizontal(reader, dest, columns, a0, a0color);
      if (a2 === undefined || a2 >= columns) return false;
      state.a0 = a2;
      return true;
    }
    case "pass":
      if (!a0color) fillBits(dest, columns, a0, b2);
      if (b2 >= columns) return false;
      state.a0 = b2;
      return true;
    case "vertical": {
      const a1 = b1 + mode.delta;
      if (!a0color) fillBits(dest, columns, a0, a1);
      // The position of a picture element must increase.
      if (a1 >= columns || a0 >= a1) return false;
      state.a0 = a1;
      state.a0color = !a0color;
      return true;
    }
  }
}

/** One row in two dimensions (Group 4, or a mixed Group 3 row), T.4 §4.2.1.3 and T.6. PDFium's `FaxG4GetRow`. */
function g4Row(reader: BitReader, dest: Uint8Array, ref: Uint8Array, columns: number): void {
  const state: G4State = { a0: -1, a0color: true };
  // `findB1B2` reads only the reference row and the state, so taking it after the mode is read changes nothing.
  while (!atEnd(reader) && applyG4Mode(readG4Mode(reader), { reader, dest, ref, columns }, state));
}

/** One run of a one-dimensional row (make-up codes then terminating code), or `undefined` when a code is unreadable. */
function readRowRun(reader: BitReader, color: boolean): number | undefined {
  let runLen = 0;
  for (;;) {
    const run = getRun(color ? FAX_WHITE_RUN_INS : FAX_BLACK_RUN_INS, reader);
    if (run < 0) return undefined;
    runLen += run;
    if (run < 64) return runLen;
  }
}

/** Skips the bits up to and including the next set bit (the resynchronisation after an unreadable code). */
function skipToSetBit(reader: BitReader): void {
  while (reader.pos < reader.size) {
    if (reader.next()) return;
  }
}

/** One row in one dimension (Group 3 one-dimensional). PDFium's `FaxGet1DLine`. */
function g3Row(reader: BitReader, dest: Uint8Array, columns: number): void {
  let color = true;
  let startpos = 0;
  for (;;) {
    if (atEnd(reader)) return;
    const runLen = readRowRun(reader, color);
    if (runLen === undefined) {
      skipToSetBit(reader);
      return;
    }
    if (!color) fillBits(dest, columns, startpos, startpos + runLen);
    startpos += runLen;
    if (startpos >= columns) break;
    color = !color;
  }
}

/** Skips an end-of-line code (`EOL`, 12 bits, with its fill zeros), when one is there. PDFium's `FaxSkipEOL`. */
function skipEol(reader: BitReader): void {
  const startbit = reader.pos;
  while (reader.pos < reader.size) {
    if (!reader.next()) continue;
    if (reader.pos - startbit <= 11) reader.pos = startbit;
    return;
  }
}

/** Decodes one row into `line` by the coding scheme (`K`); returns the reference row for the next one. */
function decodeRow(
  reader: BitReader,
  line: Uint8Array,
  ref: Uint8Array<ArrayBuffer>,
  columns: number,
  scheme: number,
): Uint8Array<ArrayBuffer> {
  if (scheme === 0) {
    g3Row(reader, line, columns);
    return ref;
  }
  if (scheme > 0 && reader.next()) g3Row(reader, line, columns);
  else g4Row(reader, line, ref, columns);
  return line.slice();
}

/** Byte alignment: the zero bits up to the next byte boundary are skipped; a set bit stops alignment for good.
 *  Returns whether alignment is still on. */
function alignToByte(reader: BitReader, src: Uint8Array): boolean {
  let at = reader.pos;
  const boundary = (reader.pos + 7) & ~7;
  while (at < boundary) {
    if (((src[at >> 3] ?? 0) & (1 << (7 - (at % 8)))) !== 0) return false;
    at += 1;
  }
  reader.pos = boundary;
  return true;
}

/** Whether the decoder takes these dimensions (the same limits as PDFium, and a byte budget of its own). */
function acceptsSize(columns: number, rows: number): boolean {
  if (columns <= 0 || rows <= 0 || columns > MAX_DIMENSION || rows > MAX_DIMENSION) return false;
  return pitchOf(columns) * rows <= MAX_CCITT_BYTES;
}

/** Decodes a CCITT fax stream into its rows. The result has `rows` rows; a stream that ends early leaves the rest white.
 *  Returns `undefined` for a size the decoder refuses (the same limits as PDFium, and a byte budget of its own). */
export function decodeCcittFax(src: Uint8Array, options: CcittOptions): CcittImage | undefined {
  const { columns, rows } = options;
  if (!acceptsSize(columns, rows)) return undefined;
  const pitch = pitchOf(columns);
  const bits = new Uint8Array(pitch * rows);
  const reader = new BitReader(src, src.length * 8);
  let ref = new Uint8Array(pitch).fill(0xff);
  let byteAlign = options.EncodedByteAlign;
  let decoded = rows;
  for (let row = 0; row < rows; row += 1) {
    skipEol(reader);
    if (atEnd(reader)) {
      decoded = row;
      break;
    }
    const line = bits.subarray(row * pitch, (row + 1) * pitch);
    line.fill(0xff);
    ref = decodeRow(reader, line, ref, columns, options.K);
    if (options.EndOfLine) skipEol(reader);
    if (byteAlign && !atEnd(reader)) byteAlign = alignToByte(reader, src);
    if (options.BlackIs1) for (let i = 0; i < pitch; i += 1) line[i] = ~line[i]! & 0xff;
  }
  // Rows the stream never reached are white: 1 bits, or 0 when BlackIs1 inverts the picture.
  bits.fill(options.BlackIs1 ? 0x00 : 0xff, decoded * pitch);
  return { columns, rows, pitch, bits };
}
