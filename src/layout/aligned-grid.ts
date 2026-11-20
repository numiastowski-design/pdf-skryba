/** The grid a page only ALIGNS, with no border painted anywhere: where the
 *  columns start, which lines are the table, and where the boundaries fall
 *  between them.
 *  NOT here: the grid the page draws (`layout/vector-grid.ts`), the placement
 *  of the fragments in the cells (`layout/fragment-cells.ts`), nor the
 *  prose-or-columns discriminant (`layout/column-discriminant.ts`).
 *  Called by: `extractor/pdf-table-detector.ts` and
 *  `tools/pdf-geometry-probe.ts`, through the `layout/geometry.ts` façade. */

import { maxOf } from "../lib/extent";
import type { Fragment, TableGrid } from "doc-ir/internal";
import { CLUSTER_TOLERANCE, clusterGroups, MIN_BOUNDARIES } from "./position-clusters";

// Stage 2 fallback (no usable vector lines): a fragment's LEFT edge that
// recurs at (near enough) the same x across several different lines is
// read as a column start — the classic "aligned but borderless" table.
const MIN_ALIGNED_ROWS = 3; // 2 columns aligned over only 2 rows is too easy to hit by coincidence in ordinary prose

/** Stage 2 of §8's detector: x/y clustering on text fragments alone, no
 *  borders. `fragmentsByLine` — one entry per visual line (already grouped
 *  by y, e.g. `pdf.ts`'s own `linesFromItems`) — because a column is
 *  "the same x recurring across many LINES", not merely many fragments
 *  (several fragments in the same table row all share a line already).
 *
 *  Written limit: a right-aligned column is invisible here. Left edges are clustered within `CLUSTER_TOLERANCE`, and
 *  the amounts of an invoice share their right edge: the widest number, hence the total, starts further left and
 *  drops out of the column. Widening the tolerance is no fix: it would merge neighbouring columns.
 *
 *  WRITTEN LIMIT, bench of 01/10/2026: **a RIGHT-ALIGNED block with ragged left edges is no column here.** Doc 10 p2
 *  opens with a letterhead (Low Pay Commission, Contact, Email, Our Reference, Date: six truth cells of one table):
 *  its LEFT edges are 400.9, 396.2, 279.9, 356, 362.8 and 416.8 pt, its right edges all 517 pt, and the page paints no
 *  line. One alignment and no second column: nothing tells it from right-aligned paragraphs, so it stays prose (the
 *  words are all kept, in two paragraphs).
 */
export function detectAlignedColumns(fragmentsByLine: readonly Fragment[][]): number[] | undefined {
  // Drop `unpdf`'s own whitespace "filler" fragments first (see
  // `hasWeakTabularitySignal`'s doc) — a column is where REAL content
  // starts, not an implementation detail of how gaps are represented.
  const realLines = fragmentsByLine.map((line) => line.filter((f) => f.text.trim().length > 0));
  const leftEdgesByLine = realLines.map((line) => line.map((f) => f.x));
  // A column recurs when its chained edges come from enough DIFFERENT lines (members carry their line index).
  const edges = leftEdgesByLine.flatMap((line, lineIndex) => line.map((x) => ({ x, lineIndex })));
  const recurring = clusterGroups(edges, (e) => e.x)
    .filter((g) => new Set(g.members.map((m) => m.lineIndex)).size >= MIN_ALIGNED_ROWS)
    .map((g) => g.center);
  if (recurring.length < MIN_BOUNDARIES) return undefined;
  return recurring.sort((a, b) => a - b);
}

// A gap between two fragments on the SAME line wider than this multiple of
// the fragment's own height reads as "these are separate table cells", not
// ordinary word-spacing (a real space between words is nowhere near this
// wide relative to the text's own font size, whatever the font).
const LARGE_GAP_HEIGHT_RATIO = 3;
// Needs this many DIFFERENT lines showing that pattern — one line with two
// widely-spaced words (a title + a page number, a label + a value) is
// common in ordinary prose and proves nothing on its own.
const MIN_WEAK_SIGNAL_LINES = 2;

/** A page with no vector grid and no clean column alignment might still
 *  genuinely contain a table this detector simply can't parse — §8's
 *  04/09/2026 correction insists that case ("aucune grille") must stay
 *  visible, never silently skipped. But reporting it for EVERY page with
 *  no grid would flag ordinary flowing prose too (every multi-page PDF has
 *  some), burying the real signal in noise. This is the missing gate: a
 *  much weaker bar than `detectAlignedColumns` (no need for the SAME x to
 *  recur — just unusually wide gaps between fragments, recurring across a
 *  few different lines) — present ⇒ worth reporting as `no-grid` (a table
 *  probably here, unparseable); absent ⇒ this is just text, don't report
 *  anything for this page at all. */
export function hasWeakTabularitySignal(fragmentsByLine: readonly Fragment[][]): boolean {
  let linesWithLargeGap = 0;
  for (const line of fragmentsByLine) {
    // `unpdf`'s own text reconstruction inserts an explicit whitespace
    // "filler" fragment (str: " ", height: 0) to represent the visual gap
    // between two distinct text runs on the same line — real content never
    // sits at zero height. Dropping these before measuring gaps means this
    // function reasons about the REAL text runs' own positions, not an
    // implementation detail of how `unpdf` chooses to represent whitespace
    // (confirmed empirically, 04/09/2026, while building this detector).
    const real = line.filter((f) => f.text.trim().length > 0);
    if (real.length < 2) continue;
    const sorted = [...real].sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const gap = sorted[i + 1]!.x - (sorted[i]!.x + sorted[i]!.width);
      if (gap > sorted[i]!.height * LARGE_GAP_HEIGHT_RATIO) {
        linesWithLargeGap++;
        break;
      }
    }
  }
  return linesWithLargeGap >= MIN_WEAK_SIGNAL_LINES;
}

/** §8 jalon 2, régime 1, stage-2 (borderless) case: which CONTIGUOUS run of
 *  visual lines is actually the table, inside a page that may also have
 *  ordinary prose before/after it (a title, a footer note). A line
 *  "belongs" if at least 2 of the detected column positions have a real
 *  fragment starting there — the same per-line test `detectAlignedColumns`
 *  already implies in aggregate, made explicit here per line so the table's
 *  own start/end can be found. Prose lines before the first match and after
 *  the last are left alone (never pulled into the table); a line strictly
 *  BETWEEN two matching lines that doesn't itself match (a blank spacer, a
 *  wrapped continuation) is still included — a table is one contiguous
 *  visual block, not a set of scattered matching lines. */
/** Written limit: the range is contiguous, so it absorbs what it spans. A two-column letterhead that shares the left
 *  margins of the table below starts the range, and the document's title between them enters the table untested.
 *  The vertical gaps between blocks would tell them apart; they are not read here. */
export function identifyAlignedTableLines(
  fragmentsByLine: readonly Fragment[][],
  columnStarts: readonly number[],
): { startLine: number; endLine: number } | undefined {
  const matchingLineIndices: number[] = [];
  fragmentsByLine.forEach((line, i) => {
    const real = line.filter((f) => f.text.trim().length > 0);
    const matchedColumns = columnStarts.filter((x) => real.some((f) => Math.abs(f.x - x) <= CLUSTER_TOLERANCE));
    if (matchedColumns.length >= 2) matchingLineIndices.push(i);
  });
  if (matchingLineIndices.length === 0) return undefined;
  return { startLine: matchingLineIndices[0]!, endLine: matchingLineIndices[matchingLineIndices.length - 1]! };
}

/** §8 jalon 2, régime 1, stage-2 (borderless) case: builds a `TableGrid`
 *  from the column x-positions `detectAlignedColumns` found and the line
 *  y-positions within `identifyAlignedTableLines`'s range — there is no
 *  vector grid to read, so boundaries are the MIDPOINTS between consecutive
 *  lines/columns, with a half-line-height margin on the outer edges so the
 *  outermost row/column's own content isn't clipped by its own boundary. */
export function buildGridFromAlignedRows(
  linesInRange: readonly Fragment[][],
  columnStarts: readonly number[],
): TableGrid | undefined {
  if (linesInRange.length === 0 || columnStarts.length < MIN_BOUNDARIES) return undefined;
  const allReal = linesInRange.flat().filter((f) => f.text.trim().length > 0);
  if (allReal.length === 0) return undefined;
  const typicalHeight = allReal.reduce((sum, f) => sum + f.height, 0) / allReal.length;

  const lineYs = linesInRange.map((line) => {
    const real = line.find((f) => f.text.trim().length > 0);
    return real?.y ?? line[0]!.y;
  });
  const rowBoundaries = [lineYs[0]! + typicalHeight / 2];
  for (let i = 1; i < lineYs.length; i++) rowBoundaries.push((lineYs[i - 1]! + lineYs[i]!) / 2);
  rowBoundaries.push(lineYs[lineYs.length - 1]! - typicalHeight / 2);

  const sortedCols = [...columnStarts].sort((a, b) => a - b);
  const colBoundaries = [sortedCols[0]! - typicalHeight / 2];
  for (let i = 1; i < sortedCols.length; i++) colBoundaries.push((sortedCols[i - 1]! + sortedCols[i]!) / 2);
  // The last column's right edge isn't bounded by another column start, so
  // it's read from the content itself — the furthest-right edge any
  // fragment in that column actually reaches, plus the same margin used
  // elsewhere, not a guessed page width.
  const lastColStart = sortedCols[sortedCols.length - 1]!;
  const rightEdges = allReal.filter((f) => f.x >= lastColStart - CLUSTER_TOLERANCE).map((f) => f.x + f.width);
  const maxRightEdge = rightEdges.length > 0 ? maxOf(rightEdges, (edge) => edge) : lastColStart + typicalHeight;
  colBoundaries.push(maxRightEdge + typicalHeight / 2);

  return { rowBoundaries, colBoundaries };
}
