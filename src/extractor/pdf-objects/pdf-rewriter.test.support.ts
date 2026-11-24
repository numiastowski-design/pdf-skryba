/**
 * A test REWRITER of real PDF files, written from ISO 32000-1:2008, never from the reader: §7.5.2 header, §7.5.3 body,
 * §7.5.4 cross-reference table, §7.5.5 trailer, §7.5.6 incremental updates, §7.5.7 object streams, §7.5.8
 * cross-reference streams. It writes the SAME objects again: in another order, under a classic table or a
 * cross-reference stream, some of them packed into an object stream, and with incremental updates appended that write
 * objects again unchanged.
 * Decides: what is kept of a source file (each in-use object, its bytes as they are when it sits at an offset, its
 * value spelled by the lot 2 writer when it sat in an object stream; the trailer's `Root`, `Info` and `ID`); the
 * spellings the rewriter may pick; what "the same document" means for the properties (`graphOf`: every object but the
 * cross-reference and object streams, a stream by its dictionary and decoded bytes; the trailer's three keys; the
 * pages).
 * NOT here: the properties (`xref.property.test.ts`), the damage. Encrypted files (a string is encrypted with its
 * object's number, so a moved object would still read, but the rewriter does not need them).
 * Called by: `xref.property.test.ts`, `../pdf-images.property.test.ts` (`appendObjects`).
 */

import type { PdfObjectsDocument } from "./document";
import { openPdfObjects } from "./document";
import type { PdfDict, PdfValue } from "./objects";
import { parseIndirectObject } from "./parse";
import { flateEncode, pngPredict } from "./stream-encoders.test.support";
import { type Choices, modelOf, writeValue } from "./pdf-syntax-writer.test.support";
import { readXref } from "./xref";

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** One in-use object of the source. */
export interface SourceObject {
  readonly num: number;
  readonly gen: number;
  /** Its bytes, `N G obj` to `endobj`, when it sat at an offset. */
  readonly raw: Uint8Array | undefined;
  /** Its value when it is not a stream: what an object stream may hold (§7.5.7). */
  readonly value: PdfValue | undefined;
}

export interface Source {
  readonly objects: readonly SourceObject[];
  /** The trailer keys a rewritten file carries: `Root`, `Info`, `ID` (§7.5.5 Table 15). */
  readonly trailer: PdfDict;
}

const isStructureStream = (value: PdfValue): boolean => {
  if (value.kind !== "stream") return false;
  const type = value.dict.get("Type");
  return type?.kind === "name" && (type.value === "XRef" || type.value === "ObjStm");
};

/** The objects and trailer of a real file, as its own cross-reference section places them. */
export function sourceOf(bytes: Uint8Array): Source {
  const doc = openPdfObjects(bytes);
  const xref = readXref(bytes);
  const lengthOf = (ref: { readonly num: number; readonly gen: number }): number | undefined => {
    const value = doc.resolve({ kind: "ref", num: ref.num, gen: ref.gen });
    return value?.kind === "number" ? value.value : undefined;
  };
  const objects: SourceObject[] = [];
  for (const [num, entry] of [...xref.entries].sort(([a], [b]) => a - b)) {
    if (entry.kind === "offset") {
      const parsed = parseIndirectObject(bytes, entry.offset, lengthOf);
      if (isStructureStream(parsed.value)) continue;
      objects.push({
        num,
        gen: entry.gen,
        raw: bytes.slice(entry.offset, parsed.end),
        value: parsed.value.kind === "stream" ? undefined : parsed.value,
      });
    } else {
      const value = doc.resolve({ kind: "ref", num, gen: 0 });
      if (value !== undefined) objects.push({ num, gen: 0, raw: undefined, value });
    }
  }
  const trailer = new Map<string, PdfValue>();
  for (const key of ["Root", "Info", "ID"]) {
    const value = xref.trailer.get(key);
    if (value !== undefined) trailer.set(key, value);
  }
  return { objects, trailer };
}

// ---------------------------------------------------------------------------------------------------------------------
// What "the same document" means.

/** A value with its stream (if it is one) replaced by its dictionary and decoded bytes — up to an image filter, whose
 *  bytes stay as they are (`document.ts#imageStreamOf`): where the stream sits is not part of the document. */
function normalized(doc: PdfObjectsDocument, value: PdfValue | undefined): unknown {
  if (value?.kind !== "stream") return value;
  const { imageFilter, data } = doc.imageStreamOf(value);
  return { dict: value.dict, imageFilter, data: Uint8Array.from(data) };
}

export interface Graph {
  readonly objects: ReadonlyMap<number, unknown>;
  readonly trailer: PdfDict;
  readonly pages: readonly unknown[];
}

/** Every object the file's cross-reference section places, but its cross-reference and object streams; the trailer's
 *  `Root`, `Info` and `ID`; the pages as the tree gives them. Reads everything, so a refusal comes out here. */
export function graphOf(bytes: Uint8Array): Graph {
  const doc = openPdfObjects(bytes);
  const xref = readXref(bytes);
  const objects = new Map<number, unknown>();
  for (const [num, entry] of [...xref.entries].sort(([a], [b]) => a - b)) {
    const value = doc.resolve({ kind: "ref", num, gen: entry.kind === "offset" ? entry.gen : 0 });
    if (value !== undefined && isStructureStream(value)) continue;
    objects.set(num, normalized(doc, value));
  }
  const trailer = new Map<string, PdfValue>();
  for (const key of ["Root", "Info", "ID"]) {
    const value = doc.trailer().get(key);
    if (value !== undefined) trailer.set(key, value);
  }
  const pages = doc.pages().map((page) => ({
    ref: page.ref,
    dict: page.dict,
    view: page.view,
    rotate: page.rotate,
    resources: page.resources,
  }));
  return { objects, trailer, pages };
}

// ---------------------------------------------------------------------------------------------------------------------
// The writer.

/** Where an object ends up: at an offset, or as the `index`-th member of the object stream `container`. */
type Placement =
  | { readonly kind: "offset"; readonly offset: number; readonly gen: number }
  | { readonly kind: "compressed"; readonly container: number; readonly index: number };

/** A file being written: its bytes so far, and what its newest section says. */
export interface Built {
  readonly bytes: Uint8Array;
  readonly startxref: number;
  /** The first object number no section has used. */
  readonly nextNum: number;
}

const valueText = (value: PdfValue, choices: Choices): Uint8Array => writeValue(modelOf(value), choices);

/** §7.3.10: `N G obj`, the value, `endobj`. A stream keeps its bytes as the source had them. */
function objectBytes(object: SourceObject, choices: Choices): Uint8Array {
  if (object.raw !== undefined && (object.value === undefined || choices.chance(70))) return object.raw;
  return concat([
    latin1(`${object.num} ${object.gen} obj${choices.oneOf([" ", "\n", "\r\n"])}`),
    valueText(object.value as PdfValue, choices),
    latin1(`${choices.oneOf([" ", "\n", "\r\n"])}endobj`),
  ]);
}

/** §7.5.7: an object stream holding `members`, spelled by the lot 2 writer, Flate-encoded now and then. */
function objectStreamBytes(num: number, members: readonly SourceObject[], choices: Choices): Uint8Array {
  const bodies = members.map((member) => concat([valueText(member.value as PdfValue, choices), latin1("\n")]));
  const offsets: number[] = [];
  let at = 0;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length;
  }
  const head = latin1(`${members.map((member, i) => `${member.num} ${offsets[i]}`).join(" ")}\n`);
  const plain = concat([head, ...bodies]);
  const flate = choices.chance(60);
  const data = flate ? flateEncode(plain, choices) : plain;
  const filter = flate ? " /Filter /FlateDecode" : "";
  return concat([
    latin1(
      `${num} 0 obj\n<< /Type /ObjStm /N ${members.length} /First ${head.length} /Length ${data.length}${filter} >>\nstream\n`,
    ),
    data,
    latin1("\nendstream\nendobj"),
  ]);
}

/** The trailer keys as text: `Size`, `Root`, `Info`, `ID`, and `Prev` for an update (§7.5.5 Table 15, §7.5.6). */
function trailerText(source: Source, size: number, prev: number | undefined, choices: Choices): Uint8Array {
  const parts: Uint8Array[] = [latin1(`/Size ${size}`)];
  for (const [key, value] of source.trailer) parts.push(latin1(` /${key} `), valueText(value, choices));
  if (prev !== undefined) parts.push(latin1(` /Prev ${prev}`));
  return concat(parts);
}

/** Runs of consecutive numbers: the subsections of a table, the `/Index` of a stream. */
function runsOf(numbers: readonly number[]): (readonly [number, number])[] {
  const runs: [number, number][] = [];
  for (const num of numbers) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] + last[1] === num) last[1] += 1;
    else runs.push([num, 1]);
  }
  return runs;
}

/** §7.5.4: `xref`, subsections of 20-byte entries (`nnnnnnnnnn ggggg n` and a two-character end of line), `trailer`.
 *  The whole range from 0 with free entries in the gaps, or one subsection per run, at random. */
function tableBytes(
  placements: ReadonlyMap<number, Placement>,
  trailer: Uint8Array,
  withHead: boolean,
  choices: Choices,
): Uint8Array {
  const eol = choices.oneOf([" \r", " \n", "\r\n"]);
  const entry = (offset: number, gen: number, type: "n" | "f"): string =>
    `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} ${type}${eol}`;
  const numbers = [...placements.keys()].sort((a, b) => a - b);
  const listed = withHead ? [0, ...numbers.filter((num) => num !== 0)] : numbers;
  const max = listed[listed.length - 1] ?? 0;
  const runs: (readonly [number, number])[] = withHead && choices.chance(50) ? [[0, max + 1]] : runsOf(listed);
  let text = "xref\n";
  for (const [first, count] of runs) {
    text += `${first} ${count}\n`;
    for (let num = first; num < first + count; num += 1) {
      const placed = placements.get(num);
      text += placed?.kind === "offset" ? entry(placed.offset, placed.gen, "n") : entry(0, num === 0 ? 65535 : 1, "f");
    }
  }
  return concat([latin1(`${text}trailer\n<< `), trailer, latin1(" >>\n")]);
}

const widthOf = (value: number): number => Math.max(1, Math.ceil(Math.log2(value + 1) / 8));

function bigEndian(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256);
}

/** §7.5.8: a cross-reference stream numbered `num`, at `offset`, listing itself now and then; rows of `/W [1 w 2]`,
 *  Flate-encoded with the PNG Up predictor now and then, as real writers do (§7.4.4.4). */
function xrefStreamBytes(
  num: number,
  offset: number,
  placements: ReadonlyMap<number, Placement>,
  trailer: Uint8Array,
  choices: Choices,
): Uint8Array {
  const all = new Map(placements);
  if (choices.chance(60)) all.set(num, { kind: "offset", offset, gen: 0 });
  const numbers = [...all.keys()].sort((a, b) => a - b);
  const largest = Math.max(offset, ...[...all.values()].map((p) => (p.kind === "offset" ? p.offset : p.container)));
  const w1 = widthOf(largest) + choices.pick(2);
  const rows = numbers.flatMap((n) => {
    const placed = all.get(n) as Placement;
    return placed.kind === "offset"
      ? [1, ...bigEndian(placed.offset, w1), ...bigEndian(placed.gen, 2)]
      : [2, ...bigEndian(placed.container, w1), ...bigEndian(placed.index, 2)];
  });
  const rowBytes = 1 + w1 + 2;
  const plain = Uint8Array.from(rows);
  const flate = choices.chance(60);
  const data = flate ? flateEncode(pngPredict(plain, rowBytes, 1, choices), choices) : plain;
  const index = runsOf(numbers)
    .map(([first, count]) => `${first} ${count}`)
    .join(" ");
  const filter = flate ? ` /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${rowBytes} >>` : "";
  return concat([
    latin1(`${num} 0 obj\n<< /Type /XRef /W [1 ${w1} 2] /Index [${index}] `),
    trailer,
    latin1(` /Length ${data.length}${filter} >>\nstream\n`),
    data,
    latin1("\nendstream\nendobj\n"),
  ]);
}

/** One section and its file tail: the table or stream, `startxref`, `%%EOF` (§7.5.5). */
function sectionAndTail(
  at: number,
  placements: ReadonlyMap<number, Placement>,
  source: Source,
  nextNum: number,
  prev: number | undefined,
  asStream: boolean,
  choices: Choices,
): { bytes: Uint8Array; nextNum: number } {
  const size = asStream ? nextNum + 1 : nextNum;
  const trailer = trailerText(source, size, prev, choices);
  const section = asStream
    ? xrefStreamBytes(nextNum, at, placements, trailer, choices)
    : tableBytes(placements, trailer, prev === undefined, choices);
  return { bytes: concat([section, latin1(`startxref\n${at}\n%%EOF\n`)]), nextNum: size };
}

/** A whole new file holding the source's objects: shuffled, under a table or a stream, some packed into an object
 *  stream (only under a stream: a table cannot place them, §7.5.8.4 aside). */
export function rewrite(source: Source, choices: Choices): Built {
  const asStream = choices.chance(50);
  const order = [...source.objects];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = choices.pick(i + 1);
    [order[i], order[j]] = [order[j] as SourceObject, order[i] as SourceObject];
  }
  const packed = asStream
    ? order.filter((object) => object.value !== undefined && object.gen === 0 && choices.chance(50))
    : [];
  const packedSet = new Set(packed);
  let nextNum = Math.max(0, ...source.objects.map((object) => object.num)) + 1;

  // §7.5.2: the header, and a comment of four bytes above 127 so that a transfer tool sees binary data.
  const header = latin1(`%PDF-1.7\n%\xe2\xe3\xcf\xd3\n`);
  const parts: Uint8Array[] = [header];
  let at = header.length;
  const placements = new Map<number, Placement>();
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes, latin1(choices.oneOf(["\n", "\r\n", "\n\n"])));
    at += bytes.length + (parts[parts.length - 1] as Uint8Array).length;
  };
  for (const object of order) {
    if (packedSet.has(object)) continue;
    placements.set(object.num, { kind: "offset", offset: at, gen: object.gen });
    push(objectBytes(object, choices));
  }
  if (packed.length > 0) {
    const container = nextNum;
    nextNum += 1;
    packed.forEach((object, index) => placements.set(object.num, { kind: "compressed", container, index }));
    placements.set(container, { kind: "offset", offset: at, gen: 0 });
    push(objectStreamBytes(container, packed, choices));
  }
  const tail = sectionAndTail(at, placements, source, nextNum, undefined, asStream, choices);
  parts.push(tail.bytes);
  return { bytes: concat(parts), startxref: at, nextNum: tail.nextNum };
}

/** §7.5.6: an incremental update appended to `base` that changes nothing: some objects written again as they are (none,
 *  now and then), a new section listing them, `Prev` pointing at the base's section. Returns where the update starts. */
export function appendUpdate(base: Built, source: Source, choices: Choices): Built & { readonly from: number } {
  const asStream = choices.chance(50);
  const parts: Uint8Array[] = [base.bytes];
  // A file may end without an end-of-line after `%%EOF`; the update then starts on a line of its own.
  const last = base.bytes[base.bytes.length - 1];
  if (last !== 0x0a && last !== 0x0d) parts.push(latin1("\n"));
  let at = parts.reduce((sum, part) => sum + part.length, 0);
  const placements = new Map<number, Placement>();
  for (const object of source.objects) {
    if (!choices.chance(20)) continue;
    placements.set(object.num, { kind: "offset", offset: at, gen: object.gen });
    const bytes = concat([objectBytes(object, choices), latin1("\n")]);
    parts.push(bytes);
    at += bytes.length;
  }
  const tail = sectionAndTail(at, placements, source, base.nextNum, base.startxref, asStream, choices);
  parts.push(tail.bytes);
  return { bytes: concat(parts), startxref: at, nextNum: tail.nextNum, from: base.bytes.length };
}

/** The base file as it is, seen as a `Built` (its own `startxref`, its numbers). */
export function asBuilt(bytes: Uint8Array): Built {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString("latin1");
  const match = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail);
  if (match === null) throw new Error("the base file has no startxref at its end");
  const xref = readXref(bytes);
  const size = xref.trailer.get("Size");
  const largest = Math.max(0, ...xref.entries.keys());
  const nextNum = Math.max(largest + 1, size?.kind === "number" ? size.value : 0);
  return { bytes, startxref: Number(match[1]), nextNum };
}

/** One object an update writes: its bytes, `N G obj` to `endobj`. */
export interface WrittenObject {
  readonly num: number;
  readonly gen: number;
  readonly bytes: Uint8Array;
}

/** §7.5.6: an incremental update appended to `base` that writes `objects` (new ones, or new versions of existing
 *  ones), listed by a new section under a table or a stream at random, `Prev` pointing at the base's section. The
 *  trailer keeps `Root`, `Info` and `ID` from `trailer`. */
export function appendObjects(
  base: Built,
  trailer: Source["trailer"],
  objects: readonly WrittenObject[],
  choices: Choices,
): Built {
  const asStream = choices.chance(50);
  const parts: Uint8Array[] = [base.bytes];
  const last = base.bytes[base.bytes.length - 1];
  if (last !== 0x0a && last !== 0x0d) parts.push(latin1("\n"));
  let at = parts.reduce((sum, part) => sum + part.length, 0);
  const placements = new Map<number, Placement>();
  for (const object of objects) {
    placements.set(object.num, { kind: "offset", offset: at, gen: object.gen });
    const bytes = concat([object.bytes, latin1("\n")]);
    parts.push(bytes);
    at += bytes.length;
  }
  const nextNum = Math.max(base.nextNum, ...objects.map((object) => object.num + 1));
  const tail = sectionAndTail(at, placements, { objects: [], trailer }, nextNum, base.startxref, asStream, choices);
  parts.push(tail.bytes);
  return { bytes: concat(parts), startxref: at, nextNum: tail.nextNum };
}
