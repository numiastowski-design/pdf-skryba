/** A Google Doc's DOCX export turned into an IR document, through the same
 *  reader a .docx file goes through.
 *  NOT here: fetching the export (`adapters/forge-drive.ts`), nor reading the
 *  WordprocessingML (`extractor/docx-reader/`).
 *  Called by: `extractor/dispatch.ts`. */

/**
 * Google Docs extractor (MIKSUDOC « Spécification technique » §5.4) — the `files.export` output in
 * the Word format (the docx reader (`extractor/docx-reader/`): the export that
 * declares everything, text boxes and equations included,
 * docs/PLATFORM-STATUS.md §53) → IRDoc via the docx reader, the one a
 * .docx file uses: one format, one reader. Pure: no I/O beyond the bytes
 * it's given — fetching the export is the adapter's job. (The zipped HTML
 * export this replaced, and its converter, were removed on 24/09/2026; the
 * analysis of that export stays in docs/FORMAT-GOOGLE-DOC.md [purged 27/09/2026, git history].)
 */

import { ReaderError } from "doc-ir/lib/reader-error";
import type { PageLabelOverride } from "doc-ir/lib/page-labels";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { type DocxReadResult, type GoogleDrawingSource, readDocx } from "./docx-reader";

// One declaration, in the reader (review of 27/09/2026 night, finding 15).
export type GoogleDocExtractResult = DocxReadResult;

/** Our message for a damaged export: an archive or XML library's own words
 *  never travel (CLAUDE.md, errors composed by us). */
const UNREADABLE = "the Google Docs export could not be opened";
const unreadable = (): ReaderError => new ReaderError("EXTRACT_FAILED", UNREADABLE);

// No blanket net (review of 27/09/2026 night, finding 6 — the one docx and
// pptx lost on 27/09 evening): the reader's zip and XML layers answer
// `unreadable()` for a damaged export, while a TypeError of OUR reader stays
// ours — UNKNOWN, retried, visibly our defect — never blamed on the export.
//
// `google`: where Google's own image of a drawing comes from (D2 voie A,
// MIKSUDOC « Spécification fonctionnelle » §9.5) — asked only when a drawing is drawn.
export const extractGoogleDoc = async (docxBytes: Uint8Array, google?: GoogleDrawingSource, limits?: ReaderLimits, labels?: PageLabelOverride): Promise<GoogleDocExtractResult> =>
  readDocx(docxBytes, unreadable, google, limits, labels);
