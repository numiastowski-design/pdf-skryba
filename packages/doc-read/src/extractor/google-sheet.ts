/** A Google Sheet read through the Sheets API rather than exported: the
 *  displayed values, the merges, and the metadata that says which tabs exist
 *  — plus the `DocumentNotice[]` for what did NOT make the page (a withheld
 *  sheet, the sheets beyond the tab cap): kept OFF the page since lot A
 *  (docs/CONCEPTION-CARTE-ET-REMARQUES.md, 29/09/2026) — the dashboard shows
 *  them, never a published paragraph. A chart publishes its title alone.
 *  NOT here: the HTTP calls (`adapters/forge-drive.ts`), which rows and
 *  columns a tab keeps (`extractor/sheet-grid.ts`, shared with `xlsx.ts`),
 *  nor how a workbook becomes pages (`orchestrator/doc-processor.ts`).
 *  Called by: `extractor/dispatch.ts`; its metadata type is also the shape
 *  `ports/drive-content.ts` promises and `pipeline/source-reading-gsheet.ts`
 *  reads. */

/**
 * Google Sheets extractor (MIKSUDOC « Spécification technique » §5.4) — **not** `files.export`
 * (10 MB hard cap, and it renders a snapshot rather than "fidèle à
 * l'affichage"): the Sheets API v4 (`spreadsheets.get` for metadata/merges,
 * `values.get`/`values:batchGet` with `valueRenderOption=FORMATTED_VALUE`
 * for the displayed text, formula errors like `#DIV/0!` included verbatim —
 * a real one showed up in the live fixture, no special-casing needed, it's
 * just text). Pure, and — unlike every byte-parsing extractor in this
 * codebase — synchronous: there is no binary format to parse, just two
 * already-fetched API response shapes to fold into an IRDoc. Fetching them
 * is the caller's job (`adapters/forge-drive.ts`), same split as everywhere
 * else.
 *
 * One `tabs` IRBlock, one tab per visible sheet, mirroring `xlsx.ts` (same
 * caps, same slot count for a withheld sheet). A whole hidden tab
 * (`properties.hidden`) is dropped, matching `xlsx.ts`'s "fidèle à
 * l'affichage" rule — verified on the real fixture, which has one
 * ("Archive-Interne"), the exact Google Sheets equivalent of the .xlsx
 * twin's hidden tab.
 *
 * DATA-EXPOSURE GUARD (STATUS.md/l'historique git v0.6,
 * 31/08/2026, Gemini consultation, same finding as `xlsx.ts`'s own):
 * hidden rows/columns within an otherwise-visible tab are ignored too,
 * `rowMetadata[r].hiddenByUser`/`columnMetadata[c].hiddenByUser` — the
 * Sheets API v4's own field names for this, confirmed live against a real
 * spreadsheet (`c5-parent-probe.ts`, `sheets-hidden-field-probe`,
 * 31/08/2026) rather than assumed equivalent to SheetJS's `!rows`/`!cols`
 * shape, which Gemini correctly flagged as a different API with no
 * guaranteed equivalence.
 */

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
      /** Links a chart's GridRange back to its sheet (étape 10). Absent
       *  means 0: proto3 JSON omits a default value. */
      sheetId?: number;
      /** "GRID" or "OBJECT" — ABSENT means GRID (the pre-étape-10 answers
       *  carried none, and the adapter must keep reading their values). */
      sheetType?: string;
      gridProperties?: { frozenRowCount?: number };
    };
    merges?: { startRowIndex?: number; endRowIndex: number; startColumnIndex?: number; endColumnIndex: number }[];
    rowMetadata?: { hiddenByUser?: boolean; hiddenByFilter?: boolean }[];
    columnMetadata?: { hiddenByUser?: boolean }[];
    /** Cell links by SOURCE grid position (0-based), one per cell (`adapters/forge-drive.ts`). */
    links?: { row: number; col: number; uri: string }[];
    /** Embedded charts (étape 10: `sheets.charts.spec.title` joins the fields).
     *  A3 of docs/CONCEPTION-CARTE-ET-REMARQUES.md (Mikolaj, 29/09/2026):
     *  the chart's TITLE alone is published — no "Chart" word, no source
     *  range — so `basicChart.domains[].domain.sourceRange` (the GridRange
     *  the line used to resolve to A1 notation, étape 10/11) is gone from
     *  this type: the adapter's `fields` request asks for
     *  `sheets.charts.spec.title` alone (`adapters/forge-drive.ts`). */
    charts?: { spec?: { title?: string } }[];
  }[];
}

/** The kept grid of one tab: the SAME retreats as the `.xlsx` reader
 *  (`sheet-grid.ts`) — hidden and fully empty rows/columns out, edges AND
 *  interior, merges counting only the kept lines — all BEFORE the display
 *  caps (revue HIGH 29/09, constat 5: the caps read the raw grid, and a
 *  merge declared down to row 1000 widened it). Merge ranges are half-open
 *  [start, end) here, inclusive in `sheet-grid.ts`: converted once. */
const keptTableOf = (sheet: GoogleSheetMeta["sheets"][number], values: string[][]): { lines: KeptLines; build: () => Extract<IRBlock, { kind: "table" }> } => {
  const filled: [number, number][] = [];
  values.forEach((row, r) => row.forEach((text, c) => (text.length > 0 ? filled.push([r, c]) : undefined)));
  const lines = keptLinesOf(
    filled,
    (r) => sheet.rowMetadata?.[r]?.hiddenByUser === true || sheet.rowMetadata?.[r]?.hiddenByFilter === true, // ignored, same as a hidden tab (module doc)
    (c) => sheet.columnMetadata?.[c]?.hiddenByUser === true,
  );
  // proto3 JSON omits a field equal to its default: a merge starting at A1
  // carries no start index — it is 0 (same rule as `sheetId`, below).
  const merges = (sheet.merges ?? []).map((m) => ({ startRow: m.startRowIndex ?? 0, startCol: m.startColumnIndex ?? 0, endRow: m.endRowIndex - 1, endCol: m.endColumnIndex - 1 }));
  // Same rule as a .xlsx cell link: an internal form (« #gid=… ») stays plain text; the scheme filter is the renderer's.
  const linkAt = new Map<string, string>();
  for (const l of sheet.links ?? []) {
    const href = externalLinkTarget({ external: true, target: l.uri });
    if (href !== undefined) linkAt.set(`${l.row},${l.col}`, href);
  }
  return {
    lines,
    build: () =>
      tableOfKept(lines, merges, (r, c) => {
        const href = linkAt.get(`${r},${c}`);
        return { text: values[r]?.[c] ?? "", ...(href !== undefined ? { href } : {}) };
      }),
  };
};

export const extractGoogleSheet = async (meta: GoogleSheetMeta, valuesByTitle: Map<string, string[][]>, limits?: ReaderLimits): Promise<{ doc: IRDoc; notices: DocumentNotice[] }> => {
  // Fuzz finding, fixed 04/09/2026 (STATUS.md): `meta.sheets` missing/not an
  // array used to throw a raw, un-classified TypeError ("meta.sheets is not
  // iterable") — the outer sync loop (run-sync.ts) already catches any
  // exception so this never crashed a whole sync (P1/P3 were safe one layer
  // up), but it reclassified the failure as bare `UNKNOWN`, violating P2
  // ("un échec est toujours un échec nommé"). A malformed API response
  // shape is exactly the extraction failure this function exists to name.
  if (!Array.isArray(meta.sheets)) {
    throw new ReaderError("EXTRACT_FAILED", "google sheet metadata response has no sheets array");
  }
  // A3 of docs/CONCEPTION-CARTE-ET-REMARQUES.md (Mikolaj, 29/09/2026): the
  // chart's TITLE ALONE is published, as a plain paragraph — no "Chart"
  // word, no source range (the title is the document's own text, decision
  // (g); the range was technical). No title: nothing at all (reco of §1.3.3
  // — "sans titre, rien"). This ended the GridRange → A1 resolution this
  // function used to do (étape 10/11): dead code once nothing reads it, so
  // it is gone, not kept unused.
  const chartLinesOf = (sheet: GoogleSheetMeta["sheets"][number]): IRBlock[] =>
    (sheet.charts ?? []).flatMap((chart): IRBlock[] => {
      const title = chart.spec?.title;
      return title === undefined || title.length === 0 ? [] : [{ kind: "paragraph", inlines: [{ text: title }] }];
    });

  // ONE tabs block, the xlsx shape and caps (étape 11): `sheet-workbook.ts` applies the caps on the KEPT lines (a withheld
  // sheet carries no tab, A7 29/09/2026) and the one header rule. An OBJECT tab has no grid at all (the adapter never
  // fetched values): its tab carries its chart lines alone.
  // Rows a sheet filter hides that carry a value: dropped, said by count only (a row hidden by the user alone is expected, silent).
  let filteredRows = 0;
  const { tabs, notices: workbookNotices } = await publishWorkbook(
    [...meta.sheets]
      .sort((a, b) => a.properties.index - b.properties.index)
      .map((sheet): SheetSource => ({
        name: sheet.properties.title,
        visible: !sheet.properties.hidden,
        open: async (): Promise<SheetBody> => {
          const extras = async (): Promise<IRBlock[]> => chartLinesOf(sheet);
          if (sheet.properties.sheetType !== undefined && sheet.properties.sheetType !== "GRID") return { extras };
          const kept = keptTableOf(sheet, valuesByTitle.get(sheet.properties.title) ?? []);
          // The frozen pane's LAST row is the header (the one arbitration for every spreadsheet, Mikolaj 28/09/2026), in source rows.
          const frozen = sheet.properties.gridProperties?.frozenRowCount ?? 0;
          const hiddenRows = new Set<number>();
          const values = valuesByTitle.get(sheet.properties.title) ?? [];
          (sheet.rowMetadata ?? []).forEach((row, r) => {
            if (row.hiddenByUser === true || row.hiddenByFilter === true) hiddenRows.add(r);
            if (row.hiddenByFilter === true && (values[r] ?? []).some((text) => text.length > 0)) filteredRows++;
          });
          return {
            grid: { lines: kept.lines, hiddenRows, table: kept.build, header: async () => ({ ...(frozen >= 1 ? { frozenRow: frozen - 1 } : {}), tableSpans: [] }) },
            extras,
          };
        },
      })),
    limits,
  );
  const notices: DocumentNotice[] = [...workbookNotices, ...unpublishedPartNotices({ chartsWithheld: 0, imagesMissing: 0, filteredRows })];
  return { doc: { blocks: tabs.length > 0 ? [{ kind: "tabs", tabs }] : [] }, notices };
};
