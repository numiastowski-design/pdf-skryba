/** A .docx turned into an IR document by our own reader
 *  (`extractor/docx-reader/`): its declared headings, lists, tables, text
 *  boxes, equations and notes read as ECMA-376 writes them, with raw image
 *  bytes travelling alongside.
 *  NOT here: reading the WordprocessingML itself (`extractor/docx-reader/`),
 *  nor persisting the images (`orchestrator/doc-processor.ts`).
 *  Called by: `extractor/dispatch.ts`. */

/**
 * docx extractor (MIKSUDOC « Spécification technique » §5.4) — .docx → IRDoc via the docx reader
 * (the docx reader (`extractor/docx-reader/`)). Pure: no I/O beyond the bytes it's given,
 * no storage write. Raw image bytes travel alongside the IRDoc (`images`),
 * keyed by sha256, for a later step to persist via StoragePort and fill
 * `ImageRef.payloadRef`.
 */

import type { PageLabelOverride } from "doc-ir/lib/page-labels";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { type DocxReadResult, readDocx } from "./docx-reader";

// One declaration, in the reader (review of 27/09/2026 night, finding 15).
export type DocxExtractResult = DocxReadResult;

// No blanket net here (27/09/2026 evening review, finding 4 — same fix as
// pptx): the archive and XML libraries' own words are already netted where
// they happen (`ooxml/package.ts#readBytes/readXml`), so
// readDocx answers our message for a damaged file, while a TypeError from
// OUR reader stays OURS — UNKNOWN, retried, visibly our defect — instead of
// blaming the user's document.
export const extractDocx = async (bytes: Uint8Array, limits?: ReaderLimits, labels?: PageLabelOverride): Promise<DocxExtractResult> => readDocx(bytes, undefined, undefined, limits, labels);
