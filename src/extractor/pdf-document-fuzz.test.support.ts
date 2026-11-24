/**
 * Test support of the document-level PDF fuzz (lots 6 to 8 of the PDF fuzz design, 16/11/2026): the words of a
 * result, the objects that carry no text located twice, and their damage.
 * Decides: what a published word is (a blank-separated token of the published text units, NFC); what "the layout
 * invents nothing" checks (each published token is a piece of the read letters, `inventedTokens`); which objects carry
 * no text (an image XObject, the `/Info` dictionary, an outline item, a `/Metadata` stream, a link annotation:
 * `TargetKind`); how they are located (by our reader, and by a naive scan of the bytes that shares no code with it);
 * the damages (bytes overwritten, a run filled, the body replaced by `null`, the stream data overwritten), each of them
 * inside the object and keeping the file's length, so that every cross-reference offset stays true.
 * NOT here: the properties (`pdf-document.property.test.ts`, `pdf-decrypt.property.test.ts`,
 * `pdf-images.property.test.ts`).
 * Called by: those three property tests.
 */

import type { IRBlock } from "doc-ir";

import { textUnitsOf } from "./pdf-corpus-cases.test.support";
import { openPdfObjects } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import { parseIndirectObject } from "./pdf-objects/parse";
import { readXref } from "./pdf-objects/xref";
import type { PdfSource } from "./pdf-source";

// ---------------------------------------------------------------------------------------------------------------------
// Words.

/** The published words of a result: every text unit (paragraph, heading, cell, list item), split on blanks, NFC. */
export function publishedWords(pages: readonly (readonly IRBlock[])[]): string[] {
  return pages
    .flatMap((blocks) => textUnitsOf(blocks))
    .join(" ")
    .normalize("NFC")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** The hyphens a cut word may lose when the layout joins it (`layout/cut-word.ts`). */
const HYPHENS = /[-­‐‑]/gu;

/**
 * The published tokens that are NOT a piece of the read letters: the read runs of every page, in reading order, with
 * every blank removed (and, as a second chance, every hyphen, for a cut word joined across a line).
 * What it can see: a letter the layout made up, a word put together from runs that are not adjacent. What it cannot
 * see: a join of two ADJACENT runs that should have stayed apart (« Total - » and « 12,00 »); that one has its own tests
 * (`layout/cut-word.ts`). Measured on 24/11/2026 over the 66 fixtures under 700 KB: zero such token on 59 of them; the
 * seven others hold typography the layout rebuilds on purpose (`…` from leader dots, `m³` from a raised `3`), and none of
 * them is a seed here.
 */
export function inventedTokens(published: readonly string[], source: PdfSource): string[] {
  const letters = source.pages
    .flatMap((page) => page.runs.map((run) => run.text))
    .join("")
    .normalize("NFC")
    .replace(/\s+/gu, "");
  const unhyphenated = letters.replace(HYPHENS, "");
  return published.filter((word) => !letters.includes(word) && !unhyphenated.includes(word.replace(HYPHENS, "")));
}

// ---------------------------------------------------------------------------------------------------------------------
// The objects that carry no text.

export type TargetKind = "image" | "info" | "outline" | "metadata" | "link";

/** One object at an offset of the file: `start` at its `N G obj`, `end` just after its `endobj`. */
export interface Target {
  readonly num: number;
  readonly gen: number;
  readonly kind: TargetKind;
  readonly start: number;
  readonly end: number;
}

const nameValue = (value: PdfValue | undefined): string | undefined =>
  value?.kind === "name" ? value.value : undefined;

/** ISO 32000-1 §8.9.5 (`/Subtype /Image`), §14.3.2 (`/Type /Metadata`), §12.3.3 (the outline dictionary, and an item:
 *  a `/Title` and a `/Parent`), §12.5.6.5 (`/Subtype /Link`). */
function kindOfDict(dict: PdfDict): TargetKind | undefined {
  const type = nameValue(dict.get("Type"));
  const subtype = nameValue(dict.get("Subtype"));
  if (subtype === "Image") return "image";
  if (subtype === "Link") return "link";
  if (type === "Metadata") return "metadata";
  if (type === "Outlines" || (dict.has("Title") && dict.has("Parent"))) return "outline";
  return undefined;
}

/** The objects that carry no text, as OUR reader places and parses them: every object at an offset of the newest
 *  cross-reference section, classified by its own dictionary, and the trailer's `/Info`. */
export function readerTargets(bytes: Uint8Array): Target[] {
  const doc = openPdfObjects(bytes);
  const xref = readXref(bytes);
  const info = xref.trailer.get("Info");
  const lengthOf = (ref: { readonly num: number; readonly gen: number }): number | undefined => {
    const value = doc.resolve({ kind: "ref", num: ref.num, gen: ref.gen });
    return value?.kind === "number" ? value.value : undefined;
  };
  const targets: Target[] = [];
  for (const [num, entry] of [...xref.entries].sort(([a], [b]) => a - b)) {
    if (entry.kind !== "offset") continue;
    const parsed = parseIndirectObject(bytes, entry.offset, lengthOf);
    const value = parsed.value;
    const dict = value.kind === "stream" ? value.dict : value.kind === "dict" ? value.entries : undefined;
    const isInfo = info?.kind === "ref" && info.num === num;
    const kind = isInfo ? "info" : dict === undefined ? undefined : kindOfDict(dict);
    if (kind !== undefined) targets.push({ num, gen: entry.gen, kind, start: entry.offset, end: parsed.end });
  }
  return targets;
}

const latin1Text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** The objects that carry no text, found by a NAIVE scan of the bytes, without our parser: each `N G obj` up to the
 *  next `endobj` (after the `endstream` of a stream), classified by regular expressions over its dictionary text; the
 *  info dictionary is the one the last `/Info N G R` of the file names. It sees every revision and no object stream. */
export function naiveTargets(bytes: Uint8Array): Target[] {
  const text = latin1Text(bytes);
  const infoMatches = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/gu)];
  const infoNum = infoMatches.length === 0 ? undefined : Number(infoMatches[infoMatches.length - 1]?.[1]);
  const targets: Target[] = [];
  for (const match of text.matchAll(/(?<![0-9])(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![A-Za-z])/gu)) {
    const start = match.index;
    const bodyAt = start + match[0].length;
    const endobjAt = text.indexOf("endobj", bodyAt);
    if (endobjAt < 0) continue;
    const streamAt = text.slice(bodyAt, endobjAt).search(/(?<![A-Za-z])stream(?![A-Za-z])/u);
    let end = endobjAt + "endobj".length;
    let dictText = text.slice(bodyAt, endobjAt);
    if (streamAt >= 0) {
      dictText = text.slice(bodyAt, bodyAt + streamAt);
      const endstreamAt = text.indexOf("endstream", bodyAt + streamAt);
      const after = endstreamAt < 0 ? -1 : text.indexOf("endobj", endstreamAt);
      if (after < 0) continue;
      end = after + "endobj".length;
    }
    const num = Number(match[1]);
    const kind = num === infoNum ? "info" : naiveKind(dictText);
    if (kind !== undefined) targets.push({ num, gen: Number(match[2]), kind, start, end });
  }
  return targets;
}

function naiveKind(dictText: string): TargetKind | undefined {
  if (/\/Subtype\s*\/Image(?![A-Za-z])/u.test(dictText)) return "image";
  if (/\/Subtype\s*\/Link(?![A-Za-z])/u.test(dictText)) return "link";
  if (/\/Type\s*\/Metadata(?![A-Za-z])/u.test(dictText)) return "metadata";
  if (/\/Type\s*\/Outlines(?![A-Za-z])/u.test(dictText)) return "outline";
  if (/\/Title(?![A-Za-z])/u.test(dictText) && /\/Parent(?![A-Za-z])/u.test(dictText)) return "outline";
  return undefined;
}

const keyOf = (target: Target): string => `${target.num} ${target.gen} ${target.kind} ${target.start} ${target.end}`;

/** The targets both readings give exactly alike (number, generation, kind, start and end), and those only one gives
 *  among the objects our reader places: two readings that differ abstain. */
export function agreedTargets(bytes: Uint8Array): {
  readonly agreed: readonly Target[];
  readonly readerOnly: readonly Target[];
  readonly naiveOnly: readonly Target[];
} {
  const reader = readerTargets(bytes);
  const naive = naiveTargets(bytes);
  const naiveKeys = new Set(naive.map(keyOf));
  const readerKeys = new Set(reader.map(keyOf));
  // A naive hit our reader does not give alike, at an offset the newest section places: the readings differ. A naive
  // hit elsewhere is an older revision or an object the newest section frees: not a disagreement.
  const offsets = offsetsOf(bytes);
  return {
    agreed: reader.filter((target) => naiveKeys.has(keyOf(target))),
    readerOnly: reader.filter((target) => !naiveKeys.has(keyOf(target))),
    naiveOnly: naive.filter((target) => !readerKeys.has(keyOf(target)) && offsets.has(target.start)),
  };
}

/** Every offset the newest cross-reference section places. */
function offsetsOf(bytes: Uint8Array): ReadonlySet<number> {
  const offsets = new Set<number>();
  for (const entry of readXref(bytes).entries.values()) if (entry.kind === "offset") offsets.add(entry.offset);
  return offsets;
}

// ---------------------------------------------------------------------------------------------------------------------
// Damage, inside one object, the file's length kept.

/** Bytes that mean something to the parser: delimiters, keywords, a reference, a number edge. */
export const FRAGMENTS: readonly string[] = [
  "(",
  ")",
  "<",
  ">",
  "<<",
  ">>",
  "[",
  "]",
  "/",
  "%",
  "\\",
  "R",
  " 0 R",
  "obj",
  "endobj",
  "stream",
  "endstream",
  "null",
  "-",
  "99999999999",
  "\x00",
  "\xff",
];

export type Damage =
  | {
      readonly kind: "overwrite";
      readonly writes: readonly { readonly at: number; readonly byte: number; readonly fragment: number | null }[];
    }
  | { readonly kind: "fill"; readonly at: number; readonly length: number; readonly byte: number }
  | { readonly kind: "null" }
  | { readonly kind: "stream-data"; readonly at: number; readonly length: number; readonly byte: number };

/** A copy of `bytes` with `damage` applied inside `[target.start, target.end)`: never a byte outside it, never a
 *  change of length. Positions are taken modulo the object's extent. */
export function damaged(bytes: Uint8Array, target: Target, damage: Damage): Uint8Array {
  const out = bytes.slice();
  const size = target.end - target.start;
  const put = (at: number, byte: number): void => {
    if (at >= target.start && at < target.end) out[at] = byte;
  };
  switch (damage.kind) {
    case "overwrite":
      for (const { at, byte, fragment } of damage.writes) {
        const from = target.start + (at % size);
        const piece =
          fragment === null ? String.fromCharCode(byte) : (FRAGMENTS[fragment % FRAGMENTS.length] as string);
        for (let i = 0; i < piece.length; i += 1) put(from + i, piece.charCodeAt(i));
      }
      return out;
    case "fill": {
      const from = target.start + (damage.at % size);
      for (let i = 0; i < damage.length; i += 1) put(from + i, damage.byte);
      return out;
    }
    case "null": {
      // `N G obj`, then ` null` and blanks up to the `endobj`, kept.
      const text = latin1Text(bytes.subarray(target.start, target.end));
      const header = /^\d+\s+\d+\s+obj/u.exec(text);
      const tail = text.lastIndexOf("endobj");
      if (header === null || tail < 0) return out;
      const from = target.start + header[0].length;
      const to = target.start + tail;
      for (let at = from; at < to; at += 1) out[at] = 0x20;
      const word = " null ";
      if (to - from >= word.length) for (let i = 0; i < word.length; i += 1) out[from + i] = word.charCodeAt(i);
      return out;
    }
    case "stream-data": {
      const text = latin1Text(bytes.subarray(target.start, target.end));
      const streamAt = text.search(/(?<![A-Za-z])stream(\r\n|\n|\r)/u);
      const endAt = text.lastIndexOf("endstream");
      if (streamAt < 0 || endAt < 0) return out;
      const dataStart = target.start + streamAt + "stream".length + 1;
      const dataSize = target.start + endAt - dataStart;
      if (dataSize <= 0) return out;
      const from = dataStart + (damage.at % dataSize);
      for (let i = 0; i < damage.length && from + i < dataStart + dataSize; i += 1) out[from + i] = damage.byte;
      return out;
    }
  }
}
