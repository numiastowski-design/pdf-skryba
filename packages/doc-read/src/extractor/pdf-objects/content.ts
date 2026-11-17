/** A page's content stream read as OPERATORS and their operands — the work pdf.js's `page.getOperatorList()` did
 *  before its removal (ISO 32000-1:2008 §7.8.2 content streams, §8.9.7 inline images, §7.2.3 comments).
 *  Decides: where an operand ends and an operator begins (§7.8.2 has no indirect reference here, so a value is
 *  always direct, and a bare word is either `true`, `false`, `null` or an OPERATOR); that an operator we do not
 *  know is kept as it is — this layer reads, it never judges; that an inline image is ONE operator carrying its
 *  dictionary, its binary data skipped and never parsed (§8.9.7: the data ends at a white space, then `EI`, then
 *  a separator — an `EI` glued to other bytes is data, not an end); and the ceilings that make hostile bytes cost
 *  a bounded, linear amount of work.
 *  NOT here: what the operators MEAN (`extractor/pdf-ops.ts` for the operator encoding, `extractor/glyph-positions.ts`
 *  for the text matrices), the resources a name points at, the forms a `Do` draws, the fonts.
 *  Called by: the POC's font census (`tools/poc/`), and `content.test.ts`. */

import {
  MAX_CONTENT_NODES,
  MAX_CONTENT_OPERANDS,
  MAX_CONTENT_OPS,
  MAX_INLINE_IMAGE_ENTRIES,
  MAX_TOKEN_BYTES,
} from "./bounds";
import type { PdfDict, PdfValue } from "./objects";
import { parseContentValue } from "./parse";
import { PdfObjectsRefusal } from "./refusal";

export interface ContentOp {
  /** The operator's own letters (`Tj`, `cm`, `BI`), as the stream writes them. */
  readonly op: string;
  readonly operands: readonly PdfValue[];
}

const NUL = 0x00;
const HT = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SP = 0x20;
const PERCENT = 0x25;

const isSpace = (byte: number): boolean =>
  byte === SP || byte === LF || byte === CR || byte === HT || byte === FF || byte === NUL;

/** §7.2.2 Table 2 delimiters, which end a keyword as a white space does. */
const isDelimiter = (byte: number): boolean =>
  byte === 0x28 ||
  byte === 0x29 ||
  byte === 0x3c ||
  byte === 0x3e ||
  byte === 0x5b ||
  byte === 0x5d ||
  byte === 0x7b ||
  byte === 0x7d ||
  byte === 0x2f ||
  byte === PERCENT;

/** The bytes a VALUE may start with (§7.3): a number, a name, a string, an array, a dictionary. */
const startsValue = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2b ||
  byte === 0x2d ||
  byte === 0x2e ||
  byte === 0x2f ||
  byte === 0x28 ||
  byte === 0x3c ||
  byte === 0x5b;

/** Past white space and comments (§7.2.3: a comment runs to the end of the line). */
function skipBlanks(data: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    while (at < data.length && isSpace(data[at] as number)) at += 1;
    if (at >= data.length || data[at] !== PERCENT) return at;
    while (at < data.length && data[at] !== LF && data[at] !== CR) at += 1;
  }
}

interface Keyword {
  readonly text: string;
  readonly end: number;
}

/** The run of regular characters at `from`, which is either a bare word operand or an operator. Its length is
 *  capped like the lexer's (`parse.ts`, `MAX_TOKEN_BYTES`): the longest operator of the clause is three bytes,
 *  so binary bytes reaching this path cost a named refusal instead of one multi-megabyte « operator »
 *  (the limit written on 31/10/2026 is lifted the same day). */
// TRIED AND LEFT (performance review of 02/11/2026): the `Buffer` copy per keyword costs about 0.32 µs more than reading one to three bytes
// by hand (micro-benchmark, a million operators: 355 ms against 37 ms). Measured on real documents (fixtures and corpus, 5 585 pages,
// 12.9 million operators), tokenizing a page costs 0.7 µs per operator, 1.7 ms a page on average: the copy is at most 0.8 ms a page, nothing
// that decides a reading. It would only matter for a page near `MAX_CONTENT_OPS` (about 0.3 s), which is refused anyway at a million.
function keywordAt(data: Uint8Array, from: number): Keyword | undefined {
  let at = from;
  while (at < data.length && !isSpace(data[at] as number) && !isDelimiter(data[at] as number)) {
    at += 1;
    if (at - from > MAX_TOKEN_BYTES) throw new PdfObjectsRefusal("token-too-long", undefined, from);
  }
  if (at === from) return undefined;
  return { text: Buffer.from(data.subarray(from, at)).toString("latin1"), end: at };
}

const BARE_WORDS: Readonly<Record<string, PdfValue>> = {
  true: { kind: "bool", value: true },
  false: { kind: "bool", value: false },
  null: { kind: "null" },
};

/** One key and its value of an inline image dictionary, read at `at` and added to `entries`. */
function readInlineEntry(data: Uint8Array, at: number, entries: Map<string, PdfValue>): { end: number; nodes: number } {
  if (entries.size >= MAX_INLINE_IMAGE_ENTRIES) throw new PdfObjectsRefusal("inline-image", undefined, at);
  const key = parseContentValue(data, at);
  if (key.value.kind !== "name") throw new PdfObjectsRefusal("inline-image");
  const value = parseContentValue(data, key.end);
  entries.set(key.value.value, value.value);
  return { end: value.end, nodes: key.nodes + value.nodes };
}

/** §8.9.7: the dictionary between `BI` and `ID`, with the NUMBER OF NODES it makes us retain.
 *  🔴 The two bounds of this function were born of the security review of 31/10/2026: the whole `BI` cost a
 *  single node, so neither the number of keys nor the weight of the values was counted. See
 *  `bounds.ts#MAX_INLINE_IMAGE_ENTRIES`. */
function inlineImageDict(data: Uint8Array, from: number): { entries: PdfDict; dataStart: number; nodes: number } {
  const entries = new Map<string, PdfValue>();
  let nodes = 0;
  let at = from;
  for (;;) {
    at = skipBlanks(data, at);
    if (at >= data.length) throw new PdfObjectsRefusal("inline-image");
    if (startsValue(data[at] as number)) {
      const entry = readInlineEntry(data, at, entries);
      nodes += entry.nodes;
      at = entry.end;
      continue;
    }
    const keyword = keywordAt(data, at);
    if (keyword?.text !== "ID") throw new PdfObjectsRefusal("inline-image");
    // §8.9.7: exactly ONE white space byte separates `ID` from the data — but a CR LF counts for ONE
    // separator, and it is the only tolerance of this reader, written with its reason: a producer that writes
    // CR LF there AND declares `/L` would otherwise make the end of the data fall one byte too early, and the page would be
    // refused although it reads (finding of the review of 31/10/2026, fixed the same day). A single byte is
    // skipped when it is not a CR LF, without checking whether it is blank: the clause says it is.
    const crlf = data[keyword.end] === CR && data[keyword.end + 1] === LF;
    return { entries, dataStart: keyword.end + (crlf ? 2 : 1), nodes };
  }
}

/** Where the binary data of an inline image ends: the offset just past its `EI`. */
function endOfInlineData(data: Uint8Array, dataStart: number, entries: PdfDict): number {
  const declared = entries.get("L") ?? entries.get("Length");
  if (declared?.kind === "number" && Number.isInteger(declared.value) && declared.value >= 0) {
    const after = skipBlanks(data, dataStart + declared.value);
    const keyword = keywordAt(data, after);
    if (keyword?.text !== "EI") throw new PdfObjectsRefusal("inline-image");
    return keyword.end;
  }
  for (let at = dataStart; at + 2 < data.length; at += 1) {
    if (!isSpace(data[at] as number) || data[at + 1] !== 0x45 || data[at + 2] !== 0x49) continue;
    const after = at + 3;
    if (after === data.length || isSpace(data[after] as number) || isDelimiter(data[after] as number)) return after;
  }
  throw new PdfObjectsRefusal("inline-image");
}

/** One operand read at `at`; the refusal says WHERE, since the lexer does not know it is in a content stream. */
function operandAt(data: Uint8Array, at: number, operands: PdfValue[]): { end: number; nodes: number } {
  if (operands.length >= MAX_CONTENT_OPERANDS) throw new PdfObjectsRefusal("content-operands", undefined, at);
  let parsed;
  try {
    parsed = parseContentValue(data, at);
  } catch (error) {
    if (error instanceof PdfObjectsRefusal) throw new PdfObjectsRefusal(error.reason, error.objectNumber, at);
    throw error;
  }
  operands.push(parsed.value);
  // The NUMBER of nodes the operand retains, not 1: `[0 0 0 … 0] TJ` is ONE operand and millions of
  // nodes, and it is what `MAX_CONTENT_NODES` must see (`medium` review of 31/10/2026).
  return { end: parsed.end, nodes: parsed.nodes };
}

/** One operator, with the operands read so far — or, for `BI`, the inline image read whole (§8.9.7). Returns
 *  where to go on, and the nodes the operator makes us RETAIN beyond itself (an inline image's dictionary). */
function operatorAt(
  data: Uint8Array,
  keyword: Keyword,
  operands: readonly PdfValue[],
  ops: ContentOp[],
): { end: number; nodes: number } {
  if (ops.length >= MAX_CONTENT_OPS) throw new PdfObjectsRefusal("content-too-long");
  if (keyword.text !== "BI") {
    ops.push({ op: keyword.text, operands });
    return { end: keyword.end, nodes: 0 };
  }
  const { entries, dataStart, nodes } = inlineImageDict(data, keyword.end);
  const end = endOfInlineData(data, dataStart, entries);
  ops.push({ op: "BI", operands: [{ kind: "dict", entries }] });
  return { end, nodes };
}

/** What the content stream retains is bounded: see `MAX_CONTENT_NODES`. */
function guardNodes(nodes: number, at: number): void {
  if (nodes > MAX_CONTENT_NODES) throw new PdfObjectsRefusal("content-too-long", undefined, at);
}

/** The value of a bare word (`true`, `false`, `null`), or `undefined` for any other keyword.
 *  `Object.hasOwn`, never a bare lookup: the token comes from the FILE, and an operator spelled `constructor`
 *  or `__proto__` would otherwise find something on `Object.prototype` and be pushed as if it were a value
 *  (review of 31/10/2026). */
function bareWordValue(text: string): PdfValue | undefined {
  return Object.hasOwn(BARE_WORDS, text) ? BARE_WORDS[text] : undefined;
}

/** Every operator of one content stream, in the order it is written. */
export function readContentOps(data: Uint8Array): readonly ContentOp[] {
  return tokenizeContent(data).ops;
}

/** The operators of a content stream, and the NODES they retain (operands included): what a cache that keeps them has to price. */
export function tokenizeContent(data: Uint8Array): { readonly ops: readonly ContentOp[]; readonly nodes: number } {
  const ops: ContentOp[] = [];
  let operands: PdfValue[] = [];
  let at = 0;
  // What we RETAIN, and not what we read: see `MAX_CONTENT_NODES`.
  let nodes = 0;

  while (at < data.length) {
    nodes += 1;
    guardNodes(nodes, at);
    at = skipBlanks(data, at);
    if (at >= data.length) break;

    if (startsValue(data[at] as number)) {
      const operand = operandAt(data, at, operands);
      nodes += operand.nodes;
      // As for the operator below: a stream may end on its operands, and the loop would exit
      // without looking at what they made it retain (`[1 …] [1 …]` with no operator, twice `MAX_VALUE_NODES`).
      guardNodes(nodes, at);
      at = operand.end;
      continue;
    }

    const keyword = keywordAt(data, at);
    // A lone `]`, `>>` or `}`: the stream is not the grammar of §7.8.2.
    if (keyword === undefined) throw new PdfObjectsRefusal("content-syntax", undefined, at);

    const bare = bareWordValue(keyword.text);
    if (bare !== undefined) {
      if (operands.length >= MAX_CONTENT_OPERANDS) throw new PdfObjectsRefusal("content-operands", undefined, at);
      operands.push(bare);
      at = keyword.end;
      continue;
    }

    const operator = operatorAt(data, keyword, operands, ops);
    nodes += operator.nodes;
    // Checked HERE and not at the next turn: an inline image may be the LAST operator of the stream, and the
    // loop would then exit without ever looking at what it made it retain.
    guardNodes(nodes, at);
    at = operator.end;
    operands = [];
  }

  return { ops, nodes };
}
