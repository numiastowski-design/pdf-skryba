/** The most frequent value of a count table, and the quarter-point rounding of sizes.
 *  Each caller keeps its OWN key (what is counted) and its OWN tie-break; only the vote is shared.
 *  NOT here: what is counted (characters, lines, occurrences) or how a key is quantised, except the quarter point
 *  that four sites wrote by hand.
 *  Called by: `layout/text-size.ts`, `layout/heading-sizes.ts`, `layout/column-discriminant.ts`,
 *  `extractor/pdf-lines.ts`, `extractor/pdf-document-scale.ts`, `extractor/pdf-paragraphs.ts`, `extractor/pdf-bands.ts`. */

/** Which key wins when two have exactly the same count: the smallest, the largest, or the first one inserted. */
export type ModeTie = "smallest" | "largest" | "first";

/** The key with the highest count, `undefined` for an empty table. Ties are broken by `tie` and nothing else, so the
 *  result never depends on anything but the table (the golden masters pin same input, same bytes). */
export function modeOf<K extends number>(counts: ReadonlyMap<K, number>, tie: ModeTie): K | undefined {
  let best: K | undefined;
  let bestCount = -Infinity;
  for (const [key, count] of counts) {
    const wins =
      count > bestCount ||
      (count === bestCount &&
        best !== undefined &&
        ((tie === "smallest" && key < best) || (tie === "largest" && key > best)));
    if (wins) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** A size rounded to the nearest quarter of a point: one body comes out at 6.499 or 6.501 depending on the fragment,
 *  and two neighbouring classes would share the vote. */
export const quarterPoint = (x: number): number => Math.round(x * 4) / 4;
