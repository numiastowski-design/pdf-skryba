/** The cells of a worksheet and the workbook-wide tables behind them, read from the package ourselves (ECMA-376
 *  Part 1 §18).
 *  Decides how a stored cell is read: its raw value and type, its number-format code (style → `numFmtId` → the
 *  workbook's own `numFmts`, else the built-in table of §18.8.30), bold, merges, hidden rows and columns, hyperlink
 *  targets, the sheet's extent and the workbook's date system. Built-in format 14 is flagged by id, never by its literal
 *  code. Also exports `LANGUAGE_SAMPLE_CHARS`, the bound on the text sampled for language detection.
 *  NOT here: the display text (`xlsx-number-format.ts`), what gets published (`xlsx.ts`), the tab inventory
 *  (`xlsx-parts.ts`).
 *  Called by: `extractor/xlsx.ts`, `extractor/xlsx-parts.ts` (cell references), `tools/bench/render.ts`. */

import { DAY_MS } from "../lib/clock";
import { isXsdTrue } from "../lib/ooxml-bool";
import { externalLinkTarget } from "doc-ir/lib/link-schemes";
import { ReaderError } from "doc-ir/lib/reader-error";
import { type OpcPackage, readOrFlag, findRelationshipOfKind } from "./ooxml/package";
import { attributeOf, findChild, findChildren, childNodesOf, qualifiedNameOf, textContentOf, type XNode } from "./ooxml/xml";

/** Zero-based, like `sheet-grid.ts`. */
interface CellAddress {
  rowIndex: number;
  columnIndex: number;
}

interface CellRange {
  readonly start: CellAddress;
  readonly end: CellAddress;
}

/** A cell's value as the file stores it (§18.3.1.4 `c@t`). Shared strings,
 *  inline strings and a formula's string result are all `s`; an ISO 8601
 *  date cell (`t="d"`) is turned into the serial number the formatter
 *  reads, in the workbook's own date system. An error keeps the text the
 *  file writes (`#DIV/0!`). */
type CellValue = { readonly t: "n"; readonly v: number } | { readonly t: "s"; readonly v: string } | { readonly t: "b"; readonly v: boolean } | { readonly t: "e"; readonly v: string };

export interface WorksheetCell {
  readonly value: CellValue;
  /** The format code the cell's style resolves to, faithfully to ECMA-376
   *  §18.8.30 (built-in id 14 is its literal `mm-dd-yy`); `undefined` when
   *  the style names an id neither the workbook nor §18.8.30 defines. */
  readonly formatCode: string | undefined;
  /** Whether the style resolves to built-in id 14 ITSELF (§18.8.30) — never a custom
   *  code that merely spells the same mask, and never a workbook that
   *  redefines id 14 with its own code (the workbook's own `numFmts` win first).
   *  Our decision (29/09/2026): id 14 is written as the short date of the document's
   *  language, not as a fixed mask (`xlsx-number-format.ts#selectBuiltinNumFmt14`), selected
   *  by this flag — never by matching the literal `mm-dd-yy` string, which `formatCode`
   *  above still reports as the standard writes it. */
  readonly isBuiltinNumFmt14: boolean;
  /** Bold, from the cell's style font (§18.8.2 `b`) or, for a rich string, from its runs (`runWeights`). One flag for the
   *  whole cell: a cell is published as one inline, so runs of MIXED weight give a plain cell. */
  readonly isBold: boolean;
}

/** A rich-text run's weight (§18.4.4 `r`): its own `rPr` replaces the cell font, so a run with properties and no `b` is
 *  plain; a run without `rPr` takes the cell's font. */
type RunWeight = "bold" | "plain" | "inherit";

interface SheetHyperlink {
  /** A hyperlink's `ref` may be a range (`A1:C1`): every cell in it links. */
  readonly range: CellRange;
  /** The relationship's target, plus `#location` when both are given;
   *  `#location` alone for a link inside the workbook. */
  readonly target: string;
  /** Whether the target comes from an External relationship (never for `#location` alone). */
  readonly external: boolean;
}

export interface WorksheetCells {
  /** Keyed by the A1 reference (`formatCellReference`). Cells that hold no value — a
   *  style alone, a formula without a cached `<v>` — are absent. */
  readonly cells: Map<string, WorksheetCell>;
  /** The declared `dimension` united with the extent of every `<c>` the
   *  part writes: a dimension that understates would hide real cells. */
  readonly dimensionRange: CellRange | undefined;
  readonly mergeCells: CellRange[];
  readonly hiddenRows: Set<number>;
  /** `col@min..max` spans, zero-based and inclusive, kept as spans: one
   *  `<col>` may cover any number of columns, so they are never expanded. */
  readonly hiddenColumns: { min: number; max: number }[];
  readonly hyperlinks: SheetHyperlink[];
  /** Where a `<c>` carries a formula `<f>` but NO cached value (counted
   *  under the table, never published), read in the same walk as `cells`.
   *  An empty `<v>` counts, EXCEPT on a string-typed formula (`t="str"`),
   *  where it IS the cached result. Each distinct written reference once. */
  readonly formulasWithoutValue: CellAddress[];
}

export interface SharedStringsAndStyles {
  /** §18.2.28 `workbookPr@date1904`: serials count from 1904-01-01. */
  readonly date1904: boolean;
  readonly sharedStrings: string[];
  /** The format code of each cell style (`cellXfs` index). */
  readonly cellXfsFormatCodes: (string | undefined)[];
  /** Whether each cell style (`cellXfs` index) resolves to built-in id 14
   *  itself — `WorksheetCell.isBuiltinNumFmt14`'s own source. */
  readonly cellXfsIsBuiltinNumFmt14: boolean[];
  /** Whether each cell style (`cellXfs` index) points at a bold font. */
  readonly cellXfsIsBold: boolean[];
  /** Per shared string: the weight of each run that carries text; `undefined` for a plain `<t>` string. */
  readonly sharedRuns: (RunWeight[] | undefined)[];
  /** `xl/styles.xml` is declared but unreadable: no cell has a format (raw values), said by the caller. */
  readonly isStylesPartUnreadable: boolean;
}

/** ECMA-376 Part 1 §18.8.30 (numFmt): the built-in formats the standard
 *  itself writes out. Ids 5-8, 23-36, 41-44 and 50+ are left to the
 *  application's locale by the standard: a style naming one without the
 *  workbook defining it gets `undefined`, never a guessed currency. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

const isTrueAttribute = isXsdTrue;

const writeColumnName = (colIndex: number): string => {
  let name = "";
  for (let columnNumber = colIndex + 1; columnNumber > 0; columnNumber = Math.floor((columnNumber - 1) / 26)) name = String.fromCharCode(65 + ((columnNumber - 1) % 26)) + name;
  return name;
};

/** `{ rowIndex: 0, columnIndex: 0 }` → `A1`. */
export const formatCellReference = (rowIndex: number, colIndex: number): string => `${writeColumnName(colIndex)}${rowIndex + 1}`;

const CELL_REFERENCE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** `A1` → `{ rowIndex: 0, columnIndex: 0 }`; `undefined` for anything else. */
export const parseCellReference = (reference: string): CellAddress | undefined => {
  const match = CELL_REFERENCE.exec(reference.trim());
  if (!match) return undefined;
  let colIndex = 0;
  for (const letter of match[1]!.toUpperCase()) colIndex = colIndex * 26 + (letter.charCodeAt(0) - 64);
  const rowNumber = Number(match[2]);
  return rowNumber >= 1 ? { rowIndex: rowNumber - 1, columnIndex: colIndex - 1 } : undefined;
};

/** `A1:C3` or a single `B2` → a range, corners put in order. */
export const parseCellRangeReference = (reference: string | undefined): CellRange | undefined => {
  if (reference === undefined) return undefined;
  const [firstText, secondText = firstText] = reference.split(":");
  const first = parseCellReference(firstText ?? "");
  const second = parseCellReference(secondText ?? "");
  if (!first || !second) return undefined;
  return { start: { rowIndex: Math.min(first.rowIndex, second.rowIndex), columnIndex: Math.min(first.columnIndex, second.columnIndex) }, end: { rowIndex: Math.max(first.rowIndex, second.rowIndex), columnIndex: Math.max(first.columnIndex, second.columnIndex) } };
};

/** §22.9.2.19 ST_Xstring: a character XML cannot carry is written
 *  `_xHHHH_`; `_x005F_` escapes a literal underscore. One left-to-right
 *  pass, so `_x005F_x0041_` stays the text `_x0041_`. */
const unescapeXstring = (text: string): string =>
  text.replace(/_x([0-9A-Fa-f]{4})_/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** §18.8.2 CT_BooleanProperty: `<b/>` is bold, `val` absent means true, `val` "0" or "false" means not. */
const isBoldFont = (font: XNode): boolean => {
  const boldElement = findChild(font, "b");
  if (boldElement === undefined) return false;
  const value = attributeOf(boldElement, "val");
  return value === undefined || isTrueAttribute(value);
};

/** The weights of the runs of a `si` / `is` that carry text; `undefined` when it has no `<r>` (a plain `<t>`). */
const runWeights = (node: XNode): RunWeight[] | undefined => {
  const runs = findChildren(node, "r");
  if (runs.length === 0) return undefined;
  return runs
    .filter((run) => findChildren(run, "t").some((textElement) => textContentOf(textElement).length > 0))
    .map((run): RunWeight => {
      const rPr = findChild(run, "rPr");
      if (rPr === undefined) return "inherit";
      return isBoldFont(rPr) ? "bold" : "plain";
    });
};

/** Whether a cell is bold: every text-bearing run resolves to bold (a run without properties takes the cell font). */
const boldOf = (runs: readonly RunWeight[] | undefined, cellFont: boolean): boolean => {
  if (runs === undefined || runs.length === 0) return cellFont;
  return runs.every((weight) => (weight === "inherit" ? cellFont : weight === "bold"));
};

/** A §18.4.8 `si` or a §18.3.1.53 `is` (CT_Rst): its own `t`, or its rich
 *  runs' `t` concatenated. The phonetic runs (`rPh`) are a reading aid laid
 *  over the text, not the text: excluded. */
const readRichText = (node: XNode): string => {
  let text = "";
  for (const child of childNodesOf(node)) {
    const tag = qualifiedNameOf(child);
    if (tag === "t") text += textContentOf(child);
    else if (tag === "r") for (const textElement of findChildren(child, "t")) text += textContentOf(textElement);
  }
  return unescapeXstring(text);
};

// eslint-disable-next-line sonarjs/regex-complexity -- ISO date and time shape: flat optional groups with fixed digit counts
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(?:Z)?$/;

/** An ISO 8601 date-time (§18.17.4.1) as a serial. The 1900 system keeps
 *  Excel's fictitious 1900-02-29 (serial 60, §18.17.4.1): serials below
 *  61 are one less than the day count from 1899-12-30. `undefined` when the
 *  text is not the date form we read. */
const serialOf = (iso: string, date1904: boolean): number | undefined => {
  const match = ISO_DATE.exec(iso.trim());
  if (!match) return undefined;
  const seconds = Number(match[6] ?? "0");
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? "0"), Number(match[5] ?? "0")) + seconds * 1000;
  if (date1904) return (utc - Date.UTC(1904, 0, 1)) / DAY_MS;
  const serial = (utc - Date.UTC(1899, 11, 30)) / DAY_MS;
  return serial < 61 ? serial - 1 : serial;
};

/** The workbook's own number-format codes by id: a file may redefine a built-in id, and its own code then wins. */
const customFormatsOf = (styles: XNode): Map<number, string> => {
  const custom = new Map<number, string>();
  for (const numFmts of findChildren(styles, "numFmts")) {
    for (const numFmt of findChildren(numFmts, "numFmt")) {
      const numFmtId = Number(attributeOf(numFmt, "numFmtId"));
      const code = attributeOf(numFmt, "formatCode");
      if (Number.isInteger(numFmtId) && code !== undefined) custom.set(numFmtId, code);
    }
  }
  return custom;
};

/** The per-style tables (format code, built-in date 14, bold) of a styles part, indexed like `cellXfs`. */
const styleTablesOf = (styles: XNode): Pick<SharedStringsAndStyles, "cellXfsFormatCodes" | "cellXfsIsBuiltinNumFmt14" | "cellXfsIsBold"> => {
  const styleFormats: (string | undefined)[] = [];
  const styleBuiltinDate14: boolean[] = [];
  const styleBold: boolean[] = [];
  const custom = customFormatsOf(styles);
  // `applyFont` is not consulted: the xf's fontId is read whatever it says, as numFmtId is above (our choice).
  const fonts = findChildren(styles, "fonts").flatMap((fontsElement) => findChildren(fontsElement, "font"));
  for (const cellXfs of findChildren(styles, "cellXfs")) {
    for (const xf of findChildren(cellXfs, "xf")) {
      const numFmtId = Number(attributeOf(xf, "numFmtId") ?? "0");
      const overridden = custom.get(numFmtId);
      styleFormats.push(overridden ?? BUILTIN_FORMATS[numFmtId]);
      styleBuiltinDate14.push(numFmtId === 14 && overridden === undefined);
      const fontId = attributeOf(xf, "fontId");
      const font = fontId === undefined || !/^\d+$/.test(fontId) ? undefined : fonts[Number(fontId)];
      styleBold.push(font !== undefined && isBoldFont(font));
    }
  }
  return { cellXfsFormatCodes: styleFormats, cellXfsIsBuiltinNumFmt14: styleBuiltinDate14, cellXfsIsBold: styleBold };
};

/** The shared strings of a workbook, with the weight of each rich run. */
const sharedStringsOf = (sst: XNode | undefined): Pick<SharedStringsAndStyles, "sharedStrings" | "sharedRuns"> => {
  const sharedStrings: string[] = [];
  const sharedRuns: (RunWeight[] | undefined)[] = [];
  for (const si of sst ? findChildren(sst, "si") : []) {
    sharedStrings.push(readRichText(si));
    sharedRuns.push(runWeights(si));
  }
  return { sharedStrings, sharedRuns };
};

/** The workbook-wide tables every sheet reads through: shared strings,
 *  style formats, date system. `workbookXml`: the caller's own parse, when
 *  it has one. */
export async function readSharedStringsAndStyles(opcPackage: OpcPackage, workbookXml?: XNode): Promise<SharedStringsAndStyles> {
  const workbook = workbookXml ?? (await opcPackage.readXml(opcPackage.mainPart));
  const workbookPr = workbook ? findChild(workbook, "workbookPr") : undefined;
  const date1904 = isTrueAttribute(workbookPr ? attributeOf(workbookPr, "date1904") : undefined);

  const mainRelationships = await opcPackage.relationships(opcPackage.mainPart);
  const partOf = (kind: string): string | undefined => findRelationshipOfKind(mainRelationships, kind)?.target;

  const sstPart = partOf("sharedStrings");
  const sst = sstPart !== undefined ? await opcPackage.readXml(sstPart) : undefined;
  const { sharedStrings, sharedRuns } = sharedStringsOf(sst);

  const { styles, stylesUnreadable } = await readStylesPart(opcPackage, partOf("styles"));
  const { cellXfsFormatCodes: styleFormats, cellXfsIsBuiltinNumFmt14: styleBuiltinDate14, cellXfsIsBold: styleBold } = styles ? styleTablesOf(styles) : { cellXfsFormatCodes: [], cellXfsIsBuiltinNumFmt14: [], cellXfsIsBold: [] };
  return { date1904, sharedStrings, cellXfsFormatCodes: styleFormats, cellXfsIsBuiltinNumFmt14: styleBuiltinDate14, cellXfsIsBold: styleBold, sharedRuns, isStylesPartUnreadable: stylesUnreadable };
}

/** The styles part, parsed; `isStylesPartUnreadable` when it is declared but damaged. */
const readStylesPart = async (opcPackage: OpcPackage, stylesPart: string | undefined): Promise<{ styles: XNode | undefined; stylesUnreadable: boolean }> => {
  if (stylesPart === undefined) return { styles: undefined, stylesUnreadable: false };
  // A damaged styles part does not refuse the workbook: values come out unformatted, the caller says so (08/10/2026).
  const { value, damaged } = await readOrFlag(() => opcPackage.readXml(stylesPart));
  return { styles: value, stylesUnreadable: damaged };
};

/** Upper bound of the text sampled to detect the document's language: a sample, never a whole workbook. */
export const LANGUAGE_SAMPLE_CHARS = 30_000;

/** The runs of the cell's string, when it is a rich one. */
const runsOf = (cellNode: XNode, workbook: SharedStringsAndStyles): RunWeight[] | undefined => {
  const type = attributeOf(cellNode, "t") ?? "n";
  if (type === "inlineStr") {
    const is = findChild(cellNode, "is");
    return is ? runWeights(is) : undefined;
  }
  const valueNode = findChild(cellNode, "v");
  return type === "s" && valueNode !== undefined ? workbook.sharedRuns[Number(textContentOf(valueNode))] : undefined;
};

const readCellValue = (cellNode: XNode, workbook: SharedStringsAndStyles): CellValue | undefined => {
  const type = attributeOf(cellNode, "t") ?? "n";
  if (type === "inlineStr") {
    const is = findChild(cellNode, "is");
    return is ? { t: "s", v: readRichText(is) } : undefined;
  }
  const valueNode = findChild(cellNode, "v");
  if (valueNode === undefined) return undefined;
  const raw = textContentOf(valueNode);
  switch (type) {
    case "s": {
      const text = workbook.sharedStrings[Number(raw)];
      return text === undefined ? undefined : { t: "s", v: text };
    }
    // A formula's string result: an EMPTY `<v>` IS its cached value ("").
    case "str":
      return { t: "s", v: unescapeXstring(raw) };
    case "b":
      return raw.length === 0 ? undefined : { t: "b", v: isTrueAttribute(raw) };
    case "e":
      return raw.length === 0 ? undefined : { t: "e", v: raw };
    case "d": {
      if (raw.length === 0) return undefined;
      const serial = serialOf(raw, workbook.date1904);
      // A date form we do not read stays visible as written, never dropped.
      return serial === undefined ? { t: "s", v: raw } : { t: "n", v: serial };
    }
    default: {
      if (raw.trim().length === 0) return undefined;
      const number = Number(raw);
      return Number.isFinite(number) ? { t: "n", v: number } : { t: "s", v: raw };
    }
  }
};

/** The bounding box of the cells met so far: grows with each cell. */
interface ExtentTracker {
  readonly grow: (rowIndex: number, colIndex: number) => void;
  readonly get: () => CellRange | undefined;
}

const createExtentTracker = (): ExtentTracker => {
  let extent: CellRange | undefined;
  return {
    grow: (rowIndex, colIndex) => {
      if (!extent) extent = { start: { rowIndex: rowIndex, columnIndex: colIndex }, end: { rowIndex: rowIndex, columnIndex: colIndex } };
      else {
        extent.start.rowIndex = Math.min(extent.start.rowIndex, rowIndex);
        extent.start.columnIndex = Math.min(extent.start.columnIndex, colIndex);
        extent.end.rowIndex = Math.max(extent.end.rowIndex, rowIndex);
        extent.end.columnIndex = Math.max(extent.end.columnIndex, colIndex);
      }
    },
    get: () => extent,
  };
};

/** What the rows of a sheet fill in. */
interface RowsAccumulator {
  readonly cells: Map<string, WorksheetCell>;
  readonly noValue: Map<string, CellAddress>;
  readonly hiddenRows: Set<number>;
  readonly extent: ExtentTracker;
}

/** A formula cell with no cached value: an EMPTY `<v>` and an absent one both mean « no cached value ». */
const isFormulaWithoutValue = (cellNode: XNode, address: CellAddress | undefined): boolean => {
  if (address === undefined || attributeOf(cellNode, "r") === undefined || findChild(cellNode, "f") === undefined || findChild(cellNode, "is") !== undefined) return false;
  const valueNode = findChild(cellNode, "v");
  return valueNode === undefined || (textContentOf(valueNode).length === 0 && attributeOf(cellNode, "t") !== "str");
};

/** One `<c>`: notes its extent and a missing cached value, stores its value when it has one. Returns the cell's column. */
const readCell = (cellNode: XNode, rowIndex: number, previousCol: number, workbook: SharedStringsAndStyles, accumulator: RowsAccumulator): number => {
  const address = parseCellReference(attributeOf(cellNode, "r") ?? "");
  const cellRowIndex = address?.rowIndex ?? rowIndex;
  const colIndex = address?.columnIndex ?? previousCol + 1;
  accumulator.extent.grow(cellRowIndex, colIndex);
  if (isFormulaWithoutValue(cellNode, address)) accumulator.noValue.set(attributeOf(cellNode, "r")!, address!);
  const value = readCellValue(cellNode, workbook);
  if (value === undefined) return colIndex;
  const styleIndex = Number(attributeOf(cellNode, "s") ?? "0");
  accumulator.cells.set(formatCellReference(cellRowIndex, colIndex), {
    value,
    formatCode: workbook.cellXfsFormatCodes[styleIndex],
    isBuiltinNumFmt14: workbook.cellXfsIsBuiltinNumFmt14[styleIndex] ?? false,
    isBold: boldOf(runsOf(cellNode, workbook), workbook.cellXfsIsBold[styleIndex] ?? false),
  });
  return colIndex;
};

/** The rows of the sheet's `<sheetData>`. §18.3.1.73 row@r and §18.3.1.4 c@r are optional: an absent one is the next after its predecessor. */
const readRows = (sheetXml: XNode, workbook: SharedStringsAndStyles, accumulator: RowsAccumulator): void => {
  let rowIndex = -1;
  for (const sheetData of findChildren(sheetXml, "sheetData")) {
    for (const row of findChildren(sheetData, "row")) {
      const declaredRow = Number(attributeOf(row, "r"));
      rowIndex = Number.isInteger(declaredRow) && declaredRow >= 1 ? declaredRow - 1 : rowIndex + 1;
      if (isTrueAttribute(attributeOf(row, "hidden"))) accumulator.hiddenRows.add(rowIndex);
      let colIndex = -1;
      for (const cellNode of findChildren(row, "c")) colIndex = readCell(cellNode, rowIndex, colIndex, workbook, accumulator);
    }
  }
};

/** The zero-based spans of the sheet's hidden `<col>` elements. */
const hiddenColsOf = (sheetXml: XNode): { min: number; max: number }[] => {
  const hiddenCols: { min: number; max: number }[] = [];
  for (const cols of findChildren(sheetXml, "cols")) {
    for (const col of findChildren(cols, "col")) {
      const min = Number(attributeOf(col, "min"));
      const max = Number(attributeOf(col, "max"));
      if (isTrueAttribute(attributeOf(col, "hidden")) && Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min) hiddenCols.push({ min: min - 1, max: max - 1 });
    }
  }
  return hiddenCols;
};

/** Merged ranges one sheet may declare (starting value to calibrate, 06/11/2026). Two populations measured: 68 real workbooks, at
 *  most 172 on one sheet (452 in all); the hostile file of 27/10/2026, about 1.8 M merges in 64 MB inflated. Past it the file is
 *  refused for safety: each merge costs memory downstream, and no real workbook comes near. */
export const MAX_MERGE_CELLS_PER_SHEET = 10_000;

const mergesOf = (sheetXml: XNode): CellRange[] => {
  const merges: CellRange[] = [];
  for (const mergeCells of findChildren(sheetXml, "mergeCells")) {
    for (const mergeCell of findChildren(mergeCells, "mergeCell")) {
      if (merges.length >= MAX_MERGE_CELLS_PER_SHEET) throw new ReaderError("FILE_UNSAFE", "the sheet declares more merged ranges than any real workbook");
      const range = parseCellRangeReference(attributeOf(mergeCell, "ref"));
      if (range) merges.push(range);
    }
  }
  return merges;
};

/** The hyperlinks of the sheet, their targets resolved through the sheet's relationships. */
const hyperlinksOf = async (opcPackage: OpcPackage, sheetPartPath: string, sheetXml: XNode): Promise<SheetHyperlink[]> => {
  const hyperlinks: SheetHyperlink[] = [];
  const hyperlinkNodes = findChildren(sheetXml, "hyperlinks").flatMap((hyperlinksElement) => findChildren(hyperlinksElement, "hyperlink"));
  if (hyperlinkNodes.length === 0) return hyperlinks;
  const relationships = await opcPackage.relationships(sheetPartPath);
  for (const hyperlinkNode of hyperlinkNodes) {
    const range = parseCellRangeReference(attributeOf(hyperlinkNode, "ref"));
    if (!range) continue;
    const relationshipId = attributeOf(hyperlinkNode, "r:id");
    const relationship = relationshipId !== undefined ? relationships.get(relationshipId) : undefined;
    const location = attributeOf(hyperlinkNode, "location");
    const locationFragment = location !== undefined ? `#${location}` : "";
    const target = relationship !== undefined ? `${relationship.target}${locationFragment}` : locationFragment;
    // Neither a relationship nor a location: nothing to link to.
    if (target.length > 0) hyperlinks.push({ range, target, external: relationship?.external === true });
  }
  return hyperlinks;
};

/** The sheet's range: the declared `<dimension>` widened to the cells actually met. */
const sheetRefOf = (sheetXml: XNode, extent: CellRange | undefined): CellRange | undefined => {
  const dimensionNode = findChild(sheetXml, "dimension");
  const declared = parseCellRangeReference(dimensionNode ? attributeOf(dimensionNode, "ref") : undefined);
  if (!declared || !extent) return declared ?? extent;
  return {
    start: { rowIndex: Math.min(declared.start.rowIndex, extent.start.rowIndex), columnIndex: Math.min(declared.start.columnIndex, extent.start.columnIndex) },
    end: { rowIndex: Math.max(declared.end.rowIndex, extent.end.rowIndex), columnIndex: Math.max(declared.end.columnIndex, extent.end.columnIndex) },
  };
};

/** One worksheet part's cells. `sheetXml`: the part as the caller already
 *  parsed it (one inflate per part). */
export async function readWorksheetCells(opcPackage: OpcPackage, sheetPartPath: string, sheetXml: XNode, workbook: SharedStringsAndStyles): Promise<WorksheetCells> {
  const accumulator: RowsAccumulator = { cells: new Map(), noValue: new Map(), hiddenRows: new Set(), extent: createExtentTracker() };
  readRows(sheetXml, workbook, accumulator);
  const hiddenCols = hiddenColsOf(sheetXml);
  const merges = mergesOf(sheetXml);
  const hyperlinks = await hyperlinksOf(opcPackage, sheetPartPath, sheetXml);
  const ref = sheetRefOf(sheetXml, accumulator.extent.get());
  return { cells: accumulator.cells, dimensionRange: ref, mergeCells: merges, hiddenRows: accumulator.hiddenRows, hiddenColumns: hiddenCols, hyperlinks, formulasWithoutValue: [...accumulator.noValue.values()] };
}

/** `hiddenColumns` sorted and merged (disjoint, ascending), built once per
 *  sheet: a lookup is a binary search, not a scan of every span per cell. */
const mergedSpans = new WeakMap<WorksheetCells["hiddenColumns"], { min: number; max: number }[]>();
const mergedSpansOf = (spans: WorksheetCells["hiddenColumns"]): { min: number; max: number }[] => {
  const known = mergedSpans.get(spans);
  if (known) return known;
  const merged: { min: number; max: number }[] = [];
  for (const span of [...spans].sort((earlier, later) => earlier.min - later.min)) {
    const last = merged.at(-1);
    if (last && span.min <= last.max + 1) last.max = Math.max(last.max, span.max);
    else merged.push({ min: span.min, max: span.max });
  }
  mergedSpans.set(spans, merged);
  return merged;
};

/** Whether a zero-based column falls in a hidden `<col>` span. */
export const isColumnHidden = (sheet: WorksheetCells, colIndex: number): boolean => {
  const spans = mergedSpansOf(sheet.hiddenColumns);
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle]!;
    if (colIndex < span.min) high = middle - 1;
    else if (colIndex > span.max) low = middle + 1;
    else return true;
  }
  return false;
};

/** The target of the LAST hyperlink covering this cell — a later
 *  `<hyperlink>` over the same cell wins, as a later element does. */
const hyperlinkAt = (sheet: WorksheetCells, rowIndex: number, colIndex: number): SheetHyperlink | undefined => {
  for (let linkIndex = sheet.hyperlinks.length - 1; linkIndex >= 0; linkIndex--) {
    const link = sheet.hyperlinks[linkIndex]!;
    const { range } = link;
    if (rowIndex >= range.start.rowIndex && rowIndex <= range.end.rowIndex && colIndex >= range.start.columnIndex && colIndex <= range.end.columnIndex) return link;
  }
  return undefined;
};

export const findHyperlinkTargetAt = (sheet: WorksheetCells, rowIndex: number, colIndex: number): string | undefined => hyperlinkAt(sheet, rowIndex, colIndex)?.target;

/** The same cell's link, kept only if it may become an href (`lib/link-schemes.ts#externalLinkTarget`). */
export const findExternalHyperlinkTargetAt = (sheet: WorksheetCells, rowIndex: number, colIndex: number): string | undefined =>
  externalLinkTarget(hyperlinkAt(sheet, rowIndex, colIndex));
