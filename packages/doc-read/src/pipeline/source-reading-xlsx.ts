/** The second, independent reading of a .xlsx workbook that becomes its
 *  conservation source (MIKSUDOC « Spécification technique » T11):
 *  one unit per sheet, in workbook order, its STRING CELLS' words read
 *  straight off the zip (parts opened through `openSourceParts` of
 *  `source-reading-package.ts`, the extractor's bounded bytes layer) — never through `extractor/xlsx.ts`,
 *  `extractor/xlsx-cells.ts` nor `extractor/xlsx-parts.ts` (SheetJS is gone
 *  since 2032fbd; the extractor has its own cell reader), so an extractor
 *  bug cannot pass its own check. Moved here, unchanged in its reading
 *  rules, from `pipeline/no-word-lost.test.ts` (§4 of the conception): that
 *  test now imports `readXlsxSource` from here instead of keeping its own
 *  copy — one reader, not two.
 *
 *  SCOPE: this reading's WORD-BAG side covers TEXT cells only (`t="s"`
 *  shared string, `inlineStr`, `str`, `e` error text) — booleans stay
 *  excluded, never a token source. Numbers and dates are NOT compared as
 *  text (§1, DECIDED, 29/09/2026): our own formatter
 *  (`extractor/xlsx-number-format.ts`) writes their displayed text, and a
 *  reader independent of that formatting would either reimplement it
 *  (duplicating the exact rounding/date-mask rules it exists to own — the
 *  REJECTED proposal this file's tail comment used to carry) or compare raw
 *  serials to formatted text, which is not the same string. Instead, every
 *  non-empty NUMERIC cell (`t` absent or `"n"`, or `"d"` — an ISO-8601 date
 *  value, §18.3.1.4) is checked by POSITION: its `(row, col)` in this
 *  reading's own KEPT grid must be NOT EMPTY at the same position on the
 *  published table (`numericCells` below, cross-checked against the page by
 *  `pipeline/xlsx-page-cells.ts`, never against this reading's own text — a
 *  position check compares the RENDER against ITSELF only for "is something
 *  there", never for WHAT is there, so it cannot compare our formatter with
 *  itself). A formula cell with no cached `<v>` is simply never read as
 *  filled (this file's own `cellIsFilled`, same discriminant `extractor/xlsx.ts`
 *  uses): it is EMPTY BY DECISION (decision f) and never reported.
 *
 *  Whether a cell's FORMAT HIDES its value (« ;;; », an empty section) is
 *  this reading's own rule, from the spec (`codeHides` below, never the
 *  formatter's): a hidden cell publishes no text and leaves the kept grid,
 *  so it is never expected on the page.
 *
 *  Whether a numeric cell is a DATE, for its cause label, is decided
 *  independently of the formatter too: a `t="d"` cell always is; a `t="n"`
 *  cell's style resolves through this reading's OWN `xl/styles.xml` parse
 *  (`cellXfs` → `numFmtId`, `numFmts` for a custom code) against the
 *  built-in date ids ECMA-376 §18.8.30 itself lists (14-22, 45-47) or, for a
 *  custom code, whether it carries a date/time letter run outside quotes,
 *  escapes and brackets (`isDateTimeCode` below) — a much shallower
 *  question than writing the value, with no rounding or locale mask to
 *  agree or disagree on. An id neither the workbook nor §18.8.30 defines
 *  falls back to `"number"` (the escape hatch the owner named: "si cette
 *  classification n'est pas fiable, une seule cause « number », et le dire"
 *  — this is that fallback, not a broader failure of the check).
 *
 *  DECLARED removals (never read as tokens, so never reported missing) are
 *  decided from THIS READING'S OWN facts, mirroring lot D's pptx reading —
 *  never from the page's remark wording:
 *   - a sheet past `MAX_WORKBOOK_TABS`, by this reading's own count of
 *     VISIBLE sheets (mirrors `extractXlsx`'s own cap on visible sheets,
 *     withheld ones included, counted before a hidden sheet's part is ever
 *     read);
 *   - a sheet whose KEPT grid (hidden rows/columns dropped, then fully-empty
 *     rows/columns dropped — the same trim `extractor/sheet-grid.ts#keptLinesOf`
 *     performs, REIMPLEMENTED here rather than imported: that module also
 *     DECIDES what `extractXlsx` publishes, so importing it would let a
 *     shared bug pass its own check) exceeds `MAX_SHEET_ROWS`/`MAX_SHEET_COLS`;
 *   - a hidden or `veryHidden` sheet (`sheet@state`, ECMA-376 Part 1
 *     §18.2.19): still given a unit (its name is a technical id, safe to
 *     keep as a label) but excluded whole and never counted toward the tab
 *     cap — its part is never even read, matching `extractXlsx`'s own guard
 *     (`xlsx.ts`'s module doc, "DATA-EXPOSURE GUARD").
 *  Hidden rows/columns WITHIN an otherwise-kept sheet are a plainer
 *  omission, not a unit-level exclusion: their cells are simply never
 *  walked, like a docx's `w:vanish` run.
 *
 *  The same reading counts each sheet's STRUCTURE for the structure control (`source-structure-sheet.ts`: kept rows, cells, and the tables of its charts).
 *
 *  The KEPT-grid trim needs to know which cells are filled at all — every
 *  type, not just text, or a sheet whose bulk is numeric would look small
 *  enough to publish in full here while the real extractor withholds it
 *  (a false "missing" on every one of its string cells). `cellIsFilled`
 *  below answers that WITHOUT formatting a single number: presence of a
 *  `<v>`/`<is>` child is enough. A cell its format hides is then left out
 *  by this reading's own shallow rule (`hiddenByFormat`, `codeHides`: an
 *  empty section for the value's kind, in a code of 2 to 4 sections).
 *  The accepted gap, where the page hides a cell and this reading still
 *  expects it (a false "missing", or a structure "gap"): a code with a
 *  bracket CONDITION (`[=0]"";0`, never evaluated here: this reading
 *  abstains), a section that prints only blanks (`" "`), a one-section
 *  code, and a section holding nothing but a colour (`[Red]`, see the
 *  bracket strip in `codeHides`). Closing it would take the value-dependent
 *  section choice `xlsx-number-format.ts#selectSection` owns, the exact
 *  divergence this file exists to avoid.
 *
 *  NOT here: reading the workbook into this shape a second time for
 *  Google Sheets, which never has a .xlsx zip to open
 *  (`pipeline/source-reading-gsheet.ts`); comparing the word tokens against
 *  the published page (`pipeline/declared-format-conservation.ts`); locating
 *  a numeric cell's position on the published page
 *  (`pipeline/xlsx-page-cells.ts`, called from the same
 *  `declared-format-conservation.ts`); the xlsx EXTRACTOR itself
 *  (`extractor/xlsx.ts`, `extractor/xlsx-cells.ts`, `extractor/xlsx-parts.ts`,
 *  `extractor/xlsx-number-format.ts`).
 *  DECIDES here, stage by stage (`readXlsxSource`): which sheets are read (`readWorkbookParts`, `emptySheet`), the kept grid (`readHiddenCols`,
 *  `readKeptCells`), the merges (`readMergeRanges`), which sheets take a TAB SLOT (`slotOf`, mirroring the page), where each numeric cell
 *  lands on the page (`placeCells`), and the STRUCTURE the control compares — including the cells the single-first-cell rule absorbs, read
 *  from the sheet's own table parts and frozen pane (`readHeaderDeclaration`, `tableHeaderSpans`, `frozenHeaderRow`).
 *  Called by: `extractor/dispatch.ts`, for `xlsx`.
 *  `pipeline/no-word-lost.test.ts` imports `readXlsxSource`. */

import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import { addChartTable, emptyUnitStructure, excludedUnitsOf, guardedSourceAsync, unitOf, type ConservationNumericCell, type ConservationSourceReadFailure, type ConservationUnit, type DeclaredFormatConservationSource, type UnitStructure } from "./conservation-source";
import { EXCEL_MAX_ROWS, keptCellsResolver, MAX_COLUMN, type SheetCellsResolver } from "./source-chart-reference";
import { absorbedCells, chartShapesOf, createChartCache, declaredHeaderRowsOf, sheetStructure, type ChartCache, type HeaderDeclaration } from "./source-structure-sheet";
import { coveredByMerges, type MergeRange } from "./source-reading-table";
import { resolveTarget } from "../extractor/ooxml/package";
import { attrOf, first, kidsOf, openSourceParts, structureOnly, stylesOrAbsent, tagOf, textOf, type N } from "./source-reading-package";

/** ECMA-376 Part 1 §22.9.2.19 ST_Xstring: a character XML cannot carry is
 *  written `_xHHHH_`, and `_x005F_` a literal underscore. One left-to-right
 *  pass, so `_x005F_x0041_` stays the text `_x0041_`. */
const unescapeXstring = (text: string): string =>
  text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** A §18.4.8 `si` or §18.3.1.53 `is` (CT_Rst): its own `t`, or its rich
 *  runs' `t` concatenated, escapes undone. The phonetic runs (`rPh`) are a
 *  reading aid laid over the text, not the text: never collected. */
const richTextOf = (n: N): string => {
  let out = "";
  for (const k of kidsOf(n)) {
    const tag = tagOf(k);
    if (tag === "t") out += textOf(k);
    else if (tag === "r") for (const t of kidsOf(k).filter((c) => tagOf(c) === "t")) out += textOf(t);
  }
  return unescapeXstring(out);
};

/** The A1 letters of a 1-based column number. */
const colLetters = (n: number): string => {
  let out = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};

/** A cell reference's 1-based (row, column), or undefined when it is not an
 *  A1 reference — the SAME numbering `col@min`/`col@max` use (§18.3.1.13). */
const parseRef = (ref: string): { row: number; col: number } | undefined => {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref.trim());
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  return row >= 1 && col >= 1 ? { row, col } : undefined;
};

/** Whether a cell shows ANYTHING at all, every type counted — the kept-grid
 *  trim needs to know a sheet's true shape, not just where its WORDS are
 *  (this file's header). Never formats a number: presence alone answers it. */
const cellIsFilled = (cell: N, shared: readonly string[]): boolean => {
  const t = attrOf(cell, "t");
  if (t === "s") {
    const v = first(cell, "v");
    const idx = v ? Number(textOf(v)) : NaN;
    return Number.isInteger(idx) && (shared[idx]?.length ?? 0) > 0;
  }
  if (t === "inlineStr") {
    const is = first(cell, "is");
    return is !== undefined && richTextOf(is).length > 0;
  }
  if (t === "str" || t === "e") {
    const v = first(cell, "v");
    return v !== undefined && textOf(v).length > 0;
  }
  // Number or boolean (t absent or "n", or "b"): our formatter always writes
  // SOMETHING for a present value (`extractor/xlsx.ts#writeCellText`) bar the one
  // documented gap (a hide-in-place format) — presence of a NON-EMPTY `<v>`
  // is enough. EMPTY, not absent (`<v></v>`), is openpyxl's own shape for a
  // FORMULA with no cached value (`extractor/xlsx.ts#formulaRefsWithoutValue`'s
  // own rule, mirrored here so a decision-(f) cell is never counted as
  // filled — fixture 12's own name, "Formules-Sans-Valeur", is exactly this
  // case: without this check its five formula cells surfaced as false
  // "missing" numbers, caught by the real-fixture sweep this reading now
  // also runs (`no-word-lost.test.ts`, lot E addendum).
  const v = first(cell, "v");
  return v !== undefined && textOf(v).length > 0;
};

/** This cell's WORDS, text types only (this file's header's scope limit):
 *  `undefined` for a number/boolean/anything else — never a token source. */
const cellText = (cell: N, shared: readonly string[]): string | undefined => {
  const t = attrOf(cell, "t");
  if (t === "s") {
    const v = first(cell, "v");
    const idx = v ? Number(textOf(v)) : NaN;
    return Number.isInteger(idx) ? shared[idx] : undefined;
  }
  if (t === "inlineStr") {
    const is = first(cell, "is");
    return is ? richTextOf(is) : undefined;
  }
  if (t === "str" || t === "e") {
    const v = first(cell, "v");
    if (!v) return undefined;
    // §22.9.2.19 applies to a formula's string result; an error's text is a literal.
    return t === "str" ? unescapeXstring(textOf(v)) : textOf(v);
  }
  return undefined;
};

/** ECMA-376 Part 1 §18.8.30: the built-in `numFmtId`s the standard itself
 *  writes as a date or time mask — the SAME ids `extractor/xlsx-cells.ts#BUILTIN_FORMATS`
 *  lists, cited here independently (spec data, not the formatter's writing
 *  logic) since a date/no-date question never needs the mask's exact text. */
const BUILTIN_DATE_FORMAT_IDS: ReadonlySet<number> = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a (custom) number-format CODE displays a date or time — a
 *  presence question, deliberately shallower than
 *  `xlsx-number-format.ts#formatNumberCell`'s WRITER: quoted literals,
 *  backslash escapes and bracketed conditions/colours/locale tags are
 *  stripped (none of them can carry a bare date letter), then any
 *  `d`/`m`/`y`/`h`/`s` letter, or an `AM/PM`/`A/P` marker, in what remains
 *  means the code shows a date or time part — never how it rounds or pads
 *  it, which this question does not need. */
const isDateTimeCode = (code: string): boolean => {
  let stripped = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      i = end === -1 ? code.length : end + 1;
    } else if (ch === "\\") {
      i += 2;
    } else if (ch === "[") {
      const end = code.indexOf("]", i);
      i = end === -1 ? code.length : end + 1;
    } else {
      stripped += ch;
      i++;
    }
  }
  if (/am\/pm|a\/p/i.test(stripped)) return true;
  return /[dmyhs]/i.test(stripped);
};

/** This reading's OWN `xl/styles.xml`: `cellXfs[i]` gives cell style `i`'s
 *  `numFmtId`; `numFmts` resolves a custom one (≥164 by convention, never
 *  assumed) to its code. Absent styles part, or a style index past the end
 *  of `cellXfs`: `numFmtId` 0 ("General"), never a date — matches a plain
 *  cell with no style applied at all. */
interface XlsxStyles {
  cellXfs: readonly number[];
  numFmts: ReadonlyMap<number, string>;
}

const readStyles = async (xmlOf: (path: string) => Promise<N | undefined>): Promise<XlsxStyles> => {
  const styles = await stylesOrAbsent(() => xmlOf("xl/styles.xml"));
  const numFmtsEl = first(styles, "numFmts");
  const numFmts = new Map<number, string>();
  for (const nf of numFmtsEl ? kidsOf(numFmtsEl).filter((c) => tagOf(c) === "numFmt") : []) {
    const id = Number(attrOf(nf, "numFmtId"));
    const code = attrOf(nf, "formatCode");
    if (Number.isFinite(id) && code !== undefined) numFmts.set(id, code);
  }
  const cellXfsEl = first(styles, "cellXfs");
  const cellXfs = (cellXfsEl ? kidsOf(cellXfsEl).filter((c) => tagOf(c) === "xf") : []).map((xf) => Number(attrOf(xf, "numFmtId") ?? "0"));
  return { cellXfs, numFmts };
};

/** The number-format CODE of a cell's style: the workbook's custom code, or
 *  `undefined` for a built-in id (no built-in hides a number). */
const formatCodeOf = (cell: N, styles: XlsxStyles): string | undefined =>
  styles.numFmts.get(styles.cellXfs[Number(attrOf(cell, "s") ?? "0")] ?? 0);

/** This reading's OWN « hidden by its format » rule, written from the spec
 *  (ECMA-376 Part 1 §18.8.31 numFmt; Microsoft « Number format codes »): a
 *  code has up to 4 sections, positive;negative;zero;text, and an EMPTY
 *  section hides that kind of value. The code is split on `;` outside quotes
 *  and after a backslash; a section is empty when nothing but blanks is left
 *  once the strip in `codeHides` has run. That strip, `/[[^]]*]/g`, matches
 *  ONE `[` or `^` followed by one or more `]`: on `[^]` it removes `^]` and
 *  leaves `[`; on `[Red]` it removes nothing. So a section holding only a
 *  bracketed tag is not read as empty: under `0;[Red]` a negative value is
 *  hidden by the page and still expected here, a false gap (the visible
 *  bias, this file's header). It is left as it is: removing every bracket
 *  would read a section that is only `[$€-2]` or `[h]` as empty although it
 *  displays something, and for a TEXT cell the page's rule is the literal
 *  fourth section being exactly "" (`xlsx-number-format.ts#isHiddenTextFormatCode`).
 *  Nothing is formatted: only « hidden or not ».
 *  Two sections: zero uses the first; one section, or none: never hidden.
 *  A bracket CONDITION (`[>100]`) changes which section applies, and this
 *  rule does not evaluate it: it abstains (never hidden), the visible bias.
 *  A colour or locale bracket is no condition: the code is still decided. */
const sectionsOf = (code: string): string[] => {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      const stop = end === -1 ? code.length : end + 1;
      cur += code.slice(i, stop);
      // eslint-disable-next-line sonarjs/updated-loop-counter -- a quoted run or an escape is consumed whole: the scan skips past it
      i = stop - 1;
    } else if (ch === "\\") {
      cur += code.slice(i, i + 2);
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

// A bracket that opens on a comparison (`[>100]`, `[ <=0]`). A colour (`[Red]`) or a locale tag is no condition: a code that carries one is
// still decided (the earlier character class `[s*[<>=]` abstained on any `[`, `s` or `*`, so `[Blue]0;[Red]-0;;@` hid nothing here).
const CONDITION = /\[\s*[<>=]/;

/** Whether `code` shows nothing for a value of this kind. */
const codeHides = (code: string | undefined, kind: "positive" | "negative" | "zero" | "text"): boolean => {
  if (code === undefined) return false;
  const sections = sectionsOf(code);
  if (sections.length < 2 || sections.length > 4 || sections.some((sec) => CONDITION.test(sec))) return false;
  let index: number;
  if (kind === "text") {
    if (sections.length !== 4) return false; // no text section: the text shows as it is
    index = 3;
  } else if (kind === "negative") index = 1;
  else if (kind === "zero") index = sections.length >= 3 ? 2 : 0;
  else index = 0;
  return sections[index]!.replace(/[[^]]*]/g, "").trim() === "";
};

/** A filled cell whose format displays nothing for its value — a number, a
 *  date (always positive here) or a text under an empty 4th section. The
 *  extractor publishes no text for it and drops it from the kept grid, so it
 *  is never expected, nor does it keep its row or column. */
const hiddenByFormat = (cell: N, styles: XlsxStyles): boolean => {
  const code = formatCodeOf(cell, styles);
  if (code === undefined) return false;
  const t = attrOf(cell, "t");
  if (t === "d") return codeHides(code, "positive");
  if (t === undefined || t === "n") {
    const v = first(cell, "v");
    const value = v === undefined ? NaN : Number(textOf(v));
    if (!Number.isFinite(value)) return false;
    return codeHides(code, value < 0 ? "negative" : value === 0 ? "zero" : "positive");
  }
  return t === "s" || t === "inlineStr" || t === "str" ? codeHides(code, "text") : false;
};

const isDateFormatId = (numFmtId: number, numFmts: ReadonlyMap<number, string>): boolean => {
  const custom = numFmts.get(numFmtId);
  return custom !== undefined ? isDateTimeCode(custom) : BUILTIN_DATE_FORMAT_IDS.has(numFmtId);
};

/** Whether a NUMERIC (`t` absent/`"n"`, or `"d"`) filled cell is a date, for
 *  its `causeCounts` label — `undefined` for anything outside that scope
 *  (text, boolean, error, or no cached value at all — a value-less formula,
 *  EMPTY BY DECISION (f), never a source cell here). `t="d"` (ECMA-376
 *  §18.3.1.4, an ISO-8601 date VALUE) is always a date, style aside. */
const numericCellCause = (cell: N, styles: XlsxStyles): "number" | "date" | undefined => {
  const t = attrOf(cell, "t");
  if (t !== undefined && t !== "n" && t !== "d") return undefined;
  const v = first(cell, "v");
  if (v === undefined || textOf(v).length === 0) return undefined; // absent, or a formula's empty placeholder (`cellIsFilled`'s own rule): decision (f)
  if (t === "d") return "date";
  const styleIndex = Number(attrOf(cell, "s") ?? "0");
  const numFmtId = styles.cellXfs[styleIndex] ?? 0;
  return isDateFormatId(numFmtId, styles.numFmts) ? "date" : "number";
};

/** « 'Budget 2026'!D5 » — Excel's own quoting (single quotes, doubled
 *  inside) for a sheet name that is not a bare identifier; shown instead of
 *  the cell's value (owner decision, 29/09/2026: a reference is a technical
 *  position, never client content). */
const sheetCellRef = (sheetName: string, ref: string): string => {
  const name = /^\w+$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  return `${name}!${ref}`;
};

interface XlsxNumericCell {
  ref: string;
  /** 0-based position within THIS sheet's kept grid — `keptRows`/`keptCols`
   *  sorted ascending, same order the published table's rows/cells occupy. */
  row: number;
  col: number;
  cause: "number" | "date";
}

interface XlsxSheetReading {
  name: string;
  /** This sheet's string-cell words, in reading order; empty for a sheet
   *  excluded below (its real content is never read). */
  text: string;
  /** This sheet's numeric/date source cells, within the kept grid, hidden
   *  rows/columns already out — empty for an excluded or withheld sheet
   *  (§1 lot E addendum, 29/09/2026). */
  numericCells: readonly XlsxNumericCell[];
  /** `sheet@state="hidden"`/`"veryHidden"`: never read, never counted
   *  toward `MAX_WORKBOOK_TABS`. */
  hidden: boolean;
  /** Past `MAX_WORKBOOK_TABS`, by this reading's own count of VISIBLE sheets. */
  overCap: boolean;
  /** This reading's own KEPT grid (hidden lines out, then empty lines out)
   *  passes `MAX_SHEET_ROWS`/`MAX_SHEET_COLS`. */
  withheld: boolean;
  /** What the sheet declares of its structure and what the page adds (`source-structure-sheet.ts`); all zeros for a sheet without a tab. */
  structure: UnitStructure;
  /** The sheet anchors more chart frames than the bound: the structure control abstains for the document, the words do not. */
  structureUnreadable?: true;
}

export interface XlsxSourceReading {
  /** One entry per sheet the workbook DECLARES, in workbook order — hidden
   *  sheets included (their own unit, excluded — this file's header). */
  sheets: readonly XlsxSheetReading[];
}

type XmlOf = (path: string) => Promise<N | undefined>;

/** The workbook-wide facts every sheet's reading needs, read once. */
interface WorkbookParts {
  workbook: N;
  /** The part each sheet relationship id points to, resolved from `xl/workbook.xml`. */
  relTargets: ReadonlyMap<string, string>;
  shared: readonly string[];
  styles: XlsxStyles;
}

const readWorkbookParts = async (xmlOf: XmlOf): Promise<WorkbookParts> => {
  const workbook = await xmlOf("xl/workbook.xml");
  if (!workbook) throw new Error("no workbook part");
  const relsRoot = await xmlOf("xl/_rels/workbook.xml.rels");
  const relTargets = new Map<string, string>();
  for (const rel of relsRoot ? kidsOf(relsRoot).filter((c) => tagOf(c) === "rel:Relationship") : []) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (id !== undefined && target !== undefined) relTargets.set(id, resolveTarget("xl/workbook.xml", target));
  }

  const shared: string[] = [];
  const sst = await xmlOf("xl/sharedStrings.xml");
  for (const si of sst ? kidsOf(sst).filter((c) => tagOf(c) === "si") : []) {
    shared.push(richTextOf(si));
  }
  // ONE styles read for the whole workbook (like `shared` above): a numeric
  // cell's date-or-not classification needs it, never its formatted text.
  const styles = await readStyles(xmlOf);
  return { workbook, relTargets, shared, styles };
};

/** A sheet this reading holds no words nor cells of: hidden, past the tab cap, a chartsheet or a worksheet whose part is missing. */
const emptySheet = (name: string, why: { hidden?: true; overCap?: true } = {}): XlsxSheetReading => ({
  name,
  text: "",
  numericCells: [],
  hidden: why.hidden === true,
  overCap: why.overCap === true,
  withheld: false,
  structure: emptyUnitStructure(),
});

/** The columns the sheet hides (1-based), `col@min`/`col@max` spans clamped to the last column of a sheet. */
const readHiddenCols = (ws: N): Set<number> => {
  const hiddenCols = new Set<number>();
  for (const colsEl of kidsOf(ws).filter((c) => tagOf(c) === "cols")) {
    for (const col of kidsOf(colsEl).filter((c) => tagOf(c) === "col")) {
      if (attrOf(col, "hidden") === "1" || attrOf(col, "hidden") === "true") {
        const min = Math.max(1, Number(attrOf(col, "min") ?? "0"));
        const max = Math.min(MAX_COLUMN, Number(attrOf(col, "max") ?? "0"));
        for (let i = min; i <= max; i++) hiddenCols.add(i);
      }
    }
  }
  return hiddenCols;
};

/** What the cell walk of one sheet collects: the kept lines, the texts and numeric cells that may be expected, the kept cells. */
interface KeptCells {
  keptRows: Set<number>;
  keptCols: Set<number>;
  /** Kept-cell texts in source order; which ones the control reading expects is decided once the merges are resolved. */
  candidateTexts: { text: string; rowNum: number; colNum: number }[];
  numericCandidates: { ref: string; rowNum: number; colNum: number; cause: "number" | "date" }[];
  /** Source rows the author hid (even an empty one): a frozen header abstains when one lies after the last kept row. */
  hiddenRows: Set<number>;
  /** Every kept cell, with whether it would publish text beyond blanks, what it shows (the raw text for a number) and whether it holds a number
   *  (what a chart read from the sheet needs, `source-chart-reference.ts`). */
  keptCells: { rowNum: number; colNum: number; shows: boolean; text: string; numeric: boolean }[];
}

/** The line a visible cell keeps: a filled cell in a hidden row OR column keeps NEITHER line (the caller never gets here for it).
 *  Also what it would show, for the columns the renderer drops. */
const keepLine = (kept: KeptCells, cell: N, at: { rowNum: number; colNum: number }, shared: readonly string[], numeric: boolean): void => {
  const { rowNum, colNum } = at;
  if (!Number.isFinite(rowNum)) return;
  kept.keptRows.add(rowNum);
  kept.keptCols.add(colNum);
  const shown = cellText(cell, shared);
  kept.keptCells.push({ rowNum, colNum, shows: shown === undefined || shown.trim().length > 0, text: shown ?? textOf(first(cell, "v") ?? {}), numeric });
};

/** The text and the numeric source cell a visible cell may bring, expected only once the merges are resolved. */
const collectCandidates = (kept: KeptCells, cell: N, at: { rowNum: number; colNum: number }, parts: Pick<WorkbookParts, "shared">, cause: "number" | "date" | undefined): void => {
  const { rowNum, colNum } = at;
  const text = cellText(cell, parts.shared);
  if (text !== undefined && text.length > 0) kept.candidateTexts.push({ text, rowNum, colNum });
  if (cause !== undefined && Number.isFinite(rowNum)) kept.numericCandidates.push({ ref: `${colLetters(colNum)}${rowNum}`, rowNum, colNum, cause });
};

/** The cells of one row of the sheet data. */
const readRowCells = (kept: KeptCells, row: N, rowNum: number, hiddenCols: ReadonlySet<number>, parts: Pick<WorkbookParts, "shared" | "styles">): void => {
  const rowHidden = attrOf(row, "hidden") === "1" || attrOf(row, "hidden") === "true";
  let previousCol = 0;
  for (const cell of kidsOf(row).filter((c) => tagOf(c) === "c")) {
    const at = parseRef(attrOf(cell, "r") ?? "");
    const colNum = at?.col ?? previousCol + 1;
    previousCol = colNum;
    if (!cellIsFilled(cell, parts.shared)) continue;
    // Shows nothing, so the published table has no cell there and the
    // kept grid drops its line: same as an unfilled cell.
    if (hiddenByFormat(cell, parts.styles)) continue;
    // The trim `sheet-grid.ts#keptLinesOf` applies in production: a
    // filled cell in a hidden row OR column keeps NEITHER line — the
    // row is not "kept" just because a hidden column happens to fill
    // it, and vice versa. Never a token either: hidden, never published.
    if (rowHidden || hiddenCols.has(colNum)) continue;
    const cause = numericCellCause(cell, parts.styles);
    keepLine(kept, cell, { rowNum, colNum }, parts.shared, cause !== undefined);
    collectCandidates(kept, cell, { rowNum, colNum }, parts, cause);
  }
};

/** One walk over the cells of the sheet, hidden rows and columns and cells that publish nothing left out. */
const readKeptCells = (ws: N, hiddenCols: ReadonlySet<number>, parts: Pick<WorkbookParts, "shared" | "styles">): KeptCells => {
  const kept: KeptCells = { keptRows: new Set(), keptCols: new Set(), candidateTexts: [], numericCandidates: [], hiddenRows: new Set(), keptCells: [] };
  const sheetData = first(ws, "sheetData");
  // §18.3.1.73 row@r and §18.3.1.4 c@r are optional: an absent one is the
  // next after its predecessor (the extractor's rule, `xlsx-cells.ts`).
  let previousRow = 0;
  for (const row of sheetData ? kidsOf(sheetData).filter((c) => tagOf(c) === "row") : []) {
    const declaredRow = Number(attrOf(row, "r"));
    const rowNum = Number.isInteger(declaredRow) && declaredRow >= 1 ? declaredRow : previousRow + 1;
    previousRow = rowNum;
    // `lib/ooxml-bool.ts#isXsdTrue` written out, not imported: the library takes no NEW edge to the app
    // (`library-boundary.test.ts`, ceiling 8 on that file, only goes down; it joins the library at step 2 of the library
    // plan, where this copy goes). The page's `xlsx-cells.ts` uses the helper, and the frozen-header abstention of
    // `declaredHeaderRowsOf` needs the two to agree — pinned by the hidden-row tests of this reading (revue 27/10, tour 9).
    if (attrOf(row, "hidden") === "1" || attrOf(row, "hidden") === "true") kept.hiddenRows.add(rowNum);
    readRowCells(kept, row, rowNum, hiddenCols, parts);
  }
  return kept;
};

/** The merged ranges of the sheet, each normalised to `r1 <= r2` and `c1 <= c2` (1-based, ends included). */
const readMergeRanges = (ws: N): MergeRange[] => {
  const mergeRanges: MergeRange[] = [];
  for (const mc of kidsOf(ws).filter((c) => tagOf(c) === "mergeCells")) {
    for (const m of kidsOf(mc).filter((c) => tagOf(c) === "mergeCell")) {
      const [a, b] = (attrOf(m, "ref") ?? "").split(":");
      const from = parseRef(a ?? "");
      const to = parseRef(b ?? a ?? "");
      if (from && to) mergeRanges.push({
        r1: Math.min(from.row, to.row),
        c1: Math.min(from.col, to.col),
        r2: Math.max(from.row, to.row),
        c2: Math.max(from.col, to.col),
      });
    }
  }
  return mergeRanges;
};

/** The expected words of a sheet that publishes a table, and the position of its numeric cells on that table, once the merges are resolved. */
const placeCells = (name: string, kept: KeptCells, mergeRanges: readonly MergeRange[]): { texts: string[]; numericCells: XlsxNumericCell[]; structureWith: (declared: HeaderDeclaration) => UnitStructure } => {
  const { keptRows, keptCols, candidateTexts, numericCandidates, keptCells } = kept;
  // The OUTPUT position of a numeric cell is its rank among the sorted
  // kept rows/columns — the exact order `sheet-grid.ts#keptLinesOf` +
  // `tableOfKept` lay the published table out in (`pipeline/xlsx-page-cells.ts`
  // reads it back the same way).
  const sortedRows = [...keptRows].sort((a, b) => a - b);
  const sortedCols = [...keptCols].sort((a, b) => a - b);
  // A merge whose first cell sits in a kept row AND column and spans more
  // than one kept line publishes ONE cell, at that first cell; the others
  // are covered (their values are never published).
  const anchorOfCovered = coveredByMerges(mergeRanges, keptRows, keptCols);
  // Rule of 09/10/2026: nothing invisible in the source is published NOR expected by the control
  // reading. A text left in a cell a merge covers is never shown by Excel and never published, so only the
  // anchor's own text and the texts of uncovered cells are expected. (A covered NUMBER cell is a different
  // check: its position is still verified below, through the merge's first cell.)
  const texts = candidateTexts
    .filter((t) => !Number.isFinite(t.rowNum) || !anchorOfCovered.has(`${t.rowNum},${t.colNum}`))
    .map((t) => t.text);
  // The renderer drops every column in which no UNCOVERED cell shows text
  // (08/10/2026), so the page's column index is the rank among
  // the columns that keep one.
  // ONE filter for the shown cells: `shownCols` and `pageTexts` below must agree cell for cell (revue 27/10/2026, tour 6).
  const shownCells = keptCells.filter((k) => k.shows && !anchorOfCovered.has(`${k.rowNum},${k.colNum}`));
  const shownCols = new Set(shownCells.map((k) => k.colNum));
  const colIndex = new Map(sortedCols.filter((c) => shownCols.has(c)).map((c, i) => [c, i]));
  const rowIndex = new Map(sortedRows.map((r, i) => [r, i]));
  const numericCells = numericCandidates.flatMap((c) => {
    // A covered value is published through its merge's first cell.
    const at = anchorOfCovered.get(`${c.rowNum},${c.colNum}`) ?? c;
    const row = rowIndex.get(at.rowNum);
    if (row === undefined) return [];
    // A first cell in a dropped column leaves its position past the table's extent: reported missing.
    return [{ ref: sheetCellRef(name, c.ref), row, col: colIndex.get(at.colNum) ?? colIndex.size, cause: c.cause }];
  });
  const coveredInShown = [...anchorOfCovered.keys()].filter((key) => shownCols.has(Number(key.split(",")[1]))).length;
  // The page rule of 27/10/2026 (FAQ_M365_Migration_CNE.xlsx): a row whose only text is in its first cell publishes as ONE cell. Mirrored here
  // on its own so the control keeps its two readings (the first integration shipped without this mirror and 9 real workbooks reported false gaps,
  // found by review the same evening). `keptCells` holds only what is visible and filled: a format-hidden cell and a valueless formula are already
  // out, so they count as empty, as the page treats them. The declared header rows come from parts only the structure reads (`readHeaderDeclaration`),
  // so the structure is built again once they are known.
  const pageTexts = shownCells.map((k) => ({ row: k.rowNum, col: k.colNum }));
  const structureWith = (declared: HeaderDeclaration): UnitStructure =>
    sheetStructure({
      rows: keptRows.size,
      shownColumns: shownCols.size,
      covered: coveredInShown,
      absorbed: absorbedCells({ keptRows: sortedRows, keptCols: sortedCols, shownCols, covered: anchorOfCovered, texts: pageTexts, headerRows: declaredHeaderRowsOf(sortedRows, kept.hiddenRows, declared) }),
    });
  return { texts, numericCells, structureWith };
};

/** The reading of one worksheet part. */
const readWorksheet = (name: string, ws: N, parts: WorkbookParts, limits: ReaderLimits | undefined): { reading: XlsxSheetReading; structureWith?: (declared: HeaderDeclaration) => UnitStructure; chartCells?: SheetCellsResolver } => {
  const kept = readKeptCells(ws, readHiddenCols(ws), parts);
  const mergeRanges = readMergeRanges(ws);
  const withheld = kept.keptRows.size > (limits?.sheetRows ?? NO_CAP) || kept.keptCols.size > (limits?.sheetCols ?? NO_CAP);
  // A withheld sheet publishes no table at all: no numeric cell survives it either, same as its words.
  if (withheld) return { reading: { name, text: "", numericCells: [], hidden: false, overCap: false, withheld, structure: emptyUnitStructure() } };
  const { texts, numericCells, structureWith } = placeCells(name, kept, mergeRanges);
  // The structure starts EMPTY: `finishStructure` always rebuilds it with the header declaration (computing it here too
  // was pure double work on every kept cell, revue 27/10/2026), and an unreadable declaration must abstain, not keep a draft.
  return { reading: { name, text: texts.join(" "), numericCells, hidden: false, overCap: false, withheld, structure: emptyUnitStructure() }, structureWith, chartCells: keptCellsResolver(name, kept.keptCells) };
};

/** What a worksheet DECLARES as header, in 1-based source rows, written on its own from the spec (ISO/IEC 29500-1 §18.5.1.2 `table@ref` and
 *  `table@headerRowCount`, absent = 1, 0 = none; §18.3.1.66 `pane@ySplit` with `state="frozen"`, the rows of the top pane, which starts at
 *  `sheetView@topLeftCell`, row 1 when absent: the last frozen row is that row + ySplit - 1). The Excel table parts, through the sheet's own
 *  relationships, speak first; a frozen pane only when no table declared anything. `ySplit` is read as a plain decimal integer in 1..1,048,576 only
 *  (1e3, 2.0, 0x2 or a leading space declare nothing); the count of a table is clamped to its ref and a ref past the last row is ignored.
 *  ASYMMETRY, written rather than silently fixed (revue 27/10/2026, tour 8): `headerRowCount` is read with `Number()`, so « 2.0 » or « 2 »
 *  with spaces DO declare, where the same spellings of `ySplit` declare nothing. Both readings share the leniency (the page's
 *  `extractor/xlsx-parts.ts#readDeclaredHeaderRows` parses it the same way), so they cannot disagree; tightening it would change what the
 *  PAGE marks as header on files no Excel writes, which is not a change to slip into this lot. */
/** The header spans the Excel TABLE parts of a sheet declare, through its own relationships: `headerRowCount` rows from the top
 *  of each `ref`, clamped to its height; a ref past Excel's last row declares nothing (ECMA-376 Part 1 §18.5.1.2). */
const tableHeaderSpans = async (xmlOf: XmlOf, sheetPart: string): Promise<{ start: number; count: number }[]> => {
  const spans: { start: number; count: number }[] = [];
  const cut = sheetPart.lastIndexOf("/");
  const rels = await xmlOf(`${sheetPart.slice(0, cut)}/_rels/${sheetPart.slice(cut + 1)}.rels`);
  for (const rel of rels ? kidsOf(rels) : []) {
    const type = attrOf(rel, "Type");
    const target = attrOf(rel, "Target");
    if (type === undefined || target === undefined || attrOf(rel, "TargetMode") === "External" || type.slice(type.lastIndexOf("/") + 1) !== "table") continue;
    const span = tableSpanOf(await xmlOf(resolveTarget(sheetPart, target)));
    if (span !== undefined) spans.push(span);
  }
  return spans;
};

/** One table part's header span, or nothing when its `ref` or its count says nothing. */
const tableSpanOf = (table: N | undefined): { start: number; count: number } | undefined => {
  const [a, b] = (table === undefined ? "" : (attrOf(table, "ref") ?? "")).split(":");
  const from = parseRef(a ?? "");
  const to = parseRef(b ?? a ?? "");
  if (table === undefined || !from || !to) return undefined;
  const top = Math.min(from.row, to.row);
  const bottom = Math.max(from.row, to.row);
  if (bottom > EXCEL_MAX_ROWS) return undefined;
  const declared = attrOf(table, "headerRowCount");
  const count = declared === undefined ? 1 : Number(declared);
  return Number.isInteger(count) && count >= 1 ? { start: top, count: Math.min(count, bottom - top + 1) } : undefined;
};

/** The last row a FROZEN pane holds, read from the sheet views (§18.3.1.66), or nothing. */
/** The last frozen row ONE sheet view holds: `ySplit` read as a plain decimal integer only, counted from the view's own top row. */
const frozenRowOfView = (view: N): number | undefined => {
  const pane = first(view, "pane");
  const ySplit = pane !== undefined && attrOf(pane, "state") === "frozen" ? attrOf(pane, "ySplit") : undefined;
  if (ySplit === undefined || !/^\d{1,7}$/.test(ySplit)) return undefined;
  const split = Number(ySplit);
  if (split < 1 || split > EXCEL_MAX_ROWS) return undefined;
  const lastFrozen = (parseRef(attrOf(view, "topLeftCell") ?? "A1")?.row ?? 1) + split - 1;
  return lastFrozen <= EXCEL_MAX_ROWS ? lastFrozen : undefined;
};

const frozenHeaderRow = (ws: N): number | undefined => {
  for (const views of kidsOf(ws).filter((c) => tagOf(c) === "sheetViews"))
    for (const view of kidsOf(views).filter((c) => tagOf(c) === "sheetView")) {
      const row = frozenRowOfView(view);
      if (row !== undefined) return row;
    }
  return undefined;
};
const readHeaderDeclaration = async (xmlOf: XmlOf, sheetPart: string, ws: N): Promise<HeaderDeclaration> => {
  const spans = first(ws, "tableParts") === undefined ? [] : await tableHeaderSpans(xmlOf, sheetPart);
  if (spans.length > 0) return { tableSpans: spans };
  const frozenRow = frozenHeaderRow(ws);
  return frozenRow === undefined ? { tableSpans: [] } : { tableSpans: [], frozenRow };
};

/** The declared header rows are known only from parts the words never read (table parts): the sheet's structure is built again with them, after every
 *  part the words need. A part refused makes only the STRUCTURE of the document abstain. */
const finishStructure = async (xmlOf: XmlOf, sheetPart: string, ws: N, reading: XlsxSheetReading, structureWith: (declared: HeaderDeclaration) => UnitStructure): Promise<void> => {
  const read = await structureOnly(() => readHeaderDeclaration(xmlOf, sheetPart, ws));
  if ("unreadable" in read) reading.structureUnreadable = true;
  else reading.structure = structureWith(read.value);
};

/** The charts of a sheet that has a tab (a chartsheet's too, which has no grid) are tables the page adds to it. */
const addChartTables = async (xmlOf: XmlOf, target: string | undefined, worksheet: N | undefined, sheetRead: { reading: XlsxSheetReading; chartCells?: SheetCellsResolver }, cache: ChartCache): Promise<void> => {
  const { reading, chartCells } = sheetRead;
  if (target === undefined || reading.withheld) return;
  // The chartsheet part, the drawing, the relationships and the chart parts: nothing here served the words before the structure control, so a part
  // refused (damaged, too many frames, over a ceiling) makes only the STRUCTURE of the document abstain; the words are still read and checked.
  const read = await structureOnly(async () => {
    const sheet = worksheet ?? (await xmlOf(target));
    return sheet === undefined ? [] : chartShapesOf(xmlOf, target, sheet, cache, chartCells);
  });
  if ("unreadable" in read) reading.structureUnreadable = true;
  else for (const shape of read.value) addChartTable(reading.structure, shape);
};

/**
 * The source words, read independently: each sheet's shared/inline/string
 * cells, hidden rows and columns never walked, a chartsheet (no
 * `worksheets/` target) carrying no cell words of its own. See this file's
 * header for the full rule-by-rule rationale (moved here unchanged from
 * `pipeline/no-word-lost.test.ts`, plus the cap/withhold facts lot E adds).
 */
/** THE SLOTS MIRROR THE PAGE'S (`extractor/xlsx.ts#open`, revue 27/10/2026 tour 6): a relationship of an unrecognised kind,
 *  and a worksheet whose part is GONE, get no tab on the page, so they take no tab slot here either — counting them pushed the
 *  sheet sitting at the cap out of the mirror while the page published it (every word then read as invented). A chartsheet
 *  takes its slot and has no grid of its own. `undefined`: no slot. */
const slotOf = async (xmlOf: XmlOf, target: string | undefined): Promise<{ ws: N | undefined } | undefined> => {
  if (target === undefined) return undefined;
  if (target.includes("chartsheets/")) return { ws: undefined };
  if (!target.includes("worksheets/")) return undefined;
  const ws = await xmlOf(target);
  return ws === undefined ? undefined : { ws };
};
export const readXlsxSource = async (bytes: Uint8Array, limits?: ReaderLimits): Promise<XlsxSourceReading> => {
  const { xmlOf } = await openSourceParts(bytes);
  const parts = await readWorkbookParts(xmlOf);
  const sheets: XlsxSheetReading[] = [];
  const charts = createChartCache(limits);
  const drawn: (() => Promise<void>)[] = [];
  let visibleSoFar = 0;
  const sheetsEl = first(parts.workbook, "sheets");
  for (const sheetEl of sheetsEl ? kidsOf(sheetsEl).filter((c) => tagOf(c) === "sheet") : []) {
    const name = attrOf(sheetEl, "name") ?? "";
    const state = attrOf(sheetEl, "state");
    if (state === "hidden" || state === "veryHidden") {
      // Exposure guard, mirrored from `extractXlsx`: never even read, never
      // counted toward the cap — the sheets after it keep their own slot.
      sheets.push(emptySheet(name, { hidden: true }));
      continue;
    }
    if (visibleSoFar >= (limits?.workbookTabs ?? NO_CAP)) {
      sheets.push(emptySheet(name, { overCap: true }));
      continue;
    }
    const target = parts.relTargets.get(attrOf(sheetEl, "r:id") ?? "");
    const slot = await slotOf(xmlOf, target);
    if (slot === undefined) {
      sheets.push(emptySheet(name));
      continue;
    }
    const ws = slot.ws;
    visibleSoFar++;
    const read: ReturnType<typeof readWorksheet> = ws ? readWorksheet(name, ws, parts, limits) : { reading: emptySheet(name) };
    const reading = read.reading;
    drawn.push(async () => {
      if (ws !== undefined && target !== undefined && read.structureWith !== undefined) await finishStructure(xmlOf, target, ws, reading, read.structureWith);
      await addChartTables(xmlOf, target, ws, read, charts);
    });
    sheets.push(reading);
  }
  // The structure-only parts (drawings, charts, chartsheets) are read after every part the words need: the package's inflation budget is shared.
  for (const read of drawn) await read();
  return { sheets };
};

/**
 * The xlsx conservation source (MIKSUDOC « Spécification technique » T11, lot E): one unit per sheet the workbook declares, in workbook order.
 * `deliberateRemovals` stays empty — like pptx (lot D), the cap/withhold/
 * hidden facts become `excludedUnits` directly, never a literal text the
 * page repeats that would need budgeting back in. A read that cannot be
 * trusted becomes a named failure instead of throwing through to the
 * caller: never a reason not to publish (21/09/2026).
 */
export async function readXlsxConservationSource(
  bytes: Uint8Array,
  /** The caps the EXTRACTION was given, or none: the two readings must agree, or the check reports a difference of cap as a loss. */
  limits?: ReaderLimits,
): Promise<DeclaredFormatConservationSource | ConservationSourceReadFailure> {
  return readXlsxConservationSourceUnder(bytes, limits);
}

/** `readXlsxConservationSource` under the caps the page was read with (`ReaderLimits`, the SAME object the extraction got). The plain one keeps its
 *  one-parameter signature: it takes no language and no option (`extractor/xlsx.page-language.test.ts` pins that). */
export async function readXlsxConservationSourceUnder(
  bytes: Uint8Array,
  limits: ReaderLimits | undefined,
): Promise<DeclaredFormatConservationSource | ConservationSourceReadFailure> {
  return guardedSourceAsync(async () => {
    const { sheets } = await readXlsxSource(bytes, limits);
    const units: ConservationUnit[] = sheets.map((sheet) => unitOf(sheet.name, sheet.text));
    const excludedUnits = excludedUnitsOf(sheets, (sheet) => sheet.hidden || sheet.overCap || sheet.withheld);
    const numericCells: ConservationNumericCell[] = sheets.flatMap((sheet, unit) =>
      sheet.numericCells.map((c) => ({ unit, ref: c.ref, row: c.row, col: c.col, cause: c.cause })),
    );
    return {
      units,
      deliberateRemovals: [],
      excludedUnits,
      ...(numericCells.length > 0 ? { numericCells } : {}),
      structure: { units: sheets.map((sheet) => sheet.structure), format: "xlsx", ...(sheets.some((sheet) => sheet.structureUnreadable === true) ? { unreadable: true as const } : {}) },
    };
  });
}

// ---------------------------------------------------------------------------
// Numbers and dates: DECIDED and IMPLEMENTED above (§1, 29/09/2026) —
// this section used to carry a proposal to import
// `extractor/xlsx-number-format.ts#formatNumberCell` into this reading and
// call it a second time on the raw values, so a shared bug in the formatter
// would still fail. REJECTED by the owner: that would compare the reader
// with itself, the exact "an extractor bug cannot pass its own check"
// property this file exists for, broken from the other end (a NUMBER's
// PAGE TEXT is the formatter's own output either way). The implemented
// shape checks POSITION instead — a non-empty source cell must have a
// non-empty published cell at the SAME place — never comparing displayed
// text at all: `numericCellCause` above decides only NUMBER vs DATE (for
// the cause label), independently, and never writes a value.
