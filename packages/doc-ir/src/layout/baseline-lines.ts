/** The one rule for « same visual line »: items whose baselines are strictly under `SAME_LINE_TOLERANCE` points of the
 *  line's FIRST item (anchored, so a chain of near-equal baselines cannot drift into one line).
 *  NOT here: what a line means (`extractor/pdf-lines.ts`), nor slide shapes (`layout/slide-layout.ts`, EMU, y down).
 *  Called by: `extractor/pdf-lines.ts`, `extractor/pdf-region-order.ts`, `layout/fragment-cells.ts`, `layout/cell-text.ts`. */
import { reseatListMarkers, reseatSuperscripts, type SuperscriptReading } from "./superscript";
import { SAME_LINE_PT } from "./tolerances";

/** Two items are on the same visual line when their baselines are less than this many points apart.
 *
 *  WRITTEN LIMIT (R4, 22/09/2026), one line because the document decides
 *  nothing: on safedocs 0000661 (Ukrainian, out of scope) a price sits 1.2 pt
 *  under its price-list line, so it becomes a line of its own; no text is lost. */
export const SAME_LINE_TOLERANCE = SAME_LINE_PT;

/** Groups items into visual lines: sorted by y descending then x, each group anchored on its first item. The groups come
 *  top to bottom, each sorted by x. A single strict sort then a pass, never a tolerant comparator (not transitive). */
export const groupByBaseline = <T extends { x: number; y: number }>(items: readonly T[], tolerance: number = SAME_LINE_TOLERANCE): T[][] => {
  const sorted = [...items].sort((a, b) => (a.y === b.y ? a.x - b.x : b.y - a.y));
  const groups: T[][] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0]!.y - item.y) < tolerance) last.push(item);
    else groups.push([item]);
  }
  return groups.map((g) => [...g].sort((a, b) => a.x - b.x));
};

/** The lines of a page or a cell: items of empty text dropped, grouped by baseline, each raised smaller item reseated onto
 *  the line below it (`./superscript.ts`), every line sorted by x. `sizeOf` is the item's text size in points (the page
 *  flow carries `fontSize`, a table glyph its `height`). `trailingGapEm` is `reseatSuperscripts`'s (cells only; 0 = page flow). */
export const groupIntoReseatedLines = <T extends SuperscriptReading & { text: string }>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  trailingGapEm = 0,
): T[][] =>
  reseatListMarkers(reseatSuperscripts(groupByBaseline(items.filter((it) => it.text.length > 0)), sizeOf, trailingGapEm), sizeOf).map((group) => [...group].sort((a, b) => a.x - b.x));
