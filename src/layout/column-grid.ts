/** Whether a page is a GRID OF COLUMNS, read on the left edges its blocks repeat rather than on the white between
 *  them — the signal that survives one stray fragment.
 *  NOT here: the gutter, which reads the white (`layout/gutter.ts`), nor the prose test a gutter cut must pass
 *  (`layout/column-discriminant.ts`), nor the band reading that uses the cuts (`extractor/pdf-bands.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { maxOf, minOf } from "../lib/extent";
import type { GutterItem } from "./gutter";

/**
 * Why a second signal: a gutter is a white nobody crosses, so one stray fragment closes it; dozens of aligned left
 * edges survive an intruder.
 *
 * A column's right edge is the median, never the maximum: a full-width heading that starts in the column carries
 * its right edge to the end of the page, and the width ratio no longer separates anything.
 *
 * This module only returns abscissas; it does not decide what is published.
 */

/** The share of a page's fragments a left edge must hold to be a column start. Starting value to calibrate: real
 *  starts hold 13 to 47 % of their page's fragments, noise (a bullet, an indent, a label) 1 to 3 %. */
const MIN_COLUMN_SHARE = 0.1;

/** And at least this many fragments, whatever the share: on a page of twenty fragments, 10 % would be two. */
const MIN_START_ITEMS = 4;

const MIN_GRID_COLUMNS = 2;

/** Above this ratio between the widest and the narrowest column, the blocks are no grid. Starting value to
 *  calibrate, on median right edges: real columns 1.00 to 1.17, one single column 15.21 (a 17 pt column of bullets
 *  against a 263 pt text); only two documents on the negative side. */
const MAX_WIDTH_RATIO = 1.2;

/** The same ratio on the number of characters set in each column.
 *  Limit: the two populations are not cleanly apart (real columns 1.05 to 2.70, one single column 4.63, nothing
 *  measured in between), so this signal is no discriminant; it is here to be compared by eye. */
const MAX_CHARS_RATIO = 3;

/** What the grid knows of a column: where it starts, where it ends (median right edge), what it holds. */
interface GridColumn {
  at: number;
  right: number;
  count: number;
  chars: number;
}

/** What proves the grid: equal widths, or close character counts. */
type GridEvidence = "width" | "chars";

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** The column starts of a page: the left edges its fragments repeat, in ascending order. */
export function columnStarts(items: readonly GutterItem[]): GridColumn[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  if (real.length === 0) return [];
  const groups: { at: number; count: number }[] = [];
  for (const it of [...real].sort((a, b) => a.x - b.x)) {
    const last = groups[groups.length - 1];
    // Two points: the tolerance of a column edge, not of a line.
    if (last !== undefined && it.x - last.at <= 2) last.count += 1;
    else groups.push({ at: it.x, count: 1 });
  }
  const enough = Math.max(MIN_START_ITEMS, real.length * MIN_COLUMN_SHARE);
  const starts = groups.filter((g) => g.count >= enough).map((g) => g.at);

  return starts.map((at, index) => {
    const to = starts[index + 1] ?? Number.POSITIVE_INFINITY;
    // What starts between this start and the next. A crossing fragment is not set aside: the median drowns it.
    const own = real.filter((it) => it.x >= at - 2 && it.x < to - 2);
    return {
      at,
      count: own.length,
      right: median(own.map((it) => it.x + it.width)),
      chars: own.reduce((n, it) => n + it.text.trim().length, 0),
    };
  });
}

/**
 * The cuts of a page read as a grid, or none. A cut falls in the white between one column's median right edge and
 * the next start (`placeCut`). Columns that overlap are no grid: the whole page abstains.
 */
export function gridCuts(items: readonly GutterItem[], evidence: GridEvidence): number[] {
  const columns = columnStarts(items);
  if (columns.length < MIN_GRID_COLUMNS) return [];
  if (columns.some((c, i) => i + 1 < columns.length && c.right >= columns[i + 1]!.at)) return [];

  const measured = evidence === "width" ? columns.map((c) => c.right - c.at) : columns.map((c) => c.chars);
  const low = minOf(measured, (m) => m);
  if (low <= 0) return [];
  if (maxOf(measured, (m) => m) / low > (evidence === "width" ? MAX_WIDTH_RATIO : MAX_CHARS_RATIO)) return [];

  const real = items.filter((it) => it.text.trim().length > 0);
  return columns.slice(0, -1).map((c, i) => placeCut(real, c.right, columns[i + 1]!.at));
}

/**
 * Where the cut goes in the white, and it is not its middle: the band reader gives up the whole column zone as soon
 * as one fragment crosses the cut, so one point changes the reading.
 *
 * The cut goes where the fewest fragments cross it. The edges of the crossing fragments split the white into
 * pieces, and the count is constant inside a piece: the cut takes the middle of the least crossed piece, the widest
 * on a tie, then the nearest to the middle of the white.
 *
 * Tried then dropped: the very edge of the longest fragment, with no margin. Justified lines overrun the median
 * right edge by a different amount on each page, and the document's cut then fell inside a column of another page.
 */
function placeCut(items: readonly GutterItem[], from: number, to: number): number {
  const middle = (from + to) / 2;
  const crossing = items.filter((it) => it.x < to && it.x + it.width > from);
  if (crossing.length === 0) return middle;
  const edges = [
    ...new Set([from, to, ...crossing.flatMap((it) => [it.x, it.x + it.width]).filter((x) => x > from && x < to)]),
  ].sort((a, b) => a - b);
  const cost = (x: number): number => crossing.filter((it) => it.x < x && it.x + it.width > x).length;
  const pieces = edges.slice(0, -1).map((a, i) => ({ at: (a + edges[i + 1]!) / 2, width: edges[i + 1]! - a }));
  return pieces.reduce((best, piece) => {
    const [here, there] = [cost(piece.at), cost(best.at)];
    if (here !== there) return here < there ? piece : best;
    if (piece.width !== best.width) return piece.width > best.width ? piece : best;
    return Math.abs(piece.at - middle) < Math.abs(best.at - middle) ? piece : best;
  }).at;
}
