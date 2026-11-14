/**
 * THE READER-FREE HALF OF THE DECLARED-FORMATS PACKAGE (`docs-scribe/light`): the conservation check of a document
 * that declares its structure, and the shapes it speaks in. Importing this loads no reader, no zip, no XML.
 *
 * HOW THIS CHECK DIFFERS FROM THE PDF'S, and why they are two. A declared format says what its text is, so the check
 * COMPARES two readings of the same file — the one that produced the page and an independent one — and reports the
 * words the page lacks, grouped by cause. It never repairs: a word missing from a page built out of declared text is a
 * defect of OUR reader, not a render accident to paper over (MIKSUDOC « Spécification technique » T11). The PDF's
 * check is the opposite: nothing declares its text, so it tiles words and letters, and it DOES repair what it can
 * prove — that half lives in `skryba/light`.
 *
 * NOT here: the readers (`lib/docs.ts`, the package's main entry), the PDF's check, nor anything that reads a RENDERED
 * page — knowing a markup belongs to whoever owns it, and this check takes the page as TEXT, block by block.
 * Called by: nobody in this repository — it is a PUBLISHED door, so its callers are third parties that install
 * the package, and `tools/build-library.ts`, which builds it and holds what it may reach.
 */

export { conservationFromMissingWordGroups, missingWordGroups, pageWords } from "../pipeline/declared-format-conservation";
export { isDeclaredFormatSource, isReadFailure } from "../pipeline/conservation-source";
export type {
  ConservationNumericCell,
  ConservationSourceReadFailure,
  ConservationUnit,
  DeclaredFormatConservationSource,
  MissingWordCauseGroup,
  StructureFormat,
  UnitStructure,
} from "../pipeline/conservation-source";

/** The page as a check reads it: the TEXT of each published block, never a markup. */
export type { PageEdit, PublishedPage } from "doc-ir/pipeline/text-conservation";
export { conservationKey, wordKeysOf } from "doc-ir/pipeline/text-conservation";

/** The structure control, beside the words and independent of them: counts declared, published and withheld. */
export { addCounts, emptyCounts, isZeroCounts, subtractCounts } from "../pipeline/structure-counts";

/** The document the readers hand back, and what they could not publish. */
export type { ChartDrawing, IRBlock, IRDoc, IRTab, ImageRef, Inline, InlineMark, TableData } from "doc-ir/lib/ir";
export type { DocumentConservation, DocumentNotice, DocumentStructure, MissingWordCause, PageLanguage, StructureCounts } from "doc-ir/lib/reader-types";
export { ReaderError } from "doc-ir/lib/reader-error";
export type { ReaderCountDetail } from "doc-ir/lib/reader-error";
export type { ReaderLimits } from "doc-ir/lib/reader-limits";
export { MAX_PAYLOAD_BYTES, cutNoticeName } from "doc-ir/lib/reader-limits";
export type { VisionPort, VisionResult } from "doc-ir/lib/vision-port";
export type { PageLabelOverride } from "doc-ir/lib/page-labels";
export { DOCX_MIME, PPTX_MIME, XLSX_MIME, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, isGoogleNative } from "./mime-types";
/** Classer un type MIME, et savoir si c'en est un de classeur : `extractor/mime.ts`, pas la table des constantes. */
export { classifyMimeType, isSupportedKind, isWorkbookKind } from "../extractor/mime";
