/** The STRUCTURE counters of the Word second reading (`docs/CONCEPTION-CONTROLE-STRUCTURE.md` section 3.1, 3.4): what the document declares
 *  (headings per level, outermost tables, list items), what the page withholds (a table over the caps, with what is inside it), flattens
 *  (headings and items inside a NESTED table, published as text of the outer cell) and adds (a chart's table, a called note's list item).
 *  The walk of `source-reading-docx.ts` calls it at the paragraph, the table, the drawing and the note; this module holds the state between those
 *  calls (table depth, withheld depth, inside a note) and decides where a count goes. Lot 1 (choice C5 reduced): no cell and no row of a Word
 *  table is counted, except a chart's table, which the page adds whole.
 *  Rules written from ECMA-376 Part 1, not from the extractor: the style name `heading N` (N 1 to 6) or `Title` is a heading, a derived style
 *  by `w:basedOn` too, a style defined nowhere is a plain paragraph (section 17.7); a paragraph that is not a heading and carries a numbering the
 *  document defines (a `w:num` of `numbering.xml` with that level, section 17.9) is a list item; a paragraph that shows no text counts for nothing.
 *  NOT here: reading the XML (`source-reading-docx.ts`), the words, comparing with the page (`pipeline/structure-conservation.ts`).
 *  Called by: `pipeline/source-reading-docx.ts`. */

import type { StructureCounts } from "doc-ir/lib/reader-types";
import { emptyUnitStructure, type UnitStructure } from "./conservation-source";
import type { ChartShape } from "./source-reading-chart";
import { attrOf, first, kidsOf, tagOf, type N } from "./source-reading-package";
import { addHeading } from "./structure-counts";

/** The heading level (1 to 6) a built-in style NAME gives: `heading N`, `Title`; compared without case and blanks around. A `Subtitle` is `"plain"`
 *  (a plain paragraph, whatever its base style is). */
export const headingLevelOfName = (name: string): number | "plain" | undefined => {
  const lower = name.trim().toLowerCase();
  const heading = /^heading ([1-6])$/.exec(lower);
  if (heading) return Number(heading[1]);
  if (lower === "title") return 1;
  return lower === "subtitle" ? "plain" : undefined;
};

/** The same reading from the style ID, for a style that declares no name or is defined nowhere (`Heading3`, `Title`). */
export const headingLevelOfId = (id: string): number | "plain" | undefined => {
  const heading = /^Heading([1-6])$/.exec(id);
  if (heading) return Number(heading[1]);
  if (id === "Title") return 1;
  return id === "Subtitle" ? "plain" : undefined;
};

export class DocxStructureTally {
  readonly unit: UnitStructure = emptyUnitStructure();
  private tableDepth = 0;
  private withheldDepth = 0;
  private noteDepth = 0;

  /** A paragraph read: `level` its heading level when its style is a heading style, `numbered` whether it carries a list number, `shows` whether it
   *  shows any text. */
  paragraph(level: number | undefined, numbered: boolean, shows: boolean): void {
    if (this.noteDepth > 0 || !shows) return;
    if (level === undefined && !numbered) return;
    // A numbered heading stays a heading, never an item.
    const where = this.destination();
    for (const counts of where) {
      if (level !== undefined) addHeading(counts, level);
      else counts.items++;
    }
  }

  /** The sets a count of the paragraph being read goes to: always `declared`, and `withheld` or `flattened` when the page does not publish it as such. */
  private destination(): StructureCounts[] {
    if (this.withheldDepth > 0) return [this.unit.declared, this.unit.withheld];
    if (this.tableDepth >= 2) return [this.unit.declared, this.unit.flattened];
    return [this.unit.declared];
  }

  enterTable(withheld: boolean): void {
    if (this.noteDepth === 0 && this.tableDepth === 0) {
      this.unit.declared.tables++;
      if (withheld) this.unit.withheld.tables++;
    }
    this.tableDepth++;
    if (withheld) this.withheldDepth++;
  }

  leaveTable(withheld: boolean): void {
    this.tableDepth--;
    if (withheld) this.withheldDepth--;
  }

  /** A chart the page publishes as a table (never one it withholds whole, never one inside a table it does not publish). */
  chart(shape: ChartShape | undefined): void {
    if (shape === undefined || this.noteDepth > 0 || this.withheldDepth > 0) return;
    this.unit.added.tables++;
    this.unit.added.rows += shape.rows;
    this.unit.added.cells += shape.rows * shape.columns;
  }

  /** A note the page publishes (called from the published text): one more list item at the end of the page. */
  note(): void {
    this.unit.added.items++;
  }

  enterNote(): void {
    this.noteDepth++;
  }

  leaveNote(): void {
    this.noteDepth--;
  }
}

// ---------------------------------------------------------------------------
// List items: a numbering the document DEFINES (ECMA-376 Part 1 section 17.9, numbering; section 17.7, styles)

/** The highest level `w:ilvl` can name (nine levels, 0 to 8, section 17.9.3). */
const LAST_LEVEL = 8;

interface StyleNumPr {
  numId: string | undefined;
  ilvl: string | undefined;
}

const valueOf = (el: N | undefined, tag: string): string | undefined => attrOf(first(el, tag) ?? {}, "w:val");

const levelIndex = (raw: string | undefined): number | undefined => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 0 && n <= LAST_LEVEL ? n : undefined;
};

/** What `styles.xml` says of numbering: per style id, its base and the `w:numPr` of its paragraph properties (if it has one). */
const readStyleNumbering = (styles: N | undefined) => {
  const byId = new Map<string, { basedOn: string | undefined; numPr: StyleNumPr | undefined }>();
  let defaultParagraph: string | undefined;
  for (const style of styles ? kidsOf(styles) : []) {
    const id = tagOf(style) === "w:style" ? attrOf(style, "w:styleId") : undefined;
    if (id === undefined) continue;
    const numPr = first(first(style, "w:pPr"), "w:numPr");
    byId.set(id, {
      basedOn: valueOf(style, "w:basedOn"),
      numPr: numPr === undefined ? undefined : { numId: valueOf(numPr, "w:numId"), ilvl: valueOf(numPr, "w:ilvl") },
    });
    // A style with no `w:type` is a paragraph style (ST_StyleType default, section 17.7.4.17).
    if (
      ["1", "true", "on"].includes(attrOf(style, "w:default") ?? "") &&
      (attrOf(style, "w:type") ?? "paragraph") === "paragraph"
    )
      defaultParagraph ??= id;
  }
  // Depends on the style id alone: memoised.
  const memo = new Map<string | undefined, StyleNumPr | undefined>();
  const nearest = (styleId: string | undefined): StyleNumPr | undefined => {
    const seen = new Set<string>();
    for (let cur = styleId ?? defaultParagraph; cur !== undefined && !seen.has(cur); cur = byId.get(cur)?.basedOn) {
      seen.add(cur);
      const numPr = byId.get(cur)?.numPr;
      if (numPr !== undefined) return numPr;
    }
    return undefined;
  };
  return {
    /** The first `w:numPr` along the style's `basedOn` chain (the default paragraph style when none is named). */
    numPrOf: (styleId: string | undefined): StyleNumPr | undefined => {
      if (!memo.has(styleId)) memo.set(styleId, nearest(styleId));
      return memo.get(styleId);
    },
  };
};

/** The levels an abstract definition writes (`w:lvl` with a level 0 to 8). */
const levelsWritten = (abstract: N): Set<number> =>
  new Set(
    kidsOf(abstract)
      .flatMap((l) => (tagOf(l) === "w:lvl" ? [levelIndex(attrOf(l, "w:ilvl"))] : []))
      .filter((i): i is number => i !== undefined),
  );

/** The levels a `w:num` redefines whole (a `w:lvlOverride` that carries a `w:lvl`; one with only a start value defines nothing). */
const overriddenLevels = (num: N): number[] =>
  kidsOf(num)
    .filter((k) => tagOf(k) === "w:lvlOverride" && first(k, "w:lvl") !== undefined)
    .flatMap((k) => [levelIndex(attrOf(k, "w:ilvl"))])
    .filter((i): i is number => i !== undefined);

/** The levels each `w:num` of `numbering.xml` defines: its abstract definition's `w:lvl` (those of the numbering style a `w:numStyleLink` names when it has
 *  none of its own, a loop giving none) plus a `w:lvlOverride` that carries a whole `w:lvl`. A `numId` absent from the part defines no level. */
const readDefinedLevels = (
  numbering: N | undefined,
  numIdOfStyle: (styleId: string) => string | undefined,
): ReadonlyMap<string, ReadonlySet<number>> => {
  const abstracts = new Map<string, { levels: Set<number>; link: string | undefined }>();
  const abstractOfNum = new Map<string, string>();
  const children = numbering ? kidsOf(numbering) : [];
  const nums = children.filter((n) => tagOf(n) === "w:num");
  for (const a of children.filter((n) => tagOf(n) === "w:abstractNum")) {
    const id = attrOf(a, "w:abstractNumId");
    const levels = levelsWritten(a);
    if (id !== undefined) abstracts.set(id, { levels, link: valueOf(a, "w:numStyleLink") });
  }
  for (const n of nums) {
    const numId = attrOf(n, "w:numId");
    const abstractId = valueOf(n, "w:abstractNumId");
    if (numId !== undefined && abstractId !== undefined) abstractOfNum.set(numId, abstractId);
  }
  const levelsOf = (abstractId: string, seen: Set<string> = new Set()): ReadonlySet<number> => {
    const def = abstracts.get(abstractId);
    if (def === undefined || seen.has(abstractId)) return new Set();
    seen.add(abstractId);
    if (def.levels.size > 0 || def.link === undefined) return def.levels;
    const linkedNum = numIdOfStyle(def.link);
    const linked = linkedNum === undefined ? undefined : abstractOfNum.get(linkedNum);
    return linked === undefined ? new Set() : levelsOf(linked, seen);
  };
  const defined = new Map<string, ReadonlySet<number>>();
  for (const n of nums) {
    const numId = attrOf(n, "w:numId");
    const abstractId = valueOf(n, "w:abstractNumId");
    if (numId === undefined || abstractId === undefined) continue;
    const levels = new Set(levelsOf(abstractId));
    for (const ilvl of overriddenLevels(n)) levels.add(ilvl);
    defined.set(numId, levels);
  }
  return defined;
};

/** Whether a paragraph (its `w:pPr`) is a list item by what the document defines: a `w:numId` other than 0, written on the paragraph or on its style
 *  (the `w:numPr` of the nearest style that has one), that `numbering.xml` defines, at a level that definition has (`w:ilvl`, 0 when unwritten, a
 *  level past 8 read as 8). Anything else is a plain paragraph, as Word shows it and as the page publishes it. */
export const createListRule = (styles: N | undefined, numbering: N | undefined): ((pPr: N | undefined) => boolean) => {
  const styleNumbering = readStyleNumbering(styles);
  // A `w:numStyleLink` names a numbering style whose numId comes from its own `w:numPr` or from the nearest base style that has one.
  const defined = readDefinedLevels(numbering, (styleId) => styleNumbering.numPrOf(styleId)?.numId);
  return (pPr) => {
    const direct = first(pPr, "w:numPr");
    const fromStyle = styleNumbering.numPrOf(valueOf(pPr, "w:pStyle"));
    const numId = valueOf(direct, "w:numId") ?? fromStyle?.numId;
    if (numId === undefined || numId === "0") return false;
    const raw = Number.parseInt(valueOf(direct, "w:ilvl") ?? fromStyle?.ilvl ?? "0", 10);
    const ilvl = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, LAST_LEVEL) : 0;
    return defined.get(numId)?.has(ilvl) === true;
  };
};
