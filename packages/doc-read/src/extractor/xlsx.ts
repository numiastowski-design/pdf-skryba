/** A .xlsx workbook turned into ONE tabs block, one native tab per published sheet, read through our own OPC and cell
 *  readers (ECMA-376 Part 1 §18).
 *  Decides what is PUBLISHED: a hidden or very hidden tab, hidden rows and columns and fully empty rows and columns are
 *  left out, and so are the rows an `<autoFilter>` hides (counted, `filtered-rows`). The reason is data exposure: a
 *  hidden salary column or a hidden row of draft figures must never reach the readers of the Confluence space. A hidden
 *  tab's part is never read. Cell text is written by OUR number formatter; the language of numbers, dates and booleans
 *  comes from a bounded sample of the cell texts of visible sheets, rows and columns. Display caps and formula cells without a cached value are
 *  not said on the page: they come back as `notices` for the dashboard. A chart whose file cached no value is drawn from the sheet that holds it
 *  (`chartResolverOf`).
 *  NOT here: the OPC inventory and part walks (`xlsx-parts.ts`), the cells (`xlsx-cells.ts`), the format codes
 *  (`xlsx-number-format.ts`), the tab loop and caps (`sheet-workbook.ts`), the chart reader
 *  (`pptx-reader/chart.ts`), the addresses a chart reads from its sheet (`xlsx-chart-reference.ts`), image reduction (`image-collector.ts`).
 *  Called by: `extractor/dispatch.ts` (re-exported by `lib/docs.ts`), `tools/bench/render.ts`, `tools/ooxml-output-hash.ts`. */

import { cutNoticeName, NO_CAP, type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import type { DocumentNotice, PageLanguage } from "doc-ir/lib/reader-types";
import { detectLanguageFromSample } from "doc-ir/pipeline/detect-language";
import { type ImageRef, type Inline, type IRBlock, type IRDoc } from "doc-ir/lib/ir";
import type { RawImage } from "doc-ir/extractor/raw-image";
import { listedMimeType } from "../lib/mime-types";
import { ImageCollector } from "./image-collector";
import { chartToIr, readChartOrWithheld } from "./pptx-reader/chart";
import { sheetChartResolver, type ChartResolver } from "./xlsx-chart-reference";
import { IMAGE_MAX_TOTAL_BYTES, readUnlessDamaged, type OpcPackage } from "./ooxml/package";
import { attributeOf, findChild, type XNode } from "./ooxml/xml";
import { selectBuiltinNumFmt14, formatNumberCell, isHiddenTextFormatCode } from "./xlsx-number-format";
import { keptLinesOf, tableOfKept, type KeptLines } from "./sheet-grid";
import { publishWorkbook, type SheetBody, type SheetSource } from "./sheet-workbook";
import { drawingPartsOf, readWorkbookSheets, readDeclaredHeaderRows, type WorkbookSheet } from "./xlsx-parts";
import {
  LANGUAGE_SAMPLE_CHARS,
  formatCellReference,
  isColumnHidden,
  findExternalHyperlinkTargetAt,
  parseCellReference,
  parseCellRangeReference,
  readWorksheetCells,
  readSharedStringsAndStyles,
  type WorksheetCell,
  type WorksheetCells,
  type SharedStringsAndStyles,
} from "./xlsx-cells";

/** The word a boolean cell shows in the document's language. */
const writeBooleanWord = (value: boolean, language: PageLanguage): string => {
  if (language === "fr") return value ? "VRAI" : "FAUX";
  return value ? "TRUE" : "FALSE";
};

/** The cell's display text, written by OUR formatter: `xlsx-cells.ts` gives the raw value and format code, and
 *  `xlsx-number-format.ts` writes the text; a code the formatter does not write publishes the stored number as text. An
 *  error cell keeps the text the file itself writes (`#DIV/0!` is not a number format). Built-in format 14 is read BY
 *  ID (`cell.isBuiltinNumFmt14`), never by the literal code string: we write it as the short date of the document's
 *  language (`xlsx-number-format.ts#selectBuiltinNumFmt14`). Numbers, dates and booleans are written in that language
 *  (`language`). */
const writeCellText = (cell: WorksheetCell, date1904: boolean, language: PageLanguage): string => {
  const { value, formatCode: format } = cell;
  // LIMIT (written 06/11/2026), TRUNCATED TEXT: we publish the WHOLE value of a text cell, even where a spreadsheet
  // application would clip it on screen. Chosen bias: ugly and visible rather than wrong and invisible; cutting it would
  // lose words, the defect that matters most here. Not a defect to fix.
  // LIMIT (written 06/11/2026), FORMULA ERRORS: an error cell (`#DIV/0!`, `#REF!`...) keeps the text the file writes. This
  // behaviour is NOT proven on a real case: no specimen has been examined, and no case is fabricated (a corpus we make only
  // calibrates our own habits). The first real specimen decides.
  switch (value.t) {
    case "e":
      return value.v;
    case "b":
      return writeBooleanWord(value.v, language);
    case "n": {
      const code = cell.isBuiltinNumFmt14 ? selectBuiltinNumFmt14(language) : format;
      return formatNumberCell(value.v, code, date1904, language) ?? String(value.v);
    }
    case "s":
      // A text cell under a hide-in-place format (`;;;`) is written empty: publishing it raw would expose what the
      // author chose not to show.
      return isHiddenTextFormatCode(format) ? "" : value.v;
    default:
      // Exhaustive: `value` is `never`, so a new cell value type does not compile until it is handled above. Only
      // `readCellValue` in `xlsx-cells.ts` builds a cell value, and it builds the four types above.
      throw new Error("writeCellText: a cell value of an unknown type");
  }
};

/** The PUBLISHED grid of a sheet, before any cell is materialized: the kept
 *  rows and columns (hidden and fully empty ones out, `sheet-grid.ts`), and
 *  the text of the cells that show something. The withheld decision (the
 *  sheet row and column caps) reads THESE counts alone: building and formatting
 *  a 100 000-row grid just to discard it was the whole cost. Only the cells
 *  `xlsx-cells.ts` actually HOLDS are walked, never a declared range. */
export interface KeptGrid extends KeptLines {
  /** The cells that show something (row, column), hidden rows and columns out. */
  filledCells: readonly (readonly [number, number])[];
  textAt: (rowIndex: number, colIndex: number) => string;
  boldAt: (rowIndex: number, colIndex: number) => boolean;
}

export const keptGridOf = (sheet: WorksheetCells, date1904: boolean, language: PageLanguage): KeptGrid => {
  // row → column → text: numeric keys, no cell reference string built per lookup.
  const texts = new Map<number, Map<number, string>>();
  const filled: [number, number][] = [];
  // row → bold columns: numeric keys like `texts` (a whole bold sheet would otherwise build one string per cell).
  const bold = new Map<number, Set<number>>();
  for (const [cellReference, cell] of sheet.cells) {
    const address = parseCellReference(cellReference);
    if (!address) continue; // reached by a cell stored without `r` past row 9,999,999 or column ZZZ: `formatCellReference` writes a key `parseCellReference` refuses
    // A cell in a hidden row or column is dropped whatever it shows, and never formatted.
    if (sheet.hiddenRows.has(address.rowIndex) || isColumnHidden(sheet, address.columnIndex)) continue;
    const text = writeCellText(cell, date1904, language);
    if (text.length === 0) continue;
    let row = texts.get(address.rowIndex);
    if (row === undefined) texts.set(address.rowIndex, (row = new Map<number, string>()));
    row.set(address.columnIndex, text);
    if (cell.isBold) {
      let boldRow = bold.get(address.rowIndex);
      if (boldRow === undefined) bold.set(address.rowIndex, (boldRow = new Set()));
      boldRow.add(address.columnIndex);
    }
    filled.push([address.rowIndex, address.columnIndex]);
  }
  const lines = keptLinesOf(
    filled,
    (rowIndex) => sheet.hiddenRows.has(rowIndex),
    (colIndex) => isColumnHidden(sheet, colIndex),
  );
  return {
    ...lines,
    filledCells: filled,
    textAt: (rowIndex, colIndex) => texts.get(rowIndex)?.get(colIndex) ?? "",
    boldAt: (rowIndex, colIndex) => bold.get(rowIndex)?.has(colIndex) ?? false,
  };
};

/** The resolver a chart held by this sheet reads its values with when the file cached none (`xlsx-chart-reference.ts`): the published grid's
 *  text, and the stored number and format of a numeric cell. */
export const chartResolverOf = (sheetName: string, sheet: WorksheetCells, grid: KeptGrid): ChartResolver =>
  sheetChartResolver(sheetName, {
    filledCells: grid.filledCells,
    textAt: grid.textAt,
    numberAt: (rowIndex, colIndex) => {
      const cell = sheet.cells.get(formatCellReference(rowIndex, colIndex));
      return cell?.value.t === "n" ? { value: cell.value.v, formatCode: cell.formatCode } : undefined;
    },
  });

/** Rows the sheet's `<autoFilter>` hides, below the filter's header row, that hold a cell showing something: left out of the
 *  page, counted so the document says it. A hidden row outside the filter range or without any text is not counted. */
const filteredRowsOf = (sheet: WorksheetCells, sheetXml: XNode, date1904: boolean, language: PageLanguage): number => {
  if (sheet.hiddenRows.size === 0) return 0;
  const range = parseCellRangeReference(attributeOf(findChild(sheetXml, "autoFilter") ?? {}, "ref"));
  if (!range) return 0;
  const rowsWithText = new Set<number>();
  for (const [cellReference, cell] of sheet.cells) {
    const address = parseCellReference(cellReference);
    // `address` is undefined for the same keys as in `keptGridOf`.
    if (
      !address ||
      rowsWithText.has(address.rowIndex) ||
      address.rowIndex <= range.start.rowIndex ||
      address.rowIndex > range.end.rowIndex ||
      !sheet.hiddenRows.has(address.rowIndex)
    )
      continue;
    if (writeCellText(cell, date1904, language).length > 0) rowsWithText.add(address.rowIndex);
  }
  return rowsWithText.size;
};

const buildSheetTable = (sheet: WorksheetCells, grid: KeptGrid): Extract<IRBlock, { kind: "table" }> => {
  const merges = sheet.mergeCells.map((merge) => ({
    startRow: merge.start.rowIndex,
    startCol: merge.start.columnIndex,
    endRow: merge.end.rowIndex,
    endCol: merge.end.columnIndex,
  }));
  return tableOfKept(grid, merges, (rowIndex, colIndex): Inline => {
    const text = grid.textAt(rowIndex, colIndex);
    // Only `findExternalHyperlinkTargetAt` is used: a cell link's EXTERNAL target is published raw (the scheme filter lives in one
    // place, the renderer, and is not copied here), while a file's own internal form (`#'Sheet'!A1`) is refused: it must
    // never reach the renderer's internal link handling. A cross-sheet link becomes plain text (a written limit).
    const href = findExternalHyperlinkTargetAt(sheet, rowIndex, colIndex);
    return {
      text,
      ...(href !== undefined ? { href } : {}),
      ...(grid.boldAt(rowIndex, colIndex) ? { marks: ["strong" as const] } : {}),
    };
  });
};

/** The sheet parts and cells read ahead for the language sample, kept until their sheet opens: one inflate per part, and a sheet's cells are built once. */
interface ReadAhead {
  readonly preparsed: Map<string, Promise<XNode | undefined>>;
  readonly prebuilt: Map<string, WorksheetCells>;
}

/** What the language sample reads from. */
interface LanguageSource {
  readonly inventory: readonly WorkbookSheet[];
  readonly opcPackage: OpcPackage;
  readonly workbook: SharedStringsAndStyles;
  readonly limits: ReaderLimits | undefined;
  readonly readAhead: ReadAhead;
}

/** The text sampled for language detection, and its length counted so far. */
interface LanguageSample {
  readonly texts: string[];
  chars: number;
}

/** Adds the shared-string cells a sheet publishes to the sample, up to the sample bound. */
const addSheetTexts = (sheet: WorksheetCells, sample: LanguageSample): void => {
  for (const [cellReference, cell] of sheet.cells) {
    if (sample.chars >= LANGUAGE_SAMPLE_CHARS) break;
    if (cell.value.t !== "s") continue;
    const address = parseCellReference(cellReference);
    if (!address || sheet.hiddenRows.has(address.rowIndex) || isColumnHidden(sheet, address.columnIndex)) continue;
    sample.texts.push(cell.value.v);
    sample.chars += cell.value.v.length + 1;
  }
};

// Language of the numbers, dates and booleans: a format code naming its language wins (`xlsx-number-format.ts`); else the
// language OF THE DOCUMENT, detected from a bounded sample of its cell texts (French or English only); else the page
// language. An omitted `pageLanguage` (direct callers) skips detection and keeps the English default.
// The sample is the text of cells in visible sheets, rows and columns only (« Rien d'invisible »): no hidden sheet, row or column, no
// unreferenced string. It is taken before the display caps and reads no format code.
const documentLanguageOf = async (
  pageLanguage: PageLanguage | undefined,
  source: LanguageSource,
): Promise<PageLanguage> => {
  if (pageLanguage === undefined) return "en";
  const { inventory, opcPackage, workbook, limits, readAhead } = source;
  const sample: LanguageSample = { texts: [], chars: 0 };
  let visibleSheetCount = 0; // the sheets the tab cap can open: no more are read ahead
  for (const sheetInfo of inventory) {
    if (sample.chars >= LANGUAGE_SAMPLE_CHARS) break;
    if (sheetInfo.state !== "visible") continue;
    if (visibleSheetCount >= (limits?.workbookTabs ?? NO_CAP)) break;
    // The sample slots mirror the publish path (`open()` below): an unrecognised kind or a worksheet whose part is GONE gets
    // no tab, so it takes no sample slot either (counting it once dropped from the sample a sheet the page does publish,
    // review 27/10/2026). A chartsheet takes its slot but has no cells to sample.
    if (sheetInfo.kind === "chartsheet") {
      visibleSheetCount++;
      continue;
    }
    if (sheetInfo.kind !== "worksheet") continue;
    const ahead = opcPackage.readXml(sheetInfo.partPath);
    ahead.catch(() => undefined); // a damaged part is reported by the sheet's own open(), as before
    readAhead.preparsed.set(sheetInfo.partPath, ahead);
    const sheetXml = await ahead.catch(() => undefined);
    if (sheetXml === undefined) continue;
    visibleSheetCount++;
    const sheet = await readWorksheetCells(opcPackage, sheetInfo.partPath, sheetXml, workbook).catch(() => undefined);
    if (sheet === undefined) continue;
    readAhead.prebuilt.set(sheetInfo.partPath, sheet);
    addSheetTexts(sheet, sample);
  }
  const detected = detectLanguageFromSample(sample.texts.join("\n"));
  return detected === "fr" || detected === "en" ? detected : pageLanguage;
};

/** Reads a workbook into its tabs document, its pictures and the notices for the dashboard. */
export const extractXlsx = async (
  bytes: Uint8Array,
  pageLanguage?: PageLanguage,
  limits?: ReaderLimits,
): Promise<{ doc: IRDoc; images: RawImage[]; notices: DocumentNotice[] }> => {
  // The OPC inventory comes FIRST: opening the package is where a password-protected or legacy binary workbook is
  // refused with a named error, before any other read.
  const { pkg, sheets: inventory, workbookXml } = await readWorkbookSheets(bytes);
  // The workbook-wide tables (shared strings, style formats, date system):
  // ONE read for the whole workbook, shared by every sheet below.
  // `workbookXml` is `readWorkbookSheets`'s own parse of `xl/workbook.xml` —
  // passed back rather than re-read (`xlsx.read-once.test.ts`).
  const workbook = await readSharedStringsAndStyles(pkg, workbookXml);

  // Sheet parts parsed ahead for the language sample are kept here until their sheet opens: one inflate per part.
  const preparsed = new Map<string, Promise<XNode | undefined>>();
  // The cells built for that sample are kept with them: a sheet's cells are built once.
  const prebuilt = new Map<string, WorksheetCells>();
  const readSheetXml = (sheetPartPath: string): Promise<XNode | undefined> => {
    const ahead = preparsed.get(sheetPartPath);
    if (ahead === undefined) return pkg.readXml(sheetPartPath);
    preparsed.delete(sheetPartPath);
    return ahead;
  };

  const language = await documentLanguageOf(pageLanguage, {
    inventory,
    opcPackage: pkg,
    workbook,
    limits,
    readAhead: { preparsed, prebuilt },
  });

  // ONE tabs block, a sheet being a native tab: the shape the presentations also deliver. The caps are DISPLAY caps counted
  // AFTER the trimming of hidden and empty lines; the sheets beyond the tab cap are named to the dashboard (`workbook-cap`
  // notice). Charts are read through the pptx chart reader: title and cached data table, under the sheet's own table.
  let chartsWithheld = 0;
  let imagesMissing = 0;
  let filteredRows = 0;
  const chartBlocksOf = async (
    chartParts: readonly string[],
    unresolved = 0,
    resolver?: ChartResolver,
  ): Promise<IRBlock[]> => {
    const blocks: IRBlock[] = [];
    chartsWithheld += unresolved; // a chart frame with no resolvable relationship: said like a missing part
    for (const chartPart of chartParts) {
      // A damaged chart part is left out and the sheets stay published, as in the pptx reader (audit 07/10/2026).
      const { block, withheld } = chartToIr(
        await readChartOrWithheld(pkg, chartPart, { picture: false, limits, resolver }),
      );
      if (withheld)
        chartsWithheld++; // kept out (damaged part or a bound): said, one folded notice
      else if (block) blocks.push(block);
    }
    return blocks;
  };

  // Anchored pictures: image blocks UNDER the table, never with alt text, through the shared collector (which also
  // reduces oversize ones).
  const collector = new ImageCollector();
  // The workbook-wide inflated-bytes budget of the pictures, the same rule as the docx and pptx readers: a read is refused
  // past what is left, so a total exactly at IMAGE_MAX_TOTAL_BYTES passes. A part used several times is read and counted
  // once; its outcome (`undefined`: damaged) is remembered for the next use.
  let imageBudget = limits?.payloadBytes ?? IMAGE_MAX_TOTAL_BYTES;
  const readParts = new Map<string, ImageRef | undefined>();
  const imageBlocksOf = async (pictureParts: readonly string[], unresolved: number): Promise<IRBlock[]> => {
    const blocks: IRBlock[] = [];
    imagesMissing += unresolved; // linked externally or a relationship that does not resolve: said like a missing part
    for (const picturePart of pictureParts) {
      if (!readParts.has(picturePart)) {
        const raw = await readUnlessDamaged(() => pkg.readBytes(picturePart, imageBudget));
        if (raw !== undefined) imageBudget -= raw.byteLength;
        readParts.set(
          picturePart,
          raw === undefined ? undefined : collector.collect(raw, listedMimeType(pkg.contentType(picturePart))),
        );
      }
      const ref = readParts.get(picturePart);
      if (ref === undefined) {
        imagesMissing++; // a broken media part publishes nothing, never invents; said, one folded notice
        continue;
      }
      blocks.push({ kind: "image", ref });
    }
    return blocks;
  };

  const { tabs, notices } = await publishWorkbook(
    inventory.map((sheetInfo): SheetSource => ({
      name: sheetInfo.name,
      // The hidden-tab guard reads ONE source, the OPC inventory: a tab it does not list as `visible` (hidden, veryHidden
      // or absent) is never published, and its part is never even read.
      visible: sheetInfo.state === "visible",
      open: async (): Promise<SheetBody | "part-missing" | undefined> => {
        // A chart-only tab (chartsheet) has no grid at all: its tab is its charts, and it COUNTS among the tab slots.
        if (sheetInfo.kind === "chartsheet")
          return {
            extras: async () => {
              const drawn = await drawingPartsOf(pkg, sheetInfo.partPath);
              return chartBlocksOf(drawn.charts, drawn.unresolvedCharts);
            },
          };
        if (sheetInfo.kind !== "worksheet") return undefined; // an unrecognised relationship kind: nothing to publish, never guessed
        const partPath = sheetInfo.partPath;
        // ONE inflate and parse of the sheet's XML part, shared by every consumer below.
        const sheetXml = await readSheetXml(partPath);
        if (!sheetXml) return "part-missing"; // the workbook declares a sheet whose part is gone: no tab, said (08/10/2026)
        const sheet = prebuilt.get(partPath) ?? (await readWorksheetCells(pkg, partPath, sheetXml, workbook));
        prebuilt.delete(partPath);
        const grid = keptGridOf(sheet, workbook.date1904, language);
        return {
          grid: {
            lines: grid,
            hiddenRows: sheet.hiddenRows,
            table: () => buildSheetTable(sheet, grid),
            // The DECLARED header (`xlsx-parts.ts#readDeclaredHeaderRows`), marked by `sheet-workbook.ts`.
            header: () => readDeclaredHeaderRows(pkg, partPath, sheetXml),
            notices: () => {
              filteredRows += filteredRowsOf(sheet, sheetXml, workbook.date1904, language);
              // The formula notice counts only what the PUBLISHED grid shows.
              const visibleNoValue = sheet.formulasWithoutValue.filter(
                (formulaCell) =>
                  grid.keptRowSet.has(formulaCell.rowIndex) && grid.keptColSet.has(formulaCell.columnIndex),
              ).length;
              return visibleNoValue > 0
                ? [{ kind: "formula-cells-empty", sheet: cutNoticeName(sheetInfo.name), count: visibleNoValue }]
                : [];
            },
          },
          // ONE walk of the drawings for charts AND pictures: each drawing part is inflated once.
          extras: async () => {
            const drawn = await drawingPartsOf(pkg, partPath, sheetXml);
            return [
              ...(await chartBlocksOf(
                drawn.charts,
                drawn.unresolvedCharts,
                chartResolverOf(sheetInfo.name, sheet, grid),
              )),
              ...(await imageBlocksOf(drawn.pictures, drawn.unresolvedPictures)),
            ];
          },
        };
      },
    })),
    limits,
  );
  preparsed.clear(); // a sheet read ahead but never opened is not kept
  prebuilt.clear();
  notices.push(...unpublishedPartNotices({ chartsWithheld, imagesMissing, filteredRows }));
  if (workbook.isStylesPartUnreadable) notices.push({ kind: "styles-defaulted" });
  return { doc: { blocks: tabs.length > 0 ? [{ kind: "tabs", tabs }] : [] }, images: collector.images, notices };
};
