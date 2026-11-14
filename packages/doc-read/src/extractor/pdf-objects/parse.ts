/** The PDF object lexer and parser: bytes to `PdfValue` (ISO 32000-1 §7.2 lexical conventions, §7.3 objects).
 *  Decides: what a token is and where it ends; a reference (`N G R`) against two plain numbers; where a stream's data
 *  starts and how long it is (`Length` alone decides, §7.3.8.2); every refusal, as a `PdfObjectsRefusal` with a closed
 *  reason. Containers are read with an explicit stack, so depth is a counter checked before each descent, never recursion.
 *  Every scan moves forward only and is bounded by `bounds.ts`.
 *  NOT here: stream decoding, cross-reference tables, object streams, encryption, the content-stream operators (curly
 *  braces and bare operators are refused as syntax), and any repair of a damaged file.
 *  Called by: the later slices of the object reader and `parse.test.ts`. */

import { MAX_NAME_BYTES, MAX_NESTING_DEPTH, MAX_STRING_BYTES, MAX_TOKEN_BYTES, MAX_VALUE_NODES } from "./bounds";
import type { PdfDict, PdfRef, PdfValue } from "./objects";
import { PdfObjectsRefusal } from "./refusal";

/** Resolves the object number of an indirect `/Length` to its integer value; `undefined` when it cannot. */
export type ResolveLength = (ref: PdfRef) => number | undefined;

export interface ParsedValue {
  readonly value: PdfValue;
  /** Offset just past the value. */
  readonly end: number;
  /** How many NODES this value holds (numbers, names, strings, elements, entries). The caller needs it
   *  to bound its own heap: a nested array counts as ONE operand for it, and as its thousands of
   *  nodes here (`medium` review of 31/10/2026). */
  readonly nodes: number;
}

export interface ParsedObject {
  readonly num: number;
  readonly gen: number;
  readonly value: PdfValue;
  /** Offset just past `endobj`. */
  readonly end: number;
  /** How many nodes the object holds (see `ParsedValue`). */
  readonly nodes: number;
}

/** Annex C Table C.1: largest object number and generation number. */
const MAX_OBJECT_NUMBER = 8_388_607;
const MAX_GENERATION = 65_535;

const EOF = -1;
const NUL = 0x00;
const HT = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SP = 0x20;
const PERCENT = 0x25;
const LPAREN = 0x28;
const RPAREN = 0x29;
const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const SOLIDUS = 0x2f;
const LT = 0x3c;
const GT = 0x3e;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const HASH = 0x23;

const UNSIGNED_INTEGER = /^\d+$/;
const NUMERIC_CHARS = /^[+\-.\d]+$/;

/** Result of reading one item: the value, or `undefined` for an opener that only pushes a frame; and where to go on. */
interface Step {
  readonly value: PdfValue | undefined;
  readonly end: number;
}

type Frame = { readonly kind: "array"; readonly items: PdfValue[] } | { readonly kind: "dict"; readonly entries: Map<string, PdfValue>; key: string | undefined };

const refuse = (reason: ConstructorParameters<typeof PdfObjectsRefusal>[0]): never => {
  throw new PdfObjectsRefusal(reason);
};

const at = (bytes: Uint8Array, pos: number): number => (pos < bytes.length ? (bytes[pos] ?? EOF) : EOF);

/** Table 1 of §7.2.2. */
const isWhite = (c: number): boolean => c === NUL || c === HT || c === LF || c === FF || c === CR || c === SP;

/** §7.2.2 delimiters. */
const isDelimiter = (c: number): boolean =>
  c === LPAREN || c === RPAREN || c === LT || c === GT || c === LBRACKET || c === RBRACKET || c === LBRACE || c === RBRACE || c === SOLIDUS || c === PERCENT;

const isRegular = (c: number): boolean => c !== EOF && !isWhite(c) && !isDelimiter(c);

const hexValue = (c: number): number => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
};

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(at(bytes, i));
  return out;
};

/** §7.2.2 white space and §7.2.3 comments (a comment runs to CR or LF). */
function skipSeparators(bytes: Uint8Array, from: number): number {
  let pos = from;
  for (;;) {
    const c = at(bytes, pos);
    if (isWhite(c)) pos += 1;
    else if (c === PERCENT) {
      pos += 1;
      while (at(bytes, pos) !== EOF && at(bytes, pos) !== LF && at(bytes, pos) !== CR) pos += 1;
    } else return pos;
  }
}

/** End of the run of regular characters starting at `from`; a run past `limit` bytes is refused without being scanned further. */
function regularRunEnd(bytes: Uint8Array, from: number, limit: number): number {
  let end = from;
  while (isRegular(at(bytes, end))) {
    end += 1;
    if (end - from > limit) return refuse("token-too-long");
  }
  return end;
}

/** The token at the next non-separator position, for a lookahead: `undefined` when there is none or it is longer than a token may be. */
function peekToken(bytes: Uint8Array, from: number): { readonly text: string; readonly end: number } | undefined {
  const start = skipSeparators(bytes, from);
  if (!isRegular(at(bytes, start))) return undefined;
  let end = start;
  while (isRegular(at(bytes, end))) {
    end += 1;
    if (end - start > MAX_TOKEN_BYTES) return undefined;
  }
  return { text: latin1(bytes, start, end), end };
}

/** The keyword or number at the next non-separator position; refused when absent, not regular, or too long. */
function readWord(bytes: Uint8Array, from: number): { readonly text: string; readonly end: number } {
  const start = skipSeparators(bytes, from);
  const c = at(bytes, start);
  if (c === EOF) return refuse("truncated");
  if (!isRegular(c)) return refuse("syntax");
  const end = regularRunEnd(bytes, start, MAX_TOKEN_BYTES);
  return { text: latin1(bytes, start, end), end };
}

function pushByte(out: number[], byte: number): void {
  if (out.length >= MAX_STRING_BYTES) refuse("string-too-long");
  out.push(byte);
}

/** Table 3 of §7.3.4.2: the byte of `\n`, `\r`, `\t`, `\b`, `\f`; any other escaped character stands for itself. */
function simpleEscape(c: number): number {
  switch (c) {
    case 0x6e:
      return LF;
    case 0x72:
      return CR;
    case 0x74:
      return HT;
    case 0x62:
      return 0x08;
    case 0x66:
      return FF;
    default:
      return c;
  }
}

/** One escape of a literal string, `from` being the character after the backslash; returns where to go on. */
function readEscape(bytes: Uint8Array, from: number, out: number[]): number {
  const c = at(bytes, from);
  if (c === EOF) return refuse("truncated");
  if (c === CR) return at(bytes, from + 1) === LF ? from + 2 : from + 1;
  if (c === LF) return from + 1;
  if (c >= 0x30 && c <= 0x37) {
    let pos = from;
    let value = 0;
    while (pos - from < 3 && at(bytes, pos) >= 0x30 && at(bytes, pos) <= 0x37) {
      value = value * 8 + at(bytes, pos) - 0x30;
      pos += 1;
    }
    pushByte(out, value & 0xff);
    return pos;
  }
  pushByte(out, simpleEscape(c));
  return from + 1;
}

function parenthesisDelta(c: number): number {
  if (c === LPAREN) return 1;
  return c === RPAREN ? -1 : 0;
}

/** §7.3.4.2; `from` is at the opening parenthesis. Balanced parentheses nest; a bare CR or CRLF reads as LF. */
function readLiteralString(bytes: Uint8Array, from: number): Step {
  const out: number[] = [];
  let depth = 1;
  let pos = from + 1;
  while (depth > 0) {
    const c = at(bytes, pos);
    if (c === EOF) return refuse("truncated");
    pos += 1;
    if (c === BACKSLASH) pos = readEscape(bytes, pos, out);
    else if (c === CR) {
      if (at(bytes, pos) === LF) pos += 1;
      pushByte(out, LF);
    } else {
      depth += parenthesisDelta(c);
      if (depth > 0) pushByte(out, c);
    }
  }
  return { value: { kind: "string", bytes: Uint8Array.from(out) }, end: pos };
}

/** §7.3.4.3; `from` is at the `<`. */
function readHexString(bytes: Uint8Array, from: number): Step {
  const out: number[] = [];
  let pos = from + 1;
  let high = -1;
  for (;;) {
    const c = at(bytes, pos);
    if (c === EOF) return refuse("truncated");
    pos += 1;
    if (c === GT) break;
    if (isWhite(c)) continue;
    const digit = hexValue(c);
    if (digit < 0) return refuse("syntax");
    if (high < 0) high = digit;
    else {
      pushByte(out, high * 16 + digit);
      high = -1;
    }
  }
  if (high >= 0) pushByte(out, high * 16);
  return { value: { kind: "string", bytes: Uint8Array.from(out) }, end: pos };
}

/** §7.3.5; `from` is at the solidus. The cap counts bytes after `#xx` expansion. */
function readName(bytes: Uint8Array, from: number): { readonly name: string; readonly end: number } {
  let pos = from + 1;
  let count = 0;
  let name = "";
  while (isRegular(at(bytes, pos))) {
    let c = at(bytes, pos);
    pos += 1;
    if (c === HASH) {
      const high = hexValue(at(bytes, pos));
      const low = hexValue(at(bytes, pos + 1));
      c = high * 16 + low;
      if (high < 0 || low < 0 || c === 0) return refuse("syntax");
      pos += 2;
    }
    count += 1;
    if (count > MAX_NAME_BYTES) return refuse("token-too-long");
    name += String.fromCharCode(c);
  }
  return { name, end: pos };
}

/** §7.3.10: `N G R` after an unsigned integer `N` already read. Once a third token starts with `R` the text is committed to being a
 *  reference, and anything that makes it an invalid one is refused. */
function readReferenceAfter(bytes: Uint8Array, firstText: string, firstEnd: number): Step | undefined {
  const second = peekToken(bytes, firstEnd);
  if (second === undefined || !NUMERIC_CHARS.test(second.text)) return undefined;
  const third = peekToken(bytes, second.end);
  if (third === undefined || !third.text.startsWith("R")) return undefined;
  if (third.text !== "R" || !UNSIGNED_INTEGER.test(second.text)) return refuse("syntax");
  const num = Number(firstText);
  const gen = Number(second.text);
  if (num < 1 || num > MAX_OBJECT_NUMBER || gen > MAX_GENERATION) return refuse("syntax");
  return { value: { kind: "ref", num, gen }, end: third.end };
}

/** §7.3.3: optional sign, then digits with at most one point, at least one digit. No exponent, no radix (NOTE 1). */
function isNumberSyntax(text: string): boolean {
  let digits = 0;
  let points = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) digits += 1;
    else if (c === DOT) points += 1;
    else if (i !== 0 || (c !== PLUS && c !== MINUS)) return false;
  }
  return digits > 0 && points <= 1;
}

/** §7.3.3 number, or §7.3.10 reference when it is an unsigned integer followed by `G R`. */
function readNumber(bytes: Uint8Array, from: number, references: boolean): Step {
  const end = regularRunEnd(bytes, from, MAX_TOKEN_BYTES);
  const text = latin1(bytes, from, end);
  if (!isNumberSyntax(text)) return refuse("syntax");
  const reference = references && UNSIGNED_INTEGER.test(text) ? readReferenceAfter(bytes, text, end) : undefined;
  return reference ?? { value: { kind: "number", value: Number(text) }, end };
}

/** §7.3.2 and §7.3.9: the only bare words a value may be. */
function readKeywordValue(bytes: Uint8Array, from: number): Step {
  const end = regularRunEnd(bytes, from, MAX_TOKEN_BYTES);
  switch (latin1(bytes, from, end)) {
    case "true":
      return { value: { kind: "bool", value: true }, end };
    case "false":
      return { value: { kind: "bool", value: false }, end };
    case "null":
      return { value: { kind: "null" }, end };
    default:
      return refuse("syntax");
  }
}

const isNumberStart = (c: number): boolean => (c >= 0x30 && c <= 0x39) || c === PLUS || c === MINUS || c === DOT;

/** A value that is not a container opener or closer. */
function readScalar(bytes: Uint8Array, pos: number, c: number, references: boolean): Step {
  if (c === LPAREN) return readLiteralString(bytes, pos);
  if (c === LT) return readHexString(bytes, pos);
  if (c === SOLIDUS) {
    const { name, end } = readName(bytes, pos);
    return { value: { kind: "name", value: name }, end };
  }
  if (isNumberStart(c)) return readNumber(bytes, pos, references);
  if (isRegular(c)) return readKeywordValue(bytes, pos);
  return refuse("syntax");
}

function openFrame(stack: Frame[], frame: Frame, end: number): Step {
  if (stack.length >= MAX_NESTING_DEPTH) return refuse("nesting-too-deep");
  stack.push(frame);
  return { value: undefined, end };
}

/** The next item where a dictionary expects a KEY: a name, or the closing `>>`. */
function stepKey(bytes: Uint8Array, pos: number, c: number, top: Extract<Frame, { kind: "dict" }>, stack: Frame[]): Step {
  if (c === SOLIDUS) {
    const { name, end } = readName(bytes, pos);
    top.key = name;
    return { value: undefined, end };
  }
  if (c === GT && at(bytes, pos + 1) === GT) {
    stack.pop();
    return { value: { kind: "dict", entries: top.entries }, end: pos + 2 };
  }
  return refuse("syntax");
}

/** The next item where a VALUE is expected (in an array, a dictionary after its key, or at the top). */
function stepValue(bytes: Uint8Array, pos: number, c: number, stack: Frame[], references: boolean): Step {
  if (c === LBRACKET) return openFrame(stack, { kind: "array", items: [] }, pos + 1);
  if (c === LT && at(bytes, pos + 1) === LT) return openFrame(stack, { kind: "dict", entries: new Map(), key: undefined }, pos + 2);
  if (c === RBRACKET) {
    const top = stack.at(-1);
    if (top?.kind !== "array") return refuse("syntax");
    stack.pop();
    return { value: { kind: "array", items: top.items }, end: pos + 1 };
  }
  return readScalar(bytes, pos, c, references);
}

/** Hands a finished value to the container being read; `false` when there is none (the value is the result). */
function attach(stack: Frame[], value: PdfValue): boolean {
  const top = stack.at(-1);
  if (top === undefined) return false;
  if (top.kind === "array") top.items.push(value);
  else {
    // §7.3.9: an entry whose value is null is as if absent. A repeated key keeps the last value, a last null included (it removes the entry).
    if (top.key !== undefined) {
      if (value.kind === "null") top.entries.delete(top.key);
      else top.entries.set(top.key, value);
    }
    top.key = undefined;
  }
  return true;
}

function checkOffset(bytes: Uint8Array, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0) refuse("syntax");
  if (offset > bytes.length) refuse("truncated");
}

function parseValueUnchecked(bytes: Uint8Array, start: number, references: boolean): ParsedValue {
  const stack: Frame[] = [];
  let pos = start;
  // 🔴 The NUMBER of nodes is bounded, not only the depth (security review of 31/10/2026): one turn of
  // this loop produces at most one value, so counting them bounds everything — array elements, dictionary
  // entries, strings. Without this count, `[1 1 1 …]` cost ~48 bytes of heap per number, and 64 KB compressed
  // made hundreds of megabytes of them.
  let nodes = 0;
  for (;;) {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) return refuse("value-too-large");
    pos = skipSeparators(bytes, pos);
    const c = at(bytes, pos);
    if (c === EOF) return refuse("truncated");
    const top = stack.at(-1);
    const step =
      top?.kind === "dict" && top.key === undefined ? stepKey(bytes, pos, c, top, stack) : stepValue(bytes, pos, c, stack, references);
    pos = step.end;
    if (step.value !== undefined && !attach(stack, step.value)) return { value: step.value, end: pos, nodes };
  }
}

/** Reads the value starting at `offset` (separators before it are skipped). */
export function parseValue(bytes: Uint8Array, offset: number): ParsedValue {
  checkOffset(bytes, offset);
  return parseValueUnchecked(bytes, offset, true);
}

/** The same value, read where §7.8.2 FORBIDS an indirect reference: inside a content stream. The rule `N G R`
 *  must be off there, and this is not a nicety — `1 1 1 RG` (a colour operator) is three numbers followed by a
 *  word starting with `R`, which the reference rule commits to and then refuses. Measured on 31/10/2026: with the
 *  rule on, 16 of our 56 real PDFs refuse their first page for this reason alone. A rule is only as safe as what
 *  its CALLER guarantees (the probation rule paid on « Total -12,00 »): here the caller guarantees no reference. */
export function parseContentValue(bytes: Uint8Array, offset: number): ParsedValue {
  checkOffset(bytes, offset);
  return parseValueUnchecked(bytes, offset, false);
}

interface ObjectHeader {
  readonly num: number;
  readonly gen: number;
  readonly end: number;
}

function readHeader(bytes: Uint8Array, offset: number): ObjectHeader {
  const numWord = readWord(bytes, offset);
  const genWord = readWord(bytes, numWord.end);
  const objWord = readWord(bytes, genWord.end);
  if (!UNSIGNED_INTEGER.test(numWord.text) || !UNSIGNED_INTEGER.test(genWord.text) || objWord.text !== "obj") return refuse("syntax");
  const num = Number(numWord.text);
  const gen = Number(genWord.text);
  if (num < 1 || num > MAX_OBJECT_NUMBER || gen > MAX_GENERATION) return refuse("syntax");
  return { num, gen, end: objWord.end };
}

/** Table 5 and §7.3.8.2: the integer `/Length`, direct or through the callback; never larger than the bytes left. */
function streamLength(dict: PdfDict, resolve: ResolveLength, available: number): number {
  const declared = dict.get("Length");
  let length: number | undefined;
  if (declared?.kind === "number") length = declared.value;
  else if (declared?.kind === "ref") {
    length = resolve(declared);
    if (length === undefined) return refuse("length-unresolved");
  }
  if (length === undefined || !Number.isInteger(length) || length < 0 || length > available) return refuse("stream-length");
  return length;
}

/** §7.3.8.1: the keyword `stream` is followed by CR LF or LF, never CR alone. Returns the first data byte. */
function streamStart(bytes: Uint8Array, afterKeyword: number): number {
  const c = at(bytes, afterKeyword);
  if (c === EOF) return refuse("truncated");
  if (c === LF) return afterKeyword + 1;
  if (c === CR && at(bytes, afterKeyword + 1) === LF) return afterKeyword + 2;
  return refuse("syntax");
}

const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];

/** Offset just past `endstream`, found right after the data and at most one end-of-line marker; otherwise `stream-end`. */
function endstreamEnd(bytes: Uint8Array, dataEnd: number): number {
  let pos = dataEnd;
  if (at(bytes, pos) === CR) pos += 1;
  if (at(bytes, pos) === LF) pos += 1;
  for (let i = 0; i < ENDSTREAM.length; i += 1) {
    if (at(bytes, pos + i) !== ENDSTREAM[i]) return refuse("stream-end");
  }
  const end = pos + ENDSTREAM.length;
  return isRegular(at(bytes, end)) ? refuse("stream-end") : end;
}

function expectEndobj(bytes: Uint8Array, from: number): number {
  const word = readWord(bytes, from);
  return word.text === "endobj" ? word.end : refuse("syntax");
}

function readObjectBody(bytes: Uint8Array, header: ObjectHeader, resolve: ResolveLength): ParsedObject {
  const parsed = parseValueUnchecked(bytes, header.end, true);
  const word = readWord(bytes, parsed.end);
  const { num, gen } = header;
  if (word.text === "endobj") return { num, gen, value: parsed.value, end: word.end, nodes: parsed.nodes };
  if (word.text !== "stream" || parsed.value.kind !== "dict") return refuse("syntax");
  const start = streamStart(bytes, word.end);
  const length = streamLength(parsed.value.entries, resolve, bytes.length - start);
  const end = expectEndobj(bytes, endstreamEnd(bytes, start + length));
  return { num, gen, value: { kind: "stream", dict: parsed.value.entries, start, length }, end, nodes: parsed.nodes };
}

/** Reads `N G obj <value> endobj` (or a stream) at `offset`. A refusal raised while reading the body carries the object number;
 *  a refusal raised by `resolveLength` passes through unchanged. */
export function parseIndirectObject(bytes: Uint8Array, offset: number, resolveLength: ResolveLength): ParsedObject {
  checkOffset(bytes, offset);
  let fromCallback: unknown;
  const guarded: ResolveLength = (ref) => {
    try {
      return resolveLength(ref);
    } catch (error) {
      fromCallback = error;
      throw error;
    }
  };
  let objectNumber: number | undefined;
  try {
    const header = readHeader(bytes, offset);
    objectNumber = header.num;
    return readObjectBody(bytes, header, guarded);
  } catch (error) {
    if (error instanceof PdfObjectsRefusal && error.objectNumber === undefined && error !== fromCallback && objectNumber !== undefined) {
      throw new PdfObjectsRefusal(error.reason, objectNumber);
    }
    throw error;
  }
}
