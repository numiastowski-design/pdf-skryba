/** The workbook loop shared by the two spreadsheet readers: hidden sheets out, the workbook tab cap (`MAX_WORKBOOK_TABS`), the withheld-sheet slots,
 *  the per-sheet caps (`MAX_SHEET_ROWS` x `MAX_SHEET_COLS`) on the KEPT counts, ONE header rule (the LAST frozen row, plus declared table spans), the
 *  single-first-cell rows published as ONE full-width cell (`span-single-first.ts#spanSingleFirstRows`, applied here so both
 *  spreadsheet readers get it), the chart/picture blocks under the table, and ONE empty-tab rule (a tab with no block gets one empty paragraph, `lib/ir.ts#emptyTabBlocks`, the rule
 *  the pptx reader shares). Rows are counted in the SOURCE grid: a header frozen at source row N stays row N whatever empty or
 *  hidden rows precede it.
 *  NOT here: how a sheet's cells and kept lines are read (`xlsx.ts` from the OPC parts, `google-sheet.ts` from the
 *  Sheets API values), the format's own notices and counters (they come back through `SheetBody`), nor the grid itself
 *  (`sheet-grid.ts`).
 *  Called by: `extractor/xlsx.ts`, `extractor/google-sheet.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { cutNoticeName, NO_CAP, type ReaderLimits, sheetUnreadableNotice, workbookCapNotice } from "doc-ir/lib/reader-limits";
import type { DocumentNotice } from "doc-ir/lib/reader-types";
import { emptyTabBlocks, type IRBlock, type IRTab } from "doc-ir/lib/ir";
import type { KeptLines } from "./sheet-grid";
import { spanSingleFirstRows } from "./span-single-first";

type Table = Extract<IRBlock, { kind: "table" }>;

/** The header a file DECLARES, in source rows (0-based). */
interface HeaderDeclaration {
  /** The last frozen row; undefined: no frozen pane. */
  frozenRow?: number;
  /** Rows a table object marks as header. */
  tableSpans: readonly { start: number; count: number }[];
}

/** A grid tab, read just enough to decide, then built. */
interface GridBody {
  lines: KeptLines;
  /** Source rows hidden by the author (the frozen header abstains when one lies after the last kept row). */
  hiddenRows: ReadonlySet<number>;
  /** Called only for a tab that is published (never for a withheld one). */
  table: () => Table;
  header: () => Promise<HeaderDeclaration>;
  /** Notices of a published grid tab (the format's own). */
  notices?: () => DocumentNotice[];
}

export interface SheetBody {
  /** Absent: a chart-only tab (no grid). */
  grid?: GridBody;
  /** Blocks under the table (charts, pictures), or the whole tab for a chart-only one. */
  extras: () => Promise<IRBlock[]>;
}

export interface SheetSource {
  name: string;
  /** False for a hidden or very hidden tab: its content is never read. */
  visible: boolean;
  /** Reads the sheet; undefined: nothing to publish (unrecognised kind); "part-missing": the declared worksheet part is
   *  absent from the archive (said as `sheet-unreadable`, takes no tab slot). Called only below the tab cap. */
  open: () => Promise<SheetBody | "part-missing" | undefined>;
}

/** The last published row at or above `frozen`, abstaining (undefined) when a hidden row lies after it, up to `frozen`:
 *  the hidden row may be the header the file means. `keptRows` ascending; only those and the hidden rows are visited. */
const lastKeptRowAtOrAbove = (frozen: number, keptRows: readonly number[], hiddenRows: ReadonlySet<number>): number | undefined => {
  let last: number | undefined;
  for (let i = keptRows.length - 1; i >= 0; i--) {
    if (keptRows[i]! <= frozen) {
      last = keptRows[i];
      break;
    }
  }
  if (last === undefined) return undefined;
  for (const hidden of hiddenRows) if (hidden > last && hidden <= frozen) return undefined;
  return last;
};

const markHeaders = (table: Table, grid: GridBody, declared: HeaderDeclaration): void => {
  // Never walk row numbers (revue 02/10/2026, S1/S2): the kept rows are few (<= MAX_SHEET_ROWS), the declared numbers
  // come from the file.
  const frozenHeader = declared.frozenRow === undefined ? undefined : lastKeptRowAtOrAbove(declared.frozenRow, grid.lines.keptRows, grid.hiddenRows);
  grid.lines.keptRows.forEach((sourceRow, at) => {
    const isHeader = sourceRow === frozenHeader || declared.tableSpans.some((span) => sourceRow >= span.start && sourceRow < span.start + span.count);
    if (!isHeader || table.rows[at] === undefined) return;
    table.rows[at] = { cells: table.rows[at]!.cells.map((c) => ({ ...c, header: true })) };
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

const sheetOutcome = async (name: string, body: SheetBody, caps: { rows: number; cols: number }): Promise<SheetOutcome> => {
  const blocks: IRBlock[] = [];
  const notices: DocumentNotice[] = [];
  if (body.grid !== undefined) {
    // Withheld is decided on the KEPT counts alone, before a single cell is materialized.
    const rows = body.grid.lines.keptRows.length;
    const cols = body.grid.lines.keptCols.length;
    if (rows > caps.rows || cols > caps.cols) return { withheld: { kind: "sheet-withheld", sheet: cutNoticeName(name), rows, cols } };
    const built = body.grid.table();
    markHeaders(built, body.grid, await body.grid.header());
    notices.push(...(body.grid.notices?.() ?? []));
    blocks.push(spanSingleFirstRows(built));
  }
  blocks.push(...(await body.extras()));
  return { blocks, notices };
};

/** The tabs of a workbook and the notices of what did not make the page (a withheld sheet, the sheets beyond the cap).
 *  A withheld sheet still occupies one of the tab slots although it carries no tab (A7 of
 *  docs/CONCEPTION-CARTE-ET-REMARQUES.md, 29/09/2026: the dashboard says why). */
export const publishWorkbook = async (sheets: readonly SheetSource[], limits?: ReaderLimits): Promise<{ tabs: IRTab[]; notices: DocumentNotice[] }> => {
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
    const outcome = await sheetOutcome(sheet.name, body, caps);
    if ("withheld" in outcome) {
      withheldSlots++;
      notices.push(outcome.withheld);
      continue;
    }
    notices.push(...outcome.notices);
    tabs.push({ title: sheet.name, blocks: outcome.blocks.length > 0 ? outcome.blocks : emptyTabBlocks() });
  }
  // REFUSED, no page (Mikolaj, 06/11/2026): when the display caps withheld sheets and not one sheet is published, the workbook
  // is refused with our own code instead of being published as an empty page (28 of 68 real workbooks). An empty page was a
  // mute document; nothing is written on a page, « nothing visible » stays intact. The SAME decision as above: no second
  // count. A workbook with at least one published sheet goes out as before, numbering untouched.
  if (tabs.length === 0 && withheldSlots > 0) throw new ReaderError("NO_PUBLISHABLE_SHEET", "the workbook has no sheet that fits the page limits");
  if (beyondCap.length > 0) notices.push(workbookCapNotice(beyondCap));
  if (unreadable.length > 0) notices.push(sheetUnreadableNotice(unreadable));
  return { tabs, notices };
};
