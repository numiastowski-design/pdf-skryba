/** What a workbook's cells ARE, read from the package ourselves (ECMA-376
 *  Part 1 §18): each cell's raw value and type, its number-format code
 *  (style → `numFmtId` → the workbook's own `numFmts`, else the built-in
 *  table of §18.8.30), merges, hidden rows and columns, hyperlink targets,
 *  the sheet's extent, and the workbook's date system. SheetJS's own parse
 *  layer, retired 29/09/2026 after parity on 23 820 cells of 17 real
 *  workbooks (`xlsx-cells.test.ts`), two justified divergences kept (built-in
 *  format 14 read as the reading language's short date; a hyperlink's
 *  non-ASCII sheet name, no page effect).
 *  Also exports `LANGUAGE_SAMPLE_CHARS`, the bound on the text sampled for language detection.
 *  NOT here: the display text (`xlsx-number-format.ts`), what gets published
 *  (`xlsx.ts`), the tab inventory (`xlsx-parts.ts`).
 *  Called by: `extractor/xlsx.ts`. */

import { DAY_MS } from "../lib/clock";
import { isXsdTrue } from "../lib/ooxml-bool";
import { externalLinkTarget } from "doc-ir/lib/link-schemes";
import { ReaderError } from "doc-ir/lib/reader-error";
import { type DocxPackage, readOrFlag, relationOfKind } from "./ooxml/package";
import { attr, child, children, kids, tagOf, textOf, type XNode } from "./ooxml/xml";

/** Zero-based, as SheetJS and `sheet-grid.ts` count. */
interface CellAddress {
  r: number;
  c: number;
}

interface CellRange {
  s: CellAddress;
  e: CellAddress;
}

/** A cell's value as the file stores it (§18.3.1.4 `c@t`). Shared strings,
 *  inline strings and a formula's string result are all `s`; an ISO 8601
 *  date cell (`t="d"`) is turned into the serial number the formatter
 *  reads, in the workbook's own date system. An error keeps the text the
 *  file writes (`#DIV/0!`). */
type CellValue = { t: "n"; v: number } | { t: "s"; v: string } | { t: "b"; v: boolean } | { t: "e"; v: string };

export interface SheetCell {
  value: CellValue;
  /** The format code the cell's style resolves to, faithfully to ECMA-376
   *  §18.8.30 (built-in id 14 is its literal `mm-dd-yy`); `undefined` when
   *  the style names an id neither the workbook nor §18.8.30 defines. */
  format: string | undefined;
  /** Whether the style resolves to built-in id 14 ITSELF — never a custom
   *  code that merely spells the same mask, and never a workbook that
   *  redefines id 14 with its own code (`readWorkbookCells`'s own `custom`
   *  map wins first). §18.8.30 marks id 14 with an asterisk: its rendering
   *  follows the READING LANGUAGE's regional short-date setting, not a
   *  fixed mask (Microsoft, "Number format codes"). DECIDED (Mikolaj,
   *  29/09): `xlsx-number-format.ts#BUILTIN_FORMAT_14_SHORT_DATE` renders
   *  it, by this flag — never by matching the literal `mm-dd-yy` string,
   *  which `format` above still reports faithfully for any other reader. */
  builtinDate14: boolean;
  /** Bold, from the cell's style font (§18.8.2 `b`) or, for a rich string, from its runs (`runWeights`). One flag for the
   *  whole cell: a cell is published as one inline, so runs of MIXED weight give a plain cell. */
  bold: boolean;
}

/** A rich-text run's weight (§18.4.4 `r`): its own `rPr` replaces the cell font, so a run with properties and no `b` is
 *  plain; a run without `rPr` takes the cell's font. */
type RunWeight = "bold" | "plain" | "inherit";

interface SheetHyperlink {
  /** A hyperlink's `ref` may be a range (`A1:C1`): every cell in it links. */
  range: CellRange;
  /** The relationship's target, plus `#location` when both are given;
   *  `#location` alone for a link inside the workbook. */
  target: string;
  /** Whether the target comes from an External relationship (never for `#location` alone). */
  external: boolean;
}

export interface SheetCells {
  /** Keyed by the A1 reference (`cellRef`). Cells that hold no value — a
   *  style alone, a formula without a cached `<v>` — are absent. */
  cells: Map<string, SheetCell>;
  /** The declared `dimension` united with the extent of every `<c>` the
   *  part writes: a dimension that understates would hide real cells. */
  ref: CellRange | undefined;
  merges: CellRange[];
  hiddenRows: Set<number>;
  /** `col@min..max` spans, zero-based and inclusive, kept as spans: one
   *  `<col>` may cover all 16 384 columns. */
  hiddenCols: { min: number; max: number }[];
  hyperlinks: SheetHyperlink[];
  /** Where a `<c>` carries a formula `<f>` but NO cached value (decision
   *  (f): counted under the table, never published), read in the same walk
   *  as `cells`. An empty `<v>` counts, EXCEPT on a string-typed formula
   *  (`t="str"`), where it IS the cached result (revue HIGH 29/09, constat
   *  3). Each distinct written reference once. */
  formulasWithoutValue: CellAddress[];
}

export interface WorkbookCells {
  /** §18.2.28 `workbookPr@date1904`: serials count from 1904-01-01. */
  date1904: boolean;
  sharedStrings: string[];
  /** The format code of each cell style (`cellXfs` index). */
  styleFormats: (string | undefined)[];
  /** Whether each cell style (`cellXfs` index) resolves to built-in id 14
   *  itself — `SheetCell.builtinDate14`'s own source. */
  styleBuiltinDate14: boolean[];
  /** Whether each cell style (`cellXfs` index) points at a bold font. */
  styleBold: boolean[];
  /** Per shared string: the weight of each run that carries text; `undefined` for a plain `<t>` string. */
  sharedRuns: (RunWeight[] | undefined)[];
  /** `xl/styles.xml` is declared but unreadable: no cell has a format (raw values), said by the caller. */
  stylesUnreadable: boolean;
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

const bool = isXsdTrue;

const columnName = (c: number): string => {
  let name = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** `{r:0,c:0}` → `A1`. */
export const cellRef = (r: number, c: number): string => `${columnName(c)}${r + 1}`;

const REF = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** `A1` → `{r:0,c:0}`; `undefined` for anything else. */
export const parseCellRef = (ref: string): CellAddress | undefined => {
  const m = REF.exec(ref.trim());
  if (!m) return undefined;
  let c = 0;
  for (const ch of m[1]!.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = Number(m[2]);
  return r >= 1 ? { r: r - 1, c: c - 1 } : undefined;
};

/** `A1:C3` or a single `B2` → a range, corners put in order. */
export const parseRange = (ref: string | undefined): CellRange | undefined => {
  if (ref === undefined) return undefined;
  const [a, b = a] = ref.split(":");
  const s = parseCellRef(a ?? "");
  const e = parseCellRef(b ?? "");
  if (!s || !e) return undefined;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
};

/** §22.9.2.19 ST_Xstring: a character XML cannot carry is written
 *  `_xHHHH_`; `_x005F_` escapes a literal underscore. One left-to-right
 *  pass, so `_x005F_x0041_` stays the text `_x0041_`. */
const unescapeXstring = (text: string): string =>
  text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** §18.8.2 CT_BooleanProperty: `<b/>` is bold, `val` absent means true, `val` "0" or "false" means not. */
const isBoldFont = (font: XNode): boolean => {
  const b = child(font, "b");
  if (b === undefined) return false;
  const val = attr(b, "val");
  return val === undefined || bool(val);
};

/** The weights of the runs of a `si` / `is` that carry text; `undefined` when it has no `<r>` (a plain `<t>`). */
const runWeights = (node: XNode): RunWeight[] | undefined => {
  const runs = children(node, "r");
  if (runs.length === 0) return undefined;
  return runs
    .filter((r) => children(r, "t").some((t) => textOf(t).length > 0))
    .map((r): RunWeight => {
      const rPr = child(r, "rPr");
      return rPr === undefined ? "inherit" : isBoldFont(rPr) ? "bold" : "plain";
    });
};

/** Whether a cell is bold: every text-bearing run resolves to bold (a run without properties takes the cell font). */
const boldOf = (runs: RunWeight[] | undefined, cellFont: boolean): boolean =>
  runs === undefined || runs.length === 0 ? cellFont : runs.every((w) => (w === "inherit" ? cellFont : w === "bold"));

/** A §18.4.8 `si` or a §18.3.1.53 `is` (CT_Rst): its own `t`, or its rich
 *  runs' `t` concatenated. The phonetic runs (`rPh`) are a reading aid laid
 *  over the text, not the text: excluded. */
const richText = (node: XNode): string => {
  let out = "";
  for (const k of kids(node)) {
    const tag = tagOf(k);
    if (tag === "t") out += textOf(k);
    else if (tag === "r") for (const t of children(k, "t")) out += textOf(t);
  }
  return unescapeXstring(out);
};

// eslint-disable-next-line sonarjs/regex-complexity -- ISO date and time shape: flat optional groups with fixed digit counts
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(?:Z)?$/;

/** An ISO 8601 date-time (§18.17.4.1) as a serial. The 1900 system keeps
 *  Excel's fictitious 1900-02-29 (serial 60, §18.17.4.1): serials below
 *  61 are one less than the day count from 1899-12-30. `undefined` when the
 *  text is not the date form we read. */
const serialOf = (iso: string, date1904: boolean): number | undefined => {
  const m = ISO_DATE.exec(iso.trim());
  if (!m) return undefined;
  const seconds = Number(m[6] ?? "0");
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? "0"), Number(m[5] ?? "0")) + seconds * 1000;
  if (date1904) return (utc - Date.UTC(1904, 0, 1)) / DAY_MS;
  const serial = (utc - Date.UTC(1899, 11, 30)) / DAY_MS;
  return serial < 61 ? serial - 1 : serial;
};

/** The workbook's own number-format codes by id: a file may redefine a built-in id (a real one redefines 6-8 with euro codes). */
const customFormatsOf = (styles: XNode): Map<number, string> => {
  const custom = new Map<number, string>();
  for (const numFmts of children(styles, "numFmts")) {
    for (const nf of children(numFmts, "numFmt")) {
      const id = Number(attr(nf, "numFmtId"));
      const code = attr(nf, "formatCode");
      if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
    }
  }
  return custom;
};

/** The per-style tables (format code, built-in date 14, bold) of a styles part, indexed like `cellXfs`. */
const styleTablesOf = (styles: XNode): Pick<WorkbookCells, "styleFormats" | "styleBuiltinDate14" | "styleBold"> => {
  const styleFormats: (string | undefined)[] = [];
  const styleBuiltinDate14: boolean[] = [];
  const styleBold: boolean[] = [];
  // The workbook's own codes first.
  const custom = customFormatsOf(styles);
  // `applyFont` is not consulted: Excel reads the xf's fontId whatever it says, as it does numFmtId above.
  const fonts = children(styles, "fonts").flatMap((f) => children(f, "font"));
  for (const xfs of children(styles, "cellXfs")) {
    for (const xf of children(xfs, "xf")) {
      const id = Number(attr(xf, "numFmtId") ?? "0");
      const overridden = custom.get(id);
      styleFormats.push(overridden ?? BUILTIN_FORMATS[id]);
      styleBuiltinDate14.push(id === 14 && overridden === undefined);
      const fontId = attr(xf, "fontId");
      const font = fontId === undefined || !/^\d+$/.test(fontId) ? undefined : fonts[Number(fontId)];
      styleBold.push(font !== undefined && isBoldFont(font));
    }
  }
  return { styleFormats, styleBuiltinDate14, styleBold };
};

/** The shared strings of a workbook, with the weight of each rich run. */
const sharedStringsOf = (sst: XNode | undefined): Pick<WorkbookCells, "sharedStrings" | "sharedRuns"> => {
  const sharedStrings: string[] = [];
  const sharedRuns: (RunWeight[] | undefined)[] = [];
  for (const si of sst ? children(sst, "si") : []) {
    sharedStrings.push(richText(si));
    sharedRuns.push(runWeights(si));
  }
  return { sharedStrings, sharedRuns };
};

/** The workbook-wide tables every sheet reads through: shared strings,
 *  style formats, date system. `workbookXml`: the caller's own parse, when
 *  it has one. */
export async function readWorkbookCells(pkg: DocxPackage, workbookXml?: XNode): Promise<WorkbookCells> {
  const workbook = workbookXml ?? (await pkg.readXml(pkg.mainPart));
  const pr = workbook ? child(workbook, "workbookPr") : undefined;
  const date1904 = bool(pr ? attr(pr, "date1904") : undefined);

  const mainRels = await pkg.relationships(pkg.mainPart);
  const partOf = (kind: string): string | undefined => relationOfKind(mainRels, kind)?.target;

  const sstPart = partOf("sharedStrings");
  const sst = sstPart !== undefined ? await pkg.readXml(sstPart) : undefined;
  const { sharedStrings, sharedRuns } = sharedStringsOf(sst);

  const stylesPart = partOf("styles");
  let stylesUnreadable = false;
  let styles: XNode | undefined;
  if (stylesPart !== undefined) {
    // A damaged styles part does not refuse the workbook: values come out unformatted, the caller says so (08/10/2026).
    ({ value: styles, damaged: stylesUnreadable } = await readOrFlag(() => pkg.readXml(stylesPart)));
  }
  const { styleFormats, styleBuiltinDate14, styleBold } = styles ? styleTablesOf(styles) : { styleFormats: [], styleBuiltinDate14: [], styleBold: [] };
  return { date1904, sharedStrings, styleFormats, styleBuiltinDate14, styleBold, sharedRuns, stylesUnreadable };
}

/** Upper bound of the text sampled to detect the document's language: a sample, never a whole workbook. */
export const LANGUAGE_SAMPLE_CHARS = 30_000;

/** The runs of the cell's string, when it is a rich one. */
const runsOf = (c: XNode, workbook: WorkbookCells): RunWeight[] | undefined => {
  const type = attr(c, "t") ?? "n";
  if (type === "inlineStr") {
    const is = child(c, "is");
    return is ? runWeights(is) : undefined;
  }
  const v = child(c, "v");
  return type === "s" && v !== undefined ? workbook.sharedRuns[Number(textOf(v))] : undefined;
};

const valueOf = (c: XNode, workbook: WorkbookCells): CellValue | undefined => {
  const type = attr(c, "t") ?? "n";
  if (type === "inlineStr") {
    const is = child(c, "is");
    return is ? { t: "s", v: richText(is) } : undefined;
  }
  const v = child(c, "v");
  if (v === undefined) return undefined;
  const raw = textOf(v);
  switch (type) {
    case "s": {
      const text = workbook.sharedStrings[Number(raw)];
      return text === undefined ? undefined : { t: "s", v: text };
    }
    // A formula's string result: an EMPTY `<v>` IS its cached value ("").
    case "str":
      return { t: "s", v: unescapeXstring(raw) };
    case "b":
      return raw.length === 0 ? undefined : { t: "b", v: bool(raw) };
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
      const n = Number(raw);
      return Number.isFinite(n) ? { t: "n", v: n } : { t: "s", v: raw };
    }
  }
};

/** The bounding box of the cells met so far: grows with each cell. */
interface ExtentTracker {
  grow: (r: number, c: number) => void;
  get: () => CellRange | undefined;
}

const extentTracker = (): ExtentTracker => {
  let extent: CellRange | undefined;
  return {
    grow: (r, c) => {
      if (!extent) extent = { s: { r, c }, e: { r, c } };
      else {
        extent.s.r = Math.min(extent.s.r, r);
        extent.s.c = Math.min(extent.s.c, c);
        extent.e.r = Math.max(extent.e.r, r);
        extent.e.c = Math.max(extent.e.c, c);
      }
    },
    get: () => extent,
  };
};

/** What the rows of a sheet fill in. */
interface RowsAccumulator {
  cells: Map<string, SheetCell>;
  noValue: Map<string, CellAddress>;
  hiddenRows: Set<number>;
  extent: ExtentTracker;
}

/** A formula cell with no cached value: openpyxl writes `<v></v>` — an EMPTY element, not an absent one: both mean « no cached value ». */
const isFormulaWithoutValue = (c: XNode, at: CellAddress | undefined): boolean => {
  if (at === undefined || attr(c, "r") === undefined || child(c, "f") === undefined || child(c, "is") !== undefined) return false;
  const v = child(c, "v");
  return v === undefined || (textOf(v).length === 0 && attr(c, "t") !== "str");
};

/** One `<c>`: notes its extent and a missing cached value, stores its value when it has one. Returns the cell's column. */
const readCell = (c: XNode, rowIndex: number, previousCol: number, workbook: WorkbookCells, acc: RowsAccumulator): number => {
  const at = parseCellRef(attr(c, "r") ?? "");
  const r = at?.r ?? rowIndex;
  const colIndex = at?.c ?? previousCol + 1;
  acc.extent.grow(r, colIndex);
  if (isFormulaWithoutValue(c, at)) acc.noValue.set(attr(c, "r")!, at!);
  const value = valueOf(c, workbook);
  if (value === undefined) return colIndex;
  const styleIdx = Number(attr(c, "s") ?? "0");
  acc.cells.set(cellRef(r, colIndex), {
    value,
    format: workbook.styleFormats[styleIdx],
    builtinDate14: workbook.styleBuiltinDate14[styleIdx] ?? false,
    bold: boldOf(runsOf(c, workbook), workbook.styleBold[styleIdx] ?? false),
  });
  return colIndex;
};

/** The rows of the sheet's `<sheetData>`. §18.3.1.73 row@r and §18.3.1.4 c@r are optional: an absent one is the next after its predecessor. */
const readRows = (sheetXml: XNode, workbook: WorkbookCells, acc: RowsAccumulator): void => {
  let rowIndex = -1;
  for (const sheetData of children(sheetXml, "sheetData")) {
    for (const row of children(sheetData, "row")) {
      const declaredRow = Number(attr(row, "r"));
      rowIndex = Number.isInteger(declaredRow) && declaredRow >= 1 ? declaredRow - 1 : rowIndex + 1;
      if (bool(attr(row, "hidden"))) acc.hiddenRows.add(rowIndex);
      let colIndex = -1;
      for (const c of children(row, "c")) colIndex = readCell(c, rowIndex, colIndex, workbook, acc);
    }
  }
};

/** The zero-based spans of the sheet's hidden `<col>` elements. */
const hiddenColsOf = (sheetXml: XNode): { min: number; max: number }[] => {
  const hiddenCols: { min: number; max: number }[] = [];
  for (const cols of children(sheetXml, "cols")) {
    for (const col of children(cols, "col")) {
      const min = Number(attr(col, "min"));
      const max = Number(attr(col, "max"));
      if (bool(attr(col, "hidden")) && Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min) hiddenCols.push({ min: min - 1, max: max - 1 });
    }
  }
  return hiddenCols;
};

/** Merged ranges one sheet may declare (starting value to calibrate, 06/11/2026). Two populations measured: 68 real workbooks, at
 *  most 172 on one sheet (452 in all); the hostile file of 27/10/2026, about 1.8 M merges in 64 MB inflated. Past it the file is
 *  refused for safety: each merge costs memory downstream, and no real workbook comes near. */
export const MAX_SHEET_MERGES = 10_000;

/** The merged ranges of the sheet. */
const mergesOf = (sheetXml: XNode): CellRange[] => {
  const merges: CellRange[] = [];
  for (const mergeCells of children(sheetXml, "mergeCells")) {
    for (const m of children(mergeCells, "mergeCell")) {
      if (merges.length >= MAX_SHEET_MERGES) throw new ReaderError("FILE_UNSAFE", "the sheet declares more merged ranges than any real workbook");
      const range = parseRange(attr(m, "ref"));
      if (range) merges.push(range);
    }
  }
  return merges;
};

/** The hyperlinks of the sheet, their targets resolved through the sheet's relationships. */
const hyperlinksOf = async (pkg: DocxPackage, sheetPartPath: string, sheetXml: XNode): Promise<SheetHyperlink[]> => {
  const hyperlinks: SheetHyperlink[] = [];
  const hyperlinkNodes = children(sheetXml, "hyperlinks").flatMap((h) => children(h, "hyperlink"));
  if (hyperlinkNodes.length === 0) return hyperlinks;
  const rels = await pkg.relationships(sheetPartPath);
  for (const h of hyperlinkNodes) {
    const range = parseRange(attr(h, "ref"));
    if (!range) continue;
    const relId = attr(h, "r:id");
    const rel = relId !== undefined ? rels.get(relId) : undefined;
    const location = attr(h, "location");
    const hash = location !== undefined ? `#${location}` : "";
    const target = rel !== undefined ? `${rel.target}${hash}` : hash;
    // Neither a relationship nor a location: nothing to link to.
    if (target.length > 0) hyperlinks.push({ range, target, external: rel?.external === true });
  }
  return hyperlinks;
};

/** The sheet's range: the declared `<dimension>` widened to the cells actually met. */
const sheetRefOf = (sheetXml: XNode, extent: CellRange | undefined): CellRange | undefined => {
  const dimensionNode = child(sheetXml, "dimension");
  const declared = parseRange(dimensionNode ? attr(dimensionNode, "ref") : undefined);
  return declared && extent
    ? {
        s: { r: Math.min(declared.s.r, extent.s.r), c: Math.min(declared.s.c, extent.s.c) },
        e: { r: Math.max(declared.e.r, extent.e.r), c: Math.max(declared.e.c, extent.e.c) },
      }
    : (declared ?? extent);
};

/** One worksheet part's cells. `sheetXml`: the part as the caller already
 *  parsed it (one inflate per part). */
export async function readSheetCells(pkg: DocxPackage, sheetPartPath: string, sheetXml: XNode, workbook: WorkbookCells): Promise<SheetCells> {
  const acc: RowsAccumulator = { cells: new Map(), noValue: new Map(), hiddenRows: new Set(), extent: extentTracker() };
  readRows(sheetXml, workbook, acc);
  const hiddenCols = hiddenColsOf(sheetXml);
  const merges = mergesOf(sheetXml);
  const hyperlinks = await hyperlinksOf(pkg, sheetPartPath, sheetXml);
  const ref = sheetRefOf(sheetXml, acc.extent.get());
  return { cells: acc.cells, ref, merges, hiddenRows: acc.hiddenRows, hiddenCols, hyperlinks, formulasWithoutValue: [...acc.noValue.values()] };
}

/** `hiddenCols` sorted and merged (disjoint, ascending), built once per
 *  sheet: a lookup is a binary search, not a scan of every span per cell. */
const mergedSpans = new WeakMap<SheetCells["hiddenCols"], { min: number; max: number }[]>();
const mergedSpansOf = (spans: SheetCells["hiddenCols"]): { min: number; max: number }[] => {
  const known = mergedSpans.get(spans);
  if (known) return known;
  const merged: { min: number; max: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.min - b.min)) {
    const last = merged.at(-1);
    if (last && span.min <= last.max + 1) last.max = Math.max(last.max, span.max);
    else merged.push({ min: span.min, max: span.max });
  }
  mergedSpans.set(spans, merged);
  return merged;
};

/** Whether a zero-based column falls in a hidden `<col>` span. */
export const isColHidden = (sheet: SheetCells, c: number): boolean => {
  const spans = mergedSpansOf(sheet.hiddenCols);
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    if (c < span.min) hi = mid - 1;
    else if (c > span.max) lo = mid + 1;
    else return true;
  }
  return false;
};

/** The target of the LAST hyperlink covering this cell — a later
 *  `<hyperlink>` over the same cell wins, as a later element does. */
const hyperlinkAt = (sheet: SheetCells, r: number, c: number): SheetHyperlink | undefined => {
  for (let i = sheet.hyperlinks.length - 1; i >= 0; i--) {
    const link = sheet.hyperlinks[i]!;
    const { range } = link;
    if (r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c) return link;
  }
  return undefined;
};

export const linkAt = (sheet: SheetCells, r: number, c: number): string | undefined => hyperlinkAt(sheet, r, c)?.target;

/** The same cell's link, kept only if it may become an href (`lib/link-schemes.ts#externalLinkTarget`). */
export const externalLinkAt = (sheet: SheetCells, r: number, c: number): string | undefined =>
  externalLinkTarget(hyperlinkAt(sheet, r, c));
