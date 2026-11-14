/** The OPC inventory of a workbook: each tab's order, name, visibility state
 *  (`hidden`/`veryHidden`) and NATURE (worksheet or chartsheet), with its
 *  archive part path; plus, per sheet, which rows it DECLARES as header rows and
 *  which chart and picture parts its drawings anchor.
 *  NOT here: the cells themselves (`xlsx-cells.ts`), nor what gets
 *  published (`xlsx.ts` decides from this).
 *  Called by: `extractor/xlsx.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { attr, child, children, descendants, type XNode } from "./ooxml/xml";
import { type DocxPackage, internalTarget, openPackage } from "./ooxml/package";
import { parseCellRef, parseRange } from "./xlsx-cells";

export interface WorkbookSheet {
  name: string;
  /** ECMA-376 `sheet@state`, absent = visible. The ONE source of the
   *  hidden-tab guard: `xlsx.ts` publishes a tab only when this says
   *  `visible` (revue HIGH 29/09, constat 9 — SheetJS's own separate
   *  `Hidden` flag was never read even while it still parsed the grids;
   *  moot since its removal, 29/09/2026). */
  state: "visible" | "hidden" | "veryHidden";
  /** From the workbook relationship's type (its last path segment), the one
   *  place that says whether a tab is a grid or a chart-only tab. */
  kind: "worksheet" | "chartsheet" | "other";
  /** Archive path of the sheet's own part (`xl/worksheets/…`,
   *  `xl/chartsheets/…`) — where later reads (tables, drawings) start. */
  partPath: string;
}

const damagedWorkbook = (): ReaderError => new ReaderError("EXTRACT_FAILED", "the file is damaged or is not a valid Excel workbook");

/** The last row Excel can hold (ECMA-376 Part 1 §18.3.1.66 / Excel specifications and limits: 1,048,576 rows).
 *  A split or a table reaching past it is not a real declaration: ignored. */
const EXCEL_MAX_ROWS = 1_048_576;

/** A run of consecutive zero-based SOURCE rows a table declares as header. Never expanded row by row. */
export interface HeaderSpan {
  start: number;
  count: number;
}

/** What a sheet DECLARES as header (decision
 *  (d), never guessed from content). Mikolaj, 28/09/2026: « la ligne
 *  d'en-tête c'est la ligne d'en-tête » — applied as the file states it:
 *  - each Excel table part (`xl/tables/`) declares the first `headerRowCount`
 *    rows of its own `ref` (absent = 1, 0 = none; ECMA-376 Part 1 §18.5.1.2,
 *    `table@ref` and `table@headerRowCount`); several tables on one sheet each
 *    contribute their own span. The count is clamped to the ref's height; a ref
 *    past row 1,048,576 is ignored (revue 02/10/2026, S2: a count of 9,999,999
 *    used to build a ten-million-entry set). The count is read with `Number()`,
 *    so « 2.0 » declares where the same spelling of `ySplit` declares nothing
 *    (asymmetry written on 27/10/2026, tour 8; the control reading
 *    `pipeline/source-reading-xlsx.ts` shares it, so the two never disagree);
 *  - with no table declaring anything, a frozen pane declares its LAST frozen
 *    row. ISO/IEC 29500-1 §18.3.1.66 (`pane@ySplit`, `state="frozen"`; Microsoft
 *    Learn, DocumentFormat.OpenXml.Spreadsheet.Pane): ySplit is the number of
 *    rows visible in the top pane, which starts at `sheetView@topLeftCell` (row 1
 *    when absent) — so the last frozen row is that row + ySplit - 1.
 *    `pane@topLeftCell` is NOT used: it is the top-left cell of the BOTTOM pane,
 *    which scrolls independently of the split. ySplit is read only as a plain
 *    decimal integer in 1..1,048,576 (« 1e15 » or « 2.0 » declare nothing: the
 *    caller used to walk every row number down from it, S1).
 *    The real NDF freezes 8 rows but its column headers sit on row 6 (rows 7-8
 *    are empty, hence trimmed): `xlsx.ts` takes the last PUBLISHED row at or
 *    above `frozenRow`, and abstains if a hidden row lies in between;
 *  - nothing declared: none (a row is never promoted for its look).
 *  `tableSpans` and `frozenRow` are zero-based SOURCE rows.
 *  Limit: the mark covers the WHOLE published row, so a table narrower than
 *  the sheet marks the cells beside it too. `xlsx.ts` maps these source rows
 *  to published rows and abstains for one that is hidden or dropped. */
export async function declaredHeaderRows(pkg: DocxPackage, sheetPartPath: string, preParsed?: XNode): Promise<{ tableSpans: HeaderSpan[]; frozenRow?: number }> {
  // `preParsed` (revue HIGH 28/09 soir, constat 6): the caller read the part
  // once for everyone — a re-read costs CPU and double-counts the budget.
  const sheetXml = preParsed ?? (await pkg.readXml(sheetPartPath));
  if (!sheetXml) return { tableSpans: [] };
  const spans: HeaderSpan[] = [];
  if (child(sheetXml, "tableParts") !== undefined) {
    const rels = await pkg.relationships(sheetPartPath);
    for (const rel of rels.values()) {
      if (rel.kind !== "table" || rel.external) continue;
      const table = await pkg.readXml(rel.target);
      const range = table ? parseRange(attr(table, "ref")) : undefined;
      if (!table || !range || range.e.r >= EXCEL_MAX_ROWS) continue;
      const declared = attr(table, "headerRowCount");
      const count = declared === undefined ? 1 : Number(declared);
      if (!Number.isInteger(count) || count < 1) continue;
      spans.push({ start: range.s.r, count: Math.min(count, range.e.r - range.s.r + 1) });
    }
  }
  if (spans.length > 0) return { tableSpans: spans };
  for (const views of children(sheetXml, "sheetViews")) {
    for (const view of children(views, "sheetView")) {
      const pane = child(view, "pane");
      const ySplit = pane && attr(pane, "state") === "frozen" ? attr(pane, "ySplit") : undefined;
      if (ySplit === undefined || !/^\d{1,7}$/.test(ySplit)) continue;
      const split = Number(ySplit);
      if (split < 1 || split > EXCEL_MAX_ROWS) continue;
      const viewTop = parseCellRef(attr(view, "topLeftCell") ?? "A1");
      const lastFrozen = (viewTop?.r ?? 0) + split - 1;
      if (lastFrozen < EXCEL_MAX_ROWS) return { tableSpans: [], frozenRow: lastFrozen };
    }
  }
  return { tableSpans: [] };
}

/** The chart and picture parts a sheet (worksheet OR chartsheet) anchors,
 *  in drawing order: sheet XML `<drawing r:id>` → its drawing part → every
 *  `c:chart r:id` (charts) and every `xdr:pic`'s `a:blip r:embed`
 *  (pictures), resolved through the drawing's own relationships. ONE walk
 *  for both (revue HIGH 29/09, constat 10): two walks inflated and parsed
 *  each drawing part twice — double CPU, and double counted toward
 *  `PACKAGE_MAX_BYTES`. Missing or broken links are SKIPPED, never
 *  invented: a picture whose relationship is broken has nothing to
 *  publish, and is COUNTED (`unresolvedPictures`) like a chart. A chart frame whose relationship does not resolve is COUNTED
 *  (`unresolvedCharts`): the caller says it like a chart whose part is gone
 *  (Mikolaj, 07/10/2026: a missing part is said, in every format). */
export async function drawingPartsOf(
  pkg: DocxPackage,
  sheetPartPath: string,
  preParsed?: XNode,
): Promise<{ charts: string[]; pictures: string[]; unresolvedCharts: number; unresolvedPictures: number }> {
  const charts: string[] = [];
  const pictures: string[] = [];
  let unresolvedCharts = 0;
  let unresolvedPictures = 0;
  const sheetXml = preParsed ?? (await pkg.readXml(sheetPartPath));
  if (!sheetXml) return { charts, pictures, unresolvedCharts, unresolvedPictures };
  const sheetRels = await pkg.relationships(sheetPartPath);
  for (const drawing of descendants(sheetXml, "drawing", [])) {
    const drawingPart = internalTarget(sheetRels, attr(drawing, "r:id"));
    if (drawingPart === undefined) continue;
    const drawingXml = await pkg.readXml(drawingPart);
    if (!drawingXml) continue;
    const drawingRels = await pkg.relationships(drawingPart);
    for (const chartRef of descendants(drawingXml, "c:chart", [])) {
      const chartPart = internalTarget(drawingRels, attr(chartRef, "r:id"));
      if (chartPart !== undefined) charts.push(chartPart);
      else unresolvedCharts++;
    }
    for (const pic of descendants(drawingXml, "xdr:pic", [])) {
      for (const blip of descendants(pic, "a:blip", [])) {
        const embedPart = internalTarget(drawingRels, attr(blip, "r:embed"));
        if (embedPart !== undefined) pictures.push(embedPart);
        else unresolvedPictures++; // linked externally (r:link) or a relationship that does not resolve
      }
    }
  }
  return { charts, pictures, unresolvedCharts, unresolvedPictures };
}

/** The workbook's sheets in workbook order. The package is returned too:
 *  callers keep reading parts (drawings, tables, charts) without reopening.
 *  `workbookXml` is this call's own parse of `xl/workbook.xml`: a caller
 *  that also needs the workbook-wide tables (`xlsx-cells.ts#readWorkbookCells`)
 *  passes it back rather than triggering a second inflate of the same part
 *  (`xlsx.read-once.test.ts`). */
export async function readWorkbookSheets(bytes: Uint8Array): Promise<{ pkg: DocxPackage; sheets: WorkbookSheet[]; workbookXml: XNode }> {
  const pkg = await openPackage(bytes, damagedWorkbook);
  const workbook = await pkg.readXml(pkg.mainPart);
  if (!workbook) throw damagedWorkbook();
  const rels = await pkg.relationships(pkg.mainPart);

  const sheets: WorkbookSheet[] = [];
  for (const sheetsNode of children(workbook, "sheets")) {
    for (const sheet of children(sheetsNode, "sheet")) {
      const name = attr(sheet, "name");
      const relId = attr(sheet, "r:id");
      const rel = relId !== undefined ? rels.get(relId) : undefined;
      // A sheet row without a name or a resolvable part says the workbook is
      // not what it claims — skipping it silently would hide a tab (the
      // data-exposure guard reads THIS list), so the whole read refuses.
      if (name === undefined || rel === undefined || rel.external) throw damagedWorkbook();
      const state = attr(sheet, "state");
      sheets.push({
        name,
        state: state === "hidden" || state === "veryHidden" ? state : "visible",
        kind: rel.kind === "worksheet" || rel.kind === "chartsheet" ? rel.kind : "other",
        partPath: rel.target,
      });
    }
  }
  return { pkg, sheets, workbookXml: workbook };
}
