/** The text runs (`PdfTextRun`) of a PDF page, built from OUR glyphs (until pdf.js was removed, on 01/11/2026, they came from its `getTextContent()` items).
 *  Decides: where a run closes (font, size, baseline, step back, gap, marked content, form XObject) and where it gets a
 *  space (a blank glyph, or a gap over 0.1 em), and what a run carries (origin, width, size, font name, marked content).
 *  NOT here: reading the operators (`extractor/glyph-positions.ts`), which glyphs a viewer shows (`readGlyphs`,
 *  `pdf-hidden-text.ts`), the weight of the font (`pdf-source.ts#resolveRunWeights`), nor what a line or a paragraph
 *  is (`pdf-lines.ts` and after). A page whose glyphs cannot be read keeps no run: `pdf-source.ts` reports it as unreadable.
 *  Called by: `extractor/pdf-source.ts` (`runsOfGlyphs`, on the glyphs it already built). */

/**
 * WHY (docs/CONCEPTION-TEXTE-PDF-GLYPHES.md, decided by Mikolaj on 13/10/2026). pdf.js cut a word in two cycles at a
 * change of font (319 words on 27 documents) and between two glued paint operators (166), and gave the second cycle a
 * wrong position: `pdf-lines.ts#separatorBefore` then sees a gap and writes « é lectrique ». Our glyphs have the right
 * positions already. Measured on 58 French and English PDFs against Poppler 25.07 frozen: the word rule below, applied to
 * our glyphs, glued 0 words wrongly and cut 48 of 481 133 pairs (21 spaced capitals « L I V R E T », fixture 26, which
 * `pdf.ts#respaceLetterSpacedRuns` still writes).
 *
 * THE RULE, and its sources.
 *  - A run closes on a change of `Tf` font name, a change of size, a baseline shift (the text rise REMOVED) of more than
 *    0.25 × the size (the threshold pdf.js used; an absolute 0.5 pt would make a same-size superscript a run of its own,
 *    which `layout/superscript.ts` does not hang back: defect H), a step back of more than 0.2 em, a gap of more than
 *    0.6 em, a change of direction, and every marked-content or form XObject boundary (`GlyphFragment.section`).
 *  - Inside a run, ONE space is written for one or several blank glyphs, or for a gap of more than 0.1 em (Poppler's
 *    `minWordBreakSpace`, `TextOutputDev.cc` l. 2773).
 *  - A glyph outside the page's view box (CropBox within MediaBox) makes no run, as pdf.js's `getTextContent` did (worker
 *    `compareWithLastPosition`: the glyph's origin outside the box, or its end before the left edge): choice B of
 *    Mikolaj, 09/10/2026, a word that crosses the edge keeps its visible letters. The glyphs themselves are not cut.
 *  - A LETTER run neither starts nor ends with a blank, like the cycles of the former pdf.js (its origin is the first letter, its width ends
 *    with the last): inside it a blank is spacing between two letters. Without this a block ends with a space and a space
 *    and a gap make two (measured on the fixtures, 14/10/2026: « firefighting  this season »).
 *  - Blanks that a cut separates from the letters on both sides (a font change, a gap, a new section) are ONE run of their
 *    own, text one space, at the first blank glyph, as pdf.js emitted them. Dropped, they glued « Version 4Page 3 of 9 »
 *    (doc 38: the footer no longer seen as repeated) and « 3.Indicateurs » (doc 49, a gap under `pdf-lines.ts`'s word gap).
 *    Never at the end of a line or of the page (nothing after them to separate), never two in a row, never inside a run.
 *  - The text goes through `normalize` (given by the caller: NFKC in `pdf-source.ts`), as it went through pdf.js's `normalizeUnicode`.
 *
 * Thresholds below are « starting value to calibrate »: the first four come from pdf.js (0.25, 0.2 and 0.6 em, worker
 * l. 35866-35903 of 6.2.108) or Poppler (0.1 em); the bench says whether they move.
 */

import { buildGlyphFragments, readGlyphs, type FontScaleOf, type GlyphFragment, type HidePolicy, type NamedOp, type SymbolFontOf } from "./glyph-positions";
import { dropsModeHidden } from "./pdf-hidden-text";
import { WORD_GAP_EM } from "doc-ir/layout/word-gap";
import type { PdfTextRun } from "./pdf-source";
import { writingDirectionTurned } from "./text-writing-direction";

/** A baseline shift (text rise removed) above this × the size closes the run. */
const BASELINE_SHIFT_EM = 0.25;
/** A step back above this × the size closes the run. */
const STEP_BACK_EM = 0.2;
/** A gap above this × the size closes the run. */
const RUN_GAP_EM = 0.6;
/** A blank starting this × the size or more before the end of the previous letter is drawn over it (less is kerning or float
 *  noise: a blank that merely touches the letter is a space). Starting value to calibrate: 1.38 pt of 7 pt (0.2 em) in fixture 25. */
const OVERLAP_EM = 0.05;
/** Two sizes, or two directions, closer than this are the same (float noise of composed matrices). */
const SAME_RELATIVE = 1e-3;

export interface GlyphRunOptions {
  /** The page's object id (`p<num>R<gen>`, as pdf.js named it): a marked-content id is `<pageObjId>_mc<n>`. Without it a run
   *  has no `markedContentId`. */
  pageObjId?: string | undefined;
  /** The page's view box `[x0, y0, x1, y1]` (`page.view`); glyphs outside it make no run. Without it nothing is cut. */
  view?: readonly [number, number, number, number] | undefined;
  /** The Unicode normalisation (NFKC in `pdf-source.ts`). Without it the text stays as the glyphs gave it (ligatures already decomposed). */
  normalize?: ((text: string) => string) | undefined;
  /** Do two `Tf` keys name the SAME font object? A producer may declare one font under many resource names (fixture 30:
   *  forty names, one object); a font is identified by its object (as pdf.js did), so `/F1` then `/F2` of one object is no change of font
   *  and must not cut a run. Without it, two different keys are two fonts. */
  sameFont?: ((a: string | undefined, b: string | undefined) => boolean) | undefined;
}

/** A blank glyph is one whose TEXT is blank. Not `isSpace`: it is set from the character CODE (32), and a subset font can
 *  give that code to « » » (fixture 31, page 1: `isSpace` on a closing guillemet). pdf.js's own text used the Unicode
 *  category of the glyph, not the code. */
const isBlank = (g: GlyphFragment): boolean => g.text.trim() === "";

/** The unit vector of the glyph's own x axis in page space. */
function axisOf(g: GlyphFragment): { x: number; y: number } {
  const n = Math.hypot(g.matrix.a, g.matrix.b);
  return n === 0 ? { x: 1, y: 0 } : { x: g.matrix.a / n, y: g.matrix.b / n };
}

/** A span of blank glyphs, first to last. */
interface BlankSpan {
  first: GlyphFragment;
  last: GlyphFragment;
}

/** The run being built. */
interface OpenRun {
  /** The first glyph that is not blank (a blank-only run has its first glyph). */
  first: GlyphFragment;
  axis: { x: number; y: number };
  size: number;
  text: string;
  /** Does the run hold a glyph that is not blank? */
  hasInk: boolean;
  /** The last glyph that is not blank, and its baseline. */
  lastInk: GlyphFragment;
  lastInkBase: { x: number; y: number };
  /** The last glyph of any kind: what the next glyph is compared with. */
  prev: GlyphFragment;
  /** The blank glyphs before the first letter, and those after the last: not in the text, kept for the blank run a cut leaves. */
  lead: BlankSpan | undefined;
  trail: BlankSpan | undefined;
}

const baseOf = (g: GlyphFragment): { x: number; y: number } => ({ x: g.x - (g.rise?.x ?? 0), y: g.y - (g.rise?.y ?? 0) });

function openRun(g: GlyphFragment, base: { x: number; y: number }): OpenRun {
  const ink = !isBlank(g);
  return { first: g, axis: axisOf(g), size: g.height, text: ink ? g.text : "", hasInk: ink, lastInk: g, lastInkBase: base, prev: g, lead: ink ? undefined : { first: g, last: g }, trail: undefined };
}

/** What closes a run before glyph `g`. The font, the section and the size are compared with the previous glyph; the GEOMETRY
 *  (gap, step back, baseline) is measured from the last glyph that is not blank, so that blank glyphs cannot hide a wide gap:
 *  a document pads « 002283 ··········· 3. » with ten space glyphs, none of them a gap (safedocs 0000523, page 2). pdf.js
 *  measured the same way. `base` is `g`'s baseline. */
type Cut = "same-run" | "cut" | "new-line";

function cutBefore(run: OpenRun, g: GlyphFragment, base: { x: number; y: number }, sameFont: NonNullable<GlyphRunOptions["sameFont"]>): { cut: Cut; gap: number } {
  const { prev } = run;
  const axis = axisOf(g);
  if (Math.abs(axis.x - run.axis.x) > SAME_RELATIVE || Math.abs(axis.y - run.axis.y) > SAME_RELATIVE) return { cut: "cut", gap: 0 };
  const dx = base.x - run.lastInkBase.x;
  const dy = base.y - run.lastInkBase.y;
  const along = dx * run.axis.x + dy * run.axis.y;
  const across = -dx * run.axis.y + dy * run.axis.x;
  const gap = along - run.lastInk.width;
  // Font and size are read BEFORE the line change, so `hasEOL` stays what it was with pdf.js's runs: a smaller superscript raised 0.33 em
  // is a cut, not a new line (`pipeline/text-conservation.ts#joinRuns` reads `hasEOL`; review of 14/10/2026). The blank run
  // is kept off a line change in `runsOfGlyphs` instead, by the baselines.
  if (!sameFont(g.font, prev.font) || g.section !== prev.section || g.artifact !== prev.artifact) return { cut: "cut", gap: 0 };
  if (Math.abs(g.height - run.size) > SAME_RELATIVE * Math.max(run.size, g.height) + 1e-9) return { cut: "cut", gap: 0 };
  if (Math.abs(across) > BASELINE_SHIFT_EM * run.size) return { cut: "new-line", gap };
  if (gap < -STEP_BACK_EM * run.size || gap > RUN_GAP_EM * run.size) return { cut: "cut", gap };
  return { cut: "same-run", gap };
}

/** Is blank glyph `g` drawn back over the last letter of the run (it starts before that letter ends, on its baseline)? Then it
 *  is no space: fixture 25 draws a blank over the « fi » ligature before « cheur », and a viewer shows « afficheur ». */
function overlapsLastInk(run: OpenRun, g: GlyphFragment, base: { x: number; y: number }): boolean {
  if (!run.hasInk) return false;
  const axis = axisOf(g);
  if (Math.abs(axis.x - run.axis.x) > SAME_RELATIVE || Math.abs(axis.y - run.axis.y) > SAME_RELATIVE) return false;
  const dx = base.x - run.lastInkBase.x;
  const dy = base.y - run.lastInkBase.y;
  const across = -dx * run.axis.y + dy * run.axis.x;
  if (Math.abs(across) > BASELINE_SHIFT_EM * run.size) return false;
  return dx * run.axis.x + dy * run.axis.y < run.lastInk.width - OVERLAP_EM * run.size;
}

/** Two letter runs on one baseline: the next run's first letter lies within the baseline-shift tolerance of the previous
 *  run's last letter, across the previous run's axis. */
function sharesBaseline(before: OpenRun, after: OpenRun): boolean {
  const base = baseOf(after.first);
  const dx = base.x - before.lastInkBase.x;
  const dy = base.y - before.lastInkBase.y;
  return Math.abs(-dx * before.axis.y + dy * before.axis.x) <= BASELINE_SHIFT_EM * Math.max(before.size, after.size);
}

/** Adds a glyph that stays in the run. */
function extendRun(run: OpenRun, g: GlyphFragment, base: { x: number; y: number }, gap: number): void {
  if (isBlank(g)) {
    if (run.hasInk) run.trail = { first: run.trail?.first ?? g, last: g };
    else run.lead = { first: run.lead?.first ?? g, last: g };
  } else if (!run.hasInk) {
    // Blanks only so far: the run starts here.
    run.first = g;
    run.axis = axisOf(g);
    run.size = g.height;
    run.text = g.text;
    run.hasInk = true;
    run.lastInk = g;
    run.lastInkBase = base;
  } else {
    if (run.trail !== undefined || gap > WORD_GAP_EM * run.size) run.text += " ";
    run.text += g.text;
    run.trail = undefined;
    run.lastInk = g;
    run.lastInkBase = base;
  }
  run.prev = g;
}

const joinSpans = (a: BlankSpan | undefined, b: BlankSpan | undefined): BlankSpan | undefined =>
  a === undefined ? b : b === undefined ? a : { first: a.first, last: b.last };

/** The glyphs in paint order → text runs. `glyphs` must be what a viewer shows (hidden ones already left out) and
 *  already merged for overpaint (`buildGlyphFragments`): an header painted four times is one run. */
export function runsOfGlyphs(glyphs: readonly GlyphFragment[], options: GlyphRunOptions = {}): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  let open: OpenRun | undefined;
  // The blanks seen since the last letter run, to be written if a letter run follows on the same line.
  let pendingBlank: BlankSpan | undefined;
  // True until a letter run closes on the current line: a blank there has no letter before it.
  let lineStart = true;
  // The last letter run written: a blank run needs the next letter run on its baseline.
  let lastLetter: OpenRun | undefined;

  const close = (hasEOL: boolean): void => {
    if (open === undefined) return;
    if (open.hasInk) {
      // No blank across a line change that a font or size change hid from `cutBefore` (counter-review of 14/10/2026: « ab »
      // then a bold « cd » on the next line gave « ab  cd »): the two letter runs must share a baseline.
      const sameLine = lastLetter !== undefined && sharesBaseline(lastLetter, open);
      const between = lineStart || !sameLine ? undefined : joinSpans(pendingBlank, open.lead);
      if (between !== undefined) runs.push(blankRunOf(between, options));
      runs.push(runOf(open, hasEOL, options));
      lastLetter = open;
      lineStart = hasEOL;
      pendingBlank = hasEOL ? undefined : open.trail;
    } else {
      if (!lineStart) pendingBlank = joinSpans(pendingBlank, open.lead);
      if (hasEOL) {
        lineStart = true;
        pendingBlank = undefined;
      }
    }
    open = undefined;
  };

  const { view } = options;
  const sameFont = options.sameFont ?? ((a, b) => a === b);
  for (const g of glyphs) {
    if (view !== undefined && (g.x + g.width < view[0] || g.x > view[2] || g.y < view[1] || g.y > view[3])) continue;
    const base = baseOf(g);
    if (open === undefined) {
      open = openRun(g, base);
      continue;
    }
    const overlap = isBlank(g) && overlapsLastInk(open, g, base);
    const { cut, gap } = cutBefore(open, g, base, sameFont);
    if (cut !== "same-run") {
      close(cut === "new-line");
      open = openRun(g, base);
      // The cut stays (the step back is real), but the blank is no space: it leads nothing and feeds no blank run.
      if (overlap) open.lead = undefined;
      continue;
    }
    if (overlap) continue;
    extendRun(open, g, base, gap);
  }
  close(false);
  return runs;
}

/** The one space between two letter runs a cut separates: at the first blank glyph, as wide as the blanks, in their font. */
function blankRunOf({ first, last }: BlankSpan, options: GlyphRunOptions): PdfTextRun {
  return runOf({ first, lastInk: last, axis: axisOf(first), size: first.height, text: " ", lastInkBase: baseOf(last) }, false, options);
}

/** A SHEAR OF THE TEXT MATRIX IS AN ITALIC THE PDF DECLARES BY ITS GEOMETRY (05/11/2026): the caption of the newspaper's
 *  front page sets « Adieu à Terminus » in the same font as the rest, leaned by the matrix (c = 1.55 for d = 8, tan 11°).
 *  A rotation leans too, but with b ≠ 0; a shear keeps b at zero. Below `MIN_ITALIC_SHEAR` the lean is float noise. */
export const MIN_ITALIC_SHEAR = 0.05;

const shearedItalic = (m: { b: number; c: number; d: number }): boolean => Math.abs(m.b) < MIN_ITALIC_SHEAR * Math.abs(m.d) && Math.abs(m.c) >= MIN_ITALIC_SHEAR * Math.abs(m.d);

function runOf(open: Pick<OpenRun, "first" | "lastInk" | "axis" | "size" | "text" | "lastInkBase">, hasEOL: boolean, { pageObjId, normalize }: GlyphRunOptions): PdfTextRun {
  const { first, lastInk, axis } = open;
  const firstBase = baseOf(first);
  const along = (open.lastInkBase.x - firstBase.x) * axis.x + (open.lastInkBase.y - firstBase.y) * axis.y;
  return {
    text: normalize === undefined ? open.text : normalize(open.text),
    x: first.x,
    y: first.y,
    width: Math.max(0, along + lastInk.width),
    height: open.size,
    fontSize: open.size,
    matrix: first.matrix,
    fontId: first.font === undefined || first.font === "" ? undefined : first.font,
    // Resolved by `pdf-source.ts#resolveRunWeights`, once the font objects exist.
    weight: "unknown",
    italic: shearedItalic(first.matrix),
    rotated: writingDirectionTurned(first.matrix),
    hasEOL,
    dir: "ltr",
    markedContentId: first.mcid !== undefined && pageObjId !== undefined ? `${pageObjId}_mc${first.mcid}` : undefined,
    artifact: first.artifact === true,
  };
}

/** The runs of ONE page's operators, hidden glyphs left out (a layer switched off is shown: no configuration here).
 *  What `pdf-source.ts` does with glyphs it already built is `runsOfGlyphs`; this is the whole path from operators, for
 *  tests and probes. */
export function glyphRuns(
  ops: readonly NamedOp[],
  options: GlyphRunOptions & { hide?: HidePolicy; fontScaleOf?: FontScaleOf; symbolFontOf?: SymbolFontOf } = {},
): PdfTextRun[] {
  const hide: HidePolicy = options.hide ?? { isLayerVisible: () => true, dropModeHidden: dropsModeHidden(readGlyphs(ops, () => true, options.fontScaleOf, options.symbolFontOf)) };
  return runsOfGlyphs(buildGlyphFragments(ops, hide, options.fontScaleOf, options.symbolFontOf), options);
}
