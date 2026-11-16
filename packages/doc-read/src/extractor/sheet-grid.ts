/** The published grid of ONE spreadsheet tab, shared by the two sheet
 *  readers: which rows and columns are kept (hidden AND fully empty ones
 *  out, edges and interior) and the table built on them, merges shrunk to
 *  what was kept.
 *  Decides: a row or column is kept only when a visible cell of a visible row and column shows something; a merge
 *  counts only the kept lines it crosses; overlapping merges follow one rule of ours.
 *  NOT here: where the cells come from (`xlsx-cells.ts` for `.xlsx`, the
 *  Sheets API values for a Google Sheet), nor the display caps (`sheet-workbook.ts` decides
 *  on the kept counts).
 *  Called by: `extractor/xlsx.ts`, `extractor/google-sheet.ts`; `extractor/sheet-workbook.ts` uses its `KeptLines` type. */

import type { Inline, IRBlock } from "doc-ir/lib/ir";

type Table = Extract<IRBlock, { kind: "table" }>;

export interface KeptLines {
  readonly keptRows: number[];
  readonly keptCols: number[];
  readonly keptRowSet: ReadonlySet<number>;
  readonly keptColSet: ReadonlySet<number>;
}

/** A merge with INCLUSIVE bounds. Each caller converts to it: `xlsx.ts` from its cell ranges, `google-sheet.ts`
 *  from the half-open ranges of the Sheets API. */
export interface GridMerge {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

/** The kept rows and columns, from the cells that carry DISPLAYABLE text
 *  only — never from a declared range (a declared A1:Z1048576 once meant
 *  about 27 M addresses walked before the cap could refuse). A row or column
 *  is kept when a visible cell of a visible row AND a visible column shows
 *  something: a row whose only text sits in a hidden column is dropped too,
 *  as it would publish empty. */
export const keptLinesOf = (
  filledCells: Iterable<readonly [row: number, col: number]>,
  isRowHidden: (rowIndex: number) => boolean,
  isColHidden: (colIndex: number) => boolean,
): KeptLines => {
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (const [rowIndex, colIndex] of filledCells) {
    if (isRowHidden(rowIndex) || isColHidden(colIndex)) continue;
    rows.add(rowIndex);
    cols.add(colIndex);
  }
  const keptRows = [...rows].sort((earlier, later) => earlier - later);
  const keptCols = [...cols].sort((earlier, later) => earlier - later);
  return { keptRows, keptCols, keptRowSet: rows, keptColSet: cols };
};

/** The table on the kept lines. Only a merge's top-left cell gets a
 *  colspan/rowspan, every other KEPT cell it covers is skipped. A merge
 *  counts only the kept lines it crosses, so a merge declared far past the data never
 *  widens the grid (the Google Sheets reader once did). A merge whose
 *  top-left was dropped is ignored whole: its only value lived there, and
 *  that row or column was judged empty.
 *  Overlapping or repeated merges: the rule is OURS, chosen for its cost on
 *  hostile files. Merges are taken in document order; one whose top-left
 *  cell is already an anchor or already covered is ignored whole, and an
 *  accepted one covers only cells not yet covered, never an earlier anchor.
 *  `pipeline/source-reading-table.ts#coveredByMerges` writes the same rule independently. */
export const tableOfKept = (lines: KeptLines, merges: readonly GridMerge[], cellAt: (rowIndex: number, colIndex: number) => Inline | undefined): Table => {
  const layout = mergeLayoutOf(lines, merges);
  const rows: Table["rows"] = [];
  for (const rowIndex of lines.keptRows) rows.push({ cells: buildTableRowCells(rowIndex, lines.keptCols, layout, cellAt) });
  return { kind: "table", rows };
};

type Span = { rowspan: number; colspan: number };

/** The accepted merges of a grid: the span of each anchor cell and the set of cells an anchor covers. Keys are `row,col`. */
interface MergeLayout {
  readonly spanAt: ReadonlyMap<string, Span>;
  readonly covered: ReadonlySet<string>;
}

/** The cells of one kept row: every kept column except the cells a merge covers. */
const buildTableRowCells = (
  rowIndex: number,
  keptCols: readonly number[],
  { spanAt, covered }: MergeLayout,
  cellAt: (rowIndex: number, colIndex: number) => Inline | undefined,
): Table["rows"][number]["cells"] => {
  const cells: Table["rows"][number]["cells"] = [];
  for (const colIndex of keptCols) {
    if (covered.has(`${rowIndex},${colIndex}`)) continue;
    const inline = cellAt(rowIndex, colIndex);
    const span = spanAt.get(`${rowIndex},${colIndex}`);
    cells.push({
      blocks: inline !== undefined && inline.text.length > 0 ? [{ kind: "paragraph", inlines: [inline] }] : [],
      ...(span !== undefined && span.colspan > 1 ? { colspan: span.colspan } : {}),
      ...(span !== undefined && span.rowspan > 1 ? { rowspan: span.rowspan } : {}),
    });
  }
  return cells;
};

const mergeLayoutOf = (lines: KeptLines, merges: readonly GridMerge[]): MergeLayout => {
  const spanAt = new Map<string, Span>();
  const covered = new Set<string>();
  for (const merge of merges) addMerge(merge, lines, spanAt, covered);
  return { spanAt, covered };
};

/** Records one merge in `spanAt` and `covered`, unless the rules of `tableOfKept` ignore it. */
const addMerge = (merge: GridMerge, lines: KeptLines, spanAt: Map<string, Span>, covered: Set<string>): void => {
  if (!lines.keptRowSet.has(merge.startRow) || !lines.keptColSet.has(merge.startCol)) return;
  const anchorKey = `${merge.startRow},${merge.startCol}`;
  if (spanAt.has(anchorKey) || covered.has(anchorKey)) return;
  const keptRowsInMerge = lines.keptRows.filter((rowIndex) => rowIndex >= merge.startRow && rowIndex <= merge.endRow);
  const keptColsInMerge = lines.keptCols.filter((colIndex) => colIndex >= merge.startCol && colIndex <= merge.endCol);
  if (keptRowsInMerge.length <= 1 && keptColsInMerge.length <= 1) return;
  spanAt.set(anchorKey, { rowspan: keptRowsInMerge.length, colspan: keptColsInMerge.length });
  for (const rowIndex of keptRowsInMerge) {
    for (const colIndex of keptColsInMerge) {
      const key = `${rowIndex},${colIndex}`;
      if (key !== anchorKey && !spanAt.has(key)) covered.add(key);
    }
  }
};
