/** Where an image stands among the text lines it covers: the one rule ALL THREE reading orders share (a page's regions,
 *  `extractor/pdf-region-order.ts`; a table cell's paragraphs, `extractor/pdf-table-render.ts`; a tagged page's anchors,
 *  `extractor/pdf-image-anchors.ts`), so they cannot drift.
 *  NOT here: which lines an image covers (each caller measures its own: visual lines of a page, paragraph boxes of a cell,
 *  placed lines of a tagged page), nor the written reasons and measurements, which stay with the callers.
 *  Called by: `extractor/pdf-image-anchors.ts`, `extractor/pdf-region-order.ts`, `extractor/pdf-table-render.ts`. */

/** The vertical position at or below which a line comes AFTER the image. The image's median decides, unless it would
 *  fall BETWEEN two of the `covered` lines (some at or above it, some under it): then the image's top edge decides,
 *  so none of the lines it covers is split from the others. */
export const imageFrontier = (median: number, top: number, covered: readonly { middle: number }[]): number => {
  const cuts = covered.some((l) => l.middle >= median) && covered.some((l) => l.middle < median);
  return cuts ? top : median;
};
