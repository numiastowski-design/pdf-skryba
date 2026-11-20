/** Where a column break falls when no line is painted to mark it — so a
 *  two-column page is not read in zigzag, and so a label column is not read as
 *  one either.
 *  NOT here: the reading order that uses it (`extractor/pdf-bands.ts`), the
 *  bordered-table case, which has real edges (`layout/geometry.ts`), nor the
 *  prose test the cut must pass (`layout/column-discriminant.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { maxOf, minOf } from "../lib/extent";
import { bandsCarryProse, type BandFragment } from "./column-discriminant";

/**
 * The column cut when no painted line gives it.
 *
 * Two columns share their baselines, so grouping by ordinate merges them into one line that runs edge to edge: at
 * line level every gutter is already closed. The gutter is therefore measured on the fragments.
 *
 * Transverse elements are hidden first. Nearly every two-column page carries a title or a banner astride the
 * columns; kept, they close the gutter and the page reads as one column.
 *
 * One gutter means columns. Several mean a grid, that is a borderless table, which this module leaves alone.
 *
 * A hanging indent is not a column: the blank between a bullet and its text looks like a gutter, and cutting there
 * detaches every bullet from its item. Hence a minimal column width (`MIN_COLUMN_PT`).
 */

export type GutterItem = BandFragment;

/**
 * Starting values to calibrate:
 *
 *   `MIN_GUTTER_PT`      8    a gutter narrower than a word is not one
 *   `MIN_SIDE_ITEMS`     4    per side; at 8 a small two-column page found none
 *   `TRANSVERSE_RATIO`   1.5  in median widths; at 3 a full-width line closed every gutter
 *   `GUTTER_APART_PT`   20    two boundaries closer than this describe the same blank
 */
const MIN_GUTTER_PT = 8;
const MIN_SIDE_ITEMS = 4;
const TRANSVERSE_RATIO = 1.5;
const GUTTER_APART_PT = 20;
/**
 * The minimal width of a column. Starting value to calibrate, with its two populations: a hanging indent taken for
 * a column, 5 pt (the width of a bullet); the columns of the one positive witness, 142 and 144 pt. Nothing measured
 * in between.
 *
 * The bias takes the low end of the interval: a narrow column missed leaves the page braided, a visible defect,
 * whereas a hanging indent cut in two detaches the bullets from their text, which nobody sees on the published page.
 */
export const MIN_COLUMN_PT = 40;

export interface Gutter {
  x: number;
  itemsLeft: number;
  itemsRight: number;
  widthPt: number;
  /** The extent of the narrower of the two sides, to be held against `MIN_COLUMN_PT`. */
  columnPt: number;
}

/** The horizontal extent of a group of fragments, from the left edge of the leftmost to the right edge of the
 *  rightmost. */
const spanOf = (items: readonly GutterItem[]): number =>
  items.length === 0 ? 0 : maxOf(items, (it) => it.x + it.width) - minOf(items, (it) => it.x);

/**
 * THE WHITE THAT EVERY LINE OF BOTH COLUMNS LEAVES, inside a white found among the kept fragments (10/11/2026, catalogue
 * `sd-1026348`). The widest fragments are hidden to FIND the white (`TRANSVERSE_RATIO`), but a hidden fragment that ends
 * before the right column starts (or starts after the left column ends) is a long line of its column, not a transverse:
 * the cut must not cross it. Measured: page 2 of the catalogue, a white of 219 to 314 among the kept fragments, its long
 * left lines ending at 279 — the cut moves from 266 to 296. A fragment that crosses the whole white stays a transverse
 * and is ignored, as before. Undefined when the lines close the white below `MIN_GUTTER_PT`: the old middle stands.
 */
const whiteOfEveryLine = (
  real: readonly GutterItem[],
  start: number,
  end: number,
): { start: number; end: number } | undefined => {
  let from = start;
  let to = end;
  for (const it of real) {
    const right = it.x + it.width;
    if (it.x < start && right > start && right <= end) from = Math.max(from, right);
    if (right > end && it.x >= start && it.x < end) to = Math.min(to, it.x);
  }
  if (from === start && to === end) return undefined;
  return to - from >= MIN_GUTTER_PT ? { start: from, end: to } : undefined;
};

/**
 * Every clear gutter of a page: a vertical band that NO fragment crosses, with enough fragments on each side.
 *
 * Zero crossings is not a calibrated threshold: it is the definition of a column, and the criterion the repository
 * applies elsewhere, the most generous one WITHOUT ANY wrong split.
 */
export function findGutters(items: readonly GutterItem[]): Gutter[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  if (real.length < MIN_SIDE_ITEMS * 2) return [];

  const widths = [...real.map((it) => it.width)].sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] ?? 0;
  const kept = median > 0 ? real.filter((it) => it.width <= median * TRANSVERSE_RATIO) : real;
  if (kept.length < MIN_SIDE_ITEMS * 2) return [];

  const edges = [...new Set(kept.flatMap((it) => [it.x, it.x + it.width]))].sort((a, b) => a - b);
  const found: Gutter[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    const widthPt = end - start;
    if (widthPt < MIN_GUTTER_PT) continue;
    const middle = (start + end) / 2;
    if (kept.some((it) => it.x < middle && it.x + it.width > middle)) continue;
    const white = whiteOfEveryLine(real, start, end);
    const x = white === undefined ? middle : (white.start + white.end) / 2;
    const left = kept.filter((it) => it.x + it.width <= x);
    const right = kept.filter((it) => it.x >= x);
    if (left.length < MIN_SIDE_ITEMS || right.length < MIN_SIDE_ITEMS) continue;
    found.push({
      x,
      itemsLeft: left.length,
      itemsRight: right.length,
      widthPt: white === undefined ? widthPt : white.end - white.start,
      columnPt: Math.min(spanOf(left), spanOf(right)),
    });
  }
  return found.filter((g, i) => i === 0 || g.x - found[i - 1]!.x > GUTTER_APART_PT);
}

/**
 * Two gutters that frame a sliver describe the same blank. Margin furniture set inside the gutter (a page number, a
 * vertical date, a bullet) splits it into two blanks further apart than `GUTTER_APART_PT`; each then has a
 * neighbouring band as narrow as the sliver, both fail `MIN_COLUMN_PT` and the page stays braided.
 *
 * No new threshold: the band in between is judged on `MIN_COLUMN_PT`. What is too narrow to be a column does not
 * separate two columns. The wider of the two blanks is kept, so the sliver falls into a real band.
 */
const withoutSlivers = (gutters: readonly Gutter[], real: readonly GutterItem[]): Gutter[] => {
  const out: Gutter[] = [];
  for (const gutter of gutters) {
    const previous = out[out.length - 1];
    if (previous === undefined) {
      out.push(gutter);
      continue;
    }
    const between = real.filter((it) => {
      const middle = it.x + it.width / 2;
      return middle > previous.x && middle < gutter.x;
    });
    if (spanOf(between) >= MIN_COLUMN_PT) out.push(gutter);
    else if (gutter.widthPt > previous.widthPt) out[out.length - 1] = gutter;
  }
  return out;
};

/** The gutters, without the first or last one when the band it leaves at the page's edge is narrower than
 *  `MIN_COLUMN_PT` — a margin of numbers or bullets, not a column (10/11/2026, see `columnCut`). */
const withoutMarginBands = (gutters: readonly Gutter[], real: readonly GutterItem[]): Gutter[] => {
  const centre = (it: GutterItem): number => it.x + it.width / 2;
  const out = [...gutters];
  const first = out[0];
  if (first !== undefined && spanOf(real.filter((it) => centre(it) < first.x)) < MIN_COLUMN_PT) out.shift();
  const last = out[out.length - 1];
  if (last !== undefined && spanOf(real.filter((it) => centre(it) > last.x)) < MIN_COLUMN_PT) out.pop();
  return out;
};

/** Every cut of a page, in increasing order, where `columnCut` abstains as soon as a page has more than one gutter.
 *
 *  Each gutter is judged on its two adjacent bands, never on the two halves of the page. Otherwise a three-column
 *  page with prose in two columns would validate the third by contagion, and the guard that a column of labels is
 *  not a column of text would fall where it protects most. The minimal width is checked on the band too:
 *  `columnPt` from `findGutters` measures everything on one side, which says nothing of a middle column.
 *
 *  Decides nothing of the reading order. */
export function columnCuts(items: readonly GutterItem[]): number[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  const gutters = withoutSlivers(findGutters(items), real);
  if (gutters.length === 0) return [];
  const xs = gutters.map((g) => g.x);

  return xs.filter((x, index) => {
    const from = index === 0 ? Number.NEGATIVE_INFINITY : xs[index - 1]!;
    const to = index === xs.length - 1 ? Number.POSITIVE_INFINITY : xs[index + 1]!;
    const between = real.filter((it) => {
      const middle = it.x + it.width / 2;
      return middle > from && middle < to;
    });
    const left = between.filter((it) => it.x + it.width / 2 < x);
    const right = between.filter((it) => it.x + it.width / 2 >= x);
    if (spanOf(left) < MIN_COLUMN_PT || spanOf(right) < MIN_COLUMN_PT) return false;
    return bandsCarryProse(between, x);
  });
}

/**
 * The column cut of a page, or nothing: an abscissa only when the page carries a single gutter and both bands it
 * separates carry prose. Several gutters describe a grid, a borderless table, and cutting it in two columns would
 * lie about what it is. Abstaining is the default.
 *
 * Written limit: an imposed booklet stays braided. Its fold is a clear gutter, but the sparse right-hand pages leave
 * further blanks, so the page counts as a grid and each published line glues the left page to the right one. No
 * setting of this module answers it (gutter width is an inverted discriminant, and the prose guard refuses the
 * bands); it takes a recursive cut by projection profile (XY-cut), horizontal bands before any gutter.
 */
export function columnCut(items: readonly GutterItem[]): number | undefined {
  const real = items.filter((it) => it.text.trim().length > 0);
  // 🔴 A COLUMN OF NUMBERS IS NOT A COLUMN (10/11/2026, catalogue `sd-1026348`: « il faut juste un espace après
  // les numéros de paragraphe »). The blank between a lot's number and its text made a gutter of its own, three on the
  // page, and the count below abstained. A band narrower than `MIN_COLUMN_PT` at the page's edge, or between two gutters
  // (`withoutSlivers`), is a margin of numbers: its gutter is not counted. The prose guard below still judges the cut.
  const gutters = withoutMarginBands(withoutSlivers(findGutters(items), real), real);
  const only = gutters.length === 1 ? gutters[0]! : undefined;
  // The width is checked here, not in `findGutters`: dropping a narrow gutter before the count turns a two-gutter
  // grid into a one-gutter page, that is declares a label/value table "two columns". `findGutters` measures,
  // `columnCut` decides.
  if (only === undefined || only.columnPt < MIN_COLUMN_PT) return undefined;

  // A column of labels is not a column of text: a "label | value" form read in two bands gives every label, then
  // every value. So both bands must carry prose. The measure takes every fragment of the page, not the ones
  // `findGutters` keeps: hiding the transverse ones serves to find the blank, not to describe what the bands hold.
  return bandsCarryProse(items, only.x) ? only.x : undefined;
}

/** The abscissas that describe the same cut, within 10 pt, grouped, in increasing order. */
const cutGroups = (cuts: readonly number[]): number[][] => {
  const groups: number[][] = [];
  for (const x of [...cuts].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last !== undefined && x - last[last.length - 1]! <= 10) last.push(x);
    else groups.push([x]);
  }
  return groups;
};

const representative = (group: readonly number[]): number => group[Math.floor(group.length / 2)]!;

/**
 * The column cut of a document, decided once for all its pages. This is an invariant, not an optimisation: decided
 * page by page, two pages of identical geometry read differently as soon as a threshold falls on one side for one
 * and on the other for the second.
 *
 * The abscissa that comes back on the most pages wins, within 10 pt. One page is enough to found it, and it then
 * holds for all. Applied to a page without columns it breaks nothing: the banded reading falls back to no partition
 * when a full-width line crosses the cut inside the zone.
 */
export function documentColumnCut(pages: readonly (readonly GutterItem[])[]): number | undefined {
  const groups = cutGroups(pages.map(columnCut).filter((x): x is number => x !== undefined));
  if (groups.length === 0) return undefined;
  // eslint-disable-next-line sonarjs/reduce-initial-value -- groups is non-empty here (the line above returned otherwise)
  return representative(groups.reduce((a, b) => (b.length > a.length ? b : a)));
}

/**
 * The cuts of a document: the invariant of `documentColumnCut` held on several cuts. The rule (one page founds an
 * abscissa, which then holds for all) applies to each group instead of the largest one only. A page whose own
 * bands the prose guard refuses thus still gets the cuts another page founded.
 */
export function documentColumnCuts(pages: readonly (readonly GutterItem[])[]): number[] {
  return documentCutsOf(pages, columnCuts);
}

/** The same rule for another producer of cuts than the gutter: what is shared is the decision at document scale,
 *  not the evidence that founds it. */
export function documentCutsOf(
  pages: readonly (readonly GutterItem[])[],
  cutsOfPage: (page: readonly GutterItem[]) => readonly number[],
): number[] {
  return documentCutsRanked(pages, cutsOfPage).all;
}

/** The same cuts, and the one that rules when a single cut is allowed.
 *
 *  The dominant cut is the one most pages found, never `all[0]`: it also serves the `columns` block of a table and
 *  the centred container, so taking the leftmost cut degraded pages whose cuts had not changed. */
export function documentCutsRanked(
  pages: readonly (readonly GutterItem[])[],
  cutsOfPage: (page: readonly GutterItem[]) => readonly number[],
): { all: number[]; dominant: number | undefined } {
  const groups = cutGroups(pages.flatMap((page) => [...cutsOfPage(page)]));
  if (groups.length === 0) return { all: [], dominant: undefined };
  // eslint-disable-next-line sonarjs/reduce-initial-value -- groups is non-empty here (the line above returned otherwise)
  const dominant = representative(groups.reduce((a, b) => (b.length > a.length ? b : a)));
  return { all: apart(groups), dominant };
}

/**
 * Two cuts closer than `MIN_COLUMN_PT` describe the same boundary, and one survives. The 10 pt grouping says
 * nothing of two abscissas founded by different pages 11 or 30 pt apart: applied together to every page, they cut
 * a band narrower than a word.
 *
 * No new threshold. The cut most pages carry is kept; on a tie the leftmost, so that the choice does not depend on
 * the order the pages are visited.
 */
function apart(groups: readonly (readonly number[])[]): number[] {
  const byStrength = [...groups].sort((a, b) => b.length - a.length || representative(a) - representative(b));
  const kept: number[] = [];
  for (const group of byStrength) {
    const x = representative(group);
    if (!kept.some((other) => Math.abs(other - x) < MIN_COLUMN_PT)) kept.push(x);
  }
  return kept.sort((a, b) => a - b);
}
