/** A .docx turned into an IR document by our own reader: its declared headings, lists, tables, text boxes, equations
 *  and notes, with the raw image bytes alongside, keyed by sha256, for a later step to persist
 *  (MIKSUDOC « Spécification technique » §5.4). Pure: no I/O beyond the bytes it is given.
 *  Decides: nothing of its own; it names the reading of a .docx file.
 *  NOT here: reading the WordprocessingML (`extractor/docx-reader/`), nor persisting the images
 *  (`orchestrator/doc-processor.ts`).
 *  Called by: `extractor/dispatch.ts`, `tools/bench/render.ts`, `tools/ooxml-output-hash.ts`,
 *  `tools/structure-truth/run.ts`, `features/step-definitions/text-conservation.steps.ts`. */

import type { PageLabelOverride } from "doc-ir/lib/page-labels";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { type DocxReadResult, readDocx } from "./docx-reader";

// One declaration, in the reader; this name is its alias.
export type DocxExtractResult = DocxReadResult;

// No catch-all here: the archive and XML layers already answer our message for a damaged file, so a TypeError from
// OUR reader stays ours (UNKNOWN, retried, visibly our defect) instead of blaming the user's document.
export const extractDocx = async (
  bytes: Uint8Array,
  limits?: ReaderLimits,
  labels?: PageLabelOverride,
): Promise<DocxExtractResult> => readDocx(bytes, undefined, undefined, limits, labels);
