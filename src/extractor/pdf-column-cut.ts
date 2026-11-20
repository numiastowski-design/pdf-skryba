/** Which of the two cuts a page is read on: the painted one, or the
 *  document's gutter — decided on whether it actually separates the text.
 *  NOT here: where either cut comes from (`extractor/pdf-table-detector.ts`
 *  paints, `layout/gutter.ts` infers), nor the band reading that uses it
 *  (`extractor/pdf-bands.ts`).
 *  Called by: `extractor/pdf.ts`. */

import type { PdfTextRun } from "./pdf-source";

/** A column cut: its abscissa, and the bound above which it holds. */
export interface ColumnCut {
  cut: number;
  above?: number;
  /** Every cut of the document, ascending, when it has more than one; `cut` is one of them. Absent on a painted cut:
   *  a cell edge speaks of its cell, not of the gutters of the rest of the document. */
  all?: readonly number[];
}

export const pageColumnCut = (
  pageItems: readonly PdfTextRun[],
  painted: ColumnCut | undefined,
  gutter: { cut: number; all: readonly number[] } | undefined,
): ColumnCut | undefined => {
  // The two cuts are not arbitrated on their origin but on whether the cut separates the text: a cut a fragment
  // crosses separates nothing. Tried then dropped: the painted cut always winning; a small chart on a two-column page
  // paints a stroke unrelated to the columns, and that stroke won.
  const crossesText = (x: number, above: number | undefined): boolean =>
    pageItems.some(
      // Above the bound, not below: the band reading only looks at the lines above it, and y grows upwards in PDF.
      (it) => it.text.trim().length > 0 && (above === undefined || it.y >= above) && it.x < x && it.x + it.width > x,
    );
  const paintedSeparates = painted !== undefined && !crossesText(painted.cut, painted.above);
  const pageCut: ColumnCut | undefined = paintedSeparates
    ? painted
    : gutter !== undefined
      ? { cut: gutter.cut, ...(gutter.all.length > 1 ? { all: gutter.all } : {}) }
      : painted;

  return pageCut;
};
