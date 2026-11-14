/** The glyphs of a page without the ones drawn twice a hair apart (fake bold, double strike).
 *  Decides: which glyph is a second drawing of an earlier one (same character, same size, shifted by a fraction of an em).
 *  NOT here: the exact same-point merge (`glyph-positions.ts#collapseOverpaint`, which counts the paintings), the runs built after
 *  (`glyph-runs.ts`), the cells (`layout/cell-text.ts`).
 *  Called by: `extractor/glyph-positions.ts#buildGlyphFragments`, so that the page flow, the cells and the control reading all start from the same glyphs. */

import type { GlyphFragment } from "./glyph-positions";

/**
 * THE DEFECT (corpus 132, page 2, measured 19/10/2026). Word draws some form labels twice, 0.48 pt apart (« Street Address » at y 488.23
 * and 488.71, x within 0.12 pt, 9.96 pt): a double strike that thickens the text. pdf.js (then our text source) returned both, we published both
 * (« Street » three times for two boxes). Poppler reads the page with the label once.
 *
 * THE RULE, Poppler's duplicate suppression (`poppler/TextOutputDev.cc`, read 19/10/2026 at commit 6afde57f: `dupMaxPriDelta = 0.1`,
 * `dupMaxSecDelta = 0.2`, « as a fraction of the font size », used by `TextBlock::coalesce` to « discard duplicated text (fake
 * boldface, drop shadows) »; Poppler compares whole words, we compare glyphs): a glyph IDENTICAL to a glyph already placed (same
 * character, same size) and shifted by less than 0.1 em along the line and 0.6 em across it is a second drawing of that glyph and is kept once. A
 * different character is never removed. Only text that lies along an axis (not turned) is read: the direction of a turned glyph is the
 * run's business. The exact same-point merge keeps its own role and counts the paintings (`paintCount`); this one counts nothing, so the
 * colspan cross-check of `pdf-table-render.ts` (a label painted once per covered column) is not disturbed by a thickened label.
 *
 * Starting value to calibrate (across: 0.6 em), between the doubles measured and the tightest legible leading. The doubles sit 0.048 em
 * apart (0.48 pt at 9.96 pt) and up to 0.5 em: the 2.3 pt pair of the same page (« Click here to enter text. » at y 457.27 and 459.55,
 * 9.96 pt), kept on 19/10 as « the second population », WAS the defect. The .docx truth (~/d2c-corpus/word/132-ssp-a04-fedramp-pia-template.docx)
 * holds each label once, and xpdf 4.00 prints « SSuuiittee »: the copies overlap. Pairs measured 3 to 5 pt apart = 0.3 to 0.5 em. The tightest
 * legible leading is 0.8 em (Word « Exactly 8 pt » at 10 pt; dense tables 1.0 em), so 0.6 em sits between the two.
 * It goes BEYOND Poppler's word-level `dupMaxSecDelta = 0.2` (state of the art consulted, kept as the reference; what it does not give: it
 * keeps both copies of this specimen). Harmless contrived case: a vertical ellipsis of three « . » 0.33 em apart at the same x is
 * published as two « . » (a glyph is compared with the glyphs KEPT: the second is dropped, the third is 0.66 em from the first and stays).
 */
const ALONG_EM = 0.1;
const ACROSS_EM = 0.6;
/** A glyph is « along an axis » when its matrix has no tilt beyond float noise. */
const AXIS_ALIGNED_EPSILON = 1e-6;
/** Two sizes closer than this (relative) are the same size. */
const SAME_SIZE = 1e-3;

const isUpright = (g: GlyphFragment): boolean => Math.abs(g.matrix.b) <= AXIS_ALIGNED_EPSILON && Math.abs(g.matrix.c) <= AXIS_ALIGNED_EPSILON;
/** The largest glyph the rule compares: the largest page Acrobat creates (200 in = 14 400 pt). A larger « glyph » is a hostile or broken
 *  matrix, kept as is and never compared: past 2^53 a size bucket no longer grows by one and the lookup never ended (Fable's review of
 *  b8aa99d5, 23/10/2026: a `1e16 Tf`). */
const DOUBLE_DRAW_MAX_GLYPH_PT = 14_400;
/** The most glyphs one cell keeps for comparison: beyond, a glyph is kept on the page but not filed. A real page puts a handful of copies
 *  of one character, at one size, in a cell of 0.1 × 0.6 em; a crafted page put thousands of tiny distinct sizes in one cell and made the
 *  filing quadratic (Fable's review of b8aa99d5, 23/10/2026: 40 000 glyphs 2.8 s, ×4.5 per doubling). Bounds the work per glyph. */
const DOUBLE_DRAW_MAX_PER_CELL = 32;

const isInk = (g: GlyphFragment): boolean =>
  g.text.trim() !== "" && g.width > 0 && g.height > 0 && g.height <= DOUBLE_DRAW_MAX_GLYPH_PT && isUpright(g);

/** Glyphs are filed by character and SIZE BUCKET (half a point), in a grid whose cells are the rule's window of the bucket's size: 0.1 em
 *  along, 0.6 em across. A lookup visits the cells around the glyph in its own bucket and its two neighbours (18 to 83 cells: ±⌈size / bucket size⌉ cells per axis, up to 83 near 1 pt where the smaller neighbour is the 0.5 pt bucket), so two sizes the
 *  rule calls the same (`isDouble`) are compared even when they straddle a bucket edge (Fable's review, 23/10/2026: 9.994 and 10 pt met the rule
 *  but were filed apart and never compared). Limit, written: past about 500 pt the 1e-3 size rule spans more than the ±1 bucket visited, and a pair it accepts may never be compared (letters of 18 cm). Square cells of 0.1 em made it 117 cells per glyph once the window grew to 0.6 em: the structure
 *  oracle's 19 documents went from 17.8 s past their 20 s limit (23/10/2026). The cells visited depend on the font size, not on the page. */
const sizeBucket = (size: number): number => Math.max(1, Math.round(size * 2));
/** The bucket's size in points (half a point per step). */
const bucketSize = (bucket: number): number => bucket / 2;
const cellKey = (text: string, bucket: number, ix: number, iy: number): string => `${text}|${bucket}|${ix}|${iy}`;
const cellOf = (g: GlyphFragment, bucket: number): { ix: number; iy: number } => ({
  ix: Math.floor(g.x / (ALONG_EM * bucketSize(bucket))),
  iy: Math.floor(g.y / (ACROSS_EM * bucketSize(bucket))),
});

const isDouble = (g: GlyphFragment, other: GlyphFragment): boolean =>
  Math.abs(other.height - g.height) <= SAME_SIZE * g.height && Math.abs(other.x - g.x) < ALONG_EM * g.height && Math.abs(other.y - g.y) < ACROSS_EM * g.height;

/** Is there, among the glyphs filed in the cells covering the window of `g` in its bucket and the neighbouring ones, a glyph `g` doubles? */
function isDoubledIn(filed: ReadonlyMap<string, readonly GlyphFragment[]>, g: GlyphFragment): boolean {
  const own = sizeBucket(g.height);
  for (let bucket = Math.max(1, own - 1); bucket <= own + 1; bucket++) {
    // A neighbour bucket is at most half a point off: its cells can be smaller than g's window, so the span is counted in its own cells.
    const alongCells = Math.ceil(g.height / bucketSize(bucket));
    const { ix, iy } = cellOf(g, bucket);
    for (let dx = -alongCells; dx <= alongCells; dx++)
      for (let dy = -alongCells; dy <= alongCells; dy++) if (filed.get(cellKey(g.text, bucket, ix + dx, iy + dy))?.some((other) => isDouble(g, other)) === true) return true;
  }
  return false;
}

/** `glyphs` without the second drawing of a glyph; the first one stays, so the reading order is the document's. The same array when nothing is doubled. */
export function dropDoubleDraws(glyphs: GlyphFragment[]): GlyphFragment[] {
  const filed = new Map<string, GlyphFragment[]>();
  const kept: GlyphFragment[] = [];
  for (const g of glyphs) {
    if (isInk(g)) {
      if (isDoubledIn(filed, g)) continue;
      const bucket = sizeBucket(g.height);
      const { ix, iy } = cellOf(g, bucket);
      const key = cellKey(g.text, bucket, ix, iy);
      const list = filed.get(key);
      if (list === undefined) filed.set(key, [g]);
      else if (list.length < DOUBLE_DRAW_MAX_PER_CELL) list.push(g);
    }
    kept.push(g);
  }
  return kept.length === glyphs.length ? glyphs : kept;
}
