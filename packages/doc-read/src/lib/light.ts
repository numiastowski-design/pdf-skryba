/**
 * The LIGHT door of the reading library: the small, load-free things the app imports from it — the document tree (`ir`) and its one
 * traversal, the report types, the limits and the names of their notices, the MIME tables and classification, the reader's error, the
 * ports it declares (slide image, vision), the published-structure and conservation counts, and the chunk, hash and UTF-8 helpers
 * (docs/PLAN-BIBLIOTHEQUE.md §3 and §5, step 8).
 * Decides: which names the app may take from the library WITHOUT loading its readers — exactly the names the app uses, one line
 * per source module, and nothing else. Its static import graph stays free of `src/extractor/` (but `mime.ts`), `src/layout/` and any
 * PDF, zip or XML package: `app-library-surface.test.ts` holds it, so that a file `light-index` reaches can import this door
 * without `adapters/light-handlers.test.ts` going red and without the PDF reader loading with the dashboard's functions.
 * CAREFUL: `classifyMimeType` and `MimeClassification` are exported by BOTH doors, from two different modules — here from
 *  `../extractor/mime`, and by `./index.ts` from `../extractor`. A test that stubs `vi.mock("../extractor", …)` replaces the
 *  one of `./index.ts` and NOT the one taken from here (contre-revue du 28/10/2026). A file whose test stubs the extractor
 *  takes the name from `./index.ts`.
 * NOT here: the page labels of `./page-labels.ts` — the two app files that write the same strings import that module directly
 *  (`app-library-surface.test.ts` pins how many reach it), so this door never carried them; anything that reads a document or
 *  checks a render (`./index.ts`, the other door), any logic (every name is
 * re-exported from the module that owns it), nor the dashboard's imports (`src/core/import-boundaries.test.ts` names the modules it
 * may embed).
 * Called by: every app file that needs one of these names — `core/`, `orchestrator/`, `adapters/`, `ports/`, `renderer/`, `vision/`,
 * `sim/` and `ai/`; never a library file (held by `app-library-surface.test.ts`).
 */

export { classifyMimeType, isSupportedKind, isWorkbookKind } from "../extractor/mime";
export type { MimeClassification } from "../extractor/mime";
export { chunk } from "./chunk";
export { sha256Hex } from "doc-ir/lib/digest";
export { mapInlines, walkBlocks, walkInlines } from "doc-ir/lib/ir-walk";
export { DIAGRAM_TEXT_SEPARATOR, diagramParagraphs } from "doc-ir/lib/ir";
export type { DiagramTextSection } from "doc-ir/lib/ir";
export type { BlockAlign, ChartDrawing, ColumnsLayout, IRBlock, IRDoc, IRTab, ImageRef, Inline, InlineMark, TableData } from "doc-ir/lib/ir";
export { PUBLISHED_SCHEME } from "doc-ir/lib/link-schemes";
export { DOCX_MIME, EXT_BY_MIME, GOOGLE_DOC, GOOGLE_FOLDER, GOOGLE_SHEET, GOOGLE_SLIDES, PPTX_MIME, SOURCE_TYPE_BY_EXTENSION, XLSX_MIME, isGoogleNative, listedMimeType } from "./mime-types";
export { ReaderError } from "doc-ir/lib/reader-error";
export type { ReaderCountDetail } from "doc-ir/lib/reader-error";
export { MAX_PAYLOAD_BYTES, cutNoticeName } from "doc-ir/lib/reader-limits";
export type { ReaderLimits } from "doc-ir/lib/reader-limits";
export type { DocumentConservation, DocumentNotice, DocumentStructure, MissingWordCause, PageLanguage, PdfToolLabel, PictureRefusal, StructureCounts } from "doc-ir/lib/reader-types";
export type { SlideImage, SlideImagePort, SlidePage } from "./slide-image-port";
export { withoutEmptyTableParts } from "doc-ir/lib/table-empty-parts";
// The CHECKS, which an app file reads a render with (09/11/2026: everything that reads or writes a render is app
// code, so what it needs crosses a door). Values and types only — none of this loads a reader.
export { conservationKey, letterCounts, lostWords, textConservation, wordKeysOf } from "doc-ir/pipeline/text-conservation";
export type { ConservationRule, ConservationRun, ConservationVerdict, PageEdit, PublishedPage } from "doc-ir/pipeline/text-conservation";
export { gluedWordEdits, noWorse } from "../pipeline/glued-word-repair";
// La décision du texte perdu : elle ne lit que des mots, donc elle passe par la porte LÉGÈRE. Celle du recollage est
// sur la porte de lecture : elle a besoin du repérage des puces (`layout/list.ts`), et cette porte-ci doit rester
// libre de toute mise en page — un test le tient.
export { placeLostPassages } from "../pipeline/lost-text-repair";
export type { LostTextAbstention } from "../pipeline/lost-text-repair";
export { conservationFromMissingWordGroups, missingWordGroups } from "../pipeline/declared-format-conservation";
export { isDeclaredFormatSource, isReadFailure } from "../pipeline/conservation-source";
export type { ConservationNumericCell, ConservationSourceReadFailure, DeclaredFormatConservationSource, MissingWordCauseGroup, StructureFormat, UnitStructure } from "../pipeline/conservation-source";
/** What the PDF reader produces, in its own file so the PDF package can publish its types without carrying those of
 *  the declared formats (`pipeline/pdf-conservation-source.ts`). */
export type { ReferenceCycle } from "../pipeline/pdf-conservation-source";
export { addCounts, emptyCounts, isZeroCounts, subtractCounts } from "../pipeline/structure-counts";
export { alignWithRaw, movedPassages } from "../pipeline/letter-diff";
export type { MovedPassages } from "../pipeline/letter-diff";
export { decodeEntities, escapeText } from "./xml";
export type { TableBand } from "doc-ir/layout/page-furniture";
export { utf8Length } from "./utf8";
export type { BinaryRef, VisionPort, VisionResult } from "doc-ir/lib/vision-port";
export { wordsOf } from "./words";
export { element, escapeAttr, parseXmlFragment, serializeXmlFragment, text } from "./xml";
export type { XmlNode } from "./xml";
