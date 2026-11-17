/** The glyphs assigned to one table cell turned back into readable lines.
 *  Also exports `firstWordWidthOf`, the one rule for a line's first-word advance, shared with the page reader.
 *  NOT here: any product type — this package knows nothing of IR or the
 *  renderer; the caller wraps the lines (`extractor/pdf-table-render.ts`). Nor the
 *  assignment itself (`layout/geometry.ts`).
 *  Called by: `extractor/pdf-table-render.ts` (`recomposeCellText`), `extractor/pdf-cell-paragraphs.ts` (the `CellLine` type)
 *  and `extractor/pdf-line-breaks.ts` (`firstWordWidthOf`). */

/**
 * `layout/cell-text` — the glyphs of a cell become text again.
 *
 * Last link of the analysis chain: `assignFragmentsToCells` places each
 * glyph in exactly one cell, this module turns them back into readable lines.
 *
 * IT DOES NOT RETURN AN `IRBlock`, AND THAT IS A CONSTRAINT, NOT AN OVERSIGHT. The layout
 * module has no dependency on the product — no IRDoc, no renderer, no
 * Forge (see the header of `geometry.ts`). It returns a NEUTRAL structure, and
 * it is the extractor that translates it into blocks. Concrete benefit beyond the
 * rule: the recomposition is tested with hand-written glyphs, without a
 * PDF reader or IRDoc — so it is measurable by a third party, which entry v0.20
 * of the `former ideas log (git history)` asks for.
 */

import { minOf } from "doc-ir/lib/extent";
import { WORD_GAP_EM } from "./word-gap";
import { groupIntoReseatedLines } from "doc-ir/layout/baseline-lines";
import { clusterPositions, dominantTextSize, type Fragment } from "doc-ir/layout/geometry";
import {
  dominantSizeByChars,
  SUPERSCRIPT_MAX_RISE_EM,
  SUPERSCRIPT_MAX_SIZE_RATIO,
  SUPERSCRIPT_MIN_RISE_EM,
  TRAILING_CALL_GAP_EM,
} from "doc-ir/layout/superscript";

/** The column boundaries that delimit the cell, in page space. */
export interface CellBounds {
  left: number;
  right: number;
}

export interface CellLine {
  /** The text of the logical line — one visual line, or several if the
   *  text wrapped there. Never empty. */
  text: string;
  /** Indentation depth: `0` if the line starts at the cell's margin,
   *  `1` if it is indented. **Binary, deliberately** — see the
   *  comment of the computation: counting distinct abscissae would fabricate
   *  levels that the document does not declare.
   *
   *  GAP 17, FIRST STEP. This value is MEASURED and RECORDED, it
   *  is not yet INTERPRETED. The distinction is not one of form:
   *
   *  - preserving the SEPARATION of lines asserts nothing — they are the document's
   *    visual lines, as it draws them;
   *  - deciding that "indented" means "subordinate" is an assertion of a
   *    different class, which the document does not make.
   *
   *  The second step (rendering the hierarchy, for example as a nested list)
   *  waits to have seen the first rendering. `depth` is carried from now on because
   *  the information is measured: throwing it away would force a full re-traversal. */
  depth: number;
  /** Vertical middle of the logical line's FIRST visual line, in page space —
   *  what an image placed in the same cell is ordered against. */
  middle: number;
  /** Vertical middle of the visual line it ENDS on: the ordinate a vertical
   *  gap to the next logical line is measured from. Equal to `middle` on a line
   *  that was never wrapped. */
  endMiddle: number;
  /**
   * THE GEOMETRY OF THE LINE, CARRIED BUT NOT READ HERE (23/09/2026).
   *
   * This module decides where a logical line STARTS and ENDS; whether two
   * logical lines are the two halves of one sentence is a different question,
   * asked one level up (`extractor/pdf-cell-paragraphs.ts`) because it needs
   * the typographer's rule, which lives in the extractor
   * (`pdf-line-breaks.ts#isDeliberateBreak`). The measurements it stands on are
   * made here and nowhere else: recomposing the visual lines a second time
   * outside would duplicate the reading, and the two copies would drift.
   */
  /** Left edge of the logical line's FIRST visual line, in page space. */
  left: number;
  /** Right edge where the logical line's text STOPS — the right edge of its
   *  LAST visual line, which is the one a break is judged on. */
  right: number;
  /** The greatest right edge among its visual lines: what the cell's own right
   *  margin is taken from. */
  widest: number;
  /** Text size of the visual line the logical line ends on, in points — 0 when
   *  the line carries no measurable glyph. */
  fontSize: number;
  /** Text size of the visual line it STARTS on. Equal to `fontSize` on a line
   *  that was never wrapped; both are needed because a join compares the size
   *  one line ends at with the size the next one opens at. */
  startFontSize: number;
  /** Exact advance of the FIRST word of its first visual line, summed from the
   *  glyphs. 0 means « unreadable », never « nothing ». */
  firstWordWidth: number;
  /** The fragments whose text makes `text`, in the order their text is read — whitespace aside, `text` is their
   *  texts joined. What lets the caller tie a character back to its glyph (a link, `extractor/pdf-table-render.ts`).
   *  Optional: a line built by hand has none. */
  fragments?: readonly Fragment[];
  /** The fragments of the line that are raised calls (footnote numbers, « m² »), read per VISUAL line with the page flow's
   *  geometry (`./superscript.ts`). The text keeps them glued as drawn; the renderer marks them `sup`. Absent when none. */
  raised?: ReadonlySet<Fragment>;
}

/**
 * FILL THRESHOLD — AND THE ASYMMETRY THAT JUSTIFIES IT.
 *
 * A line that fills at least this share of its cell's useful width,
 * AND that is followed by another, is read as a LINE WRAP: the text
 * continues, we join. Below it, it is a TRUE BREAK: two distinct data,
 * we separate.
 *
 * **The value will move one day; the reason for setting it HIGH must
 * outlive it. The two possible errors do not cost the same:**
 *
 * - **threshold too LOW ⇒ two data glued together.** `"FRANCAIS"` and `"Mme FINELLE"`
 *   become `"FRANCAIS Mme FINELLE"`. This is the family of findings C5 and C6
 *   of the rendering review: **plausible, invisible, wrong**. The reader does not
 *   see that a boundary is missing.
 * - **threshold too HIGH ⇒ one line break too many** in the middle of an appraisal.
 *   It is ugly, it is **visible**, and it fools nobody.
 *
 * **Between the two, we take the ugly.** It is the same rule as everywhere else
 * in this repository: a visible failure is better than an apparent success.
 *
 * The value itself is a STARTING VALUE TO CALIBRATE, backed by a measurement
 * on real documents: the fill of lines there is 32 %, 40 %, 55 % for
 * distinct data, and 96 % for a true line wrap. The gap is
 * clear and nothing falls between 55 % and 96 % — but six documents do not make a
 * calibration.
 *
 * ⚠️ **`hasEOL` DOES NOT EXIST AT THIS GRANULARITY, and that is not an oversight.**
 * pdf.js's (removed) `getTextContent` carried a `hasEOL` on its items, which would have answered
 * the question directly. But it is COMPUTED by that aggregated layer: it
 * exists nowhere in the operator stream, where the glyphs come from.
 * Fill is therefore the only signal available here. Whoever looks for better
 * later will know that the obvious lead was looked at and that it is closed at
 * this level.
 *
 * ⚠️ **THIS THRESHOLD HAS A DOMAIN OF VALIDITY, and it is bounded by the CELL
 * WIDTH.** The fills above were measured in wide
 * cells. In an 18.6 pt column, every value fills: the threshold no longer
 * separates anything there. It is the degeneracy guard, in `recomposeCellText`,
 * that handles this case — the threshold itself must not be moved to answer it.
 */
const WRAP_FILL_RATIO = 0.85;

/**
 * Abscissa gap below which two lines start "at the same place".
 *
 * Deliberately WIDER than the geometric grouping tolerance (2 pt):
 * the question here is not whether two strokes are the same stroke, but whether two
 * lines of text share a margin. Measured on the real case: within
 * a single indented group, the abscissae go from 78.9 to 89.4 — ten points
 * of spread without a change of level —, whereas the indent that separates two
 * levels is fifty. Any value between ~15 and ~45 separates these two populations
 * correctly; 20 is wide of both sides.
 *
 * **THIS THRESHOLD WAS ABSOLUTE, AND THAT WAS THE GENERALITY DEFECT** (fixed on
 * 11/09/2026, MIKSUDOC « Spécification technique » §5.4.1). Twenty points, calibrated on one generator
 * and two templates, encoded that generator: on a bulletin whose body
 * is 6.50 pt, twenty points are worth three lines of text; on an
 * 11 pt document, less than two. The threshold is therefore now expressed in multiples of the
 * dominant body size (`geometry.ts#dominantTextSize`).
 *
 * **THE MULTIPLE KEEPS THE MEASURED BEHAVIOUR.** Three times the body gives
 * 19.5 pt on the bulletin, where the absolute value gave 20 — so wide of
 * the same two populations, 10.5 pt of intra-group spread and 50 pt of
 * indent between levels. On the rest of the corpus, whose bodies run from 9 to
 * 22 pt, the threshold follows the source instead of contradicting it.
 *
 * **Starting value to calibrate**: the multiple still comes from a single
 * generator. What changes is that it no longer carries a page size.
 */
const INDENT_TOLERANCE_RATIO = 3;

/** When the body size is not measurable — a cell without any usable
 *  character —, we fall back on the old absolute value rather than
 *  invent a scale. */
const INDENT_TOLERANCE_FALLBACK = 20;

/** A run of this many one-glyph tokens in a row (« L I V R E T », « 2 8 5 6 ») is a letter-spaced word or spread figures: its gaps are
 *  not word gaps. Two stay possible (« of a new » is two words around the one-letter « a »).
 *
 *  STARTING VALUE TO CALIBRATE. Measured: the letter-spaced Canva title of fixture 26 (every one of 21 gaps) and the figures of fixture
 *  46 (20 gaps) are runs of 6 to 12 one-glyph tokens; running English text has one-letter words (« a », « I ») isolated, 2 in a row at
 *  most (« a b » in prose is rare). Few documents: the gap between 2 and 6 is wide on paper only. */
const LETTER_SPACED_TOKENS = 3;

/** A line on which more than this share of the ink-to-ink pairs gap over `TRACKED_GAP_EM` is TRACKED (letter-spaced): its gaps are the
 *  letters', not the words', and only its real space glyphs separate words.
 *
 *  STARTING VALUE TO CALIBRATE. Measured: a letter-spaced title (fixture 26) gaps after EVERY letter (share 1.0); running justified
 *  text gaps once per word, a minority of its pairs (pinned by the « the same » test). Half sits between the two. */
const TRACKED_LINE_SHARE = 0.5;

/** The gap, in em, over which a pair counts toward a tracked line: lower than the word gap, so that tracking close to it (0.08 to
 *  0.13 em, mixed by kerning) still reads as tracking. Not a word gap: it decides the LINE, never a cut.
 *
 *  STARTING VALUE TO CALIBRATE. Glyph pairs inside a word: p99 = 0.024 em (`tools/probe-glyph-words.ts` (deleted, see git history), 405 563 pairs); half the word
 *  gap, 0.05 em, is over that and under the lowest tracking measured (0.12 em in a constructed case). Known limit: tracking that
 *  kerning pulls under 0.05 em on most pairs is read as ordinary text and cut where it passes 0.1 em. */
const TRACKED_GAP_EM = WORD_GAP_EM / 2;

/** A line needs at least this many ink pairs before it can be called tracked: « A » « B » 0.3 em apart, « Q 3 », « 5 % » are cells
 *  of two glyphs, not tracked lines, and their gap is kept.
 *
 *  STARTING VALUE TO CALIBRATE. Tracked lines measured: « LIVRET » (5 pairs, fixture 26), the figures of fixture 46 (3 to 5 pairs,
 *  also guarded by `LETTER_SPACED_TOKENS`). WRITTEN BIAS: on a long line of one- and two-letter words with no space glyph
 *  (« a b c is it on ») every pair is gapped or tight at random, the line reads as tracked and its words are glued. No discriminant
 *  separates it from tracking at glyph level; we abstain from cutting (pinned by a test), the same abstention as before this rule. */
const TRACKED_MIN_PAIRS = 5;

/** A gap of this many em or more is never tracking.
 *
 *  STARTING VALUE TO CALIBRATE. Measured tracking: 0.257 em (fixture 26); figures spread one by one: 0.446 em (fixture 46). One em
 *  is over both, and under the gap between two cell columns merged into one cell (several em). */
const TRACKING_MAX_EM = 1;

/** A blank starting this many em or more before the end of the previous letter is drawn OVER it: no space. The same value and reading as
 *  the page flow (`extractor/glyph-runs.ts`, `OVERLAP_EM`).
 *
 *  STARTING VALUE TO CALIBRATE. Measured 19/10/2026, corpus 219 p2: Word draws a blank glyph 4.1 pt (0.41 em) INSIDE the initial « D » of
 *  « DataType » (a small-capital word), and the cell read « D ataType » (« P age » likewise); the letters themselves touch (gap -0.003 em). */
const OVERLAP_EM = 0.05;

const COMBINING_MARK = /^\p{M}/u;

/** The line without the blank glyphs that have NO HORIZONTAL ROOM: drawn over the letter before them, or over the letter after
 *  them. Both sides, same `OVERLAP_EM` tolerance.
 *
 * 🔴 WHY THE FORWARD SIDE EXISTS SINCE 03/11/2026, and it was paid for. Looking only BACKWARD published « op erations: »,
 * « o perations: » and « op e ration s: » — the same phrase broken at four different places in four cells of one column of
 * fixture 55, where the reference (PDFium) reads « operations: » whole four times. MEASURED at the glyph: « p » ends at
 * x=242.2, the blank starts at 242.2 (so it does not overlap « p » and was kept), and the « e » starts at 242.2 TOO — the
 * blank is drawn over the letter that FOLLOWS it. Every gap of that line is between −0.008 and 0.014 em, so no word-gap
 * threshold was involved: three evenings were spent on `WORD_GAP_EM` for nothing, and 0.5 em did not heal it.
 * WHAT IT CANNOT DROP: a real space, whose next letter starts at or after the blank's own end — the condition is an
 * OVERLAP, never a narrow gap. */
const withoutOverdrawnBlanks = (line: readonly Fragment[]): readonly Fragment[] => {
  /** The next ink glyph after each index — read once, backwards, so the filter stays linear. */
  const following: (Fragment | undefined)[] = Array.from({ length: line.length });
  let ahead: Fragment | undefined;
  for (let i = line.length - 1; i >= 0; i--) {
    following[i] = ahead;
    const f = line[i]!;
    if (f.text.trim().length > 0 && f.width > 0) ahead = f;
  }
  let lastInk: Fragment | undefined;
  return line.filter((f, i) => {
    if (f.text.trim().length > 0) {
      if (f.width > 0) lastInk = f;
      return true;
    }
    const overPrevious =
      lastInk !== undefined && lastInk.height > 0 && f.x < lastInk.x + lastInk.width - OVERLAP_EM * lastInk.height;
    const next = following[i];
    const overNext = next !== undefined && next.height > 0 && f.x + f.width > next.x + OVERLAP_EM * next.height;
    return !overPrevious && !overNext;
  });
};

/** The text of a visual line: its glyphs joined, with a space at every word gap the PDF left without a space glyph.
 *  Never on a tracked line (`TRACKED_LINE_SHARE`), never inside a run of `LETTER_SPACED_TOKENS` one-glyph tokens, never beside a
 *  combining mark, a glyph with no advance or a size that is not positive. A gap of `TRACKING_MAX_EM` or more is always cut. */
export const joinGlyphs = (drawn: readonly Fragment[]): string => {
  const line = withoutOverdrawnBlanks(drawn);
  const ink = line.map((f) => f.text.trim().length > 0 && f.width > 0 && !COMBINING_MARK.test(f.text));
  /** The gap after glyph `i`, in em; NaN when there is no decision to take (no pair, or no positive size). */
  const gaps = line.map((f, i) => {
    const next = line[i + 1];
    if (next === undefined || !ink[i] || !ink[i + 1]) return Number.NaN;
    const em = Math.max(f.height, next.height);
    return em > 0 ? (next.x - (f.x + f.width)) / em : Number.NaN;
  });
  const wide = gaps.map((g) => g >= TRACKING_MAX_EM);
  const pairs = gaps.filter((g) => !Number.isNaN(g)).length;
  const tracked =
    pairs >= TRACKED_MIN_PAIRS &&
    gaps.filter((g, i) => g > TRACKED_GAP_EM && !wide[i]).length > TRACKED_LINE_SHARE * pairs;
  const cut = gaps.map((g, i) => (tracked ? wide[i]! : g > WORD_GAP_EM));
  // Tokens: the glyphs between two gaps. A run of one-glyph tokens is letter-spaced text; the gaps INSIDE the run are cancelled.
  let tokenStart = 0;
  const tokens: [number, number][] = [];
  line.forEach((_, i) => {
    if (cut[i] === true || i === line.length - 1) {
      tokens.push([tokenStart, i]);
      tokenStart = i + 1;
    }
  });
  for (let t = 0; t < tokens.length;) {
    let end = t;
    while (end < tokens.length && tokens[end]![0] === tokens[end]![1]) end++;
    if (end - t >= LETTER_SPACED_TOKENS)
      for (let k = t; k < end - 1; k++) if (!wide[tokens[k]![1]]) cut[tokens[k]![1]] = false;
    t = Math.max(end, t + 1);
  }
  return line.map((f, i) => (cut[i] === true ? `${f.text} ` : f.text)).join("");
};

interface VisualLine {
  text: string;
  /** Abscissa of the first glyph — used for the depth. */
  start: number;
  /** End abscissa of the last glyph. */
  end: number;
  /** Share of the useful width actually occupied, 0 if the cell is degenerate. */
  fill: number; /** Vertical middle of the first fragment. */
  middle: number;
  /** Body size of this visual line, in points. */
  size: number;
  /** Exact advance of its first word. */
  firstWordWidth: number;
  fragments: readonly Fragment[];
  raised: ReadonlySet<Fragment>;
}

const isInk = (f: Fragment): boolean => f.text.trim().length > 0 && f.height > 0;

/** The raised calls of one visual line: smaller glyphs after the host (the first ink glyph of the line's DOMINANT size, a tie
 *  going to the larger: the page flow's own reading, `dominantSizeByChars`) whose baseline rises by the superscript interval. */
const raisedCallsOf = (line: readonly Fragment[]): ReadonlySet<Fragment> => {
  const raised = new Set<Fragment>();
  const ink = line.filter(isInk);
  const hostSize = dominantSizeByChars(
    ink,
    (f) => f.text,
    (f) => f.height,
  );
  const host = ink.find((f) => f.height === hostSize);
  if (host === undefined) return raised;
  for (const f of ink) {
    if (!(f.x > host.x) || !(f.height <= SUPERSCRIPT_MAX_SIZE_RATIO * hostSize)) continue;
    const rise = f.y - host.y;
    if (rise > SUPERSCRIPT_MIN_RISE_EM * hostSize && rise <= SUPERSCRIPT_MAX_RISE_EM * hostSize) raised.add(f);
  }
  return raised;
};

/** THE EXACT ADVANCE OF A LINE'S FIRST WORD — the sum of its glyph widths up to the next blank, leading blanks
 *  skipped. The ONE rule: `extractor/pdf-line-breaks.ts#firstWordWidthReader` calls it on the page's glyphs, the
 *  cell reader on the cell's. Glyphs come in reading order. */
export const firstWordWidthOf = (line: readonly { text: string; width: number }[]): number => {
  let width = 0;
  for (const f of line) {
    const blank = f.text.trim().length === 0;
    if (blank && width === 0) continue;
    if (blank) break;
    width += f.width;
  }
  return width;
};

/** A logical line under construction: the output, plus the junction state. */
interface BuildingLine extends CellLine {
  pendingWrap: boolean;
  /** The text of the LAST visual line joined into this one (never the accumulated text): the junction rules read only it. */
  lastVisualText: string;
}

/** Joins the next visual line to `previous` (a wrap): text through `wrapSeparator`, the logical line now ends on THIS visual line, so
 *  its right edge and body size are the ones an end of line is judged on. `opensWrap` is whether this line fills the cell in turn. */
function joinWrappedLine(previous: BuildingLine, line: VisualLine, opensWrap: boolean): void {
  previous.text = `${previous.text.trimEnd()}${wrapSeparator(previous.lastVisualText, line.text)}${line.text.trimStart()}`;
  previous.lastVisualText = line.text;
  previous.pendingWrap = opensWrap;
  previous.right = line.end;
  previous.fontSize = line.size;
  previous.endMiddle = line.middle;
  previous.widest = Math.max(previous.widest, line.end);
  previous.fragments = [...(previous.fragments ?? []), ...line.fragments];
  if (line.raised.size > 0) previous.raised = new Set([...(previous.raised ?? []), ...line.raised]);
}

/** The separator written at a wrap junction: nothing when the cell cut a token or a hyphenated word, else one space.
 *  J1 « cut token »: the upper VISUAL line holds ONE token (no blank once trimmed), ends with a letter or digit, and the lower line
 *  starts with a lowercase letter. Measured 27/10/2026 on 32 Word/PDF pairs (2 464 junctions): 11 of 12 true cases fixed,
 *  0 of 2 298 false positives.
 *  J2 « hyphen »: the upper visual line ends with an ASCII « - » or « _ »; the hyphen stays. Measured: 25 of 25, no false positive.
 *  WRITTEN LIMITS: « …LIS » + « T » and « …CARDINA » + « L » (an uppercase lower line) stay spaced; an em dash is out of the rule;
 *  a wrapped token whose upper line holds several tokens or sits UNDER the 85 % fill never reaches this junction: the cut
 *  stays, ugly, visible and placed where the paper wraps. The named case is GONE since 28/10/2026 and NOT by this junction:
 *  jvmalin p13 « …/sched » + « ules » (a bold « GET » prefix on its upper line) is published whole because the failed-vote
 *  search licence went to 2 (`layout/vector-grid.ts`) and its box is read whole. The rule itself still does not fire there.
 *  A line that ends with a blank glyph keeps its space (the document wrote it).
 *  TRIED AND SET ASIDE (27/10/2026): « the glued form exists elsewhere in the document as one token » — 0 false positives on the
 *  same 2 464 junctions but it misses the jvmalin case too (87-char URL, unique prefix) and adds nothing over the one-token rule.
 *  J2's measured limits (27/10/2026, 96 real J2 junctions over 45 documents: 81 compounds right, 4 wrong): a Word SOFT HYPHEN
 *  (w:softHyphen) paints a hyphen the truth does not hold, so the join keeps a stray hyphen — 4 words, ONE Dutch document (223);
 *  and a truth hyphen FOLLOWED by a space the PDF never paints at the line end glues two tokens (« D-JRP15- » + « FED-AMR »,
 *  one case, 031). Candidate guard noted, not entered (catches 2 of the 4 hyphenations, 0 false positives, n = 2): unhyphenated form
 *  elsewhere in the document AND hyphenated form nowhere else.
 *  Bias: a space too many shows, a false glue does not. */
/** J2 alone, named for what it is: the upper line of a WRAP ends on a hyphen or an underscore, so the two halves join with
 *  no separator at all.
 *  🔴 NOT REUSABLE OUTSIDE A WRAP, and that was paid for on 29/10/2026. The logical-line junction of
 *  `extractor/pdf-cell-paragraphs.ts` read this very predicate for one night and glued « Total - » to « 12,00 » — a number
 *  nowhere in the document. What makes the rule safe HERE is its caller: `wrapSeparator` is only ever reached for a line
 *  whose last word did not fit the cell's drawn edge. That junction now has its own, narrower rule
 *  (`pdf-cell-paragraphs.ts#cutAcrossLines`: a LETTER before the hyphen, a LETTER after), measured on the same population. */
const endsOnJoiningHyphen = (upperLine: string): boolean =>
  // A blank glyph at the end of the upper line is a real separator the document wrote: nothing was cut.
  upperLine === upperLine.trimEnd() && /[-_]$/u.test(upperLine.trim());

const wrapSeparator = (upperLine: string, lowerLine: string): string => {
  // A blank glyph at the end of the upper line is a real separator the document wrote: nothing was cut, J1 and J2 alike.
  if (upperLine !== upperLine.trimEnd()) return " ";
  const upper = upperLine.trim();
  const lower = lowerLine.trimStart();
  if (endsOnJoiningHyphen(upperLine)) return "";
  const oneToken = upper.length > 0 && !/\s/.test(upper);
  // The lower line must start with a LOWERCASE letter only: no measured case wants a digit, and « 13,834 » + « 56 » would invent a number.
  return oneToken && /[\p{L}\p{N}]$/u.test(upper) && /^\p{Ll}/u.test(lower) ? "" : " ";
};

/** One visual line of a cell (its glyphs, left to right) with its measures; `width` is the cell's. */
const visualLineOf = (line: Fragment[], width: number): VisualLine => {
  const first = line[0]!;
  const last = line[line.length - 1]!;
  const span = last.x + last.width - first.x;
  return {
    text: joinGlyphs(line),
    start: first.x,
    end: last.x + last.width,
    middle: first.y + first.height / 2,
    size: dominantTextSize(line) ?? 0,
    firstWordWidth: firstWordWidthOf(line),
    fragments: line,
    raised: raisedCallsOf(line),
    // A cell of zero or negative width cannot say whether a
    // line "fills": `fill: 0` makes it read as a true break, so
    // we separate. Never join by default — joining wrongly glues two
    // data, separating wrongly adds a visible break.
    fill: width > 0 ? span / width : 0,
  };
};

/**
 * The glyphs of a cell → its logical lines, in reading order.
 *
 * Pure: no I/O, no clock, no randomness. Never mutates its input.
 */
export function recomposeCellText(
  fragments: readonly Fragment[],
  bounds: CellBounds,
  /** The document's dominant body size, in points. Absent ⇒ absolute fallback. */
  bodyTextSize?: number,
): CellLine[] {
  const indentTolerance =
    bodyTextSize !== undefined && bodyTextSize > 0 ? INDENT_TOLERANCE_RATIO * bodyTextSize : INDENT_TOLERANCE_FALLBACK;
  const width = bounds.right - bounds.left;
  // A WORD GAP WITH NO SPACE GLYPH IS WRITTEN AS A SPACE (`joinGlyphs`, 15/10/2026). It was a written limit (01/10/2026): a form
  // that paints « Mesto: » and its value with no space glyph is published « Mesto:BEOGRAD » (safedocs 0000441, Serbian). It was left
  // open "to reopen on a FR/EN document that shows the defect": fixture 34 (Google Docs, English) glued ~30 word pairs in its form
  // cells (« thesame », « maybe », « anew »), because Google Docs draws no space glyph in justified text. The page flow already
  // writes the space (`glyph-runs.ts`, `WORD_GAP_EM`), the cells did not.
  // Why the old abstention is lifted: the discriminant now exists. Measured by `tools/probe-glyph-words.ts` (deleted, see git history) over 481 372 glyph pairs
  // of the 6 FR/EN Word fixtures and SafeDocs: a gap over 0.1 em with no blank glyph splits 48 pairs Poppler keeps together and glues
  // none; those 48 are letter-spaced titles (fixture 26, 21) and figures spread one by one (fixture 46, 20), where EVERY glyph is
  // followed by a gap, plus 7 more in 0000713 (a PDF of the corpus, not examined one by one) — and a run of three one-glyph tokens in a row is what `joinGlyphs` refuses to cut.
  // A footnote call is raised over the line it belongs to, so it falls in a visual line of its own — and in a cell
  // merged across columns the calls of several columns, at the end of their own words, would be read as ONE line and
  // joined at the end of the line above (07, physical page 10: « data held by 345 HMCTS »). The page flow's rule
  // (`./superscript.ts`, same two readings, same constants) hangs each back on the line below it.
  const visual: VisualLine[] = groupIntoReseatedLines(fragments, (f) => f.height, TRAILING_CALL_GAP_EM)
    .map((line) => visualLineOf(line, width))
    .filter((l) => l.text.length > 0);
  if (visual.length === 0) return [];

  // THE DEPTH IS BINARY, AND THAT IS DELIBERATE.
  //
  // One abscissa per level would fabricate a hierarchy that the document does not
  // declare. Measured on the real case: the lines of a cell start at
  // `29.5`, `79.6` and `89.4` — three distinct abscissae, but only TWO groups,
  // `{29.5}` and `{79–89}`. The teacher's name is indented LESS than the
  // subject it accompanies: within a group, the abscissae
  // are not ordered by depth. Counting the abscissae would have given
  // three levels, one of which does not exist.
  //
  // We therefore record the only fact that the geometry establishes without ambiguity:
  // does this line start at the cell's margin, or indented? The
  // rest — how many levels, which contains which — is an interpretation,
  // and it is the SECOND step of gap 17 that will take it, with real cases
  // in view rather than a model guessed here.
  const shallowest = minOf(clusterPositions(visual.map((l) => l.start)), (p) => p);
  const depthOf = (start: number): number => (Math.abs(start - shallowest) <= indentTolerance ? 0 : 1);

  // THE DEGENERACY GUARD — when the threshold no longer discriminates, it no longer
  // decides (10/09/2026).
  //
  // Measured on a real bulletin: the columns "Clas." and "+" are 18.6 pt
  // wide. `"13,83"` fills more than 85 % there, `"6,59"` does not — hence three
  // distinct values JOINED into a single paragraph in one column, and
  // correctly separated in its neighbour, for the sole reason that one digit
  // less fitted there. The cell width is the variable that tips
  // the threshold, and it is what makes it fragile.
  //
  // WHAT THIS GUARD REALLY IS, and it is not one more heuristic:
  // in a column barely wider than its content, a line wrap
  // and two distinct values are GEOMETRICALLY INDISTINGUISHABLE. No
  // refinement of the threshold separates them. The guard therefore does not improve the
  // discriminant: it notes that it is not defined here, and refuses to
  // decide on a signal that says nothing.
  //
  // ITS RESERVE IS A CHOICE, NOT AN UNSEEN CASE: an appraisal each of whose
  // lines would end exactly at the end of the cell offers no asymmetry, and
  // will therefore be cut into separate lines. Rare, but possible. It is the same
  // bias as everywhere here — ugly and visible rather than wrong and invisible.
  //
  // FROM TWO LINES ONLY: with a single one, there is no
  // junction to decide, and "all of them fill" would say nothing.
  const noAsymmetry = visual.length >= 2 && visual.every((l) => l.fill >= WRAP_FILL_RATIO);
  const opensWrap = (line: VisualLine): boolean => !noAsymmetry && line.fill >= WRAP_FILL_RATIO;

  const out: BuildingLine[] = [];
  for (const line of visual) {
    const previous = out[out.length - 1];
    // A junction is decided on the PRECEDING line: it is the one that fills
    // the cell, so it is the one that announces that the text continues.
    if (previous !== undefined && previous.pendingWrap) {
      joinWrappedLine(previous, line, opensWrap(line));
      continue;
    }
    out.push({
      text: line.text,
      depth: depthOf(line.start),
      middle: line.middle,
      endMiddle: line.middle,
      left: line.start,
      right: line.end,
      widest: line.end,
      fontSize: line.size,
      startFontSize: line.size,
      firstWordWidth: line.firstWordWidth,
      fragments: line.fragments,
      ...(line.raised.size > 0 ? { raised: line.raised } : {}),
      pendingWrap: opensWrap(line),
      lastVisualText: line.text,
    });
  }

  // `pendingWrap` is a building state, not an output field.
  return out.map(
    ({
      text,
      depth,
      middle,
      endMiddle,
      left,
      right,
      widest,
      fontSize,
      startFontSize,
      firstWordWidth,
      fragments,
      raised,
    }) => ({
      text,
      depth,
      middle,
      endMiddle,
      left,
      right,
      widest,
      fontSize,
      startFontSize,
      firstWordWidth,
      ...(fragments !== undefined ? { fragments } : {}),
      ...(raised !== undefined ? { raised } : {}),
    }),
  );
}
