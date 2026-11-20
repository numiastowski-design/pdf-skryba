/** The ADVANCE of a glyph, in thousandths of an em — the last thing pdf.js gave the text path before its removal (1/11/2026)
 *  (ISO 32000-1:2008 §9.6.2.1 `/Widths` and `/FirstChar`, §9.8.1 `/MissingWidth`, §9.7.4.3 `/W` and `/DW`).
 *  Decides: that a width nothing declares is an ABSTENTION (`undefined`), never a zero and never an average —
 *  a wrong advance moves every glyph after it, which is how words get glued or split; that a CID font's default
 *  is `/DW`, or 1000 when it has none (§9.7.4.3); and that `/W` mixes its two forms (`c [w w w]` and
 *  `cFirst cLast w`) in one array, which is what real files do.
 *  The abstention does not hold for a Type0 font: a composite font gives at least its descendant's `/DW`, because
 *  the caller reads `?? 0` and an abstention stacked every letter of a line on one point. Simple fonts still abstain.
 *  THE 14 STANDARD FONTS have no `/Widths`: their metrics are read BY glyph NAME in
 *  `./glyph-data.ts` (§9.6.2.2), with the aliases that producers write (Arial → Helvetica) and the subset
 *  prefix removed (§9.6.4). ⚠️ This header said the OPPOSITE until the evening of 31/10/2026 ("a datum
 *  we do not embed — we abstain"): it was true in the morning, and the 12 903 advances then missing
 *  fell to ZERO when the metrics came in.
 *  WHAT WE RETURN, for a Type 3 font as for the others: the value of `/Widths` AS IS, in glyph
 *  space — this is also what pdf.js returned, and it is the caller that scales it by `/FontMatrix`
 *  (`extractor/glyph-positions.ts`). Putting the scale here would double the multiplication.
 *  NOT here: the text a code paints (`./font-text.ts`), the positions (`extractor/glyph-positions.ts`), the font
 *  programs — and nothing of pdf.js.
 *  Called by: `extractor/pdf-glyph-source.ts` (the advance of each painted glyph), the POC's tools (`tools/poc/`),
 *  and `widths.test.ts`. */

import type { PdfDict, PdfValue } from "../pdf-objects/objects";
import { encodingChoiceOf, type FontReader } from "./font-text";
import { MAX_CID_WIDTH_ENTRIES } from "./bounds";
import { chargeTableEntries, type TableBudget } from "./table-budget";
import { STANDARD_METRICS } from "./glyph-data";
import { cidTableOf } from "./predefined-cmaps";
import { encodingNames, standardFontOf } from "./names";

/** §9.7.4.3: the default advance of a CID font that declares no `/DW`. */
const DEFAULT_CID_WIDTH = 1000;

const numberOf = (reader: FontReader, value: PdfValue | undefined): number | undefined => {
  const resolved = reader.resolve(value);
  return resolved?.kind === "number" && Number.isFinite(resolved.value) ? resolved.value : undefined;
};

const builtInEncodingOf = (standard: string): string | undefined => {
  if (standard === "Symbol") return "SymbolEncoding";
  if (standard === "ZapfDingbats") return "ZapfDingbatsEncoding";
  return undefined;
};

/** §9.6.2.2: a STANDARD font carries no `/Widths` — its metrics are a known datum, read BY GLYPH NAME, so the
 *  encoding in force decides which width a code gets. */
function standardWidths(reader: FontReader, font: PdfDict, standard: string): (code: number) => number | undefined {
  const metrics = STANDARD_METRICS.get(standard);
  // Symbol and ZapfDingbats have their own internal encoding (§9.6.6.1); the others fall back on Standard. The reading
  // of the encoding is that of `font-text.ts`, and it is the same for the text and for the advance: see its
  // header for what two separate readings cost.
  const names = encodingNames(encodingChoiceOf(reader, font, builtInEncodingOf(standard)));
  return (code) => {
    const name = code >= 0 && code < 256 ? (names[code] as string) : "";
    return name === "" ? undefined : metrics?.get(name);
  };
}

/** §9.6.2.1: `/Widths` is indexed from `/FirstChar`; `/MissingWidth` answers for a code outside it. */
function simpleWidths(reader: FontReader, font: PdfDict): (code: number) => number | undefined {
  const first = numberOf(reader, font.get("FirstChar")) ?? 0;
  const widths = reader.resolve(font.get("Widths"));
  const descriptor = reader.dictOf(font.get("FontDescriptor"));
  const missing = numberOf(reader, descriptor?.get("MissingWidth"));
  if (widths?.kind !== "array") {
    // No `/Widths` at all: a standard font answers from its metrics, anything else abstains.
    const baseFont = reader.resolve(font.get("BaseFont"));
    const standard = standardFontOf(baseFont?.kind === "name" ? baseFont.value : undefined);
    if (standard !== undefined) return standardWidths(reader, font, standard);
    return () => missing;
  }

  const table = widths.items.map((item) => numberOf(reader, item));
  return (code) => {
    const at = code - first;
    const width = at >= 0 && at < table.length ? table[at] : undefined;
    return width ?? missing;
  };
}

type Resolved = ReturnType<FontReader["resolve"]>;

/** The `/W` table under construction, and what is left of its entry budget. */
interface WidthTable {
  readonly table: Map<number, number>;
  budget: number;
  /** The last CID an entry may concern: 65 535 by default (§9.7.4.2); for a predefined CMap whose table we hold, the
   *  last CID it reaches. */
  readonly highest: number;
}

function placeWidth(state: WidthTable, cid: number, width: number): void {
  // §9.7.4.2: a CID fits in two bytes. Outside this range, nothing is placed. And for a predefined CMap whose table we
  // hold, nothing beyond the last CID that table reaches: such an entry is DEAD, no code can ask for it, and paying it
  // refused documents (`/W [0 65535 w]`, fourteen bytes, placed 65 536 advances — reviews of 03/11/2026).
  if (cid < 0 || cid > state.highest || state.budget <= 0) return;
  state.budget -= 1;
  state.table.set(cid, width);
}

/** The form `c [w w w]`: one width per CID from `c`. */
function placeWidthList(
  reader: FontReader,
  state: WidthTable,
  start: number,
  list: readonly (PdfValue | undefined)[],
): void {
  for (const [offset, width] of list.entries()) {
    const value = numberOf(reader, width);
    if (value !== undefined) placeWidth(state, start + offset, value);
  }
}

/** The form `cFirst cLast w`: one width for a whole range of CIDs. */
function placeWidthRange(state: WidthTable, first: number, last: number, width: number): void {
  const from = Math.max(first, 0);
  const to = Math.min(last, state.highest);
  for (let cid = from; cid <= to && state.budget > 0; cid += 1) placeWidth(state, cid, width);
}

/** One entry of `/W` starting at `at`; returns where the next one starts. */
function readWidthEntry(reader: FontReader, items: readonly Resolved[], at: number, state: WidthTable): number {
  const first = items[at];
  if (first?.kind !== "number" || !Number.isInteger(first.value)) return at + 1;
  const second = items[at + 1];
  if (second?.kind === "array") {
    placeWidthList(reader, state, first.value, second.items);
    return at + 2;
  }
  const third = items[at + 2];
  if (second?.kind === "number" && third?.kind === "number" && Number.isInteger(second.value)) {
    placeWidthRange(state, first.value, second.value, third.value);
    return at + 3;
  }
  return at + 1;
}

/** The widths of a descendant font, by descendant DICTIONARY (the reader returns one object per indirect object): several Type0 fonts naming
 *  the same descendant read and charge its `/W` once, as `/ToUnicode` is read once per object (performance review of 02/11/2026). */
/** The key also carries the CID ceiling, because it changes the table: one descendant named by an `Identity-H` font
 *  and by a `UniCNS-UCS2-H` one does not hold the same entries. */
const WIDTHS_OF_DESCENDANT = new WeakMap<PdfDict, Map<number, (code: number) => number | undefined>>();

/** §9.7.4.3: `/W` mixes `c [w w w]` and `cFirst cLast w`; anything else in it is ignored, never guessed. */
function cidWidths(
  reader: FontReader,
  descendant: PdfDict,
  budget: TableBudget | undefined,
  highest = 65_535,
): (code: number) => number | undefined {
  let byCeiling = WIDTHS_OF_DESCENDANT.get(descendant);
  const known = byCeiling?.get(highest);
  if (known !== undefined) return known;
  const widths = readCidWidths(reader, descendant, budget, highest);
  if (byCeiling === undefined) {
    byCeiling = new Map();
    WIDTHS_OF_DESCENDANT.set(descendant, byCeiling);
  }
  byCeiling.set(highest, widths);
  return widths;
}

function readCidWidths(
  reader: FontReader,
  descendant: PdfDict,
  budget: TableBudget | undefined,
  highest: number,
): (code: number) => number | undefined {
  const fallback = numberOf(reader, descendant.get("DW")) ?? DEFAULT_CID_WIDTH;
  const w = reader.resolve(descendant.get("W"));
  // 🔴 ONE ENTRY BUDGET FOR THE WHOLE ARRAY, not per range (security review of 31/10/2026). Without it the
  // cost was the file size MULTIPLIED by 65 536: `0 65535 500` repeated fits in 14 bytes and places
  // 65 536 advances, so 140 KB of `/W` demanded 6.5 × 10⁸ writes. And a NEGATIVE START (`-100000000 0 1`,
  // twenty bytes) made a hundred million iterations until `RangeError: Map maximum size exceeded` — an error
  // that is not a refusal, after 450 MB of heap on a runtime that has 512.
  const state: WidthTable = { table: new Map<number, number>(), budget: MAX_CID_WIDTH_ENTRIES, highest };

  if (w?.kind === "array") {
    const items = w.items.map((item) => reader.resolve(item));
    let at = 0;
    while (at < items.length) at = readWidthEntry(reader, items, at, state);
  }
  // The table is kept with the font, for the whole document: its entries are charged to the document's budget.
  chargeTableEntries(budget, state.table.size);

  return (code) => state.table.get(code) ?? fallback;
}

/** The advance of each code of this font, read once; the function it returns is pure. */
export function fontWidths(
  reader: FontReader,
  font: PdfDict,
  budget?: TableBudget,
): (code: number) => number | undefined {
  const subtype = reader.resolve(font.get("Subtype"));
  if (subtype?.kind === "name" && subtype.value === "Type0") {
    // 🔴 `/W` IS INDEXED BY CID, NOT BY CODE (§9.7.4.3), and the code equals the CID only for `Identity-H/V`.
    // For any other CMap the CID comes from the CMap (§9.7.5, §9.7.6.2): we hold Adobe's table for TWO predefined
    // collections (`./cns-cmap-data.ts`, `./jis-cmap-data.ts`, 03/11/2026) and read the exact CID there; for every
    // other CMap — the legacy mixed-byte ones, the GB and KS collections, an embedded CMap — we still refuse to read
    // `/W`, because returning the advance of ANOTHER glyph glues or splits words with no refusal to show for it
    // (`high` review of 31/10/2026, a Japanese PDF in `/90ms-RKSJ-H`). Those fall back on `/DW`.
    // Measured on 304 files the 31/10, re-measured on 415 the 03/11: 1 156 Type0 fonts are `Identity-H`, and exactly
    // two documents carry a predefined CMap — one `UniCNS-UCS2-H`, one `UniJIS-UCS2-H`.
    const encoding = reader.resolve(font.get("Encoding"));
    const identity = encoding?.kind === "name" && encoding.value.startsWith("Identity");
    const descendants = reader.resolve(font.get("DescendantFonts"));
    const descendant = descendants?.kind === "array" ? reader.dictOf(descendants.items[0]) : undefined;
    // An unreadable descendant (absent, empty, not a dictionary) is no reason to return `undefined`: the caller
    // reads it `?? 0` and stacks every letter on one point. §9.7.4.3 gives 1 000 when the file says nothing: the
    // chosen bias, ugly and visible.
    if (descendant === undefined) return () => DEFAULT_CID_WIDTH;
    // 🔴 `/W` IS UNUSABLE WITHOUT THE CID, BUT `/DW` IS USABLE (03/11/2026, found by a screenshot of
    // safedocs 0000316, a third-party PDF of the measurement corpus). §9.7.4.3 makes `/DW` the default advance of EVERY CID the font does not list:
    // it is the font's OWN declaration, never another glyph's advance, so the reason for the abstention above does
    // not reach it. Returning `undefined` for the whole font made the caller place every letter at the SAME point
    // (`glyph-positions.ts` reads `g.width ?? 0`): that file published 155 words of stacked letters —
    // « PhrmolgyFNue15tfnEd » — while the viewer showed « Basic Pharmacology For Nurses 15th Fifteenth Edition ».
    // Evenly spaced letters are ugly where the real advances vary; stacked letters are WRONG, and the bias of this
    // project is chosen: ugly and visible rather than wrong and invisible.
    if (!identity) {
      // With the table of a predefined CMap, the code gives the CID, the CID gives `/W`, and the advance is exact.
      const encodingName = encoding?.kind === "name" ? encoding.value : "";
      const fallback = numberOf(reader, descendant.get("DW")) ?? DEFAULT_CID_WIDTH;
      // `/W` is not read without the table: `cidWidths` reads the array and charges it to the document's table
      // budget, so a few fonts declaring `/W [0 65535 1000]` would refuse a document that `/DW` alone publishes.
      // The table is resolved here, once, not for each code a page paints.
      const table = cidTableOf(encodingName);
      if (table === undefined) return () => fallback;
      const byCid = cidWidths(reader, descendant, budget, table.highest);
      return (code) => {
        const cid = table.of(code);
        return cid === undefined ? fallback : byCid(cid);
      };
    }
    return cidWidths(reader, descendant, budget);
  }
  return simpleWidths(reader, font);
}
