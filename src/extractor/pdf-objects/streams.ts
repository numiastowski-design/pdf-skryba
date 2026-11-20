/** The bytes a PDF stream really carries, and the objects a stream can hold (ISO 32000-1:2008 §7.4.4 FlateDecode
 *  and the PNG predictors, §7.5.7 object streams).
 *  Decides: which filters we implement — `FlateDecode`, `LZWDecode`, `ASCIIHexDecode`, `ASCII85Decode` and
 *  `RunLengthDecode` — and that every other one is REFUSED rather than passed through silently; that a
 *  `DecodeParms` is read as a dictionary OR as an array parallel to `/Filter` (Table 5), the limit of 24/10/2026
 *  being lifted by the measure of 31/10; how a PNG predictor is undone (by `extractor/png-unfilter.ts#unfilterPngRows`, the one
 *  implementation, so the two readers cannot drift); and what an object stream holds, member by member, read
 *  lazily at the offset its pair gives.
 *  NOT here: where a stream IS (`xref.ts`, `parse.ts`), decryption (`extractor/pdf-decrypt.ts`), image data
 *  (`extractor/pdf-embedded-images.ts` keeps image bytes raw on purpose), the page tree.
 *  Called by: `xref.ts` (cross-reference streams), the document layer of the POC, and `streams.test.ts`. */

import { inflateSync } from "node:zlib";

import { unfilterPngRows } from "doc-ir/internal";
import { MAX_DECODED_STREAM_BYTES, MAX_FILTER_CHAIN, MAX_OBJECT_STREAM_MEMBERS } from "./bounds";
import type { PdfDict, PdfStream, PdfValue } from "./objects";
import { parseValue } from "./parse";
import { PdfObjectsRefusal } from "./refusal";

/** The one decoder the readers pass around, so a caller can hand its own (the shadow tool compares two). */
export type DecodeStream = (bytes: Uint8Array, stream: PdfStream) => Uint8Array;

const FLATE = "FlateDecode";
const LZW = "LZWDecode";

/** The buffer, grown (by doubling) to hold `needed` more bytes — or the output ceiling refused before a single
 *  byte is allocated. */
function grownTo(buffer: Uint8Array, length: number, needed: number): Uint8Array {
  if (length + needed > MAX_DECODED_STREAM_BYTES) throw new PdfObjectsRefusal("stream-decode");
  if (length + needed <= buffer.length) return buffer;
  let next = buffer.length;
  while (next < length + needed) next *= 2;
  const bigger = new Uint8Array(Math.min(next, MAX_DECODED_STREAM_BYTES));
  bigger.set(buffer.subarray(0, length));
  return bigger;
}

/** A growing byte buffer, and the one place the output ceiling bites.
 *  🔴 WHY NOT A `number[]` (review of 31/10/2026, measured): an array of numbers costs EIGHT heap bytes
 *  per decoded byte, so the 64 MB ceiling was paid with 610 MB of heap before refusing — on a Forge runtime
 *  at 512 MB, that is a memory crash and not the named refusal that the header promises. Here, one byte costs one
 *  byte, and the ceiling is checked BEFORE each growth. */
function byteSink(): {
  push(byte: number): void;
  pushAll(source: Uint8Array, from: number, count: number): void;
  size(): number;
  bytes(): Uint8Array;
} {
  let buffer: Uint8Array = new Uint8Array(1024);
  let length = 0;
  const room = (needed: number): void => {
    buffer = grownTo(buffer, length, needed);
  };
  return {
    push: (byte) => {
      room(1);
      buffer[length] = byte;
      length += 1;
    },
    pushAll: (source, from, count) => {
      room(count);
      buffer.set(source.subarray(from, from + count), length);
      length += count;
    },
    size: () => length,
    bytes: () => buffer.slice(0, length),
  };
}

/** §7.4.2: pairs of hexadecimal digits, white space ignored, `>` ends the data; an odd last digit is padded. */
function asciiHexDecode(raw: Uint8Array): Uint8Array {
  const out = byteSink();
  let half = -1;
  for (const byte of raw) {
    if (byte === 0x3e) break;
    if (isSpaceByte(byte)) continue;
    const digit = hexDigit(byte);
    if (digit < 0) throw new PdfObjectsRefusal("stream-decode");
    if (half < 0) half = digit;
    else {
      out.push(half * 16 + digit);
      half = -1;
    }
  }
  if (half >= 0) out.push(half * 16);
  return out.bytes();
}

/** §7.4.3: groups of five characters of base 85, `z` for four zero bytes, `~>` ends the data. */
/** §7.4.3: one group of five base-85 digits turned into four bytes — a short last group is padded with the
 *  highest digit and gives `count - 1` bytes. */
function ascii85Group(group: number[], count: number, out: ReturnType<typeof byteSink>): void {
  while (group.length < 5) group.push(84);
  let value = 0;
  for (const digit of group) value = value * 85 + digit;
  if (value > 0xffffffff) throw new PdfObjectsRefusal("stream-decode");
  const four = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  for (let i = 0; i < count - 1; i += 1) out.push(four[i] as number);
  group.length = 0;
}

/** §7.4.3: one byte of the data — `z` stands for four zero bytes, and a fifth digit closes the group. */
function ascii85Byte(byte: number, group: number[], out: ReturnType<typeof byteSink>): void {
  if (byte === 0x7a && group.length === 0) {
    for (let i = 0; i < 4; i += 1) out.push(0);
    return;
  }
  if (byte < 0x21 || byte > 0x75) throw new PdfObjectsRefusal("stream-decode");
  group.push(byte - 0x21);
  if (group.length === 5) ascii85Group(group, 5, out);
}

function ascii85Decode(raw: Uint8Array): Uint8Array {
  const out = byteSink();
  const group: number[] = [];

  for (const byte of raw) {
    if (isSpaceByte(byte)) continue;
    if (byte === 0x7e) break; // `~>`
    ascii85Byte(byte, group, out);
  }
  // A lone character cannot encode anything: a group is at least two (§7.4.3).
  if (group.length === 1) throw new PdfObjectsRefusal("stream-decode");
  if (group.length > 1) ascii85Group(group, group.length, out);
  return out.bytes();
}

/** §7.4.5: the literal bytes a length under 128 announces, copied as they are. */
function copyLiteral(raw: Uint8Array, from: number, count: number, out: ReturnType<typeof byteSink>): void {
  if (from + count > raw.length) throw new PdfObjectsRefusal("stream-decode");
  out.pushAll(raw, from, count);
}

/** §7.4.5: a length byte under 128 means that many literal bytes plus one, over 128 a repeat, 128 the end. */
function runLengthDecode(raw: Uint8Array): Uint8Array {
  const out = byteSink();
  let at = 0;
  while (at < raw.length) {
    const length = raw[at] as number;
    at += 1;
    if (length === 128) break;
    if (length < 128) {
      copyLiteral(raw, at, length + 1, out);
      at += length + 1;
      continue;
    }
    if (at >= raw.length) throw new PdfObjectsRefusal("stream-decode");
    const byte = raw[at] as number;
    at += 1;
    for (let i = 0; i < 257 - length; i += 1) out.push(byte);
  }
  return out.bytes();
}

/** §7.4.4.2: the entry one code stands for, the table grown by one when the code was already known. The code
 *  just past the table is the one the encoder emitted before we could learn it (`previous` plus its own first
 *  byte), the classic LZW special case; anything beyond that is not this stream. */
function lzwEntry(table: Uint8Array[], code: number, previous: Uint8Array | undefined): Uint8Array {
  // §7.4.4.2: the table holds 4 096 codes at most — and once it is full it STOPS GROWING instead of growing
  // for ever. Measured by the third review of 31/10/2026: a stream that never emits code 256 added one
  // entry per decoded code, that is tens of millions of objects before the output ceiling — a memory
  // crash where the refusal is promised. pdf.js stopped the same way.
  const full = table.length >= 4096;
  if (code < table.length) {
    const known = table[code] as Uint8Array;
    if (previous !== undefined && !full) table.push(Uint8Array.from([...previous, known[0] as number]));
    return known;
  }
  if (previous === undefined || code !== table.length) throw new PdfObjectsRefusal("stream-decode");
  const entry = Uint8Array.from([...previous, previous[0] as number]);
  if (!full) table.push(entry);
  return entry;
}

/** §7.4.4.3 `EarlyChange`: the code length grows one code BEFORE the table is full, unless the parameter is 0.
 *  Beyond twelve bits the width does NOT move any more, it does not refuse (review of 31/10/2026, measured with an
 *  encoder written separately): a conforming stream that uses the last twelve-bit code, 4095, is legitimate — a
 *  refusal there refused every LZW stream of about 8 KB and more. pdf.js capped it the same way. A code beyond
 *  the table is refused by `lzwEntry`, which is the place where it really shows. */
function lzwCodeBits(grown: number, codeBits: number): number {
  if (grown >= 4096) return 12;
  if (grown >= 2048 && codeBits === 11) return 12;
  if (grown >= 1024 && codeBits === 10) return 11;
  if (grown >= 512 && codeBits === 9) return 10;
  return codeBits;
}

/** §7.4.4.3: `EarlyChange` is 0 or 1, and NOTHING ELSE. It is added to the table size to decide the code width,
 *  so `-1000` would hold the width at nine bits for the whole stream and `1000` would jump it to twelve at once:
 *  in both cases the output text is silently WRONG, that is invented words (third review of
 *  31/10/2026). A refusal is better. */
function earlyChangeOf(parms: PdfDict | undefined): number {
  const value = integerEntry(parms ?? new Map(), "EarlyChange", 1, "predictor");
  if (value !== 0 && value !== 1) throw new PdfObjectsRefusal("stream-decode");
  return value;
}

/** §7.4.4.2: LZW with variable-length codes, 256 as clear-table and 257 as end-of-data. */
/** The first 258 entries of an LZW table: the 256 bytes, then the two reserved codes. They NEVER
 *  change, so they are built once and for all — a stream that only emits code 256 otherwise demanded
 *  258 allocations every nine bits, writing nothing to the output, so that the output ceiling could not
 *  bite (security review of 31/10/2026: a megabyte of 256 codes was worth 2.4 × 10⁸ allocations). */
const LZW_BASE: readonly Uint8Array[] = [
  ...Array.from({ length: 256 }, (_, i) => Uint8Array.of(i)),
  new Uint8Array(0),
  new Uint8Array(0),
];

function lzwDecode(raw: Uint8Array, earlyChange: number): Uint8Array {
  const out = byteSink();
  let table: Uint8Array[] = [];
  const reset = (): void => {
    // A `slice` of an array of 258 references, not 258 new typed arrays.
    table = LZW_BASE.slice();
  };
  reset();

  let codeBits = 9;
  let previous: Uint8Array | undefined;
  let bits = 0;
  let value = 0;

  for (let at = 0; at <= raw.length; at += 1) {
    if (at < raw.length) {
      value = ((value << 8) | (raw[at] as number)) >>> 0;
      bits += 8;
    } else if (bits < codeBits) break;

    while (bits >= codeBits) {
      const code = (value >>> (bits - codeBits)) & ((1 << codeBits) - 1);
      bits -= codeBits;
      if (code === 257) return out.bytes();
      if (code === 256) {
        reset();
        codeBits = 9;
        previous = undefined;
        continue;
      }
      const entry = lzwEntry(table, code, previous);
      out.pushAll(entry, 0, entry.length);
      previous = entry;
      codeBits = lzwCodeBits(table.length + earlyChange, codeBits);
    }
  }
  return out.bytes();
}

const isSpaceByte = (byte: number): boolean =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;

const hexDigit = (byte: number): number => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
};

/** §7.3.8.2 Table 5: `Filter` is a name or an array of names. A reference is not resolved here. */
function filtersOf(dict: PdfDict): readonly string[] {
  const filter: PdfValue | undefined = dict.get("Filter");
  if (filter === undefined) return [];
  if (filter.kind === "name") return [filter.value];
  if (filter.kind === "array") {
    return filter.items.map((item) => {
      if (item.kind !== "name") throw new PdfObjectsRefusal("filter-unsupported");
      return item.value;
    });
  }
  throw new PdfObjectsRefusal("filter-unsupported");
}

/** An integer entry of a dictionary, or its default; a non-integer (a reference included) is refused. */
function integerEntry(dict: PdfDict, key: string, fallback: number, reason: "predictor" | "object-stream"): number {
  const value: PdfValue | undefined = dict.get(key);
  if (value === undefined) return fallback;
  if (value.kind !== "number" || !Number.isInteger(value.value)) throw new PdfObjectsRefusal(reason);
  return value.value;
}

/** §7.4 Table 5: the parameters of ONE filter of the chain. A dictionary is for a single filter; an array is
 *  parallel to `/Filter`, and a `null` in it means « no parameter ». A dictionary given with SEVERAL filters is
 *  what real writers emit for the one filter that can use a predictor, and that is where it is applied. */
function parmsAt(dict: PdfDict, index: number, filters: readonly string[], predicted: number): PdfDict | undefined {
  const parms: PdfValue | undefined = dict.get("DecodeParms") ?? dict.get("DP");
  if (parms === undefined || parms.kind === "null") return undefined;
  if (parms.kind === "dict") {
    if (filters.length === 1) return parms.entries;
    return index === predicted ? parms.entries : undefined;
  }
  if (parms.kind !== "array") throw new PdfObjectsRefusal("predictor");
  const item = parms.items[index];
  if (item === undefined || item.kind === "null") return undefined;
  if (item.kind !== "dict") throw new PdfObjectsRefusal("predictor");
  return item.entries;
}

/** §7.4.4.4: the predictor and its shape, or `undefined` when there is none to undo. */
function predictorOf(parms: PdfDict | undefined): { predictor: number; columns: number; colors: number } | undefined {
  if (parms === undefined) return undefined;
  const predictor = integerEntry(parms, "Predictor", 1, "predictor");
  if (predictor === 1) return undefined;
  // 2 is the TIFF predictor: not implemented, and a silent pass-through would corrupt every row.
  if (predictor < 10 || predictor > 15) throw new PdfObjectsRefusal("predictor");
  if (integerEntry(parms, "BitsPerComponent", 8, "predictor") !== 8) throw new PdfObjectsRefusal("predictor");
  const columns = integerEntry(parms, "Columns", 1, "predictor");
  const colors = integerEntry(parms, "Colors", 1, "predictor");
  if (columns < 1 || colors < 1) throw new PdfObjectsRefusal("predictor");
  return { predictor, columns, colors };
}

/** 🔴 THE CHUNK MUST BE LARGER THAN DEFLATE'S WINDOW (03/11/2026), and this is not a tuning knob.
 *  `inflateSync(raw)` and `inflateSync(raw, {…})` do not take the same path in Node: as soon as an options object is
 *  passed — and `maxOutputLength` forces us to pass one — the decoding runs by chunks of `chunkSize`, 16 KB by
 *  default. A back reference of the stream that points further than the current chunk then comes back « invalid
 *  distance too far back ». DEFLATE's window is 32 KB (RFC 1951): a chunk smaller than the window cannot carry it.
 *  Two populations measured on the two form streams of `fixtures/pdf/53-Arrete-Travaux-Eau-iTextSharp.pdf`
 *  (5 594 and 5 021 compressed bytes, 65 576 and 57 413 decoded): 16 KB and 32 KB FAIL, 64 KB, 128 KB, 256 KB and
 *  1 MB PASS. Hence the first power of two above the window.
 *  `maxOutputLength` STAYS, and for memory rather than for the refusal: our own buffer (`grownTo`) refuses an
 *  oversized Flate on its own — measured, the guard of `streams.inflate.test.ts` is green without the option — but
 *  without it zlib allocates the whole output BEFORE our buffer sees a byte, on a runtime that has 512 MB. */
const INFLATE_CHUNK_BYTES = 64 * 1024;

function inflate(raw: Uint8Array): Uint8Array {
  try {
    return inflateSync(raw, { maxOutputLength: MAX_DECODED_STREAM_BYTES, chunkSize: INFLATE_CHUNK_BYTES });
  } catch {
    // A zlib failure is a refusal, never a crash: truncated data, a wrong header, or the ceiling reached.
    throw new PdfObjectsRefusal("stream-decode");
  }
}

/** §7.4.4.4: the row filters undone, by the ONE implementation (`extractor/png-unfilter.ts`). */
function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const shape = predictorOf(parms);
  if (shape === undefined) return data;
  const stride = shape.columns * shape.colors;
  const rows = data.length / (stride + 1);
  if (!Number.isInteger(rows)) throw new PdfObjectsRefusal("predictor");
  const unfiltered = unfilterPngRows(data, shape.columns, rows, shape.colors);
  if (unfiltered === undefined) throw new PdfObjectsRefusal("predictor");
  return unfiltered;
}

/** §7.4: the filters whose output is PIXELS, with their abbreviations of Table 6 (`CCF`, `DCT`). None of them is ever
 *  applied here — the image decoders read those bytes themselves — but a chain may END with one, and then the filters
 *  BEFORE it are ours to undo (`decodeToImageFilter`). */
export const IMAGE_FILTERS: ReadonlySet<string> = new Set([
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "JBIG2Decode",
  "CCITTFaxDecode",
  "CCF",
]);

/** One filter of §7.4, with its own parameters. The abbreviations of Table 6 (`Fl`, `LZW`, `AHx`, `A85`, `RL`)
 *  belong to inline images; serving them here costs nothing. An IMAGE filter (`DCTDecode`, `JPXDecode`,
 *  `JBIG2Decode`, `CCITTFaxDecode`) is deliberately ABSENT from this table: those bytes are pixels, and the image
 *  path keeps them raw on purpose (`extractor/pdf-embedded-images.ts`). */
const FILTERS: Readonly<Record<string, (data: Uint8Array, parms: PdfDict | undefined) => Uint8Array>> = {
  [FLATE]: (data, parms) => unpredict(inflate(data), parms),
  Fl: (data, parms) => unpredict(inflate(data), parms),
  [LZW]: (data, parms) => unpredict(lzwDecode(data, earlyChangeOf(parms)), parms),
  ASCIIHexDecode: (data) => asciiHexDecode(data),
  AHx: (data) => asciiHexDecode(data),
  ASCII85Decode: (data) => ascii85Decode(data),
  A85: (data) => ascii85Decode(data),
  RunLengthDecode: (data) => runLengthDecode(data),
  RL: (data) => runLengthDecode(data),
};

/** The decoded bytes of one stream, the whole chain applied in order (§7.4: the first filter named is the first
 *  applied). */
export const decodeStream: DecodeStream = (bytes, stream) => {
  const filters = filtersOf(stream.dict);
  // 🔴 THE CHAIN IS BOUNDED (security review of 31/10/2026). A `/Filter` of a hundred thousand names fits in half a
  // megabyte, and `parmsAt` redid a `findIndex` there AT EACH filter: the cost was quadratic, and each
  // filter allocated its buffer. No honest file chains more than two filters (`[/A85 /Fl]`).
  if (filters.length > MAX_FILTER_CHAIN) throw new PdfObjectsRefusal("filter-unsupported");
  // Taken out of the loop for the same reason: it does not depend on the current filter.
  const predicted = filters.findIndex((filter) => filter === FLATE || filter === LZW);
  let data = bytes.subarray(stream.start, stream.start + stream.length);

  for (const [index, filter] of filters.entries()) {
    // `Object.hasOwn`, never a bare lookup: the name comes from the FILE, and `/Filter /toString` would otherwise
    // find a function on `Object.prototype` and return a string where bytes are promised (review of 31/10/2026).
    const decode = Object.hasOwn(FILTERS, filter) ? FILTERS[filter] : undefined;
    if (decode === undefined) throw new PdfObjectsRefusal("filter-unsupported");
    data = decode(data, parmsAt(stream.dict, index, filters, predicted));
    if (data.length > MAX_DECODED_STREAM_BYTES) throw new PdfObjectsRefusal("stream-decode");
  }
  return data;
};

/** §7.4, NAMES ONLY: why `decodeToImageFilter` would refuse this picture's chain, or `undefined` when it would not.
 *  Read without touching a byte, so a CAUSE can be named for a picture nobody decoded (`extractor/pdf-image-refusal.ts`).
 *  🔴 IT MUST AGREE WITH `decodeToImageFilter`, and a test holds the two against each other, dictionary by dictionary
 *  (`streams.chain.test.ts`): same bound, same table, same « an image filter is the last or there is none ». What it
 *  cannot see is a refusal only the BYTES give — a truncated stream, the decoded ceiling — and those are not its job. */
export const chainRefusal = (dict: PdfDict): "filters" | undefined => {
  let filters: readonly string[];
  try {
    filters = filtersOf(dict);
  } catch {
    // `/Filter` holds something that is not a name: `decodeToImageFilter` refuses it the same way.
    return "filters";
  }
  if (filters.length > MAX_FILTER_CHAIN) return "filters";
  for (const [index, filter] of filters.entries()) {
    if (IMAGE_FILTERS.has(filter)) {
      if (index !== filters.length - 1) return "filters";
      continue;
    }
    if (!Object.hasOwn(FILTERS, filter)) return "filters";
  }
  return undefined;
};

/** A PICTURE's bytes with the non-image filters of its chain undone, and the image filter that is LEFT for the image
 *  decoders — `undefined` when the chain holds none, and the bytes are then the samples themselves.
 *  🔴 WHY IT EXISTS (03/11/2026). A producer may compress a JPEG a second time: `/Filter [/FlateDecode /DCTDecode]`,
 *  measured on `fixtures/pdf/46-GrandSoissons-CRACL-2021-page-sans-texte.pdf`, page 12, picture `X0`. **A POPULATION OF
 *  ONE, written as such**: that one picture out of the 57 fixtures, and ZERO over 93 documents of the corpus. What pays
 *  for the rule is not its frequency — it is that the page gained a picture it did not have, in its original JPEG
 *  (172 692 bytes instead of a 1 022 868-byte PNG re-encode), and that §7.4 says plainly whose job those filters are.
 *  NOBODY read such
 *  a picture: `decodeStream` refuses the chain, since an image filter is deliberately not one of its stream filters,
 *  and each image decoder asks `singleFilterOf`, which answers `undefined` for a chain of two — so the JPEG decoder
 *  did not recognise it either, and the page published one picture less, counted "unreadable".
 *  REFUSED, and written: an image filter that is NOT the last of the chain (nothing is applied to pixels), and a second
 *  image filter. The chain's bound and the decoded ceiling are `decodeStream`'s own.
 *  `data` is given decrypted (`rawStreamBytes`), because decryption comes before any filter (§7.6.2). */
export const decodeToImageFilter = (
  data: Uint8Array,
  dict: PdfDict,
): { readonly imageFilter: string | undefined; readonly data: Uint8Array } => {
  const filters = filtersOf(dict);
  if (filters.length > MAX_FILTER_CHAIN) throw new PdfObjectsRefusal("filter-unsupported");
  const predicted = filters.findIndex((filter) => filter === FLATE || filter === LZW);
  let out = data;
  for (const [index, filter] of filters.entries()) {
    if (IMAGE_FILTERS.has(filter)) {
      if (index !== filters.length - 1) throw new PdfObjectsRefusal("filter-unsupported");
      return { imageFilter: filter, data: out };
    }
    const decode = Object.hasOwn(FILTERS, filter) ? FILTERS[filter] : undefined;
    if (decode === undefined) throw new PdfObjectsRefusal("filter-unsupported");
    out = decode(out, parmsAt(dict, index, filters, predicted));
    if (out.length > MAX_DECODED_STREAM_BYTES) throw new PdfObjectsRefusal("stream-decode");
  }
  return { imageFilter: undefined, data: out };
};

/** The members of one object stream (§7.5.7), read on demand. */
export interface ObjectStreamMembers {
  /** The object numbers it holds, in the order its pairs give them. */
  readonly numbers: readonly number[];
  /** The member's value AND the number of nodes reading it makes us retain, or `undefined` when this stream does
   *  not hold that object.
   *  🔴 THE NODE COUNT COMES THROUGH (security review of 31/10/2026): it was thrown away here, so the compressed path
   *  — the cheapest to build for a hostile input — only paid its source bytes to the document budget.
   *  A member of a few compressed kilobytes can retain a million nodes. */
  valueOf(num: number): { readonly value: PdfValue; readonly nodes: number } | undefined;
  /** How many bytes of the decompressed stream this member occupies, so that the caller can COUNT them: each
   *  read of a member is work, and a stream may name the same member thousands of times (`high`
   *  review of 31/10/2026). 0 when this stream does not carry that object. */
  extentOf(num: number): number;
}

/** An unsigned integer at `from` in the decoded data, for the pairs of §7.5.7. */
function integerAt(data: Uint8Array, from: number): { value: number; end: number } {
  let parsed;
  try {
    parsed = parseValue(data, from);
  } catch {
    throw new PdfObjectsRefusal("object-stream");
  }
  if (parsed.value.kind !== "number" || !Number.isInteger(parsed.value.value) || parsed.value.value < 0) {
    throw new PdfObjectsRefusal("object-stream");
  }
  return { value: parsed.value.value, end: parsed.end };
}

/** §7.5.7: `N` pairs of `objectNumber offset`, then the members themselves from `First`. */
export function readObjectStream(bytes: Uint8Array, stream: PdfStream, decode: DecodeStream): ObjectStreamMembers {
  const count = integerEntry(stream.dict, "N", -1, "object-stream");
  const first = integerEntry(stream.dict, "First", -1, "object-stream");
  if (count < 0 || first < 0 || count > MAX_OBJECT_STREAM_MEMBERS) throw new PdfObjectsRefusal("object-stream");

  const data = decode(bytes, stream);
  // Each pair needs at least two bytes: a count beyond that cannot be honest, whatever the dictionary claims.
  if (count > data.length / 2 || first > data.length) throw new PdfObjectsRefusal("object-stream");

  const numbers: number[] = [];
  const offsets = new Map<number, number>();
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at >= first) throw new PdfObjectsRefusal("object-stream");
    const num = integerAt(data, at);
    const offset = integerAt(data, num.end);
    const start = first + offset.value;
    if (start >= data.length) throw new PdfObjectsRefusal("object-stream");
    if (!offsets.has(num.value)) {
      offsets.set(num.value, start);
      numbers.push(num.value);
    }
    at = offset.end;
  }

  const sorted = [...offsets.values()].sort((a, b) => a - b);

  return {
    numbers,
    extentOf: (num) => {
      const start = offsets.get(num);
      if (start === undefined) return 0;
      // Up to the next member, or to the end of the decompressed data. The offsets are SORTED ONCE:
      // sorting them again at each call cost N log N per object read, that is fifty thousand sorts of 65 536 elements
      // for a 200 KB file (`medium` review of 31/10/2026).
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((sorted[middle] as number) > start) high = middle;
        else low = middle + 1;
      }
      return (sorted[low] ?? data.length) - start;
    },
    valueOf: (num) => {
      const start = offsets.get(num);
      if (start === undefined) return undefined;
      try {
        const parsed = parseValue(data, start);
        return { value: parsed.value, nodes: parsed.nodes };
      } catch {
        throw new PdfObjectsRefusal("object-stream", num);
      }
    },
  };
}
