/** A Google Sheet read through the Sheets API rather than an export: the metadata and merges, and the DISPLAYED text of
 *  the cells (formula errors such as `#DIV/0!` are plain text, kept verbatim). It folds two already-fetched API response
 *  shapes into an IRDoc; no I/O here.
 *  Decides: one `tabs` block, one tab per visible sheet, the caps and the slot rule of `sheet-workbook.ts`; a hidden tab, and the
 *  rows and columns hidden by the user or by a filter, are dropped (data exposure, as in `xlsx.ts`); filter-hidden rows
 *  that hold a value are counted for the dashboard; a chart publishes its title alone; an OBJECT tab carries its chart
 *  lines only. The `DocumentNotice[]` (a withheld sheet, the sheets beyond the tab cap) stay OFF the page: the dashboard
 *  shows them.
 *  NOT here: the HTTP calls (`google-app/src/adapters/forge-drive.ts`), which rows and columns a tab keeps
 *  (`extractor/sheet-grid.ts`, shared with `xlsx.ts`), nor how a workbook becomes pages
 *  (`google-app/src/orchestrator/doc-processor.ts`).
 *  Called by: `extractor/dispatch.ts` (re-exported by `lib/docs.ts`); its metadata type is also the shape
 *  `google-app/src/ports/drive-content.ts` promises and `pipeline/source-reading-gsheet.ts` reads. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import type { DocumentNotice } from "doc-ir/lib/reader-types";
import type { IRBlock, IRDoc } from "doc-ir/lib/ir";
import { externalLinkTarget } from "doc-ir/lib/link-schemes";
import { keptLinesOf, tableOfKept, type KeptLines } from "./sheet-grid";
import { publishWorkbook, type SheetBody, type SheetSource } from "./sheet-workbook";

export interface GoogleSheetMeta {
  sheets: {
    properties: {
      title: string;
      index: number;
      hidden?: boolean;
      /** The sheet's id. Accepted so that a Sheets API response can be passed as is.
       *  @deprecated Never read by this reader; will leave the type at the next major version. */
      sheetId?: number;
      /** An absent type or "GRID" is a grid; any other (such as "OBJECT") is a chart-only tab. */
      sheetType?: string;
      gridProperties?: { frozenRowCount?: number };
    };
    merges?: { startRowIndex?: number; endRowIndex: number; startColumnIndex?: number; endColumnIndex: number }[];
    rowMetadata?: { hiddenByUser?: boolean; hiddenByFilter?: boolean }[];
    columnMetadata?: { hiddenByUser?: boolean }[];
    /** Cell links by SOURCE grid position (0-based), one per cell (`google-app/src/adapters/forge-drive.ts`). */
    links?: { row: number; col: number; uri: string }[];
    /** Embedded charts. Only a chart's TITLE is published (29/09/2026: no "Chart" word, no source range), so this type
     *  carries `spec.title` alone and the adapter requests that field alone (`google-app/src/adapters/forge-drive.ts`). */
    charts?: { spec?: { title?: string } }[];
  }[];
}

/** The kept grid of one tab: the SAME trimming as the `.xlsx` reader
 *  (`sheet-grid.ts`) — hidden and fully empty rows/columns out, edges AND
 *  interior, merges counting only the kept lines — all BEFORE the display
 *  caps (the caps once read the raw grid, and a merge declared down to row
 *  1000 widened it). Merge ranges are half-open [start, end) here, inclusive
 *  in `sheet-grid.ts`: converted once. */
const keptTableOf = (
  sheet: GoogleSheetMeta["sheets"][number],
  values: readonly (readonly string[])[],
): { lines: KeptLines; build: () => Extract<IRBlock, { kind: "table" }> } => {
  const filled: [number, number][] = [];
  values.forEach((row, rowIndex) =>
    row.forEach((text, colIndex) => (text.length > 0 ? filled.push([rowIndex, colIndex]) : undefined)),
  );
  const lines = keptLinesOf(
    filled,
    (rowIndex) =>
      sheet.rowMetadata?.[rowIndex]?.hiddenByUser === true || sheet.rowMetadata?.[rowIndex]?.hiddenByFilter === true, // dropped, same as a hidden tab
    (colIndex) => sheet.columnMetadata?.[colIndex]?.hiddenByUser === true,
  );
  // An absent start index is read as 0 (a merge starting at A1 may carry none).
  const merges = (sheet.merges ?? []).map((merge) => ({
    startRow: merge.startRowIndex ?? 0,
    startCol: merge.startColumnIndex ?? 0,
    endRow: merge.endRowIndex - 1,
    endCol: merge.endColumnIndex - 1,
  }));
  // Same rule as a .xlsx cell link: an internal form (« #gid=… ») stays plain text; the scheme filter is the renderer's.
  const hrefByPosition = new Map<string, string>();
  for (const link of sheet.links ?? []) {
    const href = externalLinkTarget({ external: true, target: link.uri });
    if (href !== undefined) hrefByPosition.set(`${link.row},${link.col}`, href);
  }
  return {
    lines,
    build: () =>
      tableOfKept(lines, merges, (rowIndex, colIndex) => {
        const href = hrefByPosition.get(`${rowIndex},${colIndex}`);
        return { text: values[rowIndex]?.[colIndex] ?? "", ...(href !== undefined ? { href } : {}) };
      }),
  };
};

// The chart's TITLE ALONE is published, as a plain paragraph (29/09/2026): no "Chart" word and no source range, the title
// being the document's own text and the range technical. No title: nothing at all (« sans titre, rien »).
const chartLinesOf = (sheet: GoogleSheetMeta["sheets"][number]): IRBlock[] =>
  (sheet.charts ?? []).flatMap((chart): IRBlock[] => {
    const title = chart.spec?.title;
    return title === undefined || title.length === 0 ? [] : [{ kind: "paragraph", inlines: [{ text: title }] }];
  });

/** The source rows hidden by the user or by a filter, and how many of the filter-hidden ones carry a value. */
const hiddenRowsOf = (
  sheet: GoogleSheetMeta["sheets"][number],
  values: readonly (readonly string[])[],
): { hiddenRows: Set<number>; filteredRows: number } => {
  const hiddenRows = new Set<number>();
  let filteredRows = 0;
  (sheet.rowMetadata ?? []).forEach((row, rowIndex) => {
    if (row.hiddenByUser === true || row.hiddenByFilter === true) hiddenRows.add(rowIndex);
    if (row.hiddenByFilter === true && (values[rowIndex] ?? []).some((text) => text.length > 0)) filteredRows++;
  });
  return { hiddenRows, filteredRows };
};

export const extractGoogleSheet = async (
  meta: GoogleSheetMeta,
  valuesByTitle: Map<string, string[][]>,
  limits?: ReaderLimits,
): Promise<{ doc: IRDoc; notices: DocumentNotice[] }> => {
  // A `meta.sheets` that is missing or not an array is named here as an extraction failure (fuzz finding, 04/09/2026): it
  // used to throw a raw TypeError, which the caller reclassified as a bare `UNKNOWN`, against the principle « un échec est
  // toujours un échec nommé ».
  if (!Array.isArray(meta.sheets)) {
    throw new ReaderError("EXTRACT_FAILED", "google sheet metadata response has no sheets array");
  }
  // ONE tabs block, the xlsx shape and caps: `sheet-workbook.ts` applies the caps on the KEPT lines (a withheld sheet
  // carries no tab, 29/09/2026) and the one header rule. An OBJECT tab has no grid at all (the adapter fetches no values
  // for it): its tab carries its chart lines alone.
  // Rows a sheet filter hides that carry a value: dropped, said by count only (a row hidden by the user alone is expected, silent).
  let filteredRows = 0;
  const { tabs, notices: workbookNotices } = await publishWorkbook(
    [...meta.sheets]
      .sort((earlier, later) => earlier.properties.index - later.properties.index)
      .map((sheet): SheetSource => ({
        name: sheet.properties.title,
        visible: !sheet.properties.hidden,
        open: async (): Promise<SheetBody> => {
          const extras = async (): Promise<IRBlock[]> => chartLinesOf(sheet);
          if (sheet.properties.sheetType !== undefined && sheet.properties.sheetType !== "GRID") return { extras };
          const kept = keptTableOf(sheet, valuesByTitle.get(sheet.properties.title) ?? []);
          // The frozen pane's LAST row is the header, in source rows (one rule for every spreadsheet reader, 28/09/2026).
          const frozenRowCount = sheet.properties.gridProperties?.frozenRowCount ?? 0;
          const values = valuesByTitle.get(sheet.properties.title) ?? [];
          const { hiddenRows, filteredRows: filteredRowsInSheet } = hiddenRowsOf(sheet, values);
          filteredRows += filteredRowsInSheet;
          return {
            grid: {
              lines: kept.lines,
              hiddenRows,
              table: kept.build,
              header: async () => ({
                ...(frozenRowCount >= 1 ? { frozenRow: frozenRowCount - 1 } : {}),
                tableSpans: [],
              }),
            },
            extras,
          };
        },
      })),
    limits,
  );
  const notices: DocumentNotice[] = [
    ...workbookNotices,
    ...unpublishedPartNotices({ chartsWithheld: 0, imagesMissing: 0, filteredRows }),
  ];
  return { doc: { blocks: tabs.length > 0 ? [{ kind: "tabs", tabs }] : [] }, notices };
};
