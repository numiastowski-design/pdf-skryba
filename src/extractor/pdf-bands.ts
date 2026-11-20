/** Whether a page is read as two bands rather than one column, and where that
 *  zone begins and ends.
 *  NOT here: where the cut itself falls (`layout/gutter.ts` for a gutter,
 *  `layout/geometry.ts` for a painted edge), nor what each band becomes
 *  (`extractor/pdf-image-anchors.ts#rowBlocks` for the container, `extractor/pdf-paragraphs.ts` for the paragraphs).
 *  Called by: `extractor/pdf-page-tables.ts`, `extractor/pdf-image-anchors.ts`. */

import { maxOf, minOf } from "../lib/extent";
import { modeOf } from "../layout/mode";
import type { PositionedItem } from "./pdf-model";
import { groupItemsIntoLines } from "./pdf-lines";
import { SAME_LINE_PT } from "../layout/tolerances";

/**
 * The four parts of a page read in two bands.
 *
 * The column zone is bounded by the lines that hold text on both sides of the cut with no fragment across it.
 * What is above and below the zone stays in document order; the zone reads as the whole left band, then the right.
 * Tried then dropped: splitting the page into runs of full-width lines against the others. The last line of a
 * paragraph is always shorter, so it left its paragraph and became one of its own.
 * Each segment is rebuilt into paragraphs separately: from the bottom of the left column to the top of the right
 * one the gap is negative, hence no break, and the two columns would merge into one paragraph.
 */
export interface BandedSplit<T> {
  above: T[][];
  left: T[][];
  right: T[][];
  below: T[][];
}

/**
 * THE RUN OF LINES BETWEEN TWO FULL-WIDTH LINES THAT HOLDS THE MOST STRADDLING LINES.
 *
 * Lines are walked top to bottom. A line that CROSSES a cut closes the run in progress; every other line extends
 * it. The run returned is the one with the most straddling lines (text on both sides of a cut) — on a tie the
 * highest, because a document reads top to bottom and a tie-break must be deterministic.
 *
 * A RUN KEEPS THE LINES THAT SIT IN ONE BAND ONLY (05/11/2026 on the published Federal Register
 * `sd-4133285` p1: « such registration or institute, je ne sais pas d'où il sort »). That line opens column 2 one
 * point above the first row that columns 1 and 3 also fill — they start lower, after the rule between two notices.
 * The zone used to begin at the highest STRADDLING line, so a line alone in its column at the zone's edge went
 * « above », and was published before the whole page. A line between two full-width lines that crosses no cut is
 * column content wherever it stands; the straddling lines decide WHICH run is the zone, not its extent. The
 * trimming to straddling lines came from `11-Brochure-Deux-Colonnes` (16/09/2026), and that document is unchanged:
 * its full-width paragraph still closes the run.
 *
 * ONE EXCEPTION, AT THE TOP EDGE: lines in the FIRST band only, before the first line that proves anything, stay
 * above. `16-Brochure-Dense` says why: the lead paragraph crosses the cut on its first lines and its last line is
 * short, so it sits in band 1 — it is the paragraph's wrap, and in the zone it became a paragraph of its own at the
 * head of column 1. A wrap of a full-width paragraph always returns to the left margin; a line alone in band 2 or
 * beyond cannot be one. For band 1 the reading order is the same either way, only the paragraph changes.
 */
const longestRun = <T extends PositionedItem>(
  groups: readonly T[][],
  banded: readonly T[][],
  spansCut: (group: readonly T[]) => boolean,
  firstBandOnly: (group: readonly T[]) => boolean,
): { lines: T[][]; straddling: number } => {
  const isBanded = new Set(banded);
  const runs: { lines: T[][]; straddling: number }[] = [];
  let current: T[][] = [];
  const close = (): void => {
    if (current.length > 0) runs.push({ lines: current, straddling: current.filter((g) => isBanded.has(g)).length });
    current = [];
  };
  for (const group of [...groups].sort((a, b) => b[0]!.y - a[0]!.y)) {
    if (spansCut(group)) close();
    else current.push(group);
  }
  close();
  const best = runs.reduce<{ lines: T[][]; straddling: number }>(
    (kept, run) => (run.straddling > kept.straddling ? run : kept),
    { lines: [], straddling: 0 },
  );
  const start = best.lines.findIndex((g) => isBanded.has(g) || !firstBandOnly(g));
  return { lines: start < 0 ? [] : best.lines.slice(start), straddling: best.straddling };
};

/**
 * HOW MANY STRADDLING LINES A ZONE FOUND BELOW OR ABOVE ANOTHER NEEDS (05/11/2026). The first zone of a page is the
 * best run, whatever its size — 742 tests hold that. A zone looked for in what is left is judged alone, and ONE
 * straddling line is one reading: `11-Brochure-Deux-Colonnes` p0 has the axis labels « 2023 2024 2025 » of a chart
 * on both sides of the cut, and fixture 17 has table rows (« 15 - 50 50 », « 31 mars 31 mars ») of one to three
 * lines. Measured zones: real column blocks found below a headline hold 4 to 38 lines (Federal Register notes 4–8,
 * `sd-3776780` 4–12, newspaper `sd-2479793` 6–15, `sd-1026348` 9–31); labels and table rows 1 to 3. Starting
 * value to calibrate.
 */
export const MIN_SUBZONE_LINES = 4;

/**
 * HOW MANY ZONES ONE PAGE IS CUT INTO AT MOST (06/11/2026, review). Each zone found above or below another re-reads
 * what is left (`readBands` on the `remainder`), so a page of N zones costs N passes over its items. Beyond the cap the
 * rest of the page is published full-width, with no new zone: the bias is « we publish ». Starting value to calibrate.
 * Real population: the newspaper `sd-2479793` holds three or four zones per page (the most measured). Hostile
 * population: one zone per headline, thousands on a generated page. 64 sits 16 times above the real maximum.
 */
export const MAX_BAND_ZONES_PER_PAGE = 64;

/**
 * A ZONE THAT STANDS ALONE IS FOUNDED TWICE: at least `MIN_SUBZONE_LINES` straddling lines, AND fragments of several
 * words on both sides of each cut. Fixture 17 (`canada-account-annual-report`) says why the second condition: its
 * borderless financial tables hold five to twelve rows astride the document's cut — labels on the left (« Chine »,
 * « Türkiye »), figures on the right (« 255 1 279 1 ») — and read as columns they lose their rows, and the page its
 * heading « Note 4. Prêts ». A table paints ONE fragment per cell, of one or two tokens; a line of prose is a
 * fragment of several words.
 *
 * THE TWO POPULATIONS (05/11/2026, words per fragment of the POORER side of the cut, zones of 4 lines and more):
 *   table rows read as a zone — fixture 17, nine zones          1.0  1.0  1.0  1.0  1.0  1.1  1.1  1.1  1.1
 *   real column zones under a headline — `sd-3776780` 1.9 ; newspaper `sd-2479793` 3.2  3.2  3.2  3.8  3.8  4.5 ;
 *   Federal Register `sd-4133285` 4.7  4.9  4.9  5.7
 * `MIN_WORDS_PER_ZONE_FRAGMENT` sits in the gap 1.1 → 1.9. The 4 words per fragment of
 * `layout/column-discriminant.ts#bandsCarryProse` answers another question (a label column against prose) and
 * refused the newspaper's own zones (3.2) and `sd-3776780` (1.9): measured, 85 and 139 broken neighbourhoods
 * against 64 and 71 without it. Words per LINE was tried and discarded: `sd-3776780`'s left band has 2.5 words a
 * line, below fixture 17's rows at 3.6 to 4.0. Starting value to calibrate.
 */
export const MIN_WORDS_PER_ZONE_FRAGMENT = 1.5;

const wordsPerFragment = (fragments: readonly { text: string }[]): number =>
  fragments.reduce(
    (sum, f) =>
      sum +
      f.text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length,
    0,
  ) / Math.max(1, fragments.length);

const standsAloneAsZone = <T extends PositionedItem>(
  zoneLines: readonly T[][],
  straddling: number,
  cuts: readonly number[],
): boolean => {
  if (straddling < MIN_SUBZONE_LINES) return false;
  const ink = zoneLines.flat().filter((it) => it.text.trim() !== "");
  return cuts.every((cut) => {
    const sides = [ink.filter((it) => it.x + it.width / 2 < cut), ink.filter((it) => it.x + it.width / 2 >= cut)];
    return sides.every((side) => side.length > 0 && wordsPerFragment(side) >= MIN_WORDS_PER_ZONE_FRAGMENT);
  });
};

export const bandedSplit = <T extends PositionedItem>(
  pageItems: readonly T[],
  cut: number | undefined,
  bound?: number,
  {
    standsAlone = false,
    innerCuts = [],
  }: {
    /** True for a zone looked for above or below another one: it must then be founded on its own (`standsAloneAsZone`). */
    standsAlone?: boolean;
    /** The document's other cuts: a side that one of them will split again holds several columns, and has no ONE edge. */
    innerCuts?: readonly number[];
  } = {},
): BandedSplit<T> | undefined => {
  const groups = groupItemsIntoLines(pageItems);
  if (cut === undefined || groups.length === 0) return undefined;

  // Blank filler items take no part in any geometric decision: the filler of a two-column line runs from the end of
  // the left column to the start of the right one, so it crosses the cut and every line would read as full-width.
  const real = (group: readonly T[]): T[] => group.filter((it) => it.text.trim().length > 0);
  const leftOf = (it: T): boolean => it.x + it.width / 2 < cut;
  const spansCut = (group: readonly T[]): boolean => real(group).some((it) => it.x < cut && it.x + it.width > cut);
  const straddles = (group: readonly T[]): boolean =>
    !spansCut(group) && real(group).some(leftOf) && real(group).some((it) => !leftOf(it));

  // A cut can be bound to the top band: a header in two blocks side by side above a full-width table. Without the
  // bound the table's rows also hold text on both sides of the cut, and the zone would swallow the table or abstain.
  const eligible = bound === undefined ? groups : groups.filter((g) => g[0]!.y > bound);
  const banded = eligible.filter(straddles);
  if (banded.length === 0) return undefined;

  // The extent of the zone depends on what gave the cut.
  // With a bound, the cut comes from a painted cell edge and declares the whole band: trimming it to the straddling
  // lines merged the last line of the right block with the first of the left one into a sentence neither block holds.
  // Without a bound, the cut is a statistical gutter and the zone is one contiguous run of lines (`longestRun`), not
  // the envelope of the straddling lines: one stray straddling line at the foot of a page (the axis labels of a
  // chart) stretched the envelope over a full-width paragraph, and the whole page abstained.
  const run =
    bound === undefined
      ? longestRun(groups, banded, spansCut, (g) => real(g).every(leftOf))
      : { lines: eligible, straddling: banded.length };
  const zoneLines = run.lines;
  if (zoneLines.length === 0 || (standsAlone && !standsAloneAsZone(zoneLines, run.straddling, [cut]))) return undefined;
  const top = maxOf(zoneLines, (g) => g[0]!.y);
  const bottom = minOf(zoneLines, (g) => g[0]!.y);

  const inZone = (group: readonly T[]): boolean => group[0]!.y >= bottom && group[0]!.y <= top;
  if (groups.some((g) => spansCut(g) && inZone(g))) return undefined;

  const above = groups.filter((g) => g[0]!.y > top);
  const inside = groups.filter(inZone);
  const below = groups.filter((g) => g[0]!.y < bottom);
  // A straddling line is never pulled out of the zone, and its halves are not judged against a column edge: a half
  // misaligned with its column would leave alone, and the line would come out in two places.
  const straddling = new Set(inside.filter((g) => real(g).some(leftOf) && real(g).some((it) => !leftOf(it))));
  // A HALF KEEPS THE SPACE ITEMS BETWEEN ITS WORDS (21/09/2026). Keeping only
  // real items here dropped the document's own spaces, and the line then glued
  // its words: "EUROCONTROL*estuneorganisation" (safedocs 0000713 p1), "Die
  // Obergrenze" (0000944 p2). Only the blanks at a half's two ends go — the
  // gutter filler, which separates nothing inside the column.
  const halfOf = (g: readonly T[], side: (it: T) => boolean): T[] => {
    const items = g.filter(side);
    const isText = (it: T): boolean => it.text.trim().length > 0;
    const first = items.findIndex(isText);
    if (first < 0) return [];
    const last = items.length - 1 - [...items].reverse().findIndex(isText);
    return items.slice(first, last + 1);
  };
  const left = inside.map((g) => ({ g, half: halfOf(g, leftOf) })).filter((x) => x.half.length > 0);
  const right = inside.map((g) => ({ g, half: halfOf(g, (it) => !leftOf(it)) })).filter((x) => x.half.length > 0);

  // A line that crosses the left edge of a column does not belong to that column: a notice centred on the page, its
  // centre right of the cut, sits under both blocks and not in the right one. The discriminant is the column's edge
  // (the most frequent line start, seen at least twice), not the centre of the page: nothing to calibrate.
  const columnEdge = (segments: readonly T[][]): number | undefined => {
    const starts = segments.map((g) => minOf(g, (it) => it.x));
    const counts = new Map<number, number>();
    for (const x of starts) {
      const key = [...counts.keys()].find((k) => Math.abs(k - x) <= SAME_LINE_PT) ?? x;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const at = modeOf(counts, "smallest");
    return at !== undefined && counts.get(at)! >= 2 ? at : undefined;
  };

  // A FRAGMENT CROSSES THE EDGE, not the line's extent (10/11/2026, auction catalogue `sd-1026348`). A lot opens with its
  // number BEFORE the column's text edge, a blank between them (« 6 » at 314, its title at 349): measured on the line's
  // extent, the line crossed the edge and its title was published under the columns. A number that ends before the edge
  // is part of its line (« il faut juste un espace après les numéros de paragraphe »); the centred notice above
  // is ONE fragment across the edge, and still leaves. Blank fragments (the gap filler) never decide.
  const crossesEdge = (group: readonly T[], edge: number | undefined): boolean =>
    edge !== undefined && real(group).some((it) => it.x < edge - SAME_LINE_PT && it.x + it.width > edge + SAME_LINE_PT);

  // The half-line is judged, not the whole line: measured whole, a straddling line always crosses a column edge.
  // The edge does not judge a side that a remaining cut will split again: that side holds several columns, the edge
  // kept was the start of the fullest one, and every line of the others read as crossing it.
  const leftEdge = innerCuts.some((c) => c < cut) ? undefined : columnEdge(left.map((x) => x.half));
  const rightEdge = innerCuts.some((c) => c > cut) ? undefined : columnEdge(right.map((x) => x.half));
  const keep = (x: { g: T[]; half: T[] }, edge: number | undefined): boolean =>
    straddling.has(x.g) || !crossesEdge(x.half, edge);
  const pulled = [...left.filter((x) => !keep(x, leftEdge)), ...right.filter((x) => !keep(x, rightEdge))]
    .map((x) => x.half)
    .sort((a, b) => b[0]!.y - a[0]!.y);

  return {
    above,
    left: left.filter((x) => keep(x, leftEdge)).map((x) => x.half),
    right: right.filter((x) => keep(x, rightEdge)).map((x) => x.half),
    // The lines pulled out go under the zone: that is where they sit on the page.
    below: [...pulled, ...below],
  };
};

/**
 * The page cut into N bands at once, with one zone for all the cuts.
 *
 * Tried then dropped: cutting in two, then cutting the right half again. The second cut applied to what was left,
 * its zone started lower, and a band of columns 2 and 3 still mixed came out that exists only in the way of cutting.
 * A line straddles as soon as it holds text in at least two bands, and crosses as soon as one of its fragments spans
 * any cut. The zone is the run `longestRun` keeps, as for one cut.
 *
 * `undefined`: no straddling line, or a crossing line inside the zone. The caller then reads the page as before: a
 * whole page in one block rather than a partition by guess.
 */
export const bandedSplitN = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
  standsAlone = false,
): { above: T[][]; bands: T[][][]; below: T[][] } | undefined => {
  const groups = groupItemsIntoLines(pageItems);
  if (cuts.length === 0 || groups.length === 0) return undefined;
  const real = (group: readonly T[]): T[] => group.filter((it) => it.text.trim().length > 0);
  /** A fragment's band: how many cuts pass left of its middle. */
  const bandOf = (it: T): number => cuts.filter((cut) => it.x + it.width / 2 >= cut).length;
  const crosses = (group: readonly T[]): boolean =>
    real(group).some((it) => cuts.some((cut) => it.x < cut && it.x + it.width > cut));
  const straddles = (group: readonly T[]): boolean => !crosses(group) && new Set(real(group).map(bandOf)).size > 1;

  const eligible = bound === undefined ? groups : groups.filter((g) => g[0]!.y > bound);
  const banded = eligible.filter(straddles);
  if (banded.length === 0) return undefined;
  const run =
    bound === undefined
      ? longestRun(groups, banded, crosses, (g) => real(g).every((it) => bandOf(it) === 0))
      : { lines: eligible, straddling: banded.length };
  const zoneLines = run.lines;
  if (zoneLines.length === 0 || (standsAlone && !standsAloneAsZone(zoneLines, run.straddling, cuts))) return undefined;
  const top = maxOf(zoneLines, (g) => g[0]!.y);
  const bottom = minOf(zoneLines, (g) => g[0]!.y);
  const inZone = (group: readonly T[]): boolean => group[0]!.y >= bottom && group[0]!.y <= top;
  if (groups.some((g) => crosses(g) && inZone(g))) return undefined;

  const inside = groups.filter(inZone);
  // A part keeps the document's spaces between its words; only the blanks at its two ends go (the gutter filler).
  const partOf = (group: readonly T[], band: number): T[] => {
    const items = group.filter((it) => bandOf(it) === band);
    const isInk = (it: T): boolean => it.text.trim().length > 0;
    const first = items.findIndex(isInk);
    if (first < 0) return [];
    const last = items.length - 1 - [...items].reverse().findIndex(isInk);
    return items.slice(first, last + 1);
  };
  const bands = Array.from({ length: cuts.length + 1 }, (_, band) =>
    inside.map((g) => partOf(g, band)).filter((part) => part.length > 0),
  );
  return {
    above: groups.filter((g) => g[0]!.y > top),
    bands: bands.filter((band) => band.length > 0),
    below: groups.filter((g) => g[0]!.y < bottom),
  };
};

export const readingSegments = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
): T[][][] => readingBands(pageItems, cuts, bound).map((segment) => segment.lines);

/** A reading segment, and whether it is a column of the page or full-width text above or below the columns. The
 *  distinction does not change the order: it lets the caller emit a `columns` block rather than a run of paragraphs. */
export interface ReadSegment<T> {
  lines: T[][];
  column: boolean;
}

export const readingBands = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
  /** True when the call comes from a band already separated: what comes out is a column, even if no remaining cut
   *  splits it. */
  inBand = false,
): ReadSegment<T>[] =>
  readBands(pageItems, cuts, { bound, inBand, standsAlone: false, zonesLeft: { count: MAX_BAND_ZONES_PER_PAGE } });

/** Whether one inked fragment of the page spans the cut: the condition that bounds a zone (`bandedSplit`). */
const crossedByAnyLine = <T extends PositionedItem>(pageItems: readonly T[], cut: number): boolean =>
  pageItems.some((it) => it.text.trim() !== "" && it.x < cut && it.x + it.width > cut);

const readBands = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  options: { bound: number | undefined; inBand: boolean; standsAlone: boolean; zonesLeft: { count: number } },
): ReadSegment<T>[] => {
  const { bound, inBand, standsAlone, zonesLeft } = options;
  // A PAGE HOLDS SEVERAL COLUMN ZONES (05/11/2026). `longestRun` keeps ONE run of lines between two full-width
  // lines — the one with the most straddling lines. Everything above and below it was published as it came, lines
  // braided across the columns. Measured on the newspaper `sd-2479793`: three or four zones per page, separated by
  // headlines over two or three columns; the one-pass split of 04/11 read 192 broken neighbourhoods against 148 for
  // the cascade it replaced, and `sd-3776780` 141 against 117 — the cascade split each half again and so found a
  // second zone by accident. What is above and below the zone is read again with the SAME cuts: a further zone is
  // split in turn, the rest stays full-width. Each call removes at least one line, so it ends. Only on the
  // statistical path: a cut bound to a painted cell edge (`bound`) already declares its whole band.
  const remainder = (part: T[][]): ReadSegment<T>[] => {
    if (part.length === 0) return [];
    if (bound !== undefined) return [{ lines: part, column: false }];
    // Past `MAX_BAND_ZONES_PER_PAGE` the rest is published full-width, with no new zone.
    if (zonesLeft.count <= 0) return [{ lines: groupItemsIntoLines(part.flat()), column: false }];
    zonesLeft.count -= 1;
    return readBands(part.flat(), cuts, { bound: undefined, inBand: false, standsAlone: true, zonesLeft });
  };
  // From two cuts on, the page is cut at once (`bandedSplitN`); with one cut, `bandedSplit` keeps its own path
  // (bounds, column edges, lines pulled out of the zone).
  // A cut that nothing crosses splits the page first, over its whole height: a sidebar running down the page beside
  // a headline that spans the other cuts. Cut at once, the page took that headline for the bound of its zone and
  // the sidebar came out in two pieces. Each side is then read on the remaining cuts. Statistical path only: a cut
  // bound to a painted cell (`bound`) already has its band.
  const clean =
    bound === undefined && cuts.length > 1 ? cuts.find((cut) => !crossedByAnyLine(pageItems, cut)) : undefined;
  if (cuts.length > 1 && clean === undefined) {
    const whole = bandedSplitN(pageItems, cuts, bound, standsAlone);
    if (whole !== undefined) {
      return [
        ...remainder(whole.above),
        ...whole.bands.map((lines) => ({ lines, column: true })),
        ...remainder(whole.below),
      ].filter((segment) => segment.lines.length > 0);
    }
  }
  const [first, ...rest] = clean === undefined ? cuts : [clean, ...cuts.filter((cut) => cut !== clean)];
  const split =
    first === undefined ? undefined : bandedSplit(pageItems, first, bound, { standsAlone, innerCuts: rest });
  if (split === undefined) {
    if (rest.length > 0) return readBands(pageItems, rest, options);
    return [{ lines: groupItemsIntoLines(pageItems), column: inBand }];
  }
  // A band already separated is read again on the remaining cuts, never on the one that produced it.
  const deeper = (band: T[][]): ReadSegment<T>[] =>
    rest.length === 0 || band.length === 0
      ? [{ lines: band, column: true }]
      : readBands(band.flat(), rest, { ...options, inBand: true });
  // What sits above a sub-cut is no one's column.
  //
  // The columns of a page do not all start at the same height: on `sd-4133285` p1, column 1 opens on its title
  // while columns 2 and 3 are still mixed together above their own separation. That zone belongs to NEITHER of
  // the two.
  //
  // TRIED THEN DROPPED: pouring it into the first sub-column. It brought 49 one-line paragraphs there (against
  // 25 and 14 in the neighbouring columns) and column 3's title in the middle of column 2's body: "SECURITIES AND
  // EXCHANGE proceedings to determine whether such". It therefore comes out FULL WIDTH, and whatever composes
  // the page does what it wants with it: a `colspan` row put it across, in its place (the `table` variant of
  // `pdf-image-anchors.ts`, removed on 06/11/2026); `rows` leaves it full width.
  return [...remainder(split.above), ...deeper(split.left), ...deeper(split.right), ...remainder(split.below)].filter(
    (segment) => segment.lines.length > 0,
  );
};
