/**
 * Test models of PDF values and content streams, fast-check generators for them, and a WRITER that spells a model with
 * random but valid choices. Written from ISO 32000-1:2008, never from the reader: §7.2 lexical conventions, §7.3
 * objects, §7.8.2 content streams, §8.9.7 inline images.
 * Decides: the spellings the writer may pick (separators, comments, number forms, string escapes, `#xx` in names); the
 * value the reader must give back for a model (`expectedValue`); how many nodes it must count (`valueNodes`,
 * `contentNodes`, after the reader's own definition: one per item a read steps over, `parse.ts`, `content.ts`).
 * NOT here: the properties (`content.property.test.ts`, `parse.property.test.ts`), the damage of real streams.
 * Called by: the two property tests of this folder.
 */

import fc from "fast-check";

import type { PdfValue } from "./objects";

export type ValueModel =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly bytes: Uint8Array }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly ValueModel[] }
  | { readonly kind: "dict"; readonly entries: readonly (readonly [string, ValueModel])[] }
  | { readonly kind: "ref"; readonly num: number; readonly gen: number };

export type OpModel =
  | { readonly kind: "op"; readonly op: string; readonly operands: readonly ValueModel[] }
  | {
      readonly kind: "inline";
      readonly entries: readonly (readonly [string, ValueModel])[];
      readonly data: Uint8Array;
      /** Whether the dictionary declares `/L`, the data length (§8.9.7 Table 93 note, PDF 2.0 key read by the reader). */
      readonly declareLength: boolean;
    };

/** What the reader yields for one operator (`content.ts#ContentOp`). */
export interface ExpectedOp {
  readonly op: string;
  readonly operands: readonly PdfValue[];
}

/** The writer's random choices, read in turn from a fast-check array and read again from its start when it runs out:
 *  a red run replays from the seed, and the array shrinks like any other input. */
export class Choices {
  private next = 0;

  constructor(private readonly draws: readonly number[]) {}

  /** An integer in [0, n). */
  pick(n: number): number {
    const draw = this.draws.length === 0 ? 0 : (this.draws[this.next % this.draws.length] as number);
    this.next += 1;
    return draw % n;
  }

  /** True about `percent` times in a hundred. */
  chance(percent: number): boolean {
    return this.pick(100) < percent;
  }

  oneOf<T>(items: readonly T[]): T {
    return items[this.pick(items.length)] as T;
  }
}

/** The draws behind one `Choices`. */
export const drawsArb: fc.Arbitrary<number[]> = fc.array(fc.nat({ max: 0xffff }), { minLength: 1, maxLength: 256 });

// ---------------------------------------------------------------------------------------------------------------------
// Expected values and node counts.

/** §7.3.7: an entry whose value is null is as if absent; a repeated key keeps its last value (as `parse.ts` reads). */
function expectedDict(entries: readonly (readonly [string, ValueModel])[]): Map<string, PdfValue> {
  const map = new Map<string, PdfValue>();
  for (const [key, value] of entries) {
    if (value.kind === "null") map.delete(key);
    else map.set(key, expectedValue(value));
  }
  return map;
}

/** The value the reader must give back for a model. */
export function expectedValue(model: ValueModel): PdfValue {
  switch (model.kind) {
    case "array":
      return { kind: "array", items: model.items.map(expectedValue) };
    case "dict":
      return { kind: "dict", entries: expectedDict(model.entries) };
    case "string":
      return { kind: "string", bytes: model.bytes };
    default:
      return model;
  }
}

/** The nodes `parse.ts` counts for a value: one per item it steps over (a scalar, a reference, a key, an opening and a
 *  closing bracket). A null entry counts though it is dropped. */
export function valueNodes(model: ValueModel): number {
  switch (model.kind) {
    case "array":
      return 2 + model.items.reduce((sum, item) => sum + valueNodes(item), 0);
    case "dict":
      return 2 + model.entries.reduce((sum, [, value]) => sum + 1 + valueNodes(value), 0);
    default:
      return 1;
  }
}

/** A bare word at the top of a content stream (§7.8.2): read by the tokenizer itself, one node. */
const isBareWord = (model: ValueModel): boolean => model.kind === "bool" || model.kind === "null";

/** The inline image dictionary the reader must give: its entries in order, `/L` last when declared. */
function expectedInlineDict(op: Extract<OpModel, { kind: "inline" }>): Map<string, PdfValue> {
  const map = new Map<string, PdfValue>();
  for (const [key, value] of op.entries) map.set(key, expectedValue(value));
  if (op.declareLength) map.set("L", { kind: "number", value: inlineData(op).length });
  return map;
}

export function expectedOps(ops: readonly OpModel[]): ExpectedOp[] {
  return ops.map((op) =>
    op.kind === "op"
      ? { op: op.op, operands: op.operands.map(expectedValue) }
      : { op: "BI", operands: [{ kind: "dict", entries: expectedInlineDict(op) }] },
  );
}

/** The nodes `content.ts#tokenizeContent` counts: one per token of the stream, plus what each operand and each inline
 *  dictionary holds, plus one when blanks follow the last token (the loop takes one more turn to skip them). */
export function contentNodes(ops: readonly OpModel[], trailingBlank: boolean): number {
  let nodes = trailingBlank ? 1 : 0;
  for (const op of ops) {
    nodes += 1;
    if (op.kind === "op") {
      for (const operand of op.operands) nodes += isBareWord(operand) ? 1 : 1 + valueNodes(operand);
    } else {
      nodes += op.entries.reduce((sum, [, value]) => sum + 1 + valueNodes(value), 0);
      if (op.declareLength) nodes += 2;
    }
  }
  return nodes;
}

/** A reader value turned back into a model, for streams read from real files. */
export function modelOf(value: PdfValue): ValueModel {
  switch (value.kind) {
    case "array":
      return { kind: "array", items: value.items.map(modelOf) };
    case "dict":
      return { kind: "dict", entries: [...value.entries].map(([key, item]) => [key, modelOf(item)] as const) };
    case "stream":
      throw new Error("a stream is never an operand");
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The writer. A piece is one token; two pieces need a separator between them only when the first ends in a run of
// regular characters and the second starts with one (§7.2.2: a delimiter or white space ends a token).

interface Piece {
  readonly text: string;
  readonly startsRegular: boolean;
  readonly endsRegular: boolean;
}

const regularPiece = (text: string): Piece => ({ text, startsRegular: true, endsRegular: true });
const closedPiece = (text: string): Piece => ({ text, startsRegular: false, endsRegular: false });

/** §7.2.2 Table 1: the six white-space characters. */
const WHITE = ["\x00", "\t", "\n", "\x0c", "\r", " "];
const EOL = ["\n", "\r", "\r\n"];

/** §7.2.2 Table 2 delimiters, and the number sign that §7.3.5 makes special in a name. */
const DELIMITERS = new Set("()<>[]{}/%");
const isWhiteCode = (code: number): boolean => WHITE.includes(String.fromCharCode(code));
const isDelimiterCode = (code: number): boolean => DELIMITERS.has(String.fromCharCode(code));
export const isRegularCode = (code: number): boolean => !isWhiteCode(code) && !isDelimiterCode(code);

/** §7.2.3: a comment runs from `%` to the end of the line, and any byte but an end-of-line may sit in it. */
function comment(choices: Choices): string {
  let text = "%";
  const length = choices.pick(9);
  for (let i = 0; i < length; i += 1) {
    let code = choices.pick(256);
    if (code === 0x0a || code === 0x0d) code = 0x20;
    text += String.fromCharCode(code);
  }
  return text + choices.oneOf(EOL);
}

/** One or more white-space characters or comments (§7.2.2, §7.2.3). */
export function separator(choices: Choices): string {
  let text = "";
  const parts = 1 + choices.pick(3);
  for (let i = 0; i < parts; i += 1) text += choices.chance(25) ? comment(choices) : choices.oneOf(WHITE);
  return text;
}

/** The pieces joined, with a separator where §7.2.2 needs one and, at random, where it does not. */
function join(pieces: readonly Piece[], choices: Choices): string {
  let text = "";
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i] as Piece;
    const previous = pieces[i - 1];
    const needed = previous !== undefined && previous.endsRegular && piece.startsRegular;
    if (needed || (previous !== undefined && choices.chance(40))) text += separator(choices);
    text += piece.text;
  }
  return text;
}

/** The decimal digits of a finite number without an exponent (§7.3.3 has none). `String` gives the shortest text that
 *  reads back as the same double; its exponent form is only shifted here, never rounded. */
export function plainDecimal(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign = "", head = "", tail = "", exponentText = "0"] = match;
  const digits = head + tail;
  const point = 1 + Number(exponentText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** §7.3.3: an optional sign, leading zeros, a point with or without digits on either side. */
function numberText(value: number, choices: Choices): string {
  const plain = plainDecimal(value);
  // A negative zero keeps its sign: the reader gives back the double the text spells.
  const negative = plain.startsWith("-") || Object.is(value, -0);
  const [whole = "", fraction] = (plain.startsWith("-") ? plain.slice(1) : plain).split(".");
  let sign = negative ? "-" : "";
  if (!negative && choices.chance(20)) sign = "+";
  let head = "0".repeat(choices.pick(3)) + whole;
  let tail = fraction;
  if (tail === undefined) {
    if (choices.chance(15)) tail = choices.chance(50) ? "" : "0";
  } else {
    tail += "0".repeat(choices.pick(3));
    if (/^0+$/.test(head) && choices.chance(40)) head = "";
  }
  return sign + head + (tail === undefined ? "" : `.${tail}`);
}

const hexDigit = (value: number, choices: Choices): string => {
  const digit = value.toString(16);
  return choices.chance(50) ? digit.toUpperCase() : digit;
};

const hexByte = (code: number, choices: Choices): string =>
  hexDigit(Math.floor(code / 16), choices) + hexDigit(code % 16, choices);

/** §7.3.5: a white space, a delimiter or the number sign must be written `#xx`; a regular character may be written as
 *  itself, outside 21h-7Eh it should not (but a reader takes it). */
function nameText(name: string, choices: Choices): string {
  let text = "/";
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    const mustEscape = !isRegularCode(code) || code === 0x23;
    const printable = code >= 0x21 && code <= 0x7e;
    const escape = mustEscape || choices.chance(printable ? 15 : 70);
    text += escape ? `#${hexByte(code, choices)}` : String.fromCharCode(code);
  }
  return text;
}

/** §7.3.4.2 Table 3 escapes, by byte. */
const NAMED_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x0a, "n"],
  [0x0d, "r"],
  [0x09, "t"],
  [0x08, "b"],
  [0x0c, "f"],
]);

const OCTAL_DIGIT = /^[0-7]/;

interface StringChunk {
  text: string;
  /** A short octal escape: it must grow to three digits when an octal digit follows (§7.3.4.2). */
  readonly shortOctal?: number;
}

/** An octal escape of `code`: three digits, or fewer, or with an overflow digit that §7.3.4.2 says is ignored. */
function octalChunk(code: number, choices: Choices): StringChunk {
  const three = code.toString(8).padStart(3, "0");
  if (choices.chance(20)) return { text: `\\${(code + 256).toString(8)}` };
  if (choices.chance(50)) return { text: `\\${code.toString(8)}`, shortOctal: code };
  return { text: `\\${three}` };
}

/** One byte of a literal string (§7.3.4.2). A raw CR would read as LF, so it is always escaped; an LF may be a raw LF,
 *  a raw CR LF, `\n` or octal; `(`, `)` and `\` are escaped; any other escaped character stands for itself. */
function literalChunk(code: number, choices: Choices): StringChunk {
  const named = NAMED_ESCAPES.get(code);
  const special = code === 0x28 || code === 0x29 || code === 0x5c;
  const roll = choices.pick(10);
  if (roll < 2) return octalChunk(code, choices);
  if (named !== undefined && (code === 0x0d || roll < 5)) return { text: `\\${named}` };
  if (code === 0x0a) return { text: choices.chance(50) ? "\n" : "\r\n" };
  if (special) return { text: `\\${String.fromCharCode(code)}` };
  const plainEscape = /[A-Za-z]/.test(String.fromCharCode(code)) && !/[nrtbf]/.test(String.fromCharCode(code));
  if (plainEscape && roll < 4) return { text: `\\${String.fromCharCode(code)}` };
  return { text: String.fromCharCode(code) };
}

/** §7.3.4.2: a literal string, with line continuations (a backslash before an end-of-line, which adds nothing). */
function literalText(bytes: Uint8Array, choices: Choices): string {
  const chunks: StringChunk[] = [];
  for (const code of bytes) {
    if (choices.chance(5)) chunks.push({ text: choices.chance(50) ? "\\\n" : "\\\r\n" });
    chunks.push(literalChunk(code, choices));
  }
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as StringChunk;
    const next = chunks[i + 1];
    if (chunk.shortOctal !== undefined && next !== undefined && OCTAL_DIGIT.test(next.text))
      chunk.text = `\\${chunk.shortOctal.toString(8).padStart(3, "0")}`;
  }
  return `(${chunks.map((chunk) => chunk.text).join("")})`;
}

/** §7.3.4.3: hexadecimal digits in either case, white space anywhere between them, and a last digit left out when it
 *  is 0 (an odd count reads as if a 0 followed). */
function hexText(bytes: Uint8Array, choices: Choices): string {
  let text = "<";
  bytes.forEach((code, index) => {
    if (choices.chance(15)) text += choices.oneOf(WHITE);
    const last = index === bytes.length - 1;
    const pair = hexByte(code, choices);
    text += last && code % 16 === 0 && choices.chance(50) ? pair.slice(0, 1) : pair;
  });
  if (choices.chance(15)) text += choices.oneOf(WHITE);
  return `${text}>`;
}

function dictPieces(entries: readonly (readonly [string, ValueModel])[], choices: Choices): Piece[] {
  const pieces = [closedPiece("<<")];
  for (const [key, value] of entries) pieces.push(regularEnd(nameText(key, choices)), ...valuePieces(value, choices));
  pieces.push(closedPiece(">>"));
  return pieces;
}

/** A name starts with a delimiter (`/`) and ends in a run of regular characters, even the empty name `/`. */
const regularEnd = (text: string): Piece => ({ text, startsRegular: false, endsRegular: true });

/** The tokens of one value. A content stream writes a top-level `true`, `false` or `null` the same way (§7.8.2). */
function valuePieces(model: ValueModel, choices: Choices): Piece[] {
  switch (model.kind) {
    case "null":
      return [regularPiece("null")];
    case "bool":
      return [regularPiece(model.value ? "true" : "false")];
    case "number":
      return [regularPiece(numberText(model.value, choices))];
    case "string":
      return [closedPiece(choices.chance(50) ? literalText(model.bytes, choices) : hexText(model.bytes, choices))];
    case "name":
      return [regularEnd(nameText(model.value, choices))];
    case "array":
      return [closedPiece("["), ...model.items.flatMap((item) => valuePieces(item, choices)), closedPiece("]")];
    case "dict":
      return dictPieces(model.entries, choices);
    case "ref":
      // §7.3.10: three tokens; a comment may sit between them like any separator.
      return [regularPiece(String(model.num)), regularPiece(String(model.gen)), regularPiece("R")];
    default:
      throw new Error("unknown model");
  }
}

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** One value, spelled with random choices, without a separator before or after it. */
export function writeValue(model: ValueModel, choices: Choices): Uint8Array {
  return latin1Bytes(join(valuePieces(model, choices), choices));
}

/** The data of an inline image as written. Without `/L` the reader finds the end by `<white>EI<separator>` (§8.9.7),
 *  so every `E` of the data is written as `F`: the data can never hold that sequence. With `/L` the data is as is. */
function inlineData(op: Extract<OpModel, { kind: "inline" }>): Uint8Array {
  return op.declareLength ? op.data : op.data.map((code) => (code === 0x45 ? 0x46 : code));
}

/** §8.9.7: `BI`, the dictionary, `ID`, one white-space character (a CR LF counts as one, the reader's written
 *  tolerance), the data, a white-space character, `EI`. */
function inlinePieces(op: Extract<OpModel, { kind: "inline" }>, choices: Choices): Piece[] {
  const data = inlineData(op);
  const entries: (readonly [string, ValueModel])[] = [...op.entries];
  if (op.declareLength) entries.push(["L", { kind: "number", value: data.length }]);
  const dict = entries.flatMap(([key, value]) => [regularEnd(nameText(key, choices)), ...valuePieces(value, choices)]);
  const afterId = choices.oneOf([" ", "\n", "\r\n"]);
  let dataText = "";
  for (const code of data) dataText += String.fromCharCode(code);
  const body = `ID${afterId}${dataText}${choices.oneOf(WHITE)}EI`;
  return [regularPiece("BI"), ...dict, regularPiece(body)];
}

function opPieces(op: OpModel, choices: Choices): Piece[] {
  if (op.kind === "inline") return inlinePieces(op, choices);
  return [...op.operands.flatMap((operand) => valuePieces(operand, choices)), regularPiece(op.op)];
}

/** A content stream (§7.8.2): each operator after its operands, separators as `join` picks them, maybe blanks before
 *  the first token and after the last. */
export function writeContent(
  ops: readonly OpModel[],
  choices: Choices,
): { readonly bytes: Uint8Array; readonly trailingBlank: boolean } {
  const leading = choices.chance(30) ? separator(choices) : "";
  const trailing = choices.chance(30) ? separator(choices) : "";
  const body = join(
    ops.flatMap((op) => opPieces(op, choices)),
    choices,
  );
  // The loop of the tokenizer takes one more turn for blanks after the last token, or for a stream of blanks only.
  const blankTail = trailing.length > 0 || (body.length === 0 && leading.length > 0);
  return { bytes: latin1Bytes(leading + body + trailing), trailingBlank: blankTail };
}

// ---------------------------------------------------------------------------------------------------------------------
// Generators.

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"].map((char) => char.charCodeAt(0));

/** §7.3.5: any byte but NUL, letters most often. */
export const nameArb: fc.Arbitrary<string> = fc
  .array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...LETTERS) }, fc.integer({ min: 1, max: 255 })), {
    maxLength: 12,
  })
  .map((codes) => String.fromCharCode(...codes));

/** A key: a few common ones so that a dictionary repeats a key now and then. */
const keyArb = fc.oneof(fc.constantFrom("Type", "A", "N"), nameArb);

/** §7.3.3: integers, and reals with up to six decimals, built from their decimal text so the double is exact. */
const numberArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -(2 ** 31), max: 2 ** 31 }),
  fc
    .tuple(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), fc.integer({ min: 1, max: 6 }))
    .map(([mantissa, scale]) => {
      const digits = String(Math.abs(mantissa)).padStart(scale + 1, "0");
      const text = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
      return mantissa < 0 ? -Number(text) : Number(text);
    }),
);

/** Bytes that need care in a string (§7.3.4.2) come often. */
const stringArb = fc
  .array(
    fc.oneof(
      fc.constantFrom(0x28, 0x29, 0x5c, 0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x00, 0x30, 0x37),
      fc.integer({ min: 0, max: 255 }),
    ),
    { maxLength: 24 },
  )
  .map((codes) => Uint8Array.from(codes));

/** §7.3.10 and Annex C: object number 1 to 8 388 607, generation 0 to 65 535. */
const refArb = fc.record({
  kind: fc.constant("ref" as const),
  num: fc.integer({ min: 1, max: 8_388_607 }),
  gen: fc.integer({ min: 0, max: 65_535 }),
});

function scalarArb(withRefs: boolean, withNull: boolean): fc.Arbitrary<ValueModel> {
  const scalars: fc.Arbitrary<ValueModel>[] = [
    fc.boolean().map((value) => ({ kind: "bool", value })),
    numberArb.map((value) => ({ kind: "number", value })),
    stringArb.map((bytes) => ({ kind: "string", bytes })),
    nameArb.map((value) => ({ kind: "name", value })),
  ];
  if (withNull) scalars.push(fc.constant({ kind: "null" }));
  if (withRefs) scalars.push(refArb);
  return fc.oneof(...scalars);
}

/** Any value: arrays and dictionaries nest a few levels. `withRefs` is off for a content stream (§7.8.2 forbids an
 *  indirect reference there). */
export function valueArb(withRefs: boolean, withNull = true): fc.Arbitrary<ValueModel> {
  const tree = fc.letrec<{ value: ValueModel; array: ValueModel; dict: ValueModel }>((tie) => ({
    value: fc.oneof({ maxDepth: 4, depthSize: "small" }, scalarArb(withRefs, withNull), tie("array"), tie("dict")),
    array: fc.array(tie("value"), { maxLength: 5 }).map((items) => ({ kind: "array", items })),
    dict: fc.array(fc.tuple(keyArb, tie("value")), { maxLength: 5 }).map((entries) => ({ kind: "dict", entries })),
  }));
  return tree.value;
}

/** Operators of ISO 32000-1 Annex A, the quote operators among them. */
const KNOWN_OPERATORS = (
  "BT ET Tf Tj TJ ' \" Td TD Tm T* Tc Tw Tz TL Tr Ts cm q Q re m l c v y h f f* F B B* b b* S s n W W* gs Do BDC " +
  "BMC EMC MP DP sc scn SC SCN rg RG g G k K cs CS d0 d1 sh BX EX ri i j J M d w"
).split(" ");

/** A first byte that cannot start a value (§7.3: digits, `+`, `-`, `.` start a number). */
const operatorHeadArb = fc
  .integer({ min: 0x21, max: 0xff })
  .filter((code) => isRegularCode(code) && !/[\d+\-.]/.test(String.fromCharCode(code)));
const operatorTailArb = fc.integer({ min: 0x21, max: 0xff }).filter(isRegularCode);

/** A word the stream holds as an operator: a known one, or any run of regular characters that is not a value nor
 *  `BI` (an operator the reader does not know is kept as it is). */
const operatorArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...KNOWN_OPERATORS) },
  fc
    .tuple(operatorHeadArb, fc.array(operatorTailArb, { maxLength: 5 }))
    .map(([head, tail]) => String.fromCharCode(head, ...tail))
    .filter((word) => !["true", "false", "null", "BI"].includes(word)),
);

/** An inline image key: never `L` nor `Length`, which the reader takes as the data length. */
const inlineKeyArb = nameArb.filter((name) => name !== "L" && name !== "Length");

/** An inline image. Its values hold no null: §7.3.7 makes a null entry absent, but `content.ts#readInlineEntry` keeps
 *  it (`BI /A null ID x EI` gives `A: null`), a difference from the standard reported on 24/11/2026, not fixed here. */
const inlineArb: fc.Arbitrary<OpModel> = fc.record({
  kind: fc.constant("inline" as const),
  entries: fc.array(fc.tuple(inlineKeyArb, valueArb(false, false)), { maxLength: 4 }),
  data: fc.uint8Array({ maxLength: 32 }),
  declareLength: fc.boolean(),
});

const operatorOpArb: fc.Arbitrary<OpModel> = fc.record({
  kind: fc.constant("op" as const),
  op: operatorArb,
  operands: fc.array(valueArb(false), { maxLength: 6 }),
});

/** A content stream: operators with their operands, and now and then an inline image. */
export const opsArb: fc.Arbitrary<OpModel[]> = fc.array(fc.oneof({ weight: 6, arbitrary: operatorOpArb }, inlineArb), {
  maxLength: 30,
});
