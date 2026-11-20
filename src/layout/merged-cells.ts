/** Which cells of a row are merged, read from the gaps in the vertical
 *  separators — and the second reading that has to agree before a span is
 *  claimed. Also says how many top rows are the header (`headerRowCount`, the rows that carry `<th>`).
 *  NOT here: the grid itself (`layout/geometry.ts`), the cell text (`layout/cell-text.ts`), nor the map built from
 *  spans that are already known (`layout/merge-map.ts`, which a slide table uses too).
 *  Called by: `extractor/pdf-table-detector.ts` (`detectMergedCells`), `extractor/pdf-table-render.ts`
 *  (`headerRowCount`). */

/**
 * `layout/merged-cells`: which cells of a table are merged.
 *
 * THE SIGNAL, MEASURED AND UNAMBIGUOUS (09/09/2026). A merged cell leaves a
 * GAP in the vertical separators, and nothing else leaves one. Read on a real
 * seven-column report card, separator by separator and band by band:
 *
 *       row           |  123  142  167  185  204  222
 *       L 0  707..689 |    .    .    X    X    X    .
 *       L 1..L11      |    .    .    .    .    .    .
 *
 * Three gaps on the ONLY header row, exactly at the boundaries
 * `Élève | Clas. | - | +`, the four sub-columns « Moyennes » spans. Every other
 * row has its six separators. The `colspan` is READ in the document, never
 * guessed.
 *
 * BOTH AXES ARE READ. The `colspan` comes from the gaps in the vertical
 * separators (`detectColumnSpans`), the `rowspan` from the gaps in the
 * horizontal ones (`detectRowMerges`, since 10/09/2026, the two-level header
 * of the same report card). A boundary with no horizontal stroke at all is
 * no evidence and merges nothing.
 *
 * PURE, like the rest of `layout/`: numbers in, a structure out, no product
 * dependency (IRDoc included); the extractor turns the map into cells.
 */

import type { ClassifiedLine, MergeMap, TableGrid } from "doc-ir/internal";
import { unionLength } from "./intervals";
import { buildMergeMap } from "doc-ir/internal";
import { splitByOrientation } from "doc-ir/internal";
import { MIN_COVERAGE, SAME_POSITION_PT } from "./tolerances";

/** The share of a band's height a separator must cover to count as drawn. A stroke that covers only a bit of it — the
 *  rest of a neighbouring border, a decorative mark — separates nothing: the question is « does this stroke really
 *  cross », not « does this stroke exist somewhere ». */
const MIN_BAND_COVERAGE = MIN_COVERAGE;

/** Two abscissas closer than this many points are the same boundary. */
const SAME_POSITION_TOLERANCE = SAME_POSITION_PT;

/**
 * For each row of the grid, the `colspan` of its cells, in order.
 *
 * Their sum is always the number of columns of the grid: a row with no merge gives `[1, 1, 1, …]`, a fully merged
 * row gives `[n]`.
 *
 * IT WAS CALLED `detectRowSpans`, AND THAT WAS A MISNOMER: it returns `colspan`s, not `rowspan`s. Renamed on
 * 10/09/2026, before a real detector of vertical merges was written — setting that one beside a function that
 * already carried its name would have been a trap for the next reader.
 *
 * Pure: no I/O, no clock, no randomness. Never mutates its input.
 */
export function detectColumnSpans(lines: readonly ClassifiedLine[], grid: TableGrid): number[][] {
  const { verticals } = splitByOrientation(lines);
  const { rowBoundaries, colBoundaries } = grid;
  const columnCount = colBoundaries.length - 1;
  if (columnCount < 1) return [];

  const spans: number[][] = [];
  for (let row = 0; row + 1 < rowBoundaries.length; row++) {
    const top = rowBoundaries[row]!;
    const bottom = rowBoundaries[row + 1]!;
    const height = top - bottom;

    /** Does the inner separator at abscissa `position` cross this band? The segments of one abscissa are UNITED
     *  before being measured — a stroke is commonly drawn cell by cell, and measuring one segment alone would
     *  miss a separator that is fully drawn. */
    const crosses = (position: number): boolean => {
      if (height <= 0) return false;
      // The UNION of the overlaps, never their SUM — and the mistake was made before it was fixed. A document
      // that REPAINTS its strokes counted two stacked segments twice, so a separator covering half a band passed
      // the 60 % threshold and no merge was ever detected. Adding overlapping intervals does not measure a length.
      const covered = unionLength(
        verticals
          .filter((vertical) => Math.abs(vertical.x - position) <= SAME_POSITION_TOLERANCE)
          .map((vertical) => [Math.max(vertical.yMin, bottom), Math.min(vertical.yMax, top)] as const)
          .filter(([low, high]) => high > low),
      );
      return covered / height >= MIN_BAND_COVERAGE;
    };

    const rowSpans: number[] = [];
    let current = 1;
    for (let separator = 1; separator < columnCount; separator++) {
      if (crosses(colBoundaries[separator]!)) {
        rowSpans.push(current);
        // eslint-disable-next-line sonarjs/no-redundant-assignments -- false positive: current is read by the next iteration
        current = 1;
      } else {
        current += 1;
      }
    }
    rowSpans.push(current);
    spans.push(rowSpans);
  }
  return spans;
}

/**
 * The merge map of the grid, the contract everything downstream consumes.
 *
 * It carries both axes: the `colspan` of each row (`detectColumnSpans`) and
 * the vertical merges (`detectRowMerges`); a cell grows downward only while
 * every column it spans is merged downward (`buildMergeMap`).
 *
 * Pure: no I/O, no clock, no randomness; never mutates its input.
 */
export function detectMergedCells(lines: readonly ClassifiedLine[], grid: TableGrid): MergeMap {
  return buildMergeMap(grid, detectColumnSpans(lines, grid), detectRowMerges(lines, grid));
}

/**
 * THE SYMMETRIC SIGNAL — which cells are merged with the one below.
 *
 * `mergedDown[row][col]` is `true` when the boundary between `row` and `row + 1` DOES NOT CROSS the column `col`. A
 * horizontal that stops says literally that the cells it does not cross are merged vertically — exactly what a gap
 * in the vertical separators says for the `colspan`, on the other axis.
 *
 * The array therefore has ONE ROW LESS than the grid: the last boundary is the bottom of the table, and nothing
 * there is merged with anything.
 *
 * The same measure as for the columns: the UNION of the overlaps, never their sum. A document that repaints its
 * strokes would count twice.
 *
 * Pure: no I/O, no clock, no randomness. Never mutates its input.
 */
function detectRowMerges(lines: readonly ClassifiedLine[], grid: TableGrid): boolean[][] {
  const { horizontals } = splitByOrientation(lines);
  const { rowBoundaries, colBoundaries } = grid;
  const rowCount = rowBoundaries.length - 1;
  const colCount = colBoundaries.length - 1;
  if (rowCount < 2 || colCount < 1) return [];

  const merges: boolean[][] = [];
  for (let row = 0; row + 1 < rowCount; row++) {
    const boundary = rowBoundaries[row + 1]!;
    const atBoundary = horizontals.filter((horizontal) => Math.abs(horizontal.y - boundary) <= SAME_POSITION_TOLERANCE);
    // NO STROKE AT ALL AT THIS BOUNDARY: that is not a merge, it is an absence of evidence. The nuance is anything
    // but theoretical — a grid built by ALIGNMENT has no horizontal, and concluding « everything is merged » would
    // turn a borderless table into one giant cell. The signal is the gap in a stroke that exists, never the
    // absence of a stroke.
    if (atBoundary.length === 0) {
      merges.push(Array.from({ length: colCount }, () => false));
      continue;
    }
    const rowMerges: boolean[] = [];
    for (let col = 0; col < colCount; col++) {
      const left = colBoundaries[col]!;
      const right = colBoundaries[col + 1]!;
      const width = right - left;
      if (width <= 0) {
        rowMerges.push(false);
        continue;
      }
      const covered = unionLength(
        atBoundary
          .map((horizontal) => [Math.max(horizontal.xMin, left), Math.min(horizontal.xMax, right)] as const)
          .filter(([low, high]) => high > low),
      );
      rowMerges.push(covered / width < MIN_BAND_COVERAGE);
    }
    merges.push(rowMerges);
  }
  return merges;
}

/**
 * The height of the header block, READ in the merge.
 *
 * A cell of the first row that SPANS the next one describes a two-level header: « Matières » and « Pos. » cover
 * both rows while « Moyennes » sits above its sub-columns. The header block is as tall as the largest of these
 * merges.
 *
 * With no vertical merge the value is 1: the first row is the header.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function headerRowCount(merge: MergeMap | undefined): number {
  return Math.max(1, ...(merge?.cells ?? []).filter((cell) => cell.row === 0).map((cell) => cell.rowspan));
}
