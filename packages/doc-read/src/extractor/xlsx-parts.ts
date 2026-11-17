/** The OPC inventory of a workbook: each tab's order, name, visibility state
 *  (`hidden`/`veryHidden`) and NATURE (worksheet or chartsheet), with its
 *  archive part path; plus, per sheet, which rows it DECLARES as header rows and
 *  which chart and picture parts its drawings anchor.
 *  Decides: a workbook whose sheet row has no name or no resolvable part is refused as damaged, never skipped
 *  (the hidden-tab guard reads this list); header rows are only what the file declares.
 *  NOT here: the cells themselves (`xlsx-cells.ts`), nor what gets published (`xlsx.ts` decides from this).
 *  Called by: `extractor/xlsx.ts`, `tools/bench/render.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { attributeOf, findChild, findChildren, findDescendants, type XNode } from "./ooxml/xml";
import { type OpcPackage, findInternalTarget, openPackage } from "./ooxml/package";
import { parseCellReference, parseCellRangeReference } from "./xlsx-cells";

export interface WorkbookSheet {
  readonly name: string;
  /** ECMA-376 `sheet@state`, absent = visible. The ONE source of the
   *  hidden-tab guard: `xlsx.ts` publishes a tab only when this says
   *  `visible`. */
  readonly state: "visible" | "hidden" | "veryHidden";
  /** From the workbook relationship's type (its last path segment), the one
   *  place that says whether a tab is a grid or a chart-only tab. */
  readonly kind: "worksheet" | "chartsheet" | "other";
  /** Archive path of the sheet's own part (`xl/worksheets/…`,
   *  `xl/chartsheets/…`) — where later reads (tables, drawings) start. */
  readonly partPath: string;
}

const createDamagedWorkbookError = (): ReaderError =>
  new ReaderError("EXTRACT_FAILED", "the file is damaged or is not a valid Excel workbook");

/** The last row number we accept in a declaration (1,048,576). A split or a table reaching past it is not a real
 *  declaration: ignored. Also the last row a chart's address may name (`xlsx-chart-reference.ts`). */
export const EXCEL_MAX_ROWS = 1_048_576;

/** The last column Excel can hold (16,384, XFD): a chart's address past it names nothing (`xlsx-chart-reference.ts`). */
export const EXCEL_MAX_COLUMNS = 16_384;

/** A run of consecutive zero-based SOURCE rows a table declares as header. Never expanded row by row. */
export interface HeaderSpan {
  readonly start: number;
  readonly count: number;
}

/** What a sheet DECLARES as header, never guessed from content (a row is never promoted for its look), applied as the
 *  file states it:
 *  - each Excel table part (`xl/tables/`) declares the first `headerRowCount`
 *    rows of its own `ref` (absent = 1, 0 = none; ECMA-376 Part 1 §18.5.1.2,
 *    `table@ref` and `table@headerRowCount`); several tables on one sheet each
 *    contribute their own span. The count is clamped to the ref's height; a ref
 *    past row 1,048,576 is ignored (a count of 9,999,999 used to build a
 *    ten-million-entry set, review 02/10/2026). The count is read with `Number()`,
 *    so « 2.0 » declares where the same spelling of `ySplit` declares nothing
 *    (asymmetry written 27/10/2026; the control reading `pipeline/source-reading-xlsx.ts`
 *    shares it, so the two never disagree);
 *  - with no table declaring anything, a frozen pane declares its LAST frozen
 *    row (ISO/IEC 29500-1 §18.3.1.66, `pane@ySplit` with `state="frozen"`): ySplit is the
 *    number of rows of the top pane, which starts at `sheetView@topLeftCell` (row 1
 *    when absent), so the last frozen row is that row + ySplit - 1.
 *    `pane@topLeftCell` is NOT used: it addresses the BOTTOM pane. ySplit is read
 *    only as a plain decimal integer in 1..1,048,576 (« 1e15 » or « 2.0 » declare
 *    nothing: the caller used to walk every row number down from it);
 *  - nothing declared: none.
 *  `tableSpans` and `frozenRow` are zero-based SOURCE rows. The frozen row may lie below the real header (empty rows
 *  are trimmed): `sheet-workbook.ts` takes the last PUBLISHED row at or above it and abstains if a hidden row lies in
 *  between.
 *  Limit: the mark covers the WHOLE published row, so a table narrower than
 *  the sheet marks the cells beside it too. `sheet-workbook.ts` maps these source rows
 *  to published rows and abstains for one that is hidden or dropped. */
export async function readDeclaredHeaderRows(
  opcPackage: OpcPackage,
  sheetPartPath: string,
  parsedSheetXml?: XNode,
): Promise<{ tableSpans: HeaderSpan[]; frozenRow?: number }> {
  // `parsedSheetXml`: the caller read the part once for everyone; a re-read costs CPU and counts against the budget twice.
  const sheetXml = parsedSheetXml ?? (await opcPackage.readXml(sheetPartPath));
  if (!sheetXml) return { tableSpans: [] };
  const spans = await tableHeaderSpansOf(opcPackage, sheetPartPath, sheetXml);
  if (spans.length > 0) return { tableSpans: spans };
  const frozenRow = frozenHeaderRowOf(sheetXml);
  return frozenRow === undefined ? { tableSpans: [] } : { tableSpans: [], frozenRow };
}

/** The header spans the Excel table parts of a sheet declare, in table order. */
const tableHeaderSpansOf = async (
  opcPackage: OpcPackage,
  sheetPartPath: string,
  sheetXml: XNode,
): Promise<HeaderSpan[]> => {
  const spans: HeaderSpan[] = [];
  if (findChild(sheetXml, "tableParts") === undefined) return spans;
  const relationships = await opcPackage.relationships(sheetPartPath);
  for (const relationship of relationships.values()) {
    if (relationship.kind !== "table" || relationship.external) continue;
    const table = await opcPackage.readXml(relationship.target);
    const range = table ? parseCellRangeReference(attributeOf(table, "ref")) : undefined;
    if (!table || !range || range.end.rowIndex >= EXCEL_MAX_ROWS) continue;
    const declared = attributeOf(table, "headerRowCount");
    const count = declared === undefined ? 1 : Number(declared);
    if (!Number.isInteger(count) || count < 1) continue;
    spans.push({ start: range.start.rowIndex, count: Math.min(count, range.end.rowIndex - range.start.rowIndex + 1) });
  }
  return spans;
};

/** The zero-based last frozen row of the first sheet view that declares a usable frozen pane; `undefined` when none does. */
const frozenHeaderRowOf = (sheetXml: XNode): number | undefined => {
  for (const views of findChildren(sheetXml, "sheetViews")) {
    for (const view of findChildren(views, "sheetView")) {
      const pane = findChild(view, "pane");
      const ySplit = pane && attributeOf(pane, "state") === "frozen" ? attributeOf(pane, "ySplit") : undefined;
      if (ySplit === undefined || !/^\d{1,7}$/.test(ySplit)) continue;
      const split = Number(ySplit);
      if (split < 1 || split > EXCEL_MAX_ROWS) continue;
      const viewTop = parseCellReference(attributeOf(view, "topLeftCell") ?? "A1");
      const lastFrozen = (viewTop?.rowIndex ?? 0) + split - 1;
      if (lastFrozen < EXCEL_MAX_ROWS) return lastFrozen;
    }
  }
  return undefined;
};

/** The chart and picture parts a sheet (worksheet OR chartsheet) anchors,
 *  in drawing order: sheet XML `<drawing r:id>` → its drawing part → every
 *  `c:chart r:id` (charts) and every `xdr:pic`'s `a:blip r:embed`
 *  (pictures), resolved through the drawing's own relationships. ONE walk
 *  for both: two walks inflated and parsed each drawing part twice, doubling
 *  the CPU and the bytes counted toward `PACKAGE_MAX_BYTES`. Missing or broken
 *  links are SKIPPED, never invented, and COUNTED (`unresolvedCharts`,
 *  `unresolvedPictures`): the caller says them like a part that is gone
 *  (07/10/2026: a missing part is said, in every format). */
export async function drawingPartsOf(
  opcPackage: OpcPackage,
  sheetPartPath: string,
  parsedSheetXml?: XNode,
): Promise<{ charts: string[]; pictures: string[]; unresolvedCharts: number; unresolvedPictures: number }> {
  const found: DrawingParts = { charts: [], pictures: [], unresolvedCharts: 0, unresolvedPictures: 0 };
  const sheetXml = parsedSheetXml ?? (await opcPackage.readXml(sheetPartPath));
  if (sheetXml) await collectSheetDrawings(opcPackage, sheetPartPath, sheetXml, found);
  return found;
}

/** What `drawingPartsOf` returns: the targets found, and how many references did not resolve. */
interface DrawingParts {
  charts: string[];
  pictures: string[];
  unresolvedCharts: number;
  unresolvedPictures: number;
}

/** Adds to `found` the chart and picture parts every `<drawing>` of a sheet anchors. */
const collectSheetDrawings = async (
  opcPackage: OpcPackage,
  sheetPartPath: string,
  sheetXml: XNode,
  found: DrawingParts,
): Promise<void> => {
  const sheetRelationships = await opcPackage.relationships(sheetPartPath);
  for (const drawing of findDescendants(sheetXml, "drawing", [])) {
    const drawingPart = findInternalTarget(sheetRelationships, attributeOf(drawing, "r:id"));
    if (drawingPart === undefined) continue;
    await collectDrawingParts(opcPackage, drawingPart, found);
  }
};

/** Adds to `found` the chart and picture parts one drawing part anchors. */
const collectDrawingParts = async (opcPackage: OpcPackage, drawingPart: string, found: DrawingParts): Promise<void> => {
  const drawingXml = await opcPackage.readXml(drawingPart);
  if (!drawingXml) return;
  const drawingRelationships = await opcPackage.relationships(drawingPart);
  for (const chartRef of findDescendants(drawingXml, "c:chart", [])) {
    const chartPart = findInternalTarget(drawingRelationships, attributeOf(chartRef, "r:id"));
    if (chartPart !== undefined) found.charts.push(chartPart);
    else found.unresolvedCharts++;
  }
  for (const pic of findDescendants(drawingXml, "xdr:pic", [])) {
    for (const blip of findDescendants(pic, "a:blip", [])) {
      const embedPart = findInternalTarget(drawingRelationships, attributeOf(blip, "r:embed"));
      if (embedPart !== undefined) found.pictures.push(embedPart);
      else found.unresolvedPictures++; // linked externally (r:link) or a relationship that does not resolve
    }
  }
};

/** The workbook's sheets in workbook order. The package is returned too:
 *  callers keep reading parts (drawings, tables, charts) without reopening.
 *  `workbookXml` is this call's own parse of `xl/workbook.xml`: a caller
 *  that also needs the workbook-wide tables (`xlsx-cells.ts#readSharedStringsAndStyles`)
 *  passes it back rather than triggering a second inflate of the same part
 *  (`xlsx.read-once.test.ts`). */
export async function readWorkbookSheets(
  bytes: Uint8Array,
): Promise<{ pkg: OpcPackage; sheets: WorkbookSheet[]; workbookXml: XNode }> {
  const opcPackage = await openPackage(bytes, createDamagedWorkbookError);
  const workbook = await opcPackage.readXml(opcPackage.mainPart);
  if (!workbook) throw createDamagedWorkbookError();
  const relationships = await opcPackage.relationships(opcPackage.mainPart);

  const sheets: WorkbookSheet[] = [];
  for (const sheetsNode of findChildren(workbook, "sheets")) {
    for (const sheet of findChildren(sheetsNode, "sheet")) sheets.push(workbookSheetOf(sheet, relationships));
  }
  return { pkg: opcPackage, sheets, workbookXml: workbook };
}

/** One `<sheet>` of the workbook, its part resolved through the workbook's relationships. */
const workbookSheetOf = (
  sheet: XNode,
  relationships: Awaited<ReturnType<OpcPackage["relationships"]>>,
): WorkbookSheet => {
  const name = attributeOf(sheet, "name");
  const relationshipId = attributeOf(sheet, "r:id");
  const relationship = relationshipId !== undefined ? relationships.get(relationshipId) : undefined;
  // A sheet row without a name or a resolvable part says the workbook is
  // not what it claims — skipping it silently would hide a tab (the
  // data-exposure guard reads THIS list), so the whole read refuses.
  if (name === undefined || relationship === undefined || relationship.external) throw createDamagedWorkbookError();
  const state = attributeOf(sheet, "state");
  return {
    name,
    state: state === "hidden" || state === "veryHidden" ? state : "visible",
    kind: relationship.kind === "worksheet" || relationship.kind === "chartsheet" ? relationship.kind : "other",
    partPath: relationship.target,
  };
};
