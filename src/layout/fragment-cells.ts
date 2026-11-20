/** Where each fragment of a page lands once a grid is known: its row band,
 *  its cell, and whether that placement is ambiguous — plus the "same y ⇒ same
 *  visual line" rule every caller shares.
 *  NOT here: how the grid is found (`layout/vector-grid.ts`,
 *  `layout/aligned-grid.ts`), which cells are merged
 *  (`layout/merged-cells.ts`), nor the cell text itself
 *  (`layout/cell-text.ts`).
 *  Called by: `extractor/pdf-table-render.ts`,
 *  `extractor/pdf-table-detector.ts`, `layout/cell-text.ts`, through the
 *  `layout/geometry.ts` façade. */

import { groupByBaseline } from "./baseline-lines";
import type { CellAssignment, Fragment, MergeMap, TableGrid } from "doc-ir/internal";
import { SAME_LINE_PT } from "./tolerances";

/** The "same y ⇒ same visual line" rule shared by every caller that needs
 *  per-fragment (not merged-text) line grouping — `pdf-table-detector.ts`'s
 *  own detection pass and `pdf.ts`'s table-rendering pass both build their
 *  OWN `Fragment[]` from their own (separate) `extractTextItems` call, then
 *  call this on it; kept here rather than duplicated so the grouping RULE
 *  has one definition, even though the underlying PDF document is
 *  read twice (a deliberate, documented tradeoff — see `pdf-table-
 *  detector.ts`'s own module doc). Distinct from `pdf.ts`'s own
 *  `linesFromItems`: that one merges fragments into a single TEXT string
 *  per line (paragraph reconstruction's need), this one keeps each
 *  fragment separate with its own x/width (column clustering's need). */
export function groupFragmentsIntoVisualLines(fragments: readonly Fragment[]): Fragment[][] {
  // Geometric reading order, not emission order: the predicates built on these lines measure gaps between the
  // fragments of one line, and must give the same verdict on two pages laid out alike whatever the producer's order.
  // The grouping sorts strictly, groups, then sorts inside; a single comparator with a tolerance would not be
  // transitive.
  return groupByBaseline(fragments.filter((f) => f.text.length > 0));
}

// A fragment edge within this many PDF points of a boundary is treated as
// "at" it, not "across" it, when checking for ambiguity (assignFragmentsToCells)
// — a boundary built as the exact midpoint between two lines grazes an
// ordinary fragment's own edge by construction (buildGridFromAlignedRows),
// which isn't a real straddle.
const STRADDLE_TOLERANCE = SAME_LINE_PT;

/** §8's "regroupement des blocs multi-lignes en ligne logique": buckets
 *  fragments into the row band (between two consecutive row boundaries)
 *  their y-center falls into — a wrapped cell's second visual line lands
 *  in the SAME band as its first, because both sit strictly between the
 *  same two boundaries. A fragment outside every band is simply not
 *  returned here (this is a row-axis-only grouping step, column
 *  assignment and the real conservation check both live in
 *  `assignFragmentsToCells`, which this function is NOT a replacement
 *  for — kept separate because the clustering fallback (stage 2, no
 *  vector grid) still wants logical rows before it has any column
 *  boundaries to build a full grid from). */
export function groupFragmentsIntoRowBands(
  fragments: readonly Fragment[],
  rowBoundaries: readonly number[],
): Fragment[][] {
  const bands: Fragment[][] = rowBoundaries.slice(0, -1).map(() => []);
  for (const f of fragments) {
    const cy = f.y + f.height / 2;
    for (let row = 0; row < rowBoundaries.length - 1; row++) {
      const top = rowBoundaries[row]!;
      const bottom = rowBoundaries[row + 1]!;
      if (cy <= top && cy >= bottom) {
        bands[row]!.push(f);
        break;
      }
    }
  }
  return bands;
}

/** §8's lightweight conservation invariant, computed once here rather than
 *  reimplemented at jalon 2 — see `CellAssignment`'s own doc for what
 *  `ambiguous`/`outside` actually mean and why "landing in no band" isn't
 *  the useful signal (bands are contiguous across the grid's own bounds by
 *  construction, so that can only happen at floating-point edges). */
/** Generic on the fragment type: a caller that passes glyphs (with their `paintCount`) gets them back as they are in
 *  the cells, not flattened to `Fragment`. */
export function assignFragmentsToCells<T extends Fragment>(
  fragments: readonly T[],
  grid: TableGrid,
  merge?: MergeMap,
): CellAssignment<T> {
  const { rowBoundaries, colBoundaries } = grid;
  const rows = rowBoundaries.length - 1;
  const cols = colBoundaries.length - 1;
  // Fuzz finding (04/09/2026, STATUS.md): a grid with EXACTLY one boundary
  // on either axis has zero real rows/cols despite `insideBounds` still
  // being satisfiable (xMin === xMax, or yMin === yMax, lets a fragment
  // whose coordinate matches exactly slip through) — there is no valid
  // cell to place it in. Both real grid builders enforce MIN_BOUNDARIES=2
  // before ever returning a grid, so this never fires on a real pipeline
  // grid; guarded here anyway since this function is itself exported and
  // has no such contract of its own. A grid with no real cells explains
  // nothing — every fragment routes to `outside`, same as a fragment that
  // falls outside a well-formed grid's own bounds.
  if (rows < 1 || cols < 1) return { cells: [], ambiguous: [], outside: [...fragments] };

  const xMin = colBoundaries[0]!;
  const xMax = colBoundaries[colBoundaries.length - 1]!;
  const yMin = rowBoundaries[rowBoundaries.length - 1]!;
  const yMax = rowBoundaries[0]!;

  const cells: T[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => [] as T[]));
  const ambiguous: T[] = [];
  const outside: T[] = [];

  /** The identity of the cell that holds a slot, merges included, on both axes. With no merge map each slot is its
   *  own cell.
   *  Used by the ambiguity check: a fragment that overruns onto a slot merged with its own crosses no boundary, and
   *  reporting it ambiguous would fold a readable table back to flat text. Both axes matter: a label of a row-merged
   *  header crosses the separator of the two header levels.
   *  The check is here rather than on the output: filtering `ambiguous` afterwards would rebuild the same geometry
   *  elsewhere. */
  const cellIdAt = (row: number, col: number): number => merge?.ownerAt[row]?.[col] ?? row * cols + col;

  /** The band this ordinate falls in, or NOTHING when it falls in none.
   *  Abstains with `undefined` like every other detector in `layout/`, and
   *  not with the `-1` it used until 20/09/2026: the sentinel type-checked
   *  as an index, so each of the six readers below had to remember to test
   *  it by hand before passing it to `cellIdAt`. The compiler remembers now. */
  const bandIndexOf = (v: number, boundaries: readonly number[], ascending: boolean): number | undefined => {
    const count = boundaries.length - 1;
    for (let i = 0; i < count; i++) {
      const lo = ascending ? boundaries[i]! : boundaries[i + 1]!;
      const hi = ascending ? boundaries[i + 1]! : boundaries[i]!;
      if (v >= lo && v <= hi) return i;
    }
    return undefined;
  };

  for (const f of fragments) {
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    const insideBounds = cx >= xMin && cx <= xMax && cy >= yMin && cy <= yMax;
    if (!insideBounds) {
      outside.push(f);
      continue;
    }

    const row = bandIndexOf(cy, rowBoundaries, false);
    const col = bandIndexOf(cx, colBoundaries, true);
    // Contiguous bands spanning [xMin,xMax]×[yMin,yMax] make an abstention
    // here a floating-point edge case, not a real gap — clamp rather than
    // silently drop, "rien n'est perdu" applies even to that edge.
    const clampedRow = row === undefined ? (cy >= (rowBoundaries[0]! + rowBoundaries[1]!) / 2 ? 0 : rows - 1) : row;
    const clampedCol = col === undefined ? (cx <= (colBoundaries[0]! + colBoundaries[1]!) / 2 ? 0 : cols - 1) : col;
    cells[clampedRow]![clampedCol]!.push(f);

    // The real ambiguity check (§8 Q7, "fragments à cheval sur une
    // frontière"): does the fragment's own bounding box — not just its
    // center — cross into a DIFFERENT row or column band than the one it
    // was just assigned to? A merged cell's content, or a wrapped line
    // whose height nudges past the next row boundary, shows up this way.
    // Shrunk by STRADDLE_TOLERANCE first: a boundary built as the exact
    // midpoint between two lines' own y (§8 jalon 2's borderless grid,
    // `buildGridFromAlignedRows`) sits so close to an ordinary fragment's
    // own edge that it grazes it by construction, every time — not a real
    // merged cell, just where the math places an evenly-spaced boundary.
    const rowStart = bandIndexOf(f.y + f.height - STRADDLE_TOLERANCE, rowBoundaries, false);
    const rowEnd = bandIndexOf(f.y + STRADDLE_TOLERANCE, rowBoundaries, false);
    const colStart = bandIndexOf(f.x + STRADDLE_TOLERANCE, colBoundaries, true);
    const colEnd = bandIndexOf(f.x + f.width - STRADDLE_TOLERANCE, colBoundaries, true);
    const ownCell = cellIdAt(clampedRow, clampedCol);
    const straddles =
      (rowStart !== undefined && cellIdAt(rowStart, clampedCol) !== ownCell) ||
      (rowEnd !== undefined && cellIdAt(rowEnd, clampedCol) !== ownCell) ||
      (colStart !== undefined && cellIdAt(clampedRow, colStart) !== ownCell) ||
      (colEnd !== undefined && cellIdAt(clampedRow, colEnd) !== ownCell);
    if (straddles) ambiguous.push(f);
  }

  return { cells, ambiguous, outside };
}
