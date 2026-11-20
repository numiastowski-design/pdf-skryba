/** Whether a page in two bands is a TABLE, real text COLUMNS, or neither —
 *  the gutter that cuts it, the vertical rhythm that betrays a table, and the
 *  positive proof of prose that has been wrapped.
 *  NOT here: the reading order that follows the cut
 *  (`extractor/pdf-bands.ts`, `layout/gutter.ts`), nor the grids themselves
 *  (`layout/vector-grid.ts`, `layout/aligned-grid.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`,
 *  `extractor/pdf-table-detector.ts` and `tools/pdf-geometry-probe.ts`,
 *  through the `layout/geometry.ts` façade; and directly by `layout/gutter.ts` (`bandsCarryProse`). */

import type { Fragment } from "doc-ir/internal";
import { modeOf } from "./mode";
import { dominantTextSize } from "./text-size";

// Four stages. Stage 0 is `buildGridFromVectorLines` (`layout/vector-grid.ts`), which decides alone when the document
// draws its grid; the other three live here, on geometry only.
//
//   stage 0  vector grid                 -> table, decides alone
//   stage 1  gutter?                     -> no: prose, nothing is touched
//   stage 2  repeated second rhythm?     -> yes: table (borderless candidate)
//   stage 3  density + words/fragment    -> yes: columns; no: abstention
//
// Three signals were tried, then set aside, so that they do not come back:
//   - the width of the gutter: inverted (a borderless table has a wider gutter than real columns);
//   - the balance of the bands: the gutter already rules out the false positive it was there for;
//   - the share of gaps equal to the mode: it puts a short two-column page with the tables and a label/value block
//     above real columns. What separates is how many times a second rhythm occurs, not the share of the first.

/** An abscissa bin covered by more than this share of the lines is not a gutter. The threshold lets through the few
 *  full-width lines of a real document (title, lead, box) without letting a column through.
 *  Starting value to calibrate: two dense documents only, whose real gutters measure 0.13 and 0.17. */
const GUTTER_MAX_LINE_COVERAGE = 0.2;

/** A gutter narrower than this many times the dominant body size is spacing, not a column separation. Relative to
 *  the body, never absolute: an absolute value carries a page size.
 *  Starting value to calibrate: two dense documents only. */
const GUTTER_MIN_WIDTH_RATIO = 1;

/** Fallback, in points, when the body size cannot be measured. */
const GUTTER_MIN_WIDTH_FALLBACK = 10;

/** Widest text box (in points) the gutter profile is built over. Above it the
 *  page abstains instead of allocating one bin per point. Valeur de départ à
 *  calibrer: not measured on a corpus yet, only meant to stop an absurd allocation. */
export const COLUMN_GUTTER_MAX_SPAN = 20_000;

/**
 * The abscissa where a page is cut into two bands. It says whether the page has bands and where to cut, nothing of
 * what the bands are: stage 2 settles table against columns.
 *
 * The profile is the share of lines covering each bin, not the presence of a fragment: otherwise one full-width line
 * (a title, a lead) would erase the gutter of the whole page.
 */
export function detectColumnGutter(
  fragmentsByLine: readonly Fragment[][],
): { cut: number; start: number; end: number } | undefined {
  // Non-finite geometry carries no position: such a fragment is ignored.
  const lines = fragmentsByLine
    .map((line) =>
      line.filter(
        (f) => f.text.trim().length > 0 && Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.width),
      ),
    )
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  const all = lines.flat();
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of all) {
    if (f.x < lo) lo = f.x;
    if (f.x + f.width > hi) hi = f.x + f.width;
  }
  if (!(hi - lo <= COLUMN_GUTTER_MAX_SPAN)) return undefined;
  const width = Math.ceil(hi - lo);
  if (width <= 0) return undefined;
  const body = dominantTextSize(all);
  const minGutter = body !== undefined && body > 0 ? GUTTER_MIN_WIDTH_RATIO * body : GUTTER_MIN_WIDTH_FALLBACK;

  const coverage = new Array<number>(width + 1).fill(0);
  for (const line of lines) {
    const bins = new Set<number>();
    for (const f of line) {
      const from = Math.max(0, Math.floor(f.x - lo));
      const to = Math.min(width, Math.ceil(f.x + f.width - lo));
      for (let i = from; i <= to; i++) bins.add(i);
    }
    for (const i of bins) coverage[i] = (coverage[i] ?? 0) + 1;
  }

  let best: { cut: number; start: number; end: number; width: number } | undefined;
  let runStart = -1;
  for (let i = 0; i <= width + 1; i++) {
    const empty = i <= width && coverage[i]! / lines.length <= GUTTER_MAX_LINE_COVERAGE;
    if (empty) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;
    const runWidth = i - runStart;
    // `runStart > 0 && i <= width`: a run of empty bins that touches an edge of the text box is a margin.
    if (runWidth >= minGutter && runStart > 0 && i <= width && (best === undefined || runWidth > best.width)) {
      best = { cut: lo + runStart + runWidth / 2, start: lo + runStart, end: lo + i, width: runWidth };
    }
    runStart = -1;
  }
  return best ? { cut: best.cut, start: best.start, end: best.end } : undefined;
}

/** A second rhythm seen fewer times than this is noise, not a period.
 *  Starting value to calibrate: 3 to 5 occurrences on three pages with a table, 1 on two pages in columns. */
const MIN_SECOND_RHYTHM_OCCURRENCES = 3;

export interface VerticalRhythm {
  /** Most frequent line gap, rounded to the point. */
  mode: number;
  modeCount: number;
  /** Second most frequent gap, if any. */
  second?: number;
  secondCount: number;
  sampleSize: number;
}

/** The histogram of vertical gaps between consecutive lines, rounded to the point. Expects the lines sorted by
 *  decreasing ordinate. */
export function verticalRhythm(fragmentsByLine: readonly Fragment[][]): VerticalRhythm | undefined {
  const ys = fragmentsByLine
    .map((line) => line.find((f) => f.text.trim().length > 0)?.y)
    .filter((y): y is number => y !== undefined);
  const gaps = ys
    .slice(0, -1)
    .map((y, i) => Math.round(y - ys[i + 1]!))
    .filter((g) => g > 0);
  if (gaps.length === 0) return undefined;
  const histogram = new Map<number, number>();
  for (const g of gaps) histogram.set(g, (histogram.get(g) ?? 0) + 1);
  const mode = modeOf(histogram, "smallest")!;
  const rest = new Map(histogram);
  rest.delete(mode);
  const second = modeOf(rest, "smallest");
  return {
    mode,
    modeCount: histogram.get(mode)!,
    ...(second !== undefined ? { second } : {}),
    secondCount: second === undefined ? 0 : histogram.get(second)!,
    sampleSize: gaps.length,
  };
}

/**
 * The signal that says "table", never "columns". Prose has one line rhythm, a table has two: the line gap inside a
 * cell and the separation between rows. It is a count, not a share, so it still reads on a short page.
 *
 * Its absence does not prove columns: an isolated label/value block has a single rhythm and is no column layout.
 * Hence stage 3, which asks for a positive proof before partitioning.
 *
 * Limit: the second rhythm is a constant padding between rows. A table with variable padding has no repeated second
 * mode and is not seen.
 */
export function hasRepeatedSecondRhythm(fragmentsByLine: readonly Fragment[][]): boolean {
  const rhythm = verticalRhythm(fragmentsByLine);
  return rhythm !== undefined && rhythm.secondCount >= MIN_SECOND_RHYTHM_OCCURRENCES;
}

/** Below this many lines no signal expressed as a share means anything: a page of 8 and 6 lines in real columns was
 *  classed with the tables by three independent signals. Why the gate is a condition: see `looksLikeTextColumns`.
 *  Starting value to calibrate: two dense documents only. */
const MIN_COLUMN_LINES = 10;

/** Below this average a band carries labels or values, not prose.
 *  Starting value to calibrate: 1.69 to 3.00 for label/value blocks and an invoice, 4.80 to 8.77 for real columns. */
const MIN_WORDS_PER_FRAGMENT = 4;

const wordCount = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

/** What is needed of a fragment to say whether it carries prose: its text and its horizontal extent, no ordinate nor
 *  height, so that `layout/gutter.ts` can ask the same question. */
export interface BandFragment {
  text: string;
  x: number;
  width: number;
}

/**
 * Whether both bands of a cut carry prose, or one is only a column of labels.
 *
 * The words-per-fragment criterion of stage 3 alone, without the ten-line gate nor the lowercase hardening: the
 * gutter cut (`layout/gutter.ts`) serves short pages and needs this one only.
 *
 * On the cuts the gutter really kept, the poorer band of a label column read as text measures 1.00 to 3.57 words per
 * fragment, that of real prose columns 5.75: `MIN_WORDS_PER_FRAGMENT` falls in the gap, so no new threshold.
 */
export function bandsCarryProse(fragments: readonly BandFragment[], cut: number): boolean {
  const real = fragments.filter((f) => f.text.trim().length > 0);
  // Both bands must carry prose: a page with one empty band is in one column.
  for (const side of [(f: BandFragment) => f.x + f.width / 2 < cut, (f: BandFragment) => f.x + f.width / 2 >= cut]) {
    const band = real.filter(side);
    if (band.length === 0) return false;
    const words = band.reduce((sum, f) => sum + wordCount(f.text), 0) / band.length;
    if (words < MIN_WORDS_PER_FRAGMENT) return false;
  }
  return true;
}

/**
 * Hardening of the dense branch: the least share of lines that start with a lowercase letter.
 *
 * A line that starts in lowercase continues the previous one: the only clue, with no model nor dictionary, that a
 * text was wrapped. A label/value block never produces any. The signal only refuses a partition the other criteria
 * would accept, it allows none more: what it catches is a long form whose labels are wordy enough to pass
 * `MIN_WORDS_PER_FRAGMENT`. Short two-band pages whose lines are complete items stay unpartitioned.
 *
 * It is read only on cased scripts (`MIN_CASED_CHAR_FRACTION`), and that guard must stay: Han, kana and hangul have
 * no case, so the signal is 0 on any Japanese, Chinese or Korean document and would refuse properly laid columns.
 * The guard tests the share of cased characters, not the language, which is not known at this stage. Today
 * `MIN_WORDS_PER_FRAGMENT` already abstains on Japanese, but by accident (`wordCount` splits on spaces): the case
 * guard is what keeps the refusal right once that count is fixed.
 *
 * Starting value to calibrate, with a thin margin: German prose, which capitalises every noun, goes down to 0.20 on
 * its poorest pages (median 0.29, French 0.67). A threshold above 0.20 would stop recognising German prose.
 */
const MIN_LOWERCASE_LINE_STARTS = 0.15;

/** Below this share of cased characters the script is not bicameral and `MIN_LOWERCASE_LINE_STARTS` means nothing.
 *  Starting value to calibrate: 0.81 to 0.83 for French and German, 0.07 to 0.20 for Japanese. */
const MIN_CASED_CHAR_FRACTION = 0.5;

const CASED_CHAR = /\p{Lu}|\p{Ll}/gu;
const STARTS_LOWERCASE = /^\s*["«(\[]?\p{Ll}/u;

/**
 * Stage 3: the positive proof of two columns of prose, not the absence of proof of the contrary.
 *
 * Why density is a condition and not a setting: the label/value block of an invoice, taken alone, passes every signal
 * of a short two-band page but one (a clear gutter, a single rhythm, text on both sides of every line). Only the
 * words per fragment differ, and the labels of a real invoice are often sentences: one signal is no discriminant.
 *
 * Accepted limit: short two-column pages are not partitioned and their text stays interleaved.
 */
export function looksLikeTextColumns(fragmentsByLine: readonly Fragment[][], cut: number): boolean {
  const lines = fragmentsByLine
    .map((line) => line.filter((f) => f.text.trim().length > 0))
    .filter((line) => line.length > 0);
  if (lines.length < MIN_COLUMN_LINES) return false;
  if (!bandsCarryProse(lines.flat(), cut)) return false;
  for (const side of [(f: Fragment) => f.x + f.width / 2 < cut, (f: Fragment) => f.x + f.width / 2 >= cut]) {
    const linesOnSide = lines.map((line) => line.filter(side)).filter((line) => line.length > 0);
    const fragments = linesOnSide.flat();

    // Measured per band, not on the whole visual line: the band is what is or is not wrapped prose, and its first
    // fragment is its line start (fragments are sorted by increasing abscissa).
    const text = fragments.map((f) => f.text).join("");
    const casedFraction = (text.match(CASED_CHAR) ?? []).length / Math.max(1, text.length);
    if (casedFraction < MIN_CASED_CHAR_FRACTION) continue;
    const lowercaseStarts =
      linesOnSide.filter((line) => STARTS_LOWERCASE.test(line[0]!.text)).length / linesOnSide.length;
    if (lowercaseStarts < MIN_LOWERCASE_LINE_STARTS) return false;
  }
  return true;
}
