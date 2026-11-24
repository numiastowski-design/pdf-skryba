/** The PREDEFINED CMaps a composite font may name in `/Encoding` (ISO 32000-1:2008 §9.7.5.2,
 *  Table 118) — and the only family whose text we can read WITHOUT embedding a single table.
 *  Decides: that `UniXXX-UCS2-[HV]` is read by IDENTITY, and that no other predefined CMap is read at all.
 *
 *  THE FACT THAT DECIDES, and its source. Checked on 31/10/2026 in Adobe's official repository
 *  (`adobe-type-tools/cmap-resources`, BSD-3-Clause): a `UniXXX-UCS2-[HV]` CMap
 *  has the code space `0x0000–0xD7FF & 0xE000–0xFFFF` — the basic multilingual plane minus the surrogate
 *  block. The CODE there is thus the Unicode code point itself, on two fixed bytes, and its destination is
 *  a CID of the collection (Adobe-CNS1, Adobe-GB1, Adobe-Japan1, Adobe-Korea1).
 *  Consequence: for the TEXT, we need nothing — the code is read as is. For the ADVANCE, the CID is needed, which
 *  only Adobe's table gives: we hold TWO of them since the 03/11/2026 (`./cns-cmap-data.ts`, `./jis-cmap-data.ts`),
 *  so those two collections have their exact advance; any other keeps the `/DW` default of the font (§9.7.4.3).
 *  ⚠️ This paragraph said until that day « `./widths.ts` therefore abstains […] they now have only the text, without
 *  advance » — true from the 01/11 to the 03/11, and the cause of 155 invented words on a real file: an abstained
 *  advance is read `?? 0` by the caller, which stacks every letter of a line on one point.
 *
 *  WHY THIS FAMILY AND NOT THE OTHERS, written down rather than discovered later:
 *  - the `UTF16` variants (which REPLACE the UCS2 ones, marked obsolete by Adobe) carry in their code space
 *    a FOUR-byte range, `<D800DC00> <DBFFDFFF>`: a character outside the BMP is ONE four-byte
 *    code there, where our two-byte split would make two. The glyph count would not fall, so
 *    the pairing with pdf.js (historical) would have failed and the whole page would have gone back to it. They therefore stay unread, on purpose;
 *  - the legacy encodings (`90ms-RKSJ-H`, `B5pc-H`, `GBK-EUC-H`, `ETen-B5-H`…) are MIXED-byte and their
 *    code says nothing about the character: the real code → CID table is needed, then CID → Unicode through the
 *    `Adobe-XXX-UCS2` CMap of the collection. That is data to embed, and it is a separate lot.
 *  Measured on 31/10/2026: over 415 real files, the only fonts with a predefined CMap are in TWO safedocs, and all
 *  the other 1 156 Type0 fonts are in `Identity`. ⚠️ This line said both were `UniCNS-UCS2-H`: measured again on the
 *  03/11/2026, one is (`0000316.pdf`, `MSungStd-Light-Acro`, Chinese collection) and the other is `UniJIS-UCS2-H`
 *  (`0000877.pdf`, Japanese collection). Both documents are in ENGLISH — they are spam PDFs whose template draws
 *  Latin letters with a CJK font — which is why a Japanese table is what a « Kite Runner Study Guide » needs.
 *  We hold BOTH tables since the 03/11/2026 (`./cns-cmap-data.ts`, `./jis-cmap-data.ts`), so both documents are read
 *  with their exact advances. The other collections (GB, KS) and the legacy mixed-byte encodings are not held: a font
 *  in one of those keeps the `/DW` fallback, evenly spaced letters where the real widths vary.
 *  NOT here: reading a `/ToUnicode` CMap (`./to-unicode.ts`), the text of a code (`./font-text.ts`), the
 *  advances (`./widths.ts`), the splitting of codes (`extractor/pdf-glyph-source.ts`).
 *  Called by: `./font-text.ts`, `extractor/pdf-glyph-source.ts`, and `predefined-cmaps.test.ts`. */

/** ⚠️ WHAT THIS READING IS WORTH, MEASURED, AND THE BIAS CHOSEN. On the two safedocs in `UniCNS-UCS2-H`
 *  (safedocs 0000316 and 0000877, two third-party PDFs of the measurement corpus, 20 pages, 15 709 glyphs, 31/10/2026):
 *  19 pages out of 20 paired, `isSpace` at 100 %, and the text agreeing with pdf.js (then present) at 99.91 %.
 *  The 14 disagreements are all PUNCTUATION, and always the same thing: we return `|` (U+007C) and `–`
 *  (U+2013), where pdf.js returned `¦` (U+00A6) and `‒` (U+2012). Both readings are defensible and did not say
 *  the same thing: we return the CODE the producer wrote, pdf.js returned what Adobe's table says of the
 *  GLYPH that this code leads to (go to the CID, then come back through `Adobe-CNS1-UCS2`).
 *  🔴 AND THIS IS A TENSION WITH ONE OF OUR OWN PRINCIPLES, better named than left to be discovered: "we publish
 *  what the editor DISPLAYS, never what the file stores". Applied to the letter, it would side with
 *  the reading pdf.js gave. We choose the declared code because reading the glyph would need the two Adobe tables, which
 *  we do not embed — and because the declared code is what an author typed, hence what a Confluence
 *  search will look for. The bias is chosen, visible and quantified: 14 glyphs out of 15 709, zero words touched.
 *  One page out of twenty was not paired, by ONE glyph (688 against 689): it went back whole to pdf.js,
 *  and the fallback was counted (`extraction-cost.ts#pagesOurGlyphsDeclined`). The cause is not elucidated. */

/** The SHAPE of the codes of a CMap whose code is Unicode — it decides the splitting.
 *  - `"ucs2"`: two FIXED bytes. The code space is `0x0000–0xD7FF & 0xE000–0xFFFF`, so there is never
 *    a surrogate pair, hence never a longer code.
 *  - `"utf16"`: two bytes, FOUR for a surrogate pair. The code space carries three ranges —
 *    `<0000> <D7FF>`, `<D800DC00> <DBFFDFFF>`, `<E000> <FFFF>` — and that is the only thing that distinguishes these CMaps
 *    from the UCS2 ones they replace. A character outside the BMP is ONE four-byte code there, not two of two. */
export type UnicodeCodeForm = "ucs2" | "utf16";

/** The four Adobe CJK collections. `UniJIS-UCS2-HW-[HV]` is the half-width variant of Japanese: its code
 *  remains a Unicode code point, only the drawn shapes change. */
const UCS2_PREDEFINED = /^Uni(?:CNS|GB|JIS|KS)-UCS2-(?:HW-)?[HV]$/u;
const UTF16_PREDEFINED = /^Uni(?:CNS|GB|JIS|KS)-UTF16-[HV]$/u;

import { CNS_RANGE_FIRST_CID, CNS_RANGE_FIRST_CODE, CNS_RANGE_LAST_CODE } from "./cns-cmap-data";
import { JIS_RANGE_FIRST_CID, JIS_RANGE_FIRST_CODE, JIS_RANGE_LAST_CODE } from "./jis-cmap-data";

/** The shape of this predefined CMap's codes, or `undefined` when we cannot read it. */
export function unicodeCodeForm(encoding: string): UnicodeCodeForm | undefined {
  if (UCS2_PREDEFINED.test(encoding)) return "ucs2";
  if (UTF16_PREDEFINED.test(encoding)) return "utf16";
  return undefined;
}

/** Is the code of this predefined CMap the Unicode code point itself? */
export const codeIsUnicodeScalar = (encoding: string): boolean => unicodeCodeForm(encoding) !== undefined;

/** THE COLLECTIONS whose code → CID table we hold: Adobe-CNS1 (`./cns-cmap-data.ts`, 16 418 ranges) and
 *  Adobe-Japan1 (`./jis-cmap-data.ts`, 8 533). They are the only predefined CMaps the measure of 31/10/2026 and
 *  03/11/2026 found in real files — one document each over 415 — and nothing else is worth its weight for now.
 *  `-V` shares the horizontal table: a vertical CMap changes the WRITING direction and the vertical metrics, never
 *  the code → CID mapping. */
const HELD_UCS2 = /^Uni(CNS|JIS)-UCS2-[HV]$/u;

interface CidRanges {
  readonly first: Uint16Array;
  readonly last: Uint16Array;
  readonly cid: Uint16Array;
  /** The highest CID the collection holds. A `/W` entry above it is DEAD: no code of this CMap can ask for it. */
  readonly highest: number;
}

/** What a held CMap answers: the CID of a code, and the last CID of its collection. */
export interface CidTable {
  readonly of: (code: number) => number | undefined;
  readonly highest: number;
}

/** The three base64 columns of each collection. What is LAZY is the DECODING: the 98 KB and 51 KB of typed arrays are
 *  built on first use and kept for the container's life, so a document without such a font never builds them
 *  (measured: 1 156 of our 1 158 composite fonts are `Identity`). The base64 strings themselves are static imports:
 *  they are in the bundle and parsed on every invocation, held or not (performance review of 03/11/2026, which read
 *  an earlier version of this comment as a claim that nothing at all was paid). */
const COLUMNS: Readonly<Record<string, readonly [string, string, string]>> = {
  CNS: [CNS_RANGE_FIRST_CODE, CNS_RANGE_LAST_CODE, CNS_RANGE_FIRST_CID],
  JIS: [JIS_RANGE_FIRST_CODE, JIS_RANGE_LAST_CODE, JIS_RANGE_FIRST_CID],
};

const tables = new Map<string, CidRanges>();

/** A base64 column, as sixteen-bit values. The pairs are read LITTLE-ENDIAN BY HAND, never through the buffer: a
 *  `Uint16Array` over the bytes takes the HOST's order, and the generator writes the order of the machine that ran it
 *  (`tools/poc/build-cns-cmap.ts`). Both sides being host-ordered, the two agree only by coincidence — and no test can
 *  catch it, since both run on the same host (performance and logic reviews of 03/11/2026). Decoded byte by byte
 *  rather than through the string iterator of `Uint8Array.from`: 98 500 iterations for Adobe-CNS1, each allocating a
 *  one-character string. */
const columnOf = (base64: string): Uint16Array => {
  const text = atob(base64);
  const out = new Uint16Array(text.length >> 1);
  for (let at = 0; at < out.length; at++) out[at] = text.charCodeAt(at * 2) | (text.charCodeAt(at * 2 + 1) << 8);
  return out;
};

function rangesOf(collection: string): CidRanges {
  const known = tables.get(collection);
  if (known !== undefined) return known;
  const [first, last, cid] = COLUMNS[collection]!;
  const codes = { first: columnOf(first), last: columnOf(last), cid: columnOf(cid) };
  let highest = 0;
  for (let at = 0; at < codes.first.length; at++)
    highest = Math.max(highest, codes.cid[at]! + (codes.last[at]! - codes.first[at]!));
  const built: CidRanges = { ...codes, highest };
  tables.set(collection, built);
  return built;
}

/** The code → CID reader of this predefined CMap, or `undefined` when we hold no table for it. ONE function for the
 *  two questions — « do we hold it? » and « what is this code's CID? » — because the caller must ask the first BEFORE
 *  paying for the second: reading `/W` costs entries on the document's font-table budget, and spending them for a
 *  collection whose CID we can never compute refused real documents (`font-tables-too-many`, second review of
 *  03/11/2026). Asking once also keeps the name match and the collection lookup OUT of the per-glyph path: they ran
 *  on every painted code, up to a million per page (performance review of the same day).
 *  🔴 WHY A CID MATTERS, and it is not the text: `/W` is indexed by CID (§9.7.4.3), so without this table the advance
 *  of every glyph of such a font fell back on `/DW`, one uniform width — and a real file published
 *  « Yeah, reviewing basic  pharmacology a book  forcould nurses amass » where the viewer shows a clean sentence
 *  (safedocs 0000316, a third-party PDF of the measurement corpus, 03/11/2026). The TEXT never needed it: the code IS the code point.
 *  The ranges are sorted and disjoint (Adobe's own file, checked at generation), so a binary search answers in
 *  O(log n); a code outside every range gives `undefined`.
 *  ⚠️ The `notdefrange` of the resource (`<0000>–<001F>` → CID 1) is NOT held: those are the C0 controls, which this
 *  product never publishes (`glyph-positions.ts#isInventedControl`), so they keep the `/DW` fallback. */
export function cidTableOf(encoding: string): CidTable | undefined {
  const held = HELD_UCS2.exec(encoding);
  if (held === null) return undefined;
  const { first, last, cid, highest } = rangesOf(held[1]!);
  const of = (code: number): number | undefined => {
    let low = 0;
    let high = first.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (code < first[mid]!) high = mid - 1;
      else if (code > last[mid]!) low = mid + 1;
      else return cid[mid]! + (code - first[mid]!);
    }
    return undefined;
  };
  return { of, highest };
}

/** The codes of a painted string, according to the shape of the CMap.
 *  🔴 THE VARIABLE SPLITTING OF UTF16 IS HERE, and nowhere else: a HIGH half-pair opens a
 *  four-byte code, which then equals `(high << 16) | low`. A high half-pair at the end of the string, or followed
 *  by something other than a low one, stays a two-byte code: the file is then malformed, and `./font-text.ts`
 *  will abstain on this code rather than invent the missing half. */
export function unicodeCodes(bytes: Uint8Array, form: UnicodeCodeForm): number[] {
  const codes: number[] = [];
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    const unit = (bytes[at] as number) * 256 + (bytes[at + 1] as number);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    if (form === "utf16" && isHigh && at + 3 < bytes.length) {
      const low = (bytes[at + 2] as number) * 256 + (bytes[at + 3] as number);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codes.push(unit * 0x10000 + low);
        at += 2;
        continue;
      }
    }
    codes.push(unit);
  }
  // A lone byte at the end of the string: the file is malformed for a two-byte CMap. We keep it as a code,
  // so that the NUMBER of glyphs stays that of the painted bytes; the text, for its part, will abstain.
  if (bytes.length % 2 !== 0) codes.push(bytes[bytes.length - 1] as number);
  return codes;
}

/** The text of a code of this family: the code IS the character, and a four-byte code is a pair. */
export function textOfUnicodeCode(code: number): string | undefined {
  if (code > 0xffff) {
    const high = Math.floor(code / 0x10000);
    const low = code % 0x10000;
    return String.fromCharCode(high, low);
  }
  // A U+0000 or a lone half-pair is not a character: abstention, as everywhere else with us.
  return code > 0 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCharCode(code) : "";
}
