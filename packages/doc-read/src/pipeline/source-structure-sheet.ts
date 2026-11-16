/** The STRUCTURE of a sheet for the structure control (`docs/CONCEPTION-CONTROLE-STRUCTURE.md` section 3.3), shared by the workbook and the Google Sheet
 *  readings: a sheet that has a tab publishes ONE table (an addition of the page, `added.tables`) whose rows are the kept rows and whose cells are
 *  the kept rows times the columns that show a text, less the cells a merge covers AND less the cells the single-first-cell rule absorbs
 *  (`absorbedCells`, the independent MIRROR of `extractor/span-single-first.ts`, with its own reading of the declared header rows,
 *  `declaredHeaderRowsOf`) — `declared.rows`, `declared.cells`. A sheet with no row or no
 *  column left publishes no table. A workbook's charts are tables too, added whole (the table of a chart, `source-reading-chart.ts#chartReadOf`).
 *  NOT here: which sheets have a tab (`excludedUnits` of each reading), the words, comparing with the page (`pipeline/structure-conservation.ts`).
 *  Called by: `pipeline/source-reading-xlsx.ts`, `pipeline/source-reading-gsheet.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { resolveTarget } from "../extractor/ooxml/package";
import { emptyUnitStructure, type UnitStructure } from "./conservation-source";
import type { SheetCellsResolver } from "./source-chart-reference";
import { chartReadOf, type ChartShape } from "./source-reading-chart";
import { attrOf, kidsOf, tagOf, type N } from "./source-reading-package";

/** The structure of a sheet that has a tab. `rows`: kept rows; `shownColumns`: kept columns where some uncovered cell shows a text; `covered`: the
 *  cells of those columns a merge covers (published as no `td`); `absorbed`: the cells the page does not write because a row publishes as ONE
 *  cell (`absorbedCells`). */
export const sheetStructure = (grid: { rows: number; shownColumns: number; covered: number; absorbed?: number }): UnitStructure => {
  const unit = emptyUnitStructure();
  if (grid.rows === 0 || grid.shownColumns === 0) return unit;
  unit.declared.rows = grid.rows;
  unit.declared.cells = grid.rows * grid.shownColumns - grid.covered - (grid.absorbed ?? 0);
  unit.added.tables = 1;
  return unit;
};

/** What `absorbedCells` needs of a sheet's kept grid, in the numbering the caller uses for rows and columns (the same for every field). */
export interface SingleFirstGrid {
  /** Kept rows and columns, ascending. */
  keptRows: readonly number[];
  keptCols: readonly number[];
  /** The kept columns the page keeps (some uncovered cell shows a text). */
  shownCols: ReadonlySet<number>;
  /** Every covered cell (key `"row,col"`) with the row of the merge's anchor (`source-reading-table.ts#coveredByMerges`). */
  covered: ReadonlyMap<string, { rowNum: number }>;
  /** The UNCOVERED cells that publish a text beyond blanks. */
  texts: readonly { row: number; col: number }[];
  /** The kept rows the file declares as header (`declaredHeaderRowsOf`): they keep their cells. */
  headerRows: ReadonlySet<number>;
}

/** THE PAGE RULE OF 27/10/2026 (on the published page of FAQ_M365_Migration_CNE.xlsx), mirrored here on its own so the control keeps its two
 *  independent readings: a row whose only text is in the FIRST kept cell publishes as ONE cell spanning the table. The first integration shipped
 *  without this mirror and 9 real workbooks reported false « gap » decisions (found by review the same evening). Returns the cells such rows no
 *  longer write: for each, the cells it would have had in the shown columns, less the one it keeps.
 *  The rule never reads the extractor: a row is collapsed when the table is at least 2 wide, the row has at least 2 cells (uncovered kept columns),
 *  its first kept cell has text and no other uncovered cell does, it is not a declared header row, and no vertical merge covers or anchors it. */
/** What the merges of a grid say, per row: how many cells they cover, how many of those sit in a SHOWN column, and which rows
 *  a VERTICAL merge touches (covered or anchoring) — those rows are never collapsed. */
const mergeTally = (grid: SingleFirstGrid): { coveredInRow: Map<number, number>; coveredShownInRow: Map<number, number>; verticalRows: Set<number> } => {
  const coveredInRow = new Map<number, number>();
  const coveredShownInRow = new Map<number, number>();
  const verticalRows = new Set<number>();
  for (const [key, anchor] of grid.covered) {
    const [row, col] = key.split(",").map(Number) as [number, number];
    if (anchor.rowNum !== row) {
      verticalRows.add(row);
      verticalRows.add(anchor.rowNum);
    }
    coveredInRow.set(row, (coveredInRow.get(row) ?? 0) + 1);
    if (grid.shownCols.has(col)) coveredShownInRow.set(row, (coveredShownInRow.get(row) ?? 0) + 1);
  }
  return { coveredInRow, coveredShownInRow, verticalRows };
};
export const absorbedCells = (grid: SingleFirstGrid): number => {
  const nCols = grid.keptCols.length;
  const firstCol = grid.keptCols[0];
  if (nCols < 2 || firstCol === undefined) return 0;
  const { coveredInRow, coveredShownInRow, verticalRows } = mergeTally(grid);
  const first = new Set<number>();
  const others = new Set<number>();
  for (const t of grid.texts) (t.col === firstCol ? first : others).add(t.row);
  let absorbed = 0;
  for (const row of grid.keptRows) {
    if (!first.has(row) || others.has(row) || grid.headerRows.has(row) || verticalRows.has(row) || nCols - (coveredInRow.get(row) ?? 0) < 2) continue;
    absorbed += Math.max(0, grid.shownCols.size - (coveredShownInRow.get(row) ?? 0) - 1);
  }
  return absorbed;
};

/** The header a file DECLARES, in the numbering of the sheet's rows the caller uses: the last frozen row, and the rows an Excel table marks. */
export interface HeaderDeclaration {
  frozenRow?: number;
  tableSpans: readonly { start: number; count: number }[];
}

/** The kept rows the file declares as header, written on its own from `extractor/sheet-workbook.ts#markHeaders` (ISO/IEC 29500-1 §18.3.1.66 for the
 *  frozen pane, §18.5.1.2 for a table's `headerRowCount`; the Sheets API's `frozenRowCount`). A table span marks the kept rows inside it. A frozen pane
 *  marks the LAST KEPT row at or above its last frozen row, and ABSTAINS when a hidden row lies between that row and the frozen one (the hidden row
 *  may be the header the file means). `keptRows` ascending; only those and the hidden rows are visited, never the row numbers a file declares. */
export const declaredHeaderRowsOf = (keptRows: readonly number[], hiddenRows: ReadonlySet<number>, declared: HeaderDeclaration): Set<number> => {
  const out = new Set<number>();
  for (const row of keptRows) if (declared.tableSpans.some((span) => row >= span.start && row < span.start + span.count)) out.add(row);
  const frozen = declared.frozenRow;
  if (frozen === undefined) return out;
  let last: number | undefined;
  for (let i = keptRows.length - 1; i >= 0; i--) {
    if (keptRows[i]! <= frozen) {
      last = keptRows[i];
      break;
    }
  }
  if (last === undefined) return out;
  for (const hidden of hiddenRows) if (hidden > last && hidden <= frozen) return out;
  out.add(last);
  return out;
};

/** Chart frames read per sheet; past it the reading is refused (`check-failed` for the document), never a wrong count. */
export const MAX_SHEET_CHART_FRAMES = 200;

type XmlOf = (path: string) => Promise<N | undefined>;

const relsPathOf = (part: string): string => {
  const cut = part.lastIndexOf("/");
  return `${part.slice(0, cut)}/_rels/${part.slice(cut + 1)}.rels`;
};

/** The internal targets of a part's relationships, by id. */
const targetsOf = async (xmlOf: XmlOf, part: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const rels = await xmlOf(relsPathOf(part));
  for (const rel of rels ? kidsOf(rels) : []) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (id !== undefined && target !== undefined && attrOf(rel, "TargetMode") !== "External") out.set(id, resolveTarget(part, target));
  }
  return out;
};

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
const allOf = (n: N, tag: string, out: N[] = []): N[] => {
  for (const c of kidsOf(n)) {
    if (tagOf(c) === tag) out.push(c);
    else allOf(c, tag, out);
  }
  return out;
};

/** What a workbook's reading remembers, so a part is inflated and parsed once however many frames and sheets point at it. */
export interface ChartCache {
  /** The sheet part and the chart part it anchors (`chartShapeOf`'s key) to the table the page holds for it (`undefined`: withheld or damaged). */
  charts: Map<string, ChartShape | undefined>;
  /** Drawing part path to the chart part each of its `c:chart` frames points at, in order (`undefined`: a relationship that does not resolve). */
  drawings: Map<string, (string | undefined)[]>;
  /** The chart bounds the page was read under, so the control counts the same charts as withheld. */
  limits: ReaderLimits | undefined;
}

export const createChartCache = (limits?: ReaderLimits): ChartCache => ({ charts: new Map(), drawings: new Map(), limits });

/** A sheet anchors more chart frames than `MAX_SHEET_CHART_FRAMES`: the structure of the document is not read (never a wrong count). Stays
 *  `EXTRACT_FAILED`, not `FILE_UNSAFE` (25/10/2026): this is the second reading, which abstains on any error (`guardedSourceAsync`), so the
 *  code never reaches a row. */
export class ChartFramesOverBound extends ReaderError {
  constructor() {
    super("EXTRACT_FAILED", "too many chart frames on a sheet");
  }
}

/** The table of `chartPart` as anchored on the sheet `sheetPath`: keyed by both, as a cache-less chart reads the cells of the sheet that holds it. */
const chartShapeOf = async (xmlOf: XmlOf, at: { sheetPath: string; chartPart: string }, cache: ChartCache, resolver: SheetCellsResolver | undefined): Promise<ChartShape | undefined> => {
  const key = JSON.stringify([at.sheetPath, at.chartPart]);
  if (!cache.charts.has(key)) {
    const chart = await xmlOf(at.chartPart);
    cache.charts.set(key, chart === undefined ? undefined : chartReadOf(chart, cache.limits, resolver).shape);
  }
  return cache.charts.get(key);
};

/** The chart part each `c:chart` frame of a drawing points at, through the drawing's own relationships. Nothing of a chart is read here. */
const frameTargetsOf = async (xmlOf: XmlOf, drawingPart: string, cache: ChartCache): Promise<(string | undefined)[]> => {
  const known = cache.drawings.get(drawingPart);
  if (known !== undefined) return known;
  const drawingXml = await xmlOf(drawingPart);
  const targets = drawingXml === undefined ? new Map<string, string>() : await targetsOf(xmlOf, drawingPart);
  const refs = (drawingXml === undefined ? [] : allOf(drawingXml, "c:chart")).map((frame) => targets.get(attrOf(frame, "r:id") ?? ""));
  cache.drawings.set(drawingPart, refs);
  return refs;
};

/** The tables of the charts a sheet part (a worksheet or a chartsheet, parsed as `sheet`) anchors: the `drawing` parts its root names, their `c:chart`
 *  frames. A frame whose relationship does not resolve, a chart the page withholds whole, and a damaged part publish no table. The frames of the
 *  sheet are COUNTED before any chart part is read: more than `MAX_SHEET_CHART_FRAMES` throw `ChartFramesOverBound`. `resolver` reads the cells
 *  of the sheet for a chart whose file cached no value (`source-chart-reference.ts`); a chartsheet has none. */
export const chartShapesOf = async (xmlOf: XmlOf, sheetPath: string, sheet: N, cache: ChartCache, resolver?: SheetCellsResolver): Promise<ChartShape[]> => {
  const drawings = kidsOf(sheet).filter((c) => tagOf(c) === "drawing");
  if (drawings.length === 0) return [];
  const sheetTargets = await targetsOf(xmlOf, sheetPath);
  const frameTargets: (string | undefined)[] = [];
  for (const drawing of drawings) {
    const drawingPart = sheetTargets.get(attrOf(drawing, "r:id") ?? "");
    if (drawingPart === undefined) continue;
    for (const target of await frameTargetsOf(xmlOf, drawingPart, cache)) frameTargets.push(target);
    if (frameTargets.length > MAX_SHEET_CHART_FRAMES) throw new ChartFramesOverBound();
  }
  const shapes: ChartShape[] = [];
  for (const target of frameTargets) {
    const shape = target === undefined ? undefined : await chartShapeOf(xmlOf, { sheetPath, chartPart: target }, cache, resolver);
    if (shape !== undefined) shapes.push(shape);
  }
  return shapes;
};
