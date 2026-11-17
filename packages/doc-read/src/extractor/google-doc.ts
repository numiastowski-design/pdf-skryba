/** A Google Doc's Word export turned into an IR document, through the same reader a .docx file goes through: one
 *  format, one reader (MIKSUDOC « Spécification technique » §5.4). The Word export is taken because it declares text
 *  boxes and equations (docs/PLATFORM-STATUS.md §53); the zipped HTML export it replaced, and its converter, were removed
 *  on 24/09/2026. Pure: no I/O beyond the bytes it is given.
 *  Decides: the message a damaged export gets (`UNREADABLE`).
 *  NOT here: fetching the export (`adapters/forge-drive.ts`), nor reading the WordprocessingML
 *  (`extractor/docx-reader/`).
 *  Called by: `extractor/dispatch.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import type { PageLabelOverride } from "doc-ir/lib/page-labels";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { type DocxReadResult, type GoogleDrawingSource, readDocx } from "./docx-reader";

// One declaration, in the reader; this name is its alias.
export type GoogleDocExtractResult = DocxReadResult;

/** Our message for a damaged export: an archive or XML library's own words never travel (errors are composed by us). */
const UNREADABLE = "the Google Docs export could not be opened";
const unreadable = (): ReaderError => new ReaderError("EXTRACT_FAILED", UNREADABLE);

// No catch-all: the reader's zip and XML layers answer `unreadable()` for a damaged export, while a TypeError of OUR
// reader stays ours (UNKNOWN, retried, visibly our defect), never blamed on the export.
//
// `drawingSource`: where Google's own image of a drawing comes from (D2 voie A,
// MIKSUDOC « Spécification fonctionnelle » §9.5), asked only when a drawing is drawn.
export const extractGoogleDoc = async (
  docxBytes: Uint8Array,
  drawingSource?: GoogleDrawingSource,
  limits?: ReaderLimits,
  labels?: PageLabelOverride,
): Promise<GoogleDocExtractResult> => readDocx(docxBytes, unreadable, drawingSource, limits, labels);
