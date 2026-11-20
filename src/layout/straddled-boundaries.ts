/** Doubled grid boundaries: ONE thick rule drawn as two close edges is ONE boundary, not two. Two consecutive boundaries at
 *  most `delta` apart (inclusive) with no fragment centre in the CLOSED interval [b1, b2] are replaced by their midpoint.
 *  A second gate: a pair the text crosses (a fragment starts before its low boundary and ends after the high one) merges
 *  beyond `delta`, and on its edge rather than its midpoint: the midpoint of a wide pair belongs to no painted rule, and
 *  `merged-cells.ts` only recognises a boundary close to one. The fragment-centre guard goes first: a column that holds
 *  text never merges.
 *  Qualifying gaps that follow one another form a maximal segment: two gaps (three boundaries) merge at the midpoint of the
 *  EXTREMES; a gap holding a fragment centre cuts the chain (each remaining segment merges on its own); three gaps or more
 *  (four boundaries or more) abstain as a whole. Pure: numbers in, numbers out, inputs never mutated.
 *  NOT here: the value of `delta` (declared beside its caller, `DOUBLED_RAIL_MAX_GAP_PT` in `extractor/pdf-table-detector.ts`,
 *  with its populations), the choice of which boundaries to hand in, and any rewrite of cells after the merge.
 *  Called by: `extractor/pdf-table-detector.ts` (column boundaries of each stage-0 grid). */

/** The boundaries that replace the segment `first..last` (indices of boundaries, at least one qualifying gap): the segment itself when
 *  it abstains, else ONE boundary. A doubled rail on the hull is one thick rule whose ENVELOPE bounds the table: merging it to the
 *  midpoint would shrink the hull and eject glyphs the rule enclosed (141 p70: "(" at x-centre 55.39 inside the rail [54.2, 58.0]).
 *  So a segment touching the first boundary keeps its outer left edge, one touching the last keeps its outer right edge, an inner one
 *  takes the midpoint of its extremes. A segment spanning the whole list (two boundaries, or a chain of three) abstains, and so
 *  does one of three gaps or more. */
function replacementOf(boundaries: readonly number[], first: number, last: number): number[] {
  const touchesFirst = first === 0;
  const touchesLast = last === boundaries.length - 1;
  if (last - first > 2 || (touchesFirst && touchesLast)) return boundaries.slice(first, last + 1);
  if (touchesFirst) return [boundaries[first]!];
  if (touchesLast) return [boundaries[last]!];
  return [(boundaries[first]! + boundaries[last]!) / 2];
}

/**
 * Measured 27/10/2026 (boundaries probe, 63 PDF, 3124 boundaries):
 * - Rule A1 of the conception (a rail straddled by k lines is no boundary) was REJECTED by measure: the target boundary
 *   (47-GrandSoissons p10) is straddled on 59 % of its lines, while boundaries of FOUND tables are straddled at 78-100 %
 *   (074 p2, 106 p17, 123 p3 - their merged cells explain the straddling). No (k, s) separates the populations, so no rule.
 * - Row boundaries are NOT merged: 643 no-text row gaps <= 5 pt cannot be told apart from real thin rows (thinnest row WITH
 *   text: 2.39 pt). Columns only.
 */
export function mergeDoubledBoundaries(
  boundaries: readonly number[],
  fragmentCenters: readonly number[],
  delta: number,
  /** Whether text runs over this pair of boundaries. A crossed pair merges whatever its gap: width does not separate
   *  the splinters of a doubled rule from a narrow column that holds its own text, text running over the pair does.
   *  Absent: nothing is crossed and `delta` decides alone. */
  crosses?: (low: number, high: number) => boolean,
): number[] {
  // A DESCENDING list (TableGrid.rowBoundaries runs top-down) would make every negative gap "qualify" and the centre guard
  // unsatisfiable, mass-merging the whole list in silence (review of 27/10/2026). Mirror it instead, so either order is read
  // for what it is, and the caller's order is given back.
  if (boundaries.length > 1 && boundaries[0]! > boundaries[boundaries.length - 1]!) {
    return mergeDoubledBoundaries([...boundaries].reverse(), fragmentCenters, delta, crosses).reverse();
  }
  const out: number[] = [];
  const count = boundaries.length;
  /** Why a pair merges, or nothing: `"gap"` when its gap fits in `delta`, `"crossed"` when text crosses it. */
  const reasonOf = (i: number): "gap" | "crossed" | undefined => {
    const low = boundaries[i]!;
    const high = boundaries[i + 1]!;
    // The centre guard goes first and yields to nothing: a column that holds text is a column.
    if (fragmentCenters.some((center) => center >= low && center <= high)) return undefined;
    if (high - low <= delta) return "gap";
    return crosses?.(low, high) === true ? "crossed" : undefined;
  };
  let i = 0;
  while (i < count) {
    const reason = i + 1 < count ? reasonOf(i) : undefined;
    if (reason === undefined) {
      out.push(boundaries[i]!);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end + 1 < count && reasonOf(end) !== undefined) end += 1;
    // A crossed pair merges on its edge, never on its midpoint: the midpoint of a wide pair is no painted rule, so
    // every row would read a colspan over it and the table would collapse. The edge is the rule.
    out.push(...(reason === "crossed" ? [boundaries[i]!] : replacementOf(boundaries, i, end)));
    i = end + 1;
  }
  return out;
}
