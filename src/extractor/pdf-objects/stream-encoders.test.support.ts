/**
 * Test ENCODERS for the stream filters the reader decodes, written from ISO 32000-1:2008, never from the reader:
 * §7.4.2 ASCIIHexDecode, §7.4.3 ASCII85Decode, §7.4.4 LZWDecode and FlateDecode (zlib, RFC 1950, via `node:zlib`),
 * §7.4.4.4 the PNG predictors, §7.4.5 RunLengthDecode. Each encoder spells its output with random but valid choices
 * (white space, letter case, run cuts, clear codes).
 * Decides: the spellings an encoder may pick; how a chain of filters is encoded (the LAST filter named is applied
 * first, §7.4: the first named is the first decoded); the `DecodeParms` a chain carries (a dictionary for one filter, an
 * array parallel to `/Filter` for several, Table 5).
 * NOT here: the properties (`streams.property.test.ts`), the damage.
 * Called by: `streams.property.test.ts`, `pdf-rewriter.test.support.ts`.
 */

import { deflateSync } from "node:zlib";

import type { PdfDict, PdfValue } from "./objects";
import type { Choices } from "./pdf-syntax-writer.test.support";

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** §7.2.2 Table 1: the white-space characters an ASCII filter may hold anywhere. */
const WHITE = ["\x00", "\t", "\n", "\x0c", "\r", " "];

/** Now and then a run of white space (§7.4.2 and §7.4.3 ignore it). */
const maybeWhite = (choices: Choices): string => (choices.chance(15) ? choices.oneOf(WHITE) : "");

/** §7.4.2: two hexadecimal digits per byte, either case, white space anywhere, `>` at the end. A last byte whose low
 *  digit is 0 may be written as its high digit alone: an odd final digit is followed by an assumed 0. */
export function asciiHexEncode(data: Uint8Array, choices: Choices): Uint8Array {
  let text = "";
  for (const [index, byte] of data.entries()) {
    let pair = byte.toString(16).padStart(2, "0");
    if (choices.chance(50)) pair = pair.toUpperCase();
    if (index === data.length - 1 && (byte & 0x0f) === 0 && choices.chance(50)) pair = pair.slice(0, 1);
    text += maybeWhite(choices) + pair;
  }
  return latin1(`${text}${maybeWhite(choices)}>`);
}

/** §7.4.3: each group of four bytes as five base-85 digits from `!`; a group of four zero bytes as `z` (or spelled
 *  out); a last group of n bytes as n + 1 digits; `~>` at the end. */
export function ascii85Encode(data: Uint8Array, choices: Choices): Uint8Array {
  let text = "";
  for (let at = 0; at < data.length; at += 4) {
    const count = Math.min(4, data.length - at);
    let value = 0;
    for (let i = 0; i < 4; i += 1) value = value * 256 + (i < count ? (data[at + i] as number) : 0);
    if (count === 4 && value === 0 && choices.chance(70)) {
      text += maybeWhite(choices) + "z";
      continue;
    }
    const digits: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      digits.unshift(String.fromCharCode(0x21 + (value % 85)));
      value = Math.floor(value / 85);
    }
    for (const digit of digits.slice(0, count + 1)) text += maybeWhite(choices) + digit;
  }
  return latin1(`${text}${maybeWhite(choices)}~>`);
}

/** §7.4.5: runs of 1 to 128 literal bytes (length byte n - 1) and runs of 2 to 128 repeated bytes (length byte 257 - n),
 *  then 128, the end of data — left out now and then: the data simply ends. */
export function runLengthEncode(data: Uint8Array, choices: Choices): Uint8Array {
  const out: number[] = [];
  let at = 0;
  while (at < data.length) {
    let same = 1;
    while (at + same < data.length && same < 128 && data[at + same] === data[at]) same += 1;
    if (same >= 2 && choices.chance(80)) {
      const take = 2 + choices.pick(same - 1);
      out.push(257 - take, data[at] as number);
      at += take;
      continue;
    }
    const take = 1 + choices.pick(Math.min(128, data.length - at));
    out.push(take - 1, ...data.subarray(at, at + take));
    at += take;
  }
  if (choices.chance(80)) out.push(128);
  return Uint8Array.from(out);
}

const LZW_CLEAR = 256;
const LZW_EOD = 257;
const LZW_FIRST = 258;
/** §7.4.4.2: codes are at most twelve bits, so the table holds 4 096 entries. */
const LZW_TABLE_SIZE = 4096;

/** §7.4.4.2 and Table 8: the width of the NEXT code once entry `last` is the newest of the table. Codes are nine bits
 *  until entry 511 is made (EarlyChange 1) or entry 512 (EarlyChange 0), then ten, eleven, twelve at most. */
function lzwWidth(last: number, earlyChange: number): number {
  const reach = last + earlyChange;
  if (reach >= 2048) return 12;
  if (reach >= 1024) return 11;
  if (reach >= 512) return 10;
  return 9;
}

/** MSB-first bit packing (§7.4.4.2: codes are packed into a continuous bit stream, high-order bit first). */
class BitWriter {
  private readonly out: number[] = [];
  private value = 0;
  private bits = 0;

  write(code: number, width: number): void {
    for (let bit = width - 1; bit >= 0; bit -= 1) {
      this.value = (this.value << 1) | ((code >>> bit) & 1);
      this.bits += 1;
      if (this.bits === 8) {
        this.out.push(this.value);
        this.value = 0;
        this.bits = 0;
      }
    }
  }

  bytes(): Uint8Array {
    if (this.bits > 0) this.out.push(this.value << (8 - this.bits));
    return Uint8Array.from(this.out);
  }
}

/** §7.4.4.2: LZW. A clear-table code may open the data and comes when the table is full, or at random; each code
 *  emitted makes one table entry (the decoder makes the same entry one code later), the last one included, which is
 *  why the width keeps counting it; 257 ends the data. */
export function lzwEncode(data: Uint8Array, earlyChange: number, choices: Choices): Uint8Array {
  const writer = new BitWriter();
  let table = new Map<string, number>();
  let last = LZW_FIRST - 1;
  let width = 9;
  const reset = (): void => {
    writer.write(LZW_CLEAR, width);
    table = new Map();
    last = LZW_FIRST - 1;
    width = 9;
  };
  const codeOf = (key: string): number => (key.length === 1 ? key.charCodeAt(0) : (table.get(key) as number));
  const emit = (key: string, grown: string | undefined): void => {
    writer.write(codeOf(key), width);
    if (last + 1 < LZW_TABLE_SIZE) {
      last += 1;
      if (grown !== undefined) table.set(grown, last);
    }
    width = lzwWidth(last, earlyChange);
  };

  if (choices.chance(70)) reset();
  let current = "";
  for (const byte of data) {
    const next = current + String.fromCharCode(byte);
    if (next.length === 1 || table.has(next)) {
      current = next;
      continue;
    }
    emit(current, next);
    current = String.fromCharCode(byte);
    if (last + 1 >= LZW_TABLE_SIZE ? choices.chance(70) : choices.chance(1)) reset();
  }
  if (current !== "") emit(current, undefined);
  writer.write(LZW_EOD, width);
  return writer.bytes();
}

/** RFC 1950 zlib data, as §7.4.4 names it, at a random compression level. */
export function flateEncode(data: Uint8Array, choices: Choices): Uint8Array {
  return new Uint8Array(deflateSync(data, { level: choices.pick(10) }));
}

/** The Paeth predictor of the PNG specification, which §7.4.4.4 adopts. */
function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

/** §7.4.4.4 with PNG predictors (Predictor ≥ 10): each row of `columns × colors` bytes (BitsPerComponent 8) gets a tag
 *  byte — None, Sub, Up, Average or Paeth, chosen per row (Table 10: "the algorithm may vary from row to row"). */
export function pngPredict(data: Uint8Array, columns: number, colors: number, choices: Choices): Uint8Array {
  const stride = columns * colors;
  const rows = data.length / stride;
  const out = new Uint8Array(rows * (stride + 1));
  for (let row = 0; row < rows; row += 1) {
    const type = choices.pick(5);
    out[row * (stride + 1)] = type;
    for (let at = 0; at < stride; at += 1) {
      const here = row * stride + at;
      const left = at >= colors ? (data[here - colors] as number) : 0;
      const up = row > 0 ? (data[here - stride] as number) : 0;
      const upLeft = at >= colors && row > 0 ? (data[here - stride - colors] as number) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type] as number;
      out[row * (stride + 1) + 1 + at] = ((data[here] as number) - predicted) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chains of filters.

/** The filters of §7.4 the reader decodes, under their names and the abbreviations of §8.9.7 Table 94 that
 *  `streams.ts` serves (`LZW` since 24/11/2026). */
export const STREAM_FILTERS = [
  "ASCIIHexDecode",
  "AHx",
  "ASCII85Decode",
  "A85",
  "LZWDecode",
  "LZW",
  "FlateDecode",
  "Fl",
  "RunLengthDecode",
  "RL",
] as const;
export type StreamFilter = (typeof STREAM_FILTERS)[number];

/** The parameters of one filter of a chain (§7.4.4.3 Table 8): a PNG predictor for LZW and Flate, `EarlyChange` for LZW. */
export interface FilterStep {
  readonly filter: StreamFilter;
  readonly predictor?: { readonly predictor: number; readonly columns: number; readonly colors: number };
  readonly earlyChange?: 0 | 1;
}

const isLzw = (filter: StreamFilter): boolean => filter === "LZWDecode" || filter === "LZW";
export const takesParms = (filter: StreamFilter): boolean =>
  isLzw(filter) || filter === "FlateDecode" || filter === "Fl";

function encodeStep(data: Uint8Array, step: FilterStep, choices: Choices): Uint8Array {
  const shaped =
    step.predictor === undefined ? data : pngPredict(data, step.predictor.columns, step.predictor.colors, choices);
  switch (step.filter) {
    case "ASCIIHexDecode":
    case "AHx":
      return asciiHexEncode(shaped, choices);
    case "ASCII85Decode":
    case "A85":
      return ascii85Encode(shaped, choices);
    case "LZWDecode":
    case "LZW":
      return lzwEncode(shaped, step.earlyChange ?? 1, choices);
    case "FlateDecode":
    case "Fl":
      return flateEncode(shaped, choices);
    default:
      return runLengthEncode(shaped, choices);
  }
}

/** The bytes a chain decodes to `data`: the last filter's encoder first (§7.4). A step with a predictor needs `data`,
 *  at that point of the chain, to be whole rows; the caller makes it so. */
export function encodeChain(data: Uint8Array, steps: readonly FilterStep[], choices: Choices): Uint8Array {
  let out = data;
  for (let i = steps.length - 1; i >= 0; i -= 1) out = encodeStep(out, steps[i] as FilterStep, choices);
  return out;
}

const name = (value: string): PdfValue => ({ kind: "name", value });
const num = (value: number): PdfValue => ({ kind: "number", value });

function parmsOf(step: FilterStep): PdfDict | undefined {
  const entries = new Map<string, PdfValue>();
  if (step.predictor !== undefined) {
    entries.set("Predictor", num(step.predictor.predictor));
    entries.set("Columns", num(step.predictor.columns));
    entries.set("Colors", num(step.predictor.colors));
    entries.set("BitsPerComponent", num(8));
  }
  if (step.earlyChange !== undefined) entries.set("EarlyChange", num(step.earlyChange));
  return entries.size === 0 ? undefined : entries;
}

/** §7.3.8.2 Table 5: `/Filter` a name or an array, `/DecodeParms` a dictionary for one filter or an array parallel to
 *  the filters, `null` where a filter has none; absent when no filter has any. */
export function chainDict(steps: readonly FilterStep[], choices: Choices): Map<string, PdfValue> {
  const dict = new Map<string, PdfValue>();
  const asArray = steps.length > 1 || choices.chance(30);
  if (steps.length > 0) {
    dict.set(
      "Filter",
      asArray ? { kind: "array", items: steps.map((step) => name(step.filter)) } : name(steps[0]?.filter as string),
    );
  }
  const parms = steps.map(parmsOf);
  if (parms.every((entry) => entry === undefined)) return dict;
  const key = "DecodeParms";
  if (!asArray) dict.set(key, { kind: "dict", entries: parms[0] as PdfDict });
  else
    dict.set(key, {
      kind: "array",
      items: parms.map((entry): PdfValue =>
        entry === undefined ? { kind: "null" } : { kind: "dict", entries: entry },
      ),
    });
  return dict;
}
