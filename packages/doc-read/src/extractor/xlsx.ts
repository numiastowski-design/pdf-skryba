/** A .xlsx turned into ONE tabs block — a sheet is a native tab (decisions
 *  (e)+(n)): trimmed grid (hidden AND fully empty rows/columns out), OUR
 *  number formatter, declared header, raw external links, charts and
 *  anchored pictures under the table. Display caps (`MAX_WORKBOOK_TABS` sheets, `MAX_SHEET_ROWS` × `MAX_SHEET_COLS`,
 *  `lib/reader-limits.ts`) and formula cells without a value are NOT said
 *  on the page: they come back as `notices` for the dashboard, and a
 *  withheld sheet has no tab at all. Rows an autoFilter hides are left out and counted (`hidden-dropped`, `filtered-rows`).
 *  Also reads the `<autoFilter>` XML, writes each cell's display text (`cellText`) and samples the cell texts to
 *  detect the workbook's language.
 *  NOT here: the OPC inventory and part walks (`xlsx-parts.ts`), the cells
 *  themselves (`xlsx-cells.ts`), the format codes (`xlsx-number-format.ts`),
 *  the chart cache reader (`pptx-reader/chart.ts`), image reduction
 *  (`image-collector.ts`).
 *  Called by: `extractor/dispatch.ts`. */

/**
 * xlsx extractor (MIKSUDOC « Spécification technique » §5.4) — .xlsx → IRDoc through OUR OWN
 * reader (`xlsx-cells.ts` + `xlsx-parts.ts`, ECMA-376 Part 1 §18). SheetJS
 * removed (Mikolaj, 29/09/2026) after parity on 23 820 cells of 17 real
 * workbooks (`xlsx-cells.test.ts`), two justified divergences kept: built-in
 * format 14 read as the reading language's short date (today, US, `m/d/yy`
 * — `xlsx-cells.ts#BUILTIN_FORMATS`, MIKSUDOC « Spécification fonctionnelle » §9.4
 * § Sources de référence); a hyperlink's non-ASCII sheet name read once
 * rather than double-decoded, no page effect. Pure: no I/O beyond the bytes
 * it's given, and no part read more than once (`xlsx.read-once.test.ts`).
 *
 * ONE `tabs` IRBlock, one `IRTab` per published sheet (lot tableurs étape 3,
 * 28/09/2026 — decisions (e)+(n): a workbook is ONE page, a sheet a native
 * tab, the exact shape the presentations deliver). The pre-étape-3 shape
 * (one `section` per sheet) is gone.
 *
 * DATA-EXPOSURE GUARD, not a fidelity nicety (STATUS.md/
 * l'historique git v0.6, 31/08/2026, Gemini consultation): a
 * whole tab hidden in the workbook (`hidden` OR `veryHidden`, read from the
 * OPC inventory alone — `xlsx-parts.ts#WorkbookSheet.state`), AND hidden
 * rows/columns within an otherwise-visible tab (`xlsx-cells.ts`'s own
 * `hiddenRows`/`isColHidden`, read from the sheet's own XML), are all
 * dropped entirely. This exists because a hidden salary column, or a hidden
 * row of draft figures, would otherwise be published in plain text to every
 * reader of the Confluence space — data the file's author explicitly hid,
 * exposed without the author, the connecting admin, or any reader ever
 * being told. Same treatment for all three granularities (tab/row/column)
 * is deliberate: least surprising behavior (someone who hides a column
 * doesn't expect it republished elsewhere), consistent with "fidèle à
 * l'affichage" (MIKSUDOC « Spécification technique » §5.4, Sheets row) read as "what the author
 * chose to show", not "every byte physically present in the file". A
 * hidden tab's own part is never even READ (our reader only follows what
 * it actually publishes) — `xlsx.bomb.test.ts`.
 */

import { cutNoticeName, NO_CAP, type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import type { DocumentNotice, PageLanguage } from "doc-ir/lib/reader-types";
import { detectLanguageFromSample } from "doc-ir/pipeline/detect-language";
import { type ImageRef, type Inline, type IRBlock, type IRDoc } from "doc-ir/lib/ir";
import type { RawImage } from "doc-ir/extractor/raw-image";
import { listedMimeType } from "../lib/mime-types";
import { ImageCollector } from "./image-collector";
import { chartToIr, readChartOrWithheld } from "./pptx-reader/chart";
import { IMAGE_MAX_TOTAL_BYTES, orDamaged } from "./ooxml/package";
import { attr, child, type XNode } from "./ooxml/xml";
import { builtinFormat14, formatNumberCell, hiddenTextFormat } from "./xlsx-number-format";
import { keptLinesOf, tableOfKept, type KeptLines } from "./sheet-grid";
import { publishWorkbook, type SheetBody, type SheetSource } from "./sheet-workbook";
import { drawingPartsOf, readWorkbookSheets, declaredHeaderRows } from "./xlsx-parts";
import { LANGUAGE_SAMPLE_CHARS, isColHidden, externalLinkAt, parseCellRef, parseRange, readSheetCells, readWorkbookCells, type SheetCell, type SheetCells } from "./xlsx-cells";

/** The word a boolean cell shows in the document's language. */
const booleanWord = (value: boolean, language: PageLanguage): string =>
  language === "fr" ? (value ? "VRAI" : "FAUX") : value ? "TRUE" : "FALSE";

/** The cell's display text, written by OUR formatter: `xlsx-cells.ts` gives the raw value and format code, and
 *  `xlsx-number-format.ts` writes the text; a code outside the observed set falls back to the raw value as-is. An
 *  error cell keeps the text the file itself writes (`#DIV/0!` is not a number format). Built-in format 14 is read BY
 *  ID (`cell.builtinDate14`), never by the literal code string (`xlsx-number-format.ts#builtinFormat14`, the page
 *  language's short date). Numbers, dates and booleans are written in the document's language (`language`). */
const cellText = (cell: SheetCell, date1904: boolean, language: PageLanguage): string => {
  const { value, format } = cell;
  // LIMIT (written 06/11/2026), TRUNCATED TEXT: Excel cuts on screen a text longer than its column when the neighbouring
  // cell is filled (133 953 such cells on 68 real workbooks, estimated in `corpus-local/tableurs.md`); we publish the WHOLE
  // value. Chosen bias: ugly and visible rather than wrong and invisible. The full value is in the file and shows when the
  // cell is clicked; cutting it would lose words, the defect that matters most here. Not a defect to fix.
  // LIMIT (written 06/11/2026), FORMULA ERRORS: an error cell (`#DIV/0!`, `#REF!`...) keeps the text the file writes. Behaviour
  // NOT proven on a real case: 0 error cells on 68 real workbooks, so no specimen. No case is fabricated: a corpus we make only
  // calibrates our own habits. The first real specimen decides.
  if (value.t === "e") return value.v;
  if (value.t === "b") return booleanWord(value.v, language);
  if (value.t === "n") {
    const code = cell.builtinDate14 ? builtinFormat14(language) : format;
    return formatNumberCell(value.v, code, date1904, language) ?? String(value.v);
  }
  // A text cell under a hide-in-place format displays nothing — publishing
  // it raw breached the exposure guard (revue HIGH 28/09 soir, constat 3).
  if (hiddenTextFormat(format)) return "";
  return value.v;
};

/** The PUBLISHED grid of a sheet, before any cell is materialized: the kept
 *  rows and columns (hidden and fully empty ones out, `sheet-grid.ts`), and
 *  the text of the cells that show something. The withheld decision
 *  (100×10 cap) reads THESE counts alone — building and formatting a
 *  100 000-row grid just to discard it was the whole cost (revue HIGH 28/09
 *  soir, constat 9). Only the cells `xlsx-cells.ts` actually HAS are walked,
 *  never a declared range (constat 10's protection is now structural: our
 *  reader never iterates one at all, `xlsx-cells.ts#readSheetCells`). */
interface KeptGrid extends KeptLines {
  textAt: (r: number, c: number) => string;
  boldAt: (r: number, c: number) => boolean;
}

const keptGridOf = (sheet: SheetCells, date1904: boolean, language: PageLanguage): KeptGrid => {
  // row → column → text: numeric keys, no cellRef string built per lookup.
  const texts = new Map<number, Map<number, string>>();
  const filled: [number, number][] = [];
  // row → bold columns: numeric keys like `texts` (a whole bold sheet would otherwise build one string per cell).
  const bold = new Map<number, Set<number>>();
  for (const [addr, cell] of sheet.cells) {
    const at = parseCellRef(addr);
    if (!at) continue; // unreachable: every key here is our own cellRef(r, c)
    // A cell in a hidden row or column is dropped whatever it shows
    // (`keptLinesOf`): never formatted.
    if (sheet.hiddenRows.has(at.r) || isColHidden(sheet, at.c)) continue;
    const text = cellText(cell, date1904, language);
    if (text.length === 0) continue;
    let row = texts.get(at.r);
    if (row === undefined) texts.set(at.r, (row = new Map()));
    row.set(at.c, text);
    if (cell.bold) {
      let boldRow = bold.get(at.r);
      if (boldRow === undefined) bold.set(at.r, (boldRow = new Set()));
      boldRow.add(at.c);
    }
    filled.push([at.r, at.c]);
  }
  const lines = keptLinesOf(
    filled,
    (r) => sheet.hiddenRows.has(r),
    (c) => isColHidden(sheet, c),
  );
  return { ...lines, textAt: (r, c) => texts.get(r)?.get(c) ?? "", boldAt: (r, c) => bold.get(r)?.has(c) ?? false };
};

/** Rows the sheet's `<autoFilter>` hides, below the filter's header row, that hold a cell showing something: left out of the
 *  page, counted so the document says it. A hidden row outside the filter range or without any text is not counted. */
const filteredRowsOf = (sheet: SheetCells, sheetXml: XNode, date1904: boolean, language: PageLanguage): number => {
  if (sheet.hiddenRows.size === 0) return 0;
  const range = parseRange(attr(child(sheetXml, "autoFilter") ?? {}, "ref"));
  if (!range) return 0;
  const withText = new Set<number>();
  for (const [addr, cell] of sheet.cells) {
    const at = parseCellRef(addr);
    if (!at || withText.has(at.r) || at.r <= range.s.r || at.r > range.e.r || !sheet.hiddenRows.has(at.r)) continue;
    if (cellText(cell, date1904, language).length > 0) withText.add(at.r);
  }
  return withText.size;
};

const sheetToTable = (sheet: SheetCells, grid: KeptGrid): Extract<IRBlock, { kind: "table" }> => {
  const merges = sheet.merges.map((m) => ({ startRow: m.s.r, startCol: m.s.c, endRow: m.e.r, endCol: m.e.c }));
  return tableOfKept(grid, merges, (r, c): Inline => {
    const text = grid.textAt(r, c);
    // A cell link's EXTERNAL target is published RAW — the scheme filter
    // lives at the one door (`lib/link-schemes.ts#PUBLISHED_SCHEME`,
    // arbitrage 5: no copy here). The internal forms (`#'Feuille'!A1`)
    // are refused by provenance (`INTERNAL_HREF_FORM`): a file's own
    // target must never reach the renderer's internal handling — the
    // cross-sheet link becomes plain text, limit written.
    const href = externalLinkAt(sheet, r, c);
    return { text, ...(href !== undefined ? { href } : {}), ...(grid.boldAt(r, c) ? { marks: ["strong" as const] } : {}) };
  });
};

// Async and `{ doc, images }` since the lot tableurs (step 0, 28/09/2026):
// anchored images (step 9) and XML part reads will need both; the mechanical
// widening comes first so every later step is a behavior change only.
export const extractXlsx = async (bytes: Uint8Array, pageLanguage?: PageLanguage, limits?: ReaderLimits): Promise<{ doc: IRDoc; images: RawImage[]; notices: DocumentNotice[] }> => {
  // The OPC inventory FIRST (revue HIGH 28/09 soir, constat 2): its
  // `openPackage` runs the CFB classification, so a password-protected or
  // legacy-binary workbook refuses NAMED.
  const { pkg, sheets: inventory, workbookXml } = await readWorkbookSheets(bytes);
  // The workbook-wide tables (shared strings, style formats, date system):
  // ONE read for the whole workbook, shared by every sheet below.
  // `workbookXml` is `readWorkbookSheets`'s own parse of `xl/workbook.xml` —
  // passed back rather than re-read (`xlsx.read-once.test.ts`).
  const workbook = await readWorkbookCells(pkg, workbookXml);

  // Sheet parts parsed ahead for the language sample are kept here until their sheet opens: one inflate per part.
  const preparsed = new Map<string, Promise<XNode | undefined>>();
  // The cells built for that sample are kept with them: a sheet's cells are built once.
  const prebuilt = new Map<string, SheetCells>();
  const readSheetXml = (path: string): Promise<XNode | undefined> => {
    const ahead = preparsed.get(path);
    if (ahead === undefined) return pkg.readXml(path);
    preparsed.delete(path);
    return ahead;
  };

  // Language of the numbers, dates and booleans (decision 08/10/2026): a format code naming its language wins (xlsx-number-format);
  // else the language OF THE DOCUMENT, detected from a bounded sample of its cell texts (French or English only);
  // else the page language. An omitted `pageLanguage` (direct callers) skips detection and keeps the English default.
  // The sample is the text of PUBLISHED cells only (« Rien d'invisible »): no hidden sheet, row or column, no unreferenced string.
  let language: PageLanguage = pageLanguage ?? "en";
  if (pageLanguage !== undefined) {
    const parts: string[] = [];
    let used = 0;
    let visible = 0; // the sheets the tab cap can open: no more are read ahead
    for (const info of inventory) {
      if (used >= LANGUAGE_SAMPLE_CHARS) break;
      if (info.state !== "visible") continue;
      if (visible >= (limits?.workbookTabs ?? NO_CAP)) break;
      // SLOTS MIRROR THE PUBLISH PATH (open() below; revue 27/10/2026, tour 7): an unrecognised kind or a worksheet whose
      // part is GONE gets no tab, so it consumes no sample slot either — counting it dropped the sheet sitting at the cap
      // out of the sample although the page publishes it. A chartsheet takes its slot but has no cells to sample.
      if (info.kind === "chartsheet") {
        visible++;
        continue;
      }
      if (info.kind !== "worksheet") continue;
      const ahead = pkg.readXml(info.partPath);
      ahead.catch(() => undefined); // a damaged part is reported by the sheet's own open(), as before
      preparsed.set(info.partPath, ahead);
      const xml = await ahead.catch(() => undefined);
      if (xml === undefined) continue;
      visible++;
      const sheet = await readSheetCells(pkg, info.partPath, xml, workbook).catch(() => undefined);
      if (sheet === undefined) continue;
      prebuilt.set(info.partPath, sheet);
      for (const [addr, cell] of sheet.cells) {
        if (used >= LANGUAGE_SAMPLE_CHARS) break;
        if (cell.value.t !== "s") continue;
        const at = parseCellRef(addr);
        if (!at || sheet.hiddenRows.has(at.r) || isColHidden(sheet, at.c)) continue;
        parts.push(cell.value.v);
        used += cell.value.v.length + 1;
      }
    }
    const detected = detectLanguageFromSample(parts.join("\n"));
    if (detected === "fr" || detected === "en") language = detected;
  }

  // ONE tabs block — a sheet is a native tab (decisions (e)+(n), Mikolaj):
  // the same shape the presentations deliver, so the renderer and the page
  // ceilings already know it. Caps are DISPLAY caps counted AFTER the
  // retreats: a too-large sheet keeps its tab, which says why; the sheets
  // beyond MAX_WORKBOOK_TABS are named to the dashboard (`workbook-cap` notice).
  // Charts read through the pptx chart reader (decision (g)): title + the
  // cached data table, under the sheet's own table.
  let chartsWithheld = 0;
  let imagesMissing = 0;
  let filteredRows = 0;
  const chartBlocksOf = async (chartParts: readonly string[], unresolved = 0): Promise<IRBlock[]> => {
    const blocks: IRBlock[] = [];
    chartsWithheld += unresolved; // a chart frame with no resolvable relationship: said like a missing part
    for (const chartPart of chartParts) {
      // A damaged chart part is left out, the sheets stay published (audit 07/10/2026; like the pptx reader).
      const { block, withheld } = chartToIr(await readChartOrWithheld(pkg, chartPart, { picture: false, limits }));
      if (withheld) chartsWithheld++; // kept out (damaged part or a bound): said, one folded notice
      else if (block) blocks.push(block);
    }
    return blocks;
  };

  // Anchored pictures (decision (h)): image blocks UNDER the table, no alt
  // text ever, through the shared collector (oversize reduction included).
  const collector = new ImageCollector();
  // The workbook-wide inflated-bytes budget of the pictures, the docx and pptx rule (`readBytes(target, budget)`: a read is
  // refused past what is left, so a total exactly at IMAGE_MAX_TOTAL_BYTES passes). A part used several times is read and
  // counted once; its outcome (`undefined`: damaged) is remembered for the next use.
  let imageBudget = limits?.payloadBytes ?? IMAGE_MAX_TOTAL_BYTES;
  const readParts = new Map<string, ImageRef | undefined>();
  const imageBlocksOf = async (pictureParts: readonly string[], unresolved: number): Promise<IRBlock[]> => {
    const blocks: IRBlock[] = [];
    imagesMissing += unresolved; // linked externally or a relationship that does not resolve: said like a missing part
    for (const picturePart of pictureParts) {
      if (!readParts.has(picturePart)) {
        const raw = await orDamaged(() => pkg.readBytes(picturePart, imageBudget));
        if (raw !== undefined) imageBudget -= raw.byteLength;
        readParts.set(picturePart, raw === undefined ? undefined : collector.collect(raw, listedMimeType(pkg.contentType(picturePart))));
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
    inventory.map((info): SheetSource => ({
      name: info.name,
      // The hidden-tab guard reads ONE source, the OPC inventory (revue HIGH 29/09, constat 9): a tab it does not list as
      // `visible` — hidden, veryHidden, or absent — is never published, and its part is never even read.
      visible: info.state === "visible",
      open: async (): Promise<SheetBody | "part-missing" | undefined> => {
        // A chart-only tab (chartsheet) has no grid at all: its tab is its charts, and it COUNTS among the tab slots (decision (g)).
        if (info.kind === "chartsheet") return { extras: async () => {
          const drawn = await drawingPartsOf(pkg, info.partPath);
          return chartBlocksOf(drawn.charts, drawn.unresolvedCharts);
        } };
        if (info.kind !== "worksheet") return undefined; // an unrecognised relationship kind: nothing to publish, never guessed
        const partPath = info.partPath;
        // ONE inflate+parse of the sheet's XML part, shared by every consumer below (revue HIGH 28/09 soir, constat 6).
        const sheetXml = await readSheetXml(partPath);
        if (!sheetXml) return "part-missing"; // the workbook declares a sheet whose part is gone: no tab, said (08/10/2026)
        const sheet = prebuilt.get(partPath) ?? (await readSheetCells(pkg, partPath, sheetXml, workbook));
        prebuilt.delete(partPath);
        const grid = keptGridOf(sheet, workbook.date1904, language);
        return {
          grid: {
            lines: grid,
            hiddenRows: sheet.hiddenRows,
            table: () => sheetToTable(sheet, grid),
            // The DECLARED header (decision (d), `xlsx-parts.ts#declaredHeaderRows`), marked by `sheet-workbook.ts`.
            header: () => declaredHeaderRows(pkg, partPath, sheetXml),
            notices: () => {
              filteredRows += filteredRowsOf(sheet, sheetXml, workbook.date1904, language);
              // The formula line counts only what the PUBLISHED grid shows (constat 8).
              const visibleNoValue = sheet.formulasWithoutValue.filter((at) => grid.keptRowSet.has(at.r) && grid.keptColSet.has(at.c)).length;
              return visibleNoValue > 0 ? [{ kind: "formula-cells-empty", sheet: cutNoticeName(info.name), count: visibleNoValue }] : [];
            },
          },
          // ONE walk of the drawings for charts AND pictures (revue HIGH 29/09, constat 10): each drawing part is inflated once.
          extras: async () => {
            const drawn = await drawingPartsOf(pkg, partPath, sheetXml);
            return [...(await chartBlocksOf(drawn.charts, drawn.unresolvedCharts)), ...(await imageBlocksOf(drawn.pictures, drawn.unresolvedPictures))];
          },
        };
      },
    })),
    limits,
  );
  preparsed.clear(); // a sheet read ahead but never opened is not kept
  prebuilt.clear();
  notices.push(...unpublishedPartNotices({ chartsWithheld, imagesMissing, filteredRows }));
  if (workbook.stylesUnreadable) notices.push({ kind: "styles-defaulted" });
  return { doc: { blocks: tabs.length > 0 ? [{ kind: "tabs", tabs }] : [] }, images: collector.images, notices };
};
