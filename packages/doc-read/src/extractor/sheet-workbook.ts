/** The workbook loop shared by the two spreadsheet readers (`.xlsx` and Google Sheets).
 *  Decides: hidden sheets out; the workbook tab cap (`MAX_WORKBOOK_TABS`); the per-sheet caps (`MAX_SHEET_ROWS` x
 *  `MAX_SHEET_COLS`) on the KEPT counts, a withheld sheet still taking a tab slot; ONE header rule (the LAST frozen row,
 *  plus declared table spans), counted in SOURCE rows, so a header frozen at source row N stays row N whatever empty or
 *  hidden rows precede it; rows with a single first cell published as ONE full-width cell
 *  (`span-single-first.ts#spanSingleFirstRows`); the chart and picture blocks under the table; a tab with no block gets
 *  one empty paragraph (`lib/ir.ts#emptyTabBlocks`).
 *  NOT here: how a sheet's cells and kept lines are read (`xlsx.ts` from the OPC parts, `google-sheet.ts` from the
 *  Sheets API values), the format's own notices and counters (they come back through `SheetBody`), nor the grid itself
 *  (`sheet-grid.ts`).
 *  Called by: `extractor/xlsx.ts`, `extractor/google-sheet.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import {
  cutNoticeName,
  NO_CAP,
  type ReaderLimits,
  sheetUnreadableNotice,
  workbookCapNotice,
} from "doc-ir/lib/reader-limits";
import type { DocumentNotice } from "doc-ir/lib/reader-types";
import { emptyTabBlocks, type IRBlock, type IRTab } from "doc-ir/lib/ir";
import type { KeptLines } from "./sheet-grid";
import { spanSingleFirstRows } from "./span-single-first";

type Table = Extract<IRBlock, { kind: "table" }>;

/** The header a file DECLARES, in source rows (0-based). */
interface HeaderDeclaration {
  /** The last frozen row; undefined: no frozen pane. */
  readonly frozenRow?: number;
  /** Rows a table object marks as header. */
  readonly tableSpans: readonly { readonly start: number; readonly count: number }[];
}

/** A grid tab, read just enough to decide, then built. */
interface GridBody {
  readonly lines: KeptLines;
  /** Source rows hidden by the author (the frozen header abstains when one lies after the last kept row). */
  readonly hiddenRows: ReadonlySet<number>;
  /** Called only for a tab that is published (never for a withheld one). */
  readonly table: () => Table;
  readonly header: () => Promise<HeaderDeclaration>;
  /** Notices of a published grid tab (the format's own). */
  readonly notices?: () => DocumentNotice[];
}

export interface SheetBody {
  /** Absent: a chart-only tab (no grid). */
  readonly grid?: GridBody;
  /** Blocks under the table (charts, pictures), or the whole tab for a chart-only one. */
  readonly extras: () => Promise<IRBlock[]>;
}

export interface SheetSource {
  readonly name: string;
  /** False for a hidden or very hidden tab: its content is never read. */
  readonly visible: boolean;
  /** Reads the sheet; undefined: nothing to publish (unrecognised kind); "part-missing": the declared worksheet part is
   *  absent from the archive (said as `sheet-unreadable`, takes no tab slot). Called only below the tab cap. */
  readonly open: () => Promise<SheetBody | "part-missing" | undefined>;
}

/** The last published row at or above `frozen`, abstaining (undefined) when a hidden row lies after it, up to `frozen`:
 *  the hidden row may be the header the file means. `keptRows` ascending; only those and the hidden rows are visited. */
const findLastKeptRowAtOrAbove = (
  frozen: number,
  keptRows: readonly number[],
  hiddenRows: ReadonlySet<number>,
): number | undefined => {
  let last: number | undefined;
  for (let keptIndex = keptRows.length - 1; keptIndex >= 0; keptIndex--) {
    if (keptRows[keptIndex]! <= frozen) {
      last = keptRows[keptIndex];
      break;
    }
  }
  if (last === undefined) return undefined;
  for (const hidden of hiddenRows) if (hidden > last && hidden <= frozen) return undefined;
  return last;
};

const markHeaders = (table: Table, grid: GridBody, declared: HeaderDeclaration): void => {
  // Never walk row numbers (review 02/10/2026): the kept rows are few (<= MAX_SHEET_ROWS), the declared numbers come from
  // the file.
  const frozenHeader =
    declared.frozenRow === undefined
      ? undefined
      : findLastKeptRowAtOrAbove(declared.frozenRow, grid.lines.keptRows, grid.hiddenRows);
  grid.lines.keptRows.forEach((sourceRow, publishedRowIndex) => {
    const isHeader =
      sourceRow === frozenHeader ||
      declared.tableSpans.some((span) => sourceRow >= span.start && sourceRow < span.start + span.count);
    if (!isHeader || table.rows[publishedRowIndex] === undefined) return;
    table.rows[publishedRowIndex] = {
      cells: table.rows[publishedRowIndex].cells.map((cell) => ({ ...cell, header: true })),
    };
  });
};

/** The caps of a workbook page: the limits given, else the product's. */
const capsOf = (limits: ReaderLimits | undefined): { tabs: number; rows: number; cols: number } => ({
  tabs: limits?.workbookTabs ?? NO_CAP,
  rows: limits?.sheetRows ?? NO_CAP,
  cols: limits?.sheetCols ?? NO_CAP,
});

/** What one opened sheet gives: its blocks and the format's notices, or the notice of a withheld sheet. */
type SheetOutcome = { withheld: DocumentNotice } | { blocks: IRBlock[]; notices: DocumentNotice[] };

const buildSheetOutcome = async (
  name: string,
  body: SheetBody,
  caps: { rows: number; cols: number },
): Promise<SheetOutcome> => {
  const { grid } = body;
  if (grid === undefined) return { blocks: [...(await body.extras())], notices: [] };
  // Withheld is decided on the KEPT counts alone, before a single cell is materialized.
  const rows = grid.lines.keptRows.length;
  const cols = grid.lines.keptCols.length;
  if (rows > caps.rows || cols > caps.cols)
    return { withheld: { kind: "sheet-withheld", sheet: cutNoticeName(name), rows, cols } };
  const built = grid.table();
  markHeaders(built, grid, await grid.header());
  const notices = [...(grid.notices?.() ?? [])];
  return { blocks: [spanSingleFirstRows(built), ...(await body.extras())], notices };
};

/** The tabs of a workbook and the notices of what did not make the page (a withheld sheet, the sheets beyond the cap).
 *  A withheld sheet still occupies one of the tab slots although it carries no tab (29/09/2026: the dashboard says why). */
export const publishWorkbook = async (
  sheets: readonly SheetSource[],
  limits?: ReaderLimits,
): Promise<{ tabs: IRTab[]; notices: DocumentNotice[] }> => {
  const tabs: IRTab[] = [];
  const beyondCap: string[] = [];
  const unreadable: string[] = [];
  const notices: DocumentNotice[] = [];
  const caps = capsOf(limits);
  let withheldSlots = 0;
  for (const sheet of sheets) {
    if (!sheet.visible) continue;
    if (tabs.length + withheldSlots >= caps.tabs) {
      beyondCap.push(sheet.name);
      continue;
    }
    const body = await sheet.open();
    if (body === "part-missing") {
      unreadable.push(sheet.name);
      continue;
    }
    if (body === undefined) continue;
    const outcome = await buildSheetOutcome(sheet.name, body, caps);
    if ("withheld" in outcome) {
      withheldSlots++;
      notices.push(outcome.withheld);
      continue;
    }
    notices.push(...outcome.notices);
    tabs.push({ title: sheet.name, blocks: outcome.blocks.length > 0 ? outcome.blocks : emptyTabBlocks() });
  }
  // REFUSED, no page (06/11/2026): when the display caps withheld sheets and not one sheet is published, the workbook
  // is refused with our own code instead of being published as an empty page. An empty page was a mute document; nothing
  // is written on a page, « nothing visible » stays intact. The SAME decision as above: no second count. A workbook with
  // at least one published sheet goes out as before, numbering untouched.
  if (tabs.length === 0 && withheldSlots > 0)
    throw new ReaderError("NO_PUBLISHABLE_SHEET", "the workbook has no sheet that fits the page limits");
  if (beyondCap.length > 0) notices.push(workbookCapNotice(beyondCap));
  if (unreadable.length > 0) notices.push(sheetUnreadableNotice(unreadable));
  return { tabs, notices };
};
