/** The document's dominant body size, the normaliser that turns a threshold in
 *  points into a threshold in multiples of the text itself.
 *  NOT here: the thresholds that use it — the gutter
 *  (`layout/column-discriminant.ts`), the heading rule
 *  (`layout/heading-sizes.ts`), the wrapped-cell text (`layout/cell-text.ts`).
 *  Called by: `extractor/pdf-table-render.ts` and
 *  `layout/column-discriminant.ts`, through the `layout/geometry.ts` façade. */

import type { Fragment } from "doc-ir/internal";
import { modeOf, quarterPoint } from "./mode";

/**
 * The dominant body size, the normaliser of the typographic thresholds: a threshold in absolute points, calibrated
 * on one generator, encodes that generator; one in multiples of the body size adapts to any source.
 *
 * The height, not the width of a character. Tried then dropped: the median character width, which varies too much
 * between documents and moves the threshold's fragility into the normaliser. The height gives a mode that most of
 * the document's characters share.
 * Weighted by characters, never by fragments: counting fragments would elect the most fragmented size.
 * Heights are rounded to the quarter point first: one body size comes out as 6.499 and 6.501, and two neighbouring
 * classes would share the mode.
 * Returns `undefined` when nothing is measurable: the caller keeps its absolute fallback.
 */
export function dominantTextSize(fragments: readonly Fragment[]): number | undefined {
  const charsBySize = new Map<number, number>();
  for (const f of fragments) {
    const chars = f.text.replace(/\s/g, "").length;
    if (chars === 0 || !(f.height > 0)) continue;
    const size = quarterPoint(f.height);
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + chars);
  }
  // On an exact tie the SMALLEST size wins: the body is smaller than the headings, and the golden master needs a
  // deterministic tie-break (same input, same bytes).
  return modeOf(charsBySize, "smallest");
}
