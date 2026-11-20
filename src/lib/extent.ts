/** The smallest and the largest of a value over a list, by LOOP: the one place the PDF readers take an extent.
 *  NOT here: an extent that is bounded by construction (the four corners of a box), nor the meaning of the number.
 *  Called by: the layout and PDF readers (14 files), among them `extractor/glyph-positions.ts`, `extractor/pdf-bands.ts`, `extractor/pdf-lines.ts`,
 *  `extractor/pdf-image-anchors.ts`, `layout/gutter.ts`.
 *  Why not `Math.min(...items.map(f))`: a spread passes one ARGUMENT per item, and past ~100 000 of them the engine
 *  throws « Maximum call stack size exceeded ». A hostile page can hold that many points, glyphs or items on one line
 *  (review 06/11/2026), and an exception there fails the whole document.
 *  Same answer as `Math.min` / `Math.max` on an empty list: `Infinity` / `-Infinity`. */
export function minOf<T>(items: readonly T[], value: (item: T) => number): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const v = value(item);
    if (v < lowest) lowest = v;
  }
  return lowest;
}

export function maxOf<T>(items: readonly T[], value: (item: T) => number): number {
  let highest = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const v = value(item);
    if (v > highest) highest = v;
  }
  return highest;
}
