/** The PDF reader's own step on a table (`table-leading-bands.test.ts`, `table-header-fold.test.ts`): on every table, nested ones
 *  included, the leading rows that hold nothing at all fall (their downward spans start one row lower), then the group of rows tied by spans folds into ONE
 *  row (a header a PDF painted in layers, a « wall of bricks »: text cells spanning downward that START ON DIFFERENT ROWS), each column's pieces one after the
 *  other as blocks of one cell. It abstains (table left as it is) with no text, text in the corner, fewer than two such starts, a group that is the whole
 *  table, or a column whose pieces differ in colspan. No other format calls it.
 *  Tried, then dropped: rule A (the « tetris », render 96, 16/10/2026) glued the one-row text cells into the spanning cell below while the corner was empty.
 *  B (this fold) replaced it on 24/10/2026 after the A/B/C comparison of 16-23/10 on 2 020 tables of 429 PDFs: B moved 0 words and crushed 0 tables of 5 rows
 *  or more; A crushed one (071 p. 7, 5 rows to 1, Word has 5); distance to the Word rows 1 932 for B against 1 934 for A. Known risk of B, tested: a
 *  timetable of four rows or more looks like such a header and is folded; no word is lost.
 *  NOT here: the empty columns and the empty header row every format drops (`lib/table-empty-parts.ts`, whose anchors and
 *  « holds something » test this file reads), nor the grid a PDF table is read from.
 *  Called by: `extractor/pdf.ts`. */

import type { IRBlock } from "doc-ir";
import { mapBlockChildren } from "doc-ir/internal";
import { anchorsOf, hasContent, rowsBelow, spanOf } from "doc-ir/internal";

type TableBlock = Extract<IRBlock, { kind: "table" }>;
type Cell = TableBlock["rows"][number]["cells"][number];

/** How many leading empty rows one call removes: a grey header painted as stacked rectangles shows a few at most. Starting value, to calibrate. */
const MAX_LEADING_BANDS = 16;

/** The table without its first row, or `undefined` when that row is not EMPTY: it must have cells and hold no text, image or anchor at all. Its cells that
 *  span downward start one row lower with one row less to span; its other cells go. */
const withoutEmptyLeadingRow = (table: TableBlock): TableBlock | undefined => {
  const first = table.rows[0];
  const second = table.rows[1];
  if (first === undefined || second === undefined || first.cells.length === 0) return undefined;
  if (first.cells.some((cell) => hasContent(cell.blocks))) return undefined;
  const { anchors } = anchorsOf({ ...table, rows: table.rows.slice(0, 2) }); // the anchors of a row depend on the rows above only
  const entries: { anchor: number; cell: Cell }[] = second.cells.map((cell, cellIndex) => ({
    anchor: anchors[1]![cellIndex]!,
    cell,
  }));
  first.cells.forEach((cell, cellIndex) => {
    const left = rowsBelow(cell.rowspan);
    if (left === 0) return;
    const lower: Cell = { ...cell }; // starts one row lower, one row less to span (no span left: no attribute)
    if (left > 1) lower.rowspan = left;
    else delete lower.rowspan;
    entries.push({ anchor: anchors[0]![cellIndex]!, cell: lower });
  });
  entries.sort((before, after) => before.anchor - after.anchor);
  return { ...table, rows: [{ ...second, cells: entries.map((entry) => entry.cell) }, ...table.rows.slice(2)] };
};

/** The table without its leading rows that hold nothing at all, the same object when it has none or when it holds no text at all (a blank form's
 *  empty rows are its shape). */
export const withoutLeadingBands = (table: TableBlock): TableBlock => {
  if (!table.rows.some((row) => row.cells.some((cell) => hasContent(cell.blocks)))) return table;
  let current = table;
  for (let pass = 0; pass < MAX_LEADING_BANDS; pass++) {
    const next = withoutEmptyLeadingRow(current);
    if (next === undefined) break;
    current = next;
  }
  return current;
};

/** The last row of the group tied by spans from row 0: the running maximum of row + rowsBelow, clamped to the table. */
const groupEnd = (rows: TableBlock["rows"]): number => {
  let end = 0;
  for (let rowIndex = 0; rowIndex <= end && rowIndex < rows.length; rowIndex++)
    for (const cell of rows[rowIndex]!.cells) end = Math.max(end, rowIndex + rowsBelow(cell.rowspan));
  return Math.min(end, rows.length - 1);
};

/** How many rows of 0..end hold a text cell that spans downward. */
const spanningStarts = (rows: TableBlock["rows"], end: number): number =>
  rows
    .slice(0, end + 1)
    .filter((row) => row.cells.some((cell) => hasContent(cell.blocks) && rowsBelow(cell.rowspan) > 0)).length;

/** The cells of rows 0..end grouped by the grid column they are anchored on. */
const chainsOf = (rows: TableBlock["rows"], anchors: number[][], end: number): Map<number, Cell[]> => {
  const chains = new Map<number, Cell[]>();
  for (let rowIndex = 0; rowIndex <= end; rowIndex++)
    rows[rowIndex]!.cells.forEach((cell, cellIndex) => {
      const anchor = anchors[rowIndex]![cellIndex]!;
      const chain = chains.get(anchor);
      if (chain === undefined) chains.set(anchor, [cell]);
      else chain.push(cell);
    });
  return chains;
};

/** One column's pieces as ONE cell: the first piece holding text gives the cell, the blocks follow one another, the header flag of any piece is kept. */
const foldedCell = (chain: Cell[]): Cell => {
  const base = chain.find((cell) => hasContent(cell.blocks)) ?? chain[0]!;
  const folded: Cell = { ...base, blocks: chain.flatMap((cell) => cell.blocks) };
  delete folded.rowspan;
  if (chain.some((cell) => cell.header === true)) folded.header = true;
  return folded;
};

/** The rows 0..end tied by spans (the running maximum of row + rowsBelow, clamped to the table), folded into one row: for each column, the cells anchored
 *  there from the first row to the last, their blocks one after the other. `undefined` when the group is not a header cut into lines: no text, text in the
 *  corner, no span, the group is the whole table (no body below), fewer than two text cells spanning downward that start on different rows, or a column whose
 *  pieces have different colspans. */
const foldGroup = (table: TableBlock): TableBlock | undefined => {
  const rows = table.rows;
  const first = rows[0];
  if (rows.length < 2 || first === undefined || first.cells.length === 0 || hasContent(first.cells[0]!.blocks))
    return undefined;
  const end = groupEnd(rows);
  if (end === 0 || end === rows.length - 1 || spanningStarts(rows, end) < 2) return undefined;
  const chains = chainsOf(rows, anchorsOf(table).anchors, end);
  for (const chain of chains.values())
    if (new Set(chain.map((cell) => spanOf(cell.colspan))).size > 1) return undefined;
  const cells = [...chains.entries()]
    .sort((before, after) => before[0] - after[0])
    .map(([, chain]) => foldedCell(chain));
  return { ...table, rows: [{ ...first, cells }, ...rows.slice(end + 1)] };
};

/** The table with a header cut into lines put back together: the rows that hold nothing fall, then the group of rows tied by spans folds into one row.
 *  The same object when there is nothing to do. */
const withHeaderFolded = (table: TableBlock): TableBlock => {
  const fallen = withoutLeadingBands(table);
  return foldGroup(fallen) ?? fallen;
};

/** `withHeaderFolded` on every table of `blocks`, nested ones included. The PDF extraction's call (`extractor/pdf.ts`). */
export const withoutLeadingBandsDeep = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.map((block) => {
    const inner = mapBlockChildren(block, (list) => withoutLeadingBandsDeep(list));
    return inner.kind === "table" ? withHeaderFolded(inner) : inner;
  });
