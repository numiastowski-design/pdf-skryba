/** The second, independent reading of a Google Sheet that becomes its
 *  conservation source (MIKSUDOC « Spécification technique » T11): one unit per sheet, read straight off the SAME Sheets API
 *  response the product already fetched (`extractor/google-sheet.ts`'s own
 *  `meta`/`valuesByTitle`) — there is only ONE source for a Google Sheet (no
 *  zip, no second HTTP round-trip), so independence here means never going
 *  through the extractor's OWN FOLD of that response into an `IRTab`
 *  (`extractGoogleSheet`, `keptTableOf`): this file re-derives the kept grid
 *  from `valuesByTitle` and `rowMetadata`/`columnMetadata[].hiddenByUser`
 *  DIRECTLY, never through `extractor/sheet-grid.ts#keptLinesOf` (that
 *  module also DECIDES what the extractor publishes, so importing it would
 *  let a shared bug pass its own check — same discipline as
 *  `source-reading-xlsx.ts`, MIKSUDOC « Spécification technique » T11:
 *  a second reading of the API response, not of the fold).
 *
 *  NO NUMBERS-AND-DATES LIMIT HERE, unlike xlsx (`source-reading-xlsx.ts`'s
 *  header): the Sheets API is fetched with `valueRenderOption=FORMATTED_VALUE`
 *  (`extractor/google-sheet.ts`'s own module doc), so EVERY cell — number,
 *  date, boolean, text alike — already arrives as the exact DISPLAY STRING
 *  the page publishes. There is no second formatter to duplicate or
 *  disagree with: this reading tokenises every non-empty string in
 *  `valuesByTitle` as-is, the same string production reads.
 *
 *  DECLARED removals (never read as tokens, mirroring lot D/E's pptx/xlsx
 *  readings — never from the page's remark wording):
 *   - a sheet past `MAX_WORKBOOK_TABS`, by this reading's own count of
 *     VISIBLE sheets (mirrors `extractGoogleSheet`'s own cap on visible
 *     sheets, withheld ones included);
 *   - a sheet whose KEPT grid (hidden rows/columns dropped, then empty rows/
 *     columns dropped) exceeds `MAX_SHEET_ROWS`/`MAX_SHEET_COLS`;
 *   - an OBJECT-type tab (`properties.sheetType !== "GRID"`): no grid was
 *     ever fetched for it (`extractGoogleSheet`'s own guard), so it carries
 *     no words to lose — excluded outright rather than left an ordinary
 *     empty unit, so a future OBJECT-tab word source is never silently
 *     absorbed as "nothing to check";
 *   - a hidden sheet (`properties.hidden`): still given a unit (its title is
 *     a technical id) but excluded whole and never counted toward the cap,
 *     matching `extractGoogleSheet`'s own guard.
 *  Hidden rows/columns WITHIN an otherwise-kept sheet are a plainer
 *  omission: their cells are simply never walked.
 *
 *  The same reading counts each sheet's STRUCTURE for the structure control (`source-structure-sheet.ts`: kept rows and cells).
 *
 *  NOT here: reading a .xlsx workbook (`pipeline/source-reading-xlsx.ts`),
 *  comparing this source against the published page
 *  (`pipeline/declared-format-conservation.ts`), the Sheets extractor itself
 *  (`extractor/google-sheet.ts`), fetching the API response
 *  (`adapters/forge-drive.ts`).
 *  Called by: `extractor/dispatch.ts`, for `google-sheet`. */

import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import type { GoogleSheetMeta } from "../extractor/google-sheet";
import { emptyUnitStructure, excludedUnitsOf, guardedSource, unitOf, type ConservationSourceReadFailure, type ConservationUnit, type DeclaredFormatConservationSource, type UnitStructure } from "./conservation-source";
import { absorbedCells, declaredHeaderRowsOf, sheetStructure } from "./source-structure-sheet";
import { coveredByMerges } from "./source-reading-table";

interface GsheetSheetReading {
  name: string;
  /** This sheet's cell words, in reading order (row-major, as the API gives
   *  them); empty for a sheet excluded below. */
  text: string;
  /** `properties.hidden`: never read, never counted toward `MAX_WORKBOOK_TABS`. */
  hidden: boolean;
  /** Past `MAX_WORKBOOK_TABS`, by this reading's own count of VISIBLE sheets. */
  overCap: boolean;
  /** `properties.sheetType` set and not `"GRID"`: no grid was ever fetched. */
  object: boolean;
  /** This reading's own KEPT grid (hidden lines out, then empty lines out)
   *  passes `MAX_SHEET_ROWS`/`MAX_SHEET_COLS`. */
  withheld: boolean;
  /** What the sheet declares of its structure and what the page adds (`source-structure-sheet.ts`); all zeros for a sheet without a tab. */
  structure: UnitStructure;
}

interface GsheetSourceReading {
  /** One entry per sheet `meta.sheets` declares, in `properties.index`
   *  order — the same order `extractGoogleSheet` publishes tabs in. */
  sheets: readonly GsheetSheetReading[];
}

/**
 * The source words, read independently off the already-fetched API
 * response: every non-empty string of a GRID sheet's `valuesByTitle` entry,
 * hidden rows/columns (`rowMetadata[].hiddenByUser`/`hiddenByFilter`, `columnMetadata[].hiddenByUser`) never
 * walked. See this file's header for the full rationale.
 */
/** The cells a sheet KEEPS: those with a text, outside a row or a column the author hid. A row hidden only by a hidden column
 *  stays dropped, same as the xlsx reading. */
const keptCellsOf = (
  sheet: GoogleSheetMeta["sheets"][number],
  values: readonly string[][],
): { keptRows: Set<number>; keptCols: Set<number>; candidates: { text: string; r: number; c: number }[] } => {
  const keptRows = new Set<number>();
  const keptCols = new Set<number>();
  const candidates: { text: string; r: number; c: number }[] = [];
  values.forEach((row, r) => {
    const rowHidden = sheet.rowMetadata?.[r]?.hiddenByUser === true || sheet.rowMetadata?.[r]?.hiddenByFilter === true;
    row.forEach((text, c) => {
      if (text.length === 0) return;
      const colHidden = sheet.columnMetadata?.[c]?.hiddenByUser === true;
      if (rowHidden || colHidden) return;
      keptRows.add(r);
      keptCols.add(c);
      candidates.push({ text, r, c });
    });
  });
  return { keptRows, keptCols, candidates };
};
/** The cells the page writes no more, mirrored for a Google Sheet: the header is the last frozen row
 *  (`gridProperties.frozenRowCount` - 1, rows from 0) read as a PUBLISHED row — the last kept row at or above it, abstaining
 *  when a hidden row lies between (`declaredHeaderRowsOf`). */
const absorbedOf = (
  sheet: GoogleSheetMeta["sheets"][number],
  grid: {
    keptRows: ReadonlySet<number>;
    keptCols: ReadonlySet<number>;
    shownColumns: ReadonlySet<number>;
    covered: ReadonlyMap<string, { rowNum: number }>;
    uncovered: readonly { text: string; r: number; c: number }[];
  },
): number => {
  const hiddenRows = new Set<number>();
  (sheet.rowMetadata ?? []).forEach((rowMeta, r) => {
    if (rowMeta.hiddenByUser === true || rowMeta.hiddenByFilter === true) hiddenRows.add(r);
  });
  const sortedRows = [...grid.keptRows].sort((a, b) => a - b);
  const frozen = sheet.properties.gridProperties?.frozenRowCount ?? 0;
  return absorbedCells({
    keptRows: sortedRows,
    keptCols: [...grid.keptCols].sort((a, b) => a - b),
    shownCols: grid.shownColumns,
    covered: grid.covered,
    texts: grid.uncovered.filter((t) => t.text.trim() !== "").map((t) => ({ row: t.r, col: t.c })),
    headerRows: declaredHeaderRowsOf(sortedRows, hiddenRows, { tableSpans: [], ...(frozen >= 1 ? { frozenRow: frozen - 1 } : {}) }),
  });
};
/** The reading of ONE grid sheet: its kept cells, the merges, and the structure the control compares — the page rule of
 *  27/10/2026 (a row whose only text is in its first cell publishes as ONE cell) mirrored here on its own, so the control
 *  keeps its two independent readings. */
const readGridSheet = (sheet: GoogleSheetMeta["sheets"][number], values: readonly string[][], limits: ReaderLimits | undefined): { text: string; withheld: boolean; structure: UnitStructure } => {
  const { keptRows, keptCols, candidates } = keptCellsOf(sheet, values);
  const withheld = keptRows.size > (limits?.sheetRows ?? NO_CAP) || keptCols.size > (limits?.sheetCols ?? NO_CAP);
  // Rule of Mikolaj, 09/10/2026: nothing invisible in the source is published NOR expected by the control
  // reading. A value left in a cell a merge covers is never shown, so only anchors and uncovered cells count.
  // Merge rule (ours, written twice, same as `sheet-grid.ts#tableOfKept`): a merge counts when its first cell
  // is kept and it spans more than one kept line; first merge wins; one anchored on an anchor or a covered cell
  // is ignored whole. The API ranges are half-open; `coveredByMerges` takes inclusive bounds, hence `end - 1` below.
  const covered: ReadonlyMap<string, { rowNum: number }> = withheld
    ? new Map<string, { rowNum: number }>()
    : coveredByMerges(
      (sheet.merges ?? []).map((m) => ({
      r1: m.startRowIndex ?? 0,
      c1: m.startColumnIndex ?? 0,
      r2: m.endRowIndex - 1,
      c2: m.endColumnIndex - 1,
      })),
      keptRows,
      keptCols,
    );
  const uncovered = candidates.filter((t) => !covered.has(`${t.r},${t.c}`));
  const texts = uncovered.map((t) => t.text);
  // The page keeps the columns where an uncovered cell shows a text (as the workbook's); the merge covers cells of those columns only.
  const shownColumns = new Set(uncovered.filter((t) => t.text.trim() !== "").map((t) => t.c));
  const coveredInShown = [...covered.keys()].filter((key) => shownColumns.has(Number(key.split(",")[1]))).length;
  // The page rule of 27/10/2026 (Mikolaj, FAQ_M365_Migration_CNE.xlsx): a row whose only text is in its first cell publishes as ONE cell. Mirrored
  // here on its own so the control keeps its two readings (the first integration shipped without this mirror and 9 real workbooks reported false
  // gaps, found by review the same evening). The header is the last frozen row (`gridProperties.frozenRowCount` - 1, in rows from 0), as a published row:
  // the last KEPT row at or above it, abstaining when a hidden row lies between (`declaredHeaderRowsOf`).
  const absorbed = withheld ? 0 : absorbedOf(sheet, { keptRows, keptCols, shownColumns, covered, uncovered });
  const structure = withheld ? emptyUnitStructure() : sheetStructure({ rows: keptRows.size, shownColumns: shownColumns.size, covered: coveredInShown, absorbed });
  return { text: withheld ? "" : texts.join(" "), withheld, structure };
};

const readGsheetSource = (meta: GoogleSheetMeta, valuesByTitle: ReadonlyMap<string, string[][]>, limits: ReaderLimits | undefined): GsheetSourceReading => {
  // Same guard `extractGoogleSheet` applies to the same malformed shape
  // (`core/errors.ts`'s "un échec est toujours un échec nommé" — here, a
  // named read failure via the caller's try/catch, never a raw TypeError).
  if (!Array.isArray(meta.sheets)) throw new Error("google sheet metadata response has no sheets array");

  const ordered = [...meta.sheets].sort((a, b) => a.properties.index - b.properties.index);
  const sheets: GsheetSheetReading[] = [];
  let visibleSoFar = 0;
  for (const sheet of ordered) {
    const name = sheet.properties.title;
    if (sheet.properties.hidden === true) {
      sheets.push({ name, text: "", hidden: true, overCap: false, object: false, withheld: false, structure: emptyUnitStructure() });
      continue;
    }
    if (visibleSoFar >= (limits?.workbookTabs ?? NO_CAP)) {
      sheets.push({ name, text: "", hidden: false, overCap: true, object: false, withheld: false, structure: emptyUnitStructure() });
      visibleSoFar++;
      continue;
    }
    visibleSoFar++;
    if (sheet.properties.sheetType !== undefined && sheet.properties.sheetType !== "GRID") {
      sheets.push({ name, text: "", hidden: false, overCap: false, object: true, withheld: false, structure: emptyUnitStructure() });
      continue;
    }
    const grid = readGridSheet(sheet, valuesByTitle.get(name) ?? [], limits);
    sheets.push({ name, text: grid.text, hidden: false, overCap: false, object: false, withheld: grid.withheld, structure: grid.structure });
  }
  return { sheets };
};

/**
 * The Google Sheet conservation source (MIKSUDOC « Spécification technique » T11, lot E): one unit per sheet the response declares, in
 * `properties.index` order. `deliberateRemovals` stays empty — the cap/
 * withhold/hidden/OBJECT facts become `excludedUnits` directly. A read that
 * cannot be trusted becomes a named failure instead of throwing through to
 * the caller: never a reason not to publish (Mikolaj, 21/09/2026).
 */
export function readGoogleSheetConservationSource(
  meta: GoogleSheetMeta,
  valuesByTitle: ReadonlyMap<string, string[][]>,
  limits?: ReaderLimits,
): DeclaredFormatConservationSource | ConservationSourceReadFailure {
  return guardedSource(() => {
    const { sheets } = readGsheetSource(meta, valuesByTitle, limits);
    const units: ConservationUnit[] = sheets.map((sheet) => unitOf(sheet.name, sheet.text));
    const excludedUnits = excludedUnitsOf(sheets, (sheet) => sheet.hidden || sheet.overCap || sheet.object || sheet.withheld);
    return { units, deliberateRemovals: [], excludedUnits, structure: { units: sheets.map((sheet) => sheet.structure), format: "gsheet" } };
  });
}
