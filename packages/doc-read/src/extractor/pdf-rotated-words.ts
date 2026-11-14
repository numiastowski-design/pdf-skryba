/** The glyphs of vertical text (a column header turned by a quarter) gathered into the words they spell, read along their own direction.
 *  Decides: which rotated glyphs form one word (the run rule of `glyph-runs.ts`, on the rotated glyphs only) and the one fragment that stands for it.
 *  NOT here: the runs of the page flow (`extractor/glyph-runs.ts`), the cell lines (`layout/cell-text.ts`), where the table is found.
 *  Called by: `extractor/pdf-table-render.ts#renderTableRegion`, on the glyphs of a table before they are assigned to cells. */

import type { GlyphFragment } from "./glyph-positions";
import { runsOfGlyphs } from "./glyph-runs";
import type { PdfTextRun } from "./pdf-source";
import { writingDirectionTurned } from "./text-writing-direction";

/**
 * THE DEFECT (corpus 282, page 9, measured 19/10/2026). The six column headers of a risk matrix are printed turned by a quarter, one
 * glyph above the next. A table cell groups glyphs into lines by their ordinate and reads each line left to right: every letter of
 * « Verfügbarkeit » was a line of its own, listed from the top of the page, which is the END of the word: « t i e k r a b g ü f r e V ».
 * Poppler reads the word in the direction of its rotation. The page flow already does (`glyph-runs.ts` closes a run on a change of
 * direction and writes the letters in paint order, which IS the reading order along the axis).
 *
 * THE RULE: the rotated glyphs of a table, in paint order, go through the same run rule as the page flow; each run of two glyphs or
 * more becomes ONE fragment, at its first glyph, carrying the run's text. A single rotated glyph stays as it is. A table whose rotated
 * glyphs carry a link is left untouched (the link is tied to the glyphs). Nothing is dropped but a blank drawn over a letter and a blank
 * that starts a run: no letter is lost.
 *
 * Limit written: the fragment is placed by its first glyph, so a rotated word that crosses a cell border is read in the cell it starts in.
 */

/** A glyph lies on a run when it is within this × the run's size across the run's axis (the run rule's own baseline tolerance, `glyph-runs.ts#BASELINE_SHIFT_EM`). */
const ACROSS_EM = 0.25;
/** … and within this many points of the run's extent along it (float noise of composed matrices). */
const ALONG_SLACK = 0.5;

/** Side of a cell of the glyph grid below, in points. */
const GRID_CELL = 32;
const cellOf = (v: number): number => Math.floor(v / GRID_CELL);

const keyOf = (x: number, y: number): string => `${x}|${y}`;

/** Does glyph `g` lie on `run` (same direction, inside its extent along the axis, on its baseline)? */
const lies = (g: GlyphFragment, run: PdfTextRun): boolean => {
  const n = Math.hypot(run.matrix.a, run.matrix.b);
  const m = Math.hypot(g.matrix.a, g.matrix.b);
  if (n === 0 || m === 0 || Math.abs(g.matrix.a / m - run.matrix.a / n) > 1e-3 || Math.abs(g.matrix.b / m - run.matrix.b / n) > 1e-3) return false;
  const ax = run.matrix.a / n;
  const ay = run.matrix.b / n;
  const dx = g.x - run.x;
  const dy = g.y - run.y;
  const along = dx * ax + dy * ay;
  return along >= -ALONG_SLACK && along <= run.width + ALONG_SLACK && Math.abs(-dx * ay + dy * ax) <= ACROSS_EM * run.fontSize;
};

/** The rotated glyphs bucketed by the grid cell of their origin: a run only tests the glyphs of the cells its own box touches, so the work
 *  grows with the glyphs near each run, not with runs × glyphs (the cost test of `pdf-rotated-words.test.ts`). */
const gridOf = (glyphs: readonly GlyphFragment[]): Map<string, GlyphFragment[]> => {
  const grid = new Map<string, GlyphFragment[]>();
  for (const g of glyphs) {
    const key = keyOf(cellOf(g.x), cellOf(g.y));
    const cell = grid.get(key);
    if (cell === undefined) grid.set(key, [g]);
    else cell.push(g);
  }
  return grid;
};

/** The glyphs in the cells that touch the box `lies` accepts around `run` (its extent along its axis, widened by the across tolerance). */
const nearRun = (grid: ReadonlyMap<string, GlyphFragment[]>, run: PdfTextRun): GlyphFragment[] => {
  const n = Math.hypot(run.matrix.a, run.matrix.b);
  if (n === 0) return [];
  const endX = run.x + (run.matrix.a / n) * run.width;
  const endY = run.y + (run.matrix.b / n) * run.width;
  const pad = ACROSS_EM * run.fontSize + ALONG_SLACK;
  const out: GlyphFragment[] = [];
  for (let cx = cellOf(Math.min(run.x, endX) - pad); cx <= cellOf(Math.max(run.x, endX) + pad); cx++) {
    for (let cy = cellOf(Math.min(run.y, endY) - pad); cy <= cellOf(Math.max(run.y, endY) + pad); cy++) out.push(...(grid.get(keyOf(cx, cy)) ?? []));
  }
  return out;
};

/** `glyphs` with every run of rotated glyphs replaced by one fragment of the word it spells; the same array when nothing is rotated. */
export function gatherRotatedWords(glyphs: readonly GlyphFragment[]): readonly GlyphFragment[] {
  const rotated = glyphs.filter((g) => writingDirectionTurned(g.matrix));
  if (rotated.length < 2 || rotated.some((g) => g.href !== undefined)) return glyphs;
  const byStart = new Map<string, GlyphFragment>();
  for (const g of rotated) if (g.text.trim() !== "" && !byStart.has(keyOf(g.x, g.y))) byStart.set(keyOf(g.x, g.y), g);
  const grid = gridOf(rotated);
  const words = new Map<GlyphFragment, GlyphFragment>();
  const swallowed = new Set<GlyphFragment>();
  for (const run of runsOfGlyphs(rotated)) {
    const first = byStart.get(keyOf(run.x, run.y));
    if (first === undefined || run.text.length <= first.text.length) continue;
    words.set(first, { ...first, text: run.text });
    for (const g of nearRun(grid, run)) if (g !== first && lies(g, run)) swallowed.add(g);
  }
  if (words.size === 0) return glyphs;
  return glyphs.filter((g) => !swallowed.has(g)).map((g) => words.get(g) ?? g);
}
