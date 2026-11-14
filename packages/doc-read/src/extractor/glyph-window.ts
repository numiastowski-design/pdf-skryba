/** The glyphs a text run paints, picked from a page's glyphs by position: same baseline, inside the run's width.
 *  NOT here: reading the glyphs (`extractor/glyph-positions.ts`) nor what a caller does with them (links:
 *  `extractor/pdf-links.ts`; letter-spaced runs: `extractor/pdf-letter-spacing.ts`).
 *  Called by: `extractor/pdf-links.ts`, `extractor/pdf-letter-spacing.ts`. */

/**
 * ONE SELECTION, TWO WINDOWS. Both callers pick the glyphs on the run's baseline (|dy| < 0.25 em, found by bisection
 * on a list sorted by `y`) and then cut them by `x`. They cut differently on purpose:
 *
 *  - A LINK (`anchor: "centre"`) asks which glyph a rectangle covers, so the glyph belongs to the run when its CENTRE
 *    lies in [run.x, run.x + width]. Space glyphs are left out of the list by the caller: no run character is placed
 *    on one.
 *  - LETTER-SPACING (`anchor: "start"`) rebuilds the run's text, spaces included, to find word cuts again, so the
 *    list keeps the space glyphs and the glyph belongs to the run when it STARTS in
 *    [run.x - 0.25 em, run.x + width - 0.1 em). On fixture 26 a space run follows the word at a zero gap, so its first
 *    glyph starts exactly at the word's end: the last 0.1 em is the NEXT run's. A centre would take it in.
 *
 * Measured 08/10/2026 on 42 PDFs: 434 of 16 343 cycles read differently under the two windows (space or edge glyphs);
 * none of the letter-spaced runs of fixtures/pdf is affected. Merging the two windows would change one of the two
 * outputs, so each caller names its own.
 *
 * Ties: glyphs at exactly the same `x` keep the order of the `y`-sorted list (a stable sort), not the page's order.
 */

import type { GlyphFragment } from "./glyph-positions";

export interface GlyphWindowOptions {
  /** Which point of the glyph must fall in the run's width: its centre (`x + width / 2`, run edges inclusive) or its
   *  start (`x`, right edge exclusive). */
  readonly anchor: "centre" | "start";
  /** Slack left of `run.x`, in em: the glyph may start this far before the run (`start` anchor only). */
  readonly leftSlackEm: number;
  /** Cut from the run's right edge, in em: the last `rightTrimEm` of the run belong to the next run (`start` anchor
   *  only). */
  readonly rightTrimEm: number;
}

/** The window of a link: the glyph centre inside the run's box. */
export const CENTRE_WINDOW: GlyphWindowOptions = { anchor: "centre", leftSlackEm: 0, rightTrimEm: 0 };

/** The window of letter-spacing: the glyph start from 0.25 em before the run to 0.1 em before its end. */
export const START_WINDOW: GlyphWindowOptions = { anchor: "start", leftSlackEm: 0.25, rightTrimEm: 0.1 };

/** `glyphs` sorted by `y` (stable): the list `glyphsOfRun` bisects. The caller filters (spaces in or out) first. */
export const sortedByBaseline = (glyphs: readonly GlyphFragment[]): GlyphFragment[] => [...glyphs].sort((a, b) => a.y - b.y);

/** The glyphs of a run, left to right. `byY` is sorted by `y` (`sortedByBaseline`). Same baseline: |dy| < 0.25 em. */
export const glyphsOfRun = (
  run: { readonly x: number; readonly y: number; readonly width: number; readonly fontSize: number },
  byY: readonly GlyphFragment[],
  options: GlyphWindowOptions,
): GlyphFragment[] => {
  const em = Math.max(run.fontSize, 1);
  const reach = 0.25 * em;
  let lo = 0;
  let hi = byY.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byY[mid]!.y <= run.y - reach) lo = mid + 1;
    else hi = mid;
  }
  const found: GlyphFragment[] = [];
  const right = run.x + run.width;
  const startFrom = run.x - options.leftSlackEm * em;
  const startBefore = right - options.rightTrimEm * em;
  for (let i = lo; i < byY.length && byY[i]!.y < run.y + reach; i++) {
    const g = byY[i]!;
    if (options.anchor === "centre") {
      const cx = g.x + g.width / 2;
      if (cx >= run.x && cx <= right) found.push(g);
    } else if (g.x >= startFrom && g.x < startBefore) found.push(g);
  }
  return found.sort((a, b) => a.x - b.x);
};
