/** The published grid of ONE spreadsheet tab, shared by the two sheet
 *  readers: which rows and columns are kept (hidden AND fully empty ones
 *  out, edges and interior) and the table built on them, merges shrunk to
 *  what was kept.
 *  NOT here: where the cells come from (`xlsx-cells.ts` for `.xlsx`, the
 *  Sheets API values for a Google Sheet), nor the display caps (each reader
 *  decides on the kept counts).
 *  Called by: `extractor/xlsx.ts`, `extractor/google-sheet.ts`. */

import type { Inline, IRBlock } from "doc-ir/lib/ir";

type Table = Extract<IRBlock, { kind: "table" }>;

export interface KeptLines {
  keptRows: number[];
  keptCols: number[];
  keptRowSet: ReadonlySet<number>;
  keptColSet: ReadonlySet<number>;
}

/** A merge with INCLUSIVE bounds (`xlsx-cells.ts`'s own shape; the Sheets
 *  API's half-open ranges convert at the caller). */
export interface GridMerge {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The kept rows and columns, from the cells that carry DISPLAYABLE text
 *  only — never from a declared range (revue HIGH 29/09, constat 10: a
 *  declared A1:Z1048576 was ~27 M addresses walked before the cap could
 *  refuse). A row or column is kept when a visible cell of a visible row
 *  AND a visible column shows something: a row whose only text sits in a
 *  hidden column is dropped too (constat 4) — it would publish empty. */
export const keptLinesOf = (
  filled: Iterable<readonly [row: number, col: number]>,
  rowHidden: (r: number) => boolean,
  colHidden: (c: number) => boolean,
): KeptLines => {
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (const [r, c] of filled) {
    if (rowHidden(r) || colHidden(c)) continue;
    rows.add(r);
    cols.add(c);
  }
  const keptRows = [...rows].sort((a, b) => a - b);
  const keptCols = [...cols].sort((a, b) => a - b);
  return { keptRows, keptCols, keptRowSet: rows, keptColSet: cols };
};

/** The table on the kept lines. Only a merge's top-left cell gets a
 *  colspan/rowspan, every other KEPT cell it covers is skipped. A merge
 *  counts only the kept lines it crosses — the same rule the renderer
 *  applies to empty rows (`renderer/storage.ts#withoutEmptyRows`) — so a merge declared far past the data never
 *  widens the grid (constat 5: the Sheets reader did). A merge whose
 *  top-left was dropped is ignored whole: its only value lived there, and
 *  that row or column was judged empty.
 *  Overlapping or repeated merges (Excel never writes them; no official
 *  source says what to do, so the rule is OURS, chosen for its cost on
 *  hostile files): merges are taken in document order; one whose top-left
 *  cell is already an anchor or already covered is ignored whole, and an
 *  accepted one covers only cells not yet covered, never an earlier anchor.
 *  `pipeline/source-reading-xlsx.ts` writes the same rule independently. */
export const tableOfKept = (lines: KeptLines, merges: readonly GridMerge[], cellAt: (r: number, c: number) => Inline | undefined): Table => {
  const { keptRows, keptCols, keptRowSet, keptColSet } = lines;
  const spanAt = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();
  for (const m of merges) {
    if (!keptRowSet.has(m.startRow) || !keptColSet.has(m.startCol)) continue;
    const anchorKey = `${m.startRow},${m.startCol}`;
    if (spanAt.has(anchorKey) || covered.has(anchorKey)) continue;
    const rowsIn = keptRows.filter((r) => r >= m.startRow && r <= m.endRow);
    const colsIn = keptCols.filter((c) => c >= m.startCol && c <= m.endCol);
    if (rowsIn.length <= 1 && colsIn.length <= 1) continue;
    spanAt.set(anchorKey, { rowspan: rowsIn.length, colspan: colsIn.length });
    for (const r of rowsIn) {
      for (const c of colsIn) {
        const key = `${r},${c}`;
        if (key !== anchorKey && !spanAt.has(key)) covered.add(key);
      }
    }
  }

  const rows: Table["rows"] = [];
  for (const r of keptRows) {
    const cells: Table["rows"][number]["cells"] = [];
    for (const c of keptCols) {
      if (covered.has(`${r},${c}`)) continue;
      const inline = cellAt(r, c);
      const span = spanAt.get(`${r},${c}`);
      cells.push({
        blocks: inline !== undefined && inline.text.length > 0 ? [{ kind: "paragraph", inlines: [inline] }] : [],
        ...(span !== undefined && span.colspan > 1 ? { colspan: span.colspan } : {}),
        ...(span !== undefined && span.rowspan > 1 ? { rowspan: span.rowspan } : {}),
      });
    }
    rows.push({ cells });
  }
  return { kind: "table", rows };
};
