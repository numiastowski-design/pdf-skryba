/** A table without its empty columns and its empty header row (Mikolaj, 08/10/2026): none is published, in any format, as the
 *  PDF reader already does. A column is EMPTY when no cell ANCHORED in it (the column a merged cell starts in) holds text beyond
 *  blanks, an image, an anchor or any other published block. A merged cell loses one span per removed column it covers; an empty
 *  one covering only removed columns goes. The relative widths of a removed column go with it. An all-empty header row is left
 *  out and the row after it keeps its own kind. Cost O(rows x grid width + cells), whatever the spans
 *  (`table-empty-parts.hostile-spans.test.ts`, `table-empty-parts.equivalence.test.ts`).
 *  NOT here: the empty `<tr>` left by spans (`renderer/storage.ts#withoutEmptyRows`), the PDF's own column analysis
 *  (`extractor/pdf-table-render.ts`), nor any reading of a source file.
 *  Also holds the PDF reader's own step, `withoutLeadingBandsDeep` (`table-leading-bands.test.ts`, `table-header-fold.test.ts`): on every table, nested ones
 *  included, the leading rows that hold nothing at all fall (their downward spans start one row lower), then the group of rows tied by spans folds into ONE
 *  row (a header a PDF painted in layers, a « wall of bricks »: text cells spanning downward that START ON DIFFERENT ROWS), each column's pieces one after the
 *  other as blocks of one cell. It abstains (table left as it is) with no text, text in the corner, fewer than two such starts, a group that is the whole
 *  table, or a column whose pieces differ in colspan. No other format calls it.
 *  Tried, then dropped: rule A (the « tetris », render 96, 16/10/2026) glued the one-row text cells into the spanning cell below while the corner was empty.
 *  B (this fold) replaced it on 24/10/2026 after the A/B/C comparison of 16-23/10 on 2 020 tables of 429 PDFs: B moved 0 words and crushed 0 tables of 5 rows
 *  or more; A crushed one (071 p. 7, 5 rows to 1, Word has 5); distance to the Word rows 1 932 for B against 1 934 for A. Known risk of B, tested: a
 *  timetable of four rows or more looks like such a header and is folded; no word is lost.
 *  Called by: `renderer/storage.ts`, `lib/table-width-cap.ts`; `withoutLeadingBandsDeep` by `extractor/pdf.ts`. */

import type { IRBlock } from "./ir";
import { mapBlockChildren } from "./ir-walk";

type TableBlock = Extract<IRBlock, { kind: "table" }>;
type Row = TableBlock["rows"][number];
type Cell = Row["cells"][number];

/** True when the blocks publish something: text beyond blanks, an inline image or anchor, or any block that is not a bare text one. */
export const hasContent = (blocks: readonly IRBlock[]): boolean =>
  blocks.some((b) => {
    switch (b.kind) {
      case "paragraph":
      case "heading":
        return b.inlines.some(
          (i) =>
            i.text.trim() !== "" ||
            i.image !== undefined ||
            i.anchor !== undefined,
        );
      case "list":
        return b.items.some(hasContent);
      case "table":
        return b.rows.some((r) => r.cells.some((c) => hasContent(c.blocks)));
      default:
        return true;
    }
  });

/** A cell always spans at least one column; a degenerate value (0, negative, fractional, NaN) reads as 1. */
export const spanOf = (declared: number | undefined): number => {
  const n = Math.floor(declared ?? 1);
  return n >= 1 ? n : 1;
};

/** A rowspan reaches `ceil(rowspan) - 1` rows below its cell; a degenerate value (<= 1, NaN) reaches none. */
export const rowsBelow = (declared: number | undefined): number => {
  const n = declared ?? 1;
  return n > 1 ? Math.ceil(n) - 1 : 0;
};

/** A column range `[start, end)` that rows up to `until` (inclusive) find taken by a rowspan above. */
type Taken = { start: number; end: number; until: number };

/** The column each cell is ANCHORED in (the one it starts in; rowspans of earlier rows push it right) and the grid width.
 *  Time O(rows x grid width + cells), memory O(cells): the columns a rowspan covers are kept as ONE range, never expanded
 *  one by one (a colspan x rowspan cell would cost the product). The live ranges all start in distinct columns (a cell never
 *  anchors in a taken column), so a row meets at most grid-width of them. */
export const anchorsOf = (table: TableBlock): { anchors: number[][]; gridWidth: number } => {
  let live: Taken[] = []; // sorted by start
  const anchors: number[][] = [];
  let gridWidth = 0;
  table.rows.forEach((row, r) => {
    live = live.filter((t) => t.until >= r);
    const added: Taken[] = [];
    let next = 0; // live[next..] start beyond the column reached
    let col = 0;
    anchors.push(
      row.cells.map((cell) => {
        // The first column at or after `col` no live range covers.
        while (next < live.length && live[next]!.start <= col) {
          col = Math.max(col, live[next]!.end);
          next++;
        }
        const start = col;
        const colspan = spanOf(cell.colspan);
        const below = rowsBelow(cell.rowspan);
        if (below > 0) added.push({ start, end: start + colspan, until: Math.min(r + below, table.rows.length - 1) });
        col += colspan;
        gridWidth = Math.max(gridWidth, col);
        return start;
      }),
    );
    if (added.length > 0) live = [...live, ...added].sort((a, b) => a.start - b.start);
  });
  return { anchors, gridWidth };
};

/** The grid width of a table: the widest row in grid columns, a merged cell counting for its span. */
export const tableGridWidth = (table: TableBlock): number => anchorsOf(table).gridWidth;

/** The table without its empty columns and empty header row, the same object when there is nothing to remove, `null` when
 *  nothing is left to publish. */
export const withoutEmptyTableParts = (
  table: TableBlock,
): TableBlock | null => {
  if (table.rows.length === 0) return table;

  const { anchors, gridWidth } = anchorsOf(table);

  const filled = new Set<number>();
  table.rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (hasContent(cell.blocks)) filled.add(anchors[r]![c]!);
    }),
  );
  if (filled.size === 0) return null;

  const keptBefore: number[] = []; // keptBefore[c] = kept columns among 0..c-1
  for (let c = 0; c <= gridWidth; c++)
    keptBefore.push(
      c === 0 ? 0 : keptBefore[c - 1]! + (filled.has(c - 1) ? 1 : 0),
    );
  const removedAny = filled.size < gridWidth;

  const narrowed: Row[] = table.rows.map((row, r) => ({
    ...row,
    cells: row.cells.flatMap((cell, c): Cell[] => {
      if (!removedAny) return [cell];
      const start = anchors[r]![c]!;
      const span = spanOf(cell.colspan);
      const kept =
        keptBefore[Math.min(start + span, gridWidth)]! - keptBefore[start]!;
      if (kept === 0) return [];
      if (kept === span) return [cell];
      const { colspan: _unused, ...rest } = cell;
      void _unused;
      return [kept > 1 ? { ...rest, colspan: kept } : rest];
    }),
  }));

  // An all-empty header row, not crossed by a span and spanning none downward. `reach` = the first row no span of the rows
  // above still covers (one pass: the running maximum of row + rowspan).
  let reach = 0;
  const dropRow = narrowed.map((row, i) => {
    const crossed = reach > i;
    for (const c of row.cells) {
      const end = i + (c.rowspan ?? 1);
      if (end > reach) reach = end;
    }
    if (row.cells.length === 0) return false;
    if (
      !row.cells.every(
        (c) =>
          c.header === true && c.rowspan === undefined && !hasContent(c.blocks),
      )
    ) {
      return false;
    }
    return !crossed;
  });
  const removedRows = dropRow.includes(true);
  if (!removedAny && !removedRows) return table;

  const { columnWidths, ...others } = table;
  const rows = narrowed.filter((_, i) => !dropRow[i]);
  const widths =
    columnWidths !== undefined && columnWidths.length === gridWidth
      ? removedAny
        ? columnWidths.filter((_, c) => filled.has(c))
        : columnWidths
      : undefined;
  return { ...others, rows, ...(widths ? { columnWidths: widths } : {}) };
};

/** How many leading empty rows one call removes: a grey header painted as stacked rectangles shows a few at most. Starting value, to calibrate. */
const MAX_LEADING_BANDS = 16;

/** The table without its first row, or `undefined` when that row is not EMPTY: it must have cells and hold no text, image or anchor at all. Its cells that
 *  span downward start one row lower with one row less to span; its other cells go. */
const withoutEmptyLeadingRow = (table: TableBlock): TableBlock | undefined => {
  const first = table.rows[0];
  const second = table.rows[1];
  if (first === undefined || second === undefined || first.cells.length === 0) return undefined;
  if (first.cells.some((c) => hasContent(c.blocks))) return undefined;
  const { anchors } = anchorsOf({ ...table, rows: table.rows.slice(0, 2) }); // the anchors of a row depend on the rows above only
  const entries: { anchor: number; cell: Cell }[] = second.cells.map((cell, c) => ({ anchor: anchors[1]![c]!, cell }));
  first.cells.forEach((cell, c) => {
    const left = rowsBelow(cell.rowspan);
    if (left === 0) return;
    const lower: Cell = { ...cell }; // starts one row lower, one row less to span (no span left: no attribute)
    if (left > 1) lower.rowspan = left;
    else delete lower.rowspan;
    entries.push({ anchor: anchors[0]![c]!, cell: lower });
  });
  entries.sort((x, y) => x.anchor - y.anchor);
  return { ...table, rows: [{ ...second, cells: entries.map((e) => e.cell) }, ...table.rows.slice(2)] };
};

/** The table without its leading rows that hold nothing at all, the same object when it has none or when it holds no text at all (a blank form's
 *  empty rows are its shape). */
export const withoutLeadingBands = (table: TableBlock): TableBlock => {
  if (!table.rows.some((r) => r.cells.some((c) => hasContent(c.blocks)))) return table;
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
  for (let r = 0; r <= end && r < rows.length; r++) for (const c of rows[r]!.cells) end = Math.max(end, r + rowsBelow(c.rowspan));
  return Math.min(end, rows.length - 1);
};

/** How many rows of 0..end hold a text cell that spans downward. */
const spanningStarts = (rows: TableBlock["rows"], end: number): number =>
  rows.slice(0, end + 1).filter((row) => row.cells.some((c) => hasContent(c.blocks) && rowsBelow(c.rowspan) > 0)).length;

/** The cells of rows 0..end grouped by the grid column they are anchored on. */
const chainsOf = (rows: TableBlock["rows"], anchors: number[][], end: number): Map<number, Cell[]> => {
  const chains = new Map<number, Cell[]>();
  for (let r = 0; r <= end; r++)
    rows[r]!.cells.forEach((cell, c) => {
      const anchor = anchors[r]![c]!;
      const chain = chains.get(anchor);
      if (chain === undefined) chains.set(anchor, [cell]);
      else chain.push(cell);
    });
  return chains;
};

/** One column's pieces as ONE cell: the first piece holding text gives the cell, the blocks follow one another, the header flag of any piece is kept. */
const foldedCell = (chain: Cell[]): Cell => {
  const base = chain.find((c) => hasContent(c.blocks)) ?? chain[0]!;
  const folded: Cell = { ...base, blocks: chain.flatMap((c) => c.blocks) };
  delete folded.rowspan;
  if (chain.some((c) => c.header === true)) folded.header = true;
  return folded;
};

/** The rows 0..end tied by spans (the running maximum of row + rowsBelow, clamped to the table), folded into one row: for each column, the cells anchored
 *  there from the first row to the last, their blocks one after the other. `undefined` when the group is not a header cut into lines: no text, text in the
 *  corner, no span, the group is the whole table (no body below), fewer than two text cells spanning downward that start on different rows, or a column whose
 *  pieces have different colspans. */

const foldGroup = (table: TableBlock): TableBlock | undefined => {
  const rows = table.rows;
  const first = rows[0];
  if (rows.length < 2 || first === undefined || first.cells.length === 0 || hasContent(first.cells[0]!.blocks)) return undefined;
  const end = groupEnd(rows);
  if (end === 0 || end === rows.length - 1 || spanningStarts(rows, end) < 2) return undefined;
  const chains = chainsOf(rows, anchorsOf(table).anchors, end);
  for (const chain of chains.values()) if (new Set(chain.map((c) => spanOf(c.colspan))).size > 1) return undefined;
  const cells = [...chains.entries()].sort((a, b) => a[0] - b[0]).map(([, chain]) => foldedCell(chain));
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
