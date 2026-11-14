/** The vertical extent of a detected grid, and the question « is this height inside a grid? ».
 *  ONE rule for every caller: the CENTRE of the item (`y + height / 2`), the choice
 *  `layout/fragment-cells.ts#assignFragmentsToCells` makes; the caller passes the centre, never the baseline.
 *  NOT here: which grids exist (`layout/vector-grid.ts`, `layout/aligned-grid.ts`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-page-tables.ts`, `extractor/pdf-page-stages.ts`,
 *  `extractor/pdf-document-scale.ts`, `extractor/pdf-region-order.ts`, `extractor/pdf-page-markers.ts`, `layout/page-furniture.ts`. */

/** The vertical extent of a detected grid (PDF y axis, `top` above `bottom`). */
export interface GridBand {
  top: number;
  bottom: number;
}

/** The band from a grid's first to its last row boundary (rows run from the top down). */
export const gridBandOf = (grid: { readonly rowBoundaries: readonly number[] }): GridBand => ({
  top: grid.rowBoundaries[0]!,
  bottom: grid.rowBoundaries[grid.rowBoundaries.length - 1]!,
});

/** Is the height `y` (an item's centre) inside any of the bands? Both edges count. */
export const isInBand = (y: number, bands: readonly GridBand[]): boolean => bands.some((b) => y <= b.top && y >= b.bottom);

/** The height of a line's (or item's) vertical middle: its baseline plus half its font size. */
export const lineMiddle = (line: { readonly y: number; readonly fontSize: number }): number => line.y + line.fontSize / 2;

/** Is the middle of this line inside any of the bands? */
export const lineInBand = (line: { readonly y: number; readonly fontSize: number }, bands: readonly GridBand[]): boolean =>
  isInBand(lineMiddle(line), bands);
