/** The table-size rule as the SECOND readings of Word and PowerPoint apply it: a table the page does not publish (more than
 *  `MAX_TABLE_COLS` columns or `MAX_TABLE_ROWS` rows, counted after its empty columns and its empty header rows are left out)
 *  expects no word from the control reading. Each reading counts from its OWN XML and hands over plain numbers (the grid columns
 *  each cell starts in and spans, whether it holds a word); the decision itself is `lib/table-width-cap.ts#tableExceedsCaps`,
 *  the very one the renderer's walk uses. Nothing of an extractor is imported (`core/import-boundaries.test.ts`).
 *  Counted on the safe side: a cell holding only an image counts as empty here, so a table is never expected withheld when
 *  the page publishes it (the worst case is a word reported missing, never one lost unseen).
 *  NOT here: the walk that collects the words (`source-reading-docx.ts`, `source-reading-pptx.ts`), the removal itself
 *  (`lib/table-width-cap.ts`), nor the wording of the remark.
 *  Also holds the two layout rules the readings share: `placeRowCells` (Word and PowerPoint: where a cell starts under the rowspans
 *  above it) and `coveredByMerges` (Excel and Google Sheets: which cells a merge hides).
 *  Called by: `pipeline/source-reading-docx.ts`, `pipeline/source-reading-pptx.ts`, `pipeline/source-reading-xlsx.ts`,
 *  `pipeline/source-reading-gsheet.ts`. */

import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { tableExceedsCaps } from "doc-ir/lib/table-width-cap";

/** A cell as the reading counts it: how many grid columns it spans and whether it holds a word. */
interface GridCell {
  span: number;
  filled: boolean;
}

/** A row of cells in grid order (a cell absorbed by a merge included, with its own span), and whether it is an empty header row. */
export interface GridRow {
  cells: readonly GridCell[];
  emptyHeader: boolean;
}

/** True when the table is not published. A table with no word at all is not (nothing to expect either way). */
export const tableWithheld = (rows: readonly GridRow[], limits?: ReaderLimits): boolean => {
  const filledStarts: number[] = []; // ascending: columns are visited in order within a row, rows merged below
  const filled = new Set<number>();
  const ends: number[] = [];
  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells) {
      if (cell.filled && !filled.has(col)) {
        filled.add(col);
        filledStarts.push(col);
      }
      col += Math.max(1, Math.floor(cell.span) || 1);
    }
    ends.push(col);
  }
  if (filled.size === 0) return false;
  filledStarts.sort((a, b) => a - b);
  // The kept columns a row reaches: those that start before its end.
  const keptBefore = (end: number): number => {
    let lo = 0;
    let hi = filledStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (filledStarts[mid]! < end) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const width = ends.reduce((widest, end) => Math.max(widest, keptBefore(end)), 0);
  const kept = rows.filter((row) => !row.emptyHeader).length;
  return tableExceedsCaps(width, kept, limits);
};

/** A cell about to be laid out: its width in grid columns, whether it holds a word, and how many rows it runs down (1 = none). */
export interface LayoutCell {
  span: number;
  filled: boolean;
  rowspan: number;
}

/** Grid columns `start..end` (end excluded) that a cell above still covers through row `until`. */
export interface CoveredRange {
  start: number;
  end: number;
  until: number;
}

/** Lays out row `r` of `rowCount` as the page does: each cell starts at the next column no rowspan above covers, a gap standing for
 *  the covered columns as one unfilled cell. The covered columns are kept as RANGES sorted by start, never one entry per column (a
 *  wide span that also runs down would cost their product); a range runs down to the last row at most. Returns the row's cells and
 *  the ranges still covering the next rows. */
export const placeRowCells = (
  covered: readonly CoveredRange[],
  cells: readonly LayoutCell[],
  r: number,
  rowCount: number,
): { placed: GridCell[]; covered: CoveredRange[] } => {
  const live = covered.filter((t) => t.until >= r);
  const placed: GridCell[] = [];
  const added: CoveredRange[] = [];
  let next = 0; // live[next..] start beyond the column reached
  let column = 0;
  for (const cell of cells) {
    const before = column;
    while (next < live.length && live[next]!.start <= column) {
      column = Math.max(column, live[next]!.end);
      next++;
    }
    if (column > before) placed.push({ span: column - before, filled: false });
    if (cell.rowspan > 1) added.push({ start: column, end: column + cell.span, until: Math.min(r + cell.rowspan - 1, rowCount - 1) });
    placed.push({ span: cell.span, filled: cell.filled });
    column += cell.span;
  }
  return { placed, covered: added.length > 0 ? [...live, ...added].sort((a, b) => a.start - b.start) : live };
};

/** A merged range, 0- or 1-based as the caller counts, both ends INCLUDED and ordered (`r1 <= r2`, `c1 <= c2`). */
export interface MergeRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** The cells a sheet's merges cover, each mapped to the anchor of the merge that covers it (key `"row,col"`). Our rule (no
 *  official source; cost on hostile files), written twice with `sheet-grid.ts#tableOfKept`: the first merge wins; a merge whose
 *  first cell is not in a kept row AND column, or that spans fewer than two kept lines, covers nothing; one anchored on an
 *  anchor or a covered cell is ignored whole. The anchor itself is never covered. */
export const coveredByMerges = (
  merges: readonly MergeRange[],
  keptRows: ReadonlySet<number>,
  keptCols: ReadonlySet<number>,
): Map<string, { rowNum: number; colNum: number }> => {
  const sortedRows = [...keptRows].sort((a, b) => a - b);
  const sortedCols = [...keptCols].sort((a, b) => a - b);
  const anchorOfCovered = new Map<string, { rowNum: number; colNum: number }>();
  const anchors = new Set<string>();
  for (const m of merges) {
    if (!keptRows.has(m.r1) || !keptCols.has(m.c1)) continue;
    const anchorKey = `${m.r1},${m.c1}`;
    if (anchors.has(anchorKey) || anchorOfCovered.has(anchorKey)) continue;
    const rowsIn = sortedRows.filter((r) => r >= m.r1 && r <= m.r2);
    const colsIn = sortedCols.filter((c) => c >= m.c1 && c <= m.c2);
    if (rowsIn.length <= 1 && colsIn.length <= 1) continue;
    anchors.add(anchorKey);
    for (const r of rowsIn) {
      for (const c of colsIn) {
        const key = `${r},${c}`;
        if (key !== anchorKey && !anchors.has(key)) anchorOfCovered.set(key, { rowNum: m.r1, colNum: m.c1 });
      }
    }
  }
  return anchorOfCovered;
};
