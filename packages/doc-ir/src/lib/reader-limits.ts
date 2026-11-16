/** The size limits a reading enforces on ONE document, and the notice builders for the parts a cap leaves out
 *  (`unpublishedPartNotices`, `workbookCapNotice`, `sheetUnreadableNotice`, `cutNoticeName`).
 *
 *  ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 *  TWO FAMILIES, AND ONLY ONE OF THEM HAS A VALUE HERE (09/11/2026)
 *  ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 *  A ceiling shaped by the DESTINATION — the pages of a PDF, the slide tabs and the elements of a slide, the sheet
 *  tabs, the rows and columns of a sheet and of a table — is not the library's business: it is the size of one
 *  Confluence page, a product decision of Miksumia Publisher. Those seven live in the APP
 *  (`core/document-caps.ts#PRODUCT_READER_LIMITS`), which passes them as `limits` at the two call sites that read a
 *  document. Here they default to `NO_CAP`: **a reading given no `limits` withholds nothing**, and a consumer of the
 *  published library (`skryba`) sets its own, or none.
 *  A bound that protects the READER keeps its value here, and is only lowerable: the byte ceiling of a payload, the
 *  chart bounds, and — in their own files — the zip, XML and PDF decoding budgets. A reader that reads without bounds
 *  is a bomb whatever its caller asked for, so those are never `NO_CAP`.
 *
 *  Decides: `NO_CAP` and the reader's own bounds below, how a notice names what a cap kept out, and `ReaderLimits`,
 *  the object a reading takes to set any cap (a field left out is `NO_CAP` for the seven, the bound below for the rest).
 *  NOT here: the seven product ceilings and `exceedsDocumentPageCap` (`core/document-caps.ts`), the limit of documents
 *  of a CONNECTION (`core/document-caps.ts#PAGE_COUNT_HARD_LIMIT`), the monthly scan quota (`core/ai-budget.ts`), the
 *  comb threshold of a PDF strip of boxes (`extractor/pdf-table-render.ts#COMB_MIN_COLUMNS`, a geometry heuristic that
 *  withholds nothing), nor what a refusal becomes (`orchestrator/doc-queue.ts`, `orchestrator/sync-plan.ts`).
 *  Called by: `extractor/` (PDF, docx, pptx, xlsx and sheet readers), `pipeline/source-reading-{xlsx,pptx,gsheet,chart}.ts`,
 *  `pipeline/structure-conservation.ts`, `lib/table-width-cap.ts`, `adapters/conservation-log.ts`,
 *  `orchestrator/page-cap.ts` through its re-export, and `tools/bench/`. */

import type { DocumentNotice } from "./reader-types";

/**
 * NO_CAP — what a reading uses when its caller set no ceiling for one of the seven DESTINATION caps (the pages of a
 * PDF, the slide tabs, the elements of a slide, the sheet tabs, the rows and columns of a sheet and of a table).
 * **Nothing is withheld.** The library reads what the file holds; deciding that a document is too big for the page it
 * is going to is the caller's decision, and `core/document-caps.ts#PRODUCT_READER_LIMITS` is Miksumia Publisher's.
 *
 * `Number.MAX_SAFE_INTEGER`, not `Infinity`, for the readers that consume these fields: every one only COMPARES
 * (`>`, `>=`), SLICES (`slice(0, n)`) or SUBTRACTS from a budget (`budget.left -= count`), none allocates in
 * proportion to a cap, and an integer stays an integer where a notice or a message would otherwise print
 * « Infinity » or carry `cap + 1` (reached only past the cap, so never). The same reasoning the app wrote for its own
 * lifted upload limits on 07/11/2026, now the library's default — which is why that object could be deleted.
 */
export const NO_CAP = Number.MAX_SAFE_INTEGER;

/** The ONE byte ceiling of a payload read or inflated for a document (08/10/2026): a direct download
 *  (`adapters/forge-drive.ts#BINARY_MAX_BYTES`), an export link (`EXPORT_LINK_MAX_BYTES`) and the images a docx, pptx or xlsx
 *  inflates (`extractor/ooxml/package.ts#IMAGE_MAX_TOTAL_BYTES`) derive from it. NOT derived: Google's own 10 MB
 *  HTML export limit and `SHEETS_META_MAX_BYTES`. */
export const MAX_PAYLOAD_BYTES = 50_000_000;

/** How many sheet names a `workbook-cap` notice carries (`lib/reader-types.ts#DocumentNotice`):
 *  the record stays small however many sheets a workbook has — the rest is
 *  only counted (`more`). Starting value to calibrate (owner design, 30/09/2026). */
export const MAX_NOTICE_SHEET_NAMES = 5;

/** How many LOST PICTURE PLACES a `pdf-image-unread` notice names (`lib/reader-types.ts#DocumentNotice`): the same
 *  display bound as the sheet names, and for the same reason — a dialog line, not a log; the rest is only counted
 *  (`more`). 03/11/2026: a count with nowhere to look is not a report. */
export const MAX_NOTICE_IMAGE_PLACES = MAX_NOTICE_SHEET_NAMES;

/** A sheet name is client text: a notice keeps at most this many characters
 *  of it (then « … »). The dev log's missing words are cut by the same `cutNoticeName`, at the same value as
 *  `pipeline/declared-format-conservation.ts#MISSING_WORD_SHOWN_MAX_CHARS` (held equal by `core/reader-limits.test.ts`;
 *  this file imports no other reader file). */
export const MAX_NOTICE_SHEET_NAME_CHARS = 64;

/** Client text as a notice or the dev log carries it: bounded, never the whole string. */
export const cutNoticeName = (name: string): string => (name.length > MAX_NOTICE_SHEET_NAME_CHARS ? `${name.slice(0, MAX_NOTICE_SHEET_NAME_CHARS)}…` : name);

/** The folded notices of parts a reader kept out, one line per kind and only when counted: charts withheld whole (a bound,
 *  a damaged part: `chart-withheld`), pictures whose part is damaged (`image-missing`), and hidden content dropped
 *  (`hidden-dropped`, one per `what`; 08/10/2026). The same lines for every format (07/10/2026). */
export const unpublishedPartNotices = (counts: {
  chartsWithheld: number;
  imagesMissing: number;
  hiddenShapes?: number;
  filteredRows?: number;
  trackedDeletions?: number;
  tablesWithheld?: number;
}): Extract<DocumentNotice, { kind: "chart-withheld" | "image-missing" | "hidden-dropped" | "table-withheld" }>[] => [
  ...(counts.chartsWithheld > 0 ? [{ kind: "chart-withheld" as const, count: counts.chartsWithheld }] : []),
  ...(counts.imagesMissing > 0 ? [{ kind: "image-missing" as const, count: counts.imagesMissing }] : []),
  ...(counts.tablesWithheld !== undefined && counts.tablesWithheld > 0 ? [{ kind: "table-withheld" as const, count: counts.tablesWithheld }] : []),
  ...(([["shape", counts.hiddenShapes], ["filtered-rows", counts.filteredRows], ["tracked-deletion", counts.trackedDeletions]] as const).flatMap(([what, count]) =>
    count !== undefined && count > 0 ? [{ kind: "hidden-dropped" as const, what, count }] : [],
  )),
];

const boundedSheetNames = (names: readonly string[]): { sheets: string[]; more: number } => ({
  sheets: names.slice(0, MAX_NOTICE_SHEET_NAMES).map(cutNoticeName),
  more: Math.max(0, names.length - MAX_NOTICE_SHEET_NAMES),
});

/** The `workbook-cap` notice of the sheets left beyond the cap: at most
 *  `MAX_NOTICE_SHEET_NAMES` cut names, the others counted in `more`. */
export const workbookCapNotice = (beyondCap: readonly string[]): { kind: "workbook-cap"; sheets: string[]; more: number } => ({
  kind: "workbook-cap",
  ...boundedSheetNames(beyondCap),
});

/** The `sheet-unreadable` notice of visible sheets whose part is absent: the same bounds as `workbook-cap`. */
export const sheetUnreadableNotice = (names: readonly string[]): { kind: "sheet-unreadable"; sheets: string[]; more: number } => ({
  kind: "sheet-unreadable",
  ...boundedSheetNames(names),
});

/** Starting value to calibrate: the most cells (rows × columns) one chart
 *  table may hold. A legitimate chart is hundreds of cells (10 000 rows of
 *  3 columns is 30 000); the product of the point and series bounds alone
 *  allows hundreds of millions. Past it the chart is withheld whole. */
export const MAX_CHART_CELLS = 200_000;

/** Starting value to calibrate: the most series (`c:ser`) one chart may
 *  hold. Excel's own limit is 255 series per chart; the repo's fixtures hold
 *  a handful. Checked BEFORE any series' array is built: 5 000 series of one
 *  point each (620 KB of XML) used to cost 13 s and 435 MB. Past it the whole
 *  chart is withheld (décision B). */
export const MAX_CHART_SERIES = 255;

/** Starting value to calibrate: the largest chart-cache `idx` kept. The chart caches of the repo's fixtures count their points in the
 *  hundreds; the bound guards against a declared `c:ptCount` of 2 000 000 000. A point at or past it withholds the chart whole. */
export const MAX_CHART_POINTS = 10_000;

/** Starting value to calibrate: the most category levels (`c:multiLvlStrCache`) of one chart. Word-made charts group categories two or three
 *  deep; a cache of 2 000 levels built 4 002 000 cells. A ninth level withholds the chart whole. */
export const MAX_CHART_LEVELS = 8;

/** The limits a reading takes as a PARAMETER (docs/PLAN-BIBLIOTHEQUE.md §5, step 5): one optional object handed to a reader.
 *  **The seven destination caps are `NO_CAP` when left out** — a reading given no limits withholds nothing, and the caller
 *  that wants the size of a Confluence page asks for it (`core/document-caps.ts#PRODUCT_READER_LIMITS`). The other fields
 *  default to the reader's own bound, the constant above that each one mirrors, and can only be lowered usefully.
 *  Read where the cap bites, always as `limits?.field ?? NO_CAP` or `?? BOUND`: never copied into a default object.
 *  Two readings of one document (the extraction and its independent conservation source) must be given the SAME limits, or they
 *  withhold different tables, sheets and slides and the check reports a loss that is only a difference of cap.
 *  Not a field: the notice names (`MAX_NOTICE_SHEET_NAME*`, how a notice is written, not what a reading withholds) and the
 *  layout threshold past which a PDF strip of boxes is a comb written as spaced letters
 *  (`extractor/pdf-table-render.ts#COMB_MIN_COLUMNS`: not a cap, no content is withheld by it). */
export interface ReaderLimits {
  /** PDF only: more pages than this and the document is refused. `NO_CAP` by default. */
  readonly pageLimit?: number;
  /** The byte ceiling of the pictures a document inflates (`MAX_PAYLOAD_BYTES`, a reader bound). */
  readonly payloadBytes?: number;
  /** Elements one slide, drawing or SmartArt may hold. `NO_CAP` by default. */
  readonly slideElements?: number;
  /** Slide tabs a presentation page shows. `NO_CAP` by default. */
  readonly presentationTabs?: number;
  /** Sheet tabs a workbook page shows. `NO_CAP` by default. */
  readonly workbookTabs?: number;
  /** Rows of a worksheet tab. `NO_CAP` by default. */
  readonly sheetRows?: number;
  /** Columns of a worksheet tab. `NO_CAP` by default. */
  readonly sheetCols?: number;
  /** Rows of a table of any format. `NO_CAP` by default. */
  readonly tableRows?: number;
  /** Columns of a table of any format. `NO_CAP` by default. */
  readonly tableCols?: number;
  /** Cells of one chart table (`MAX_CHART_CELLS`). */
  readonly chartCells?: number;
  /** Series of one chart (`MAX_CHART_SERIES`). */
  readonly chartSeries?: number;
  /** The largest chart-cache index kept (`MAX_CHART_POINTS`). */
  readonly chartPoints?: number;
  /** Category levels of one chart (`MAX_CHART_LEVELS`). */
  readonly chartLevels?: number;
}
