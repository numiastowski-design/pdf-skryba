/** What a CALLER may set on a reading, in one place (review of 30/10/2026: the dispatch over every format and the reader
 *  `extractor/pdf-scanned.ts` each carried a copy, field for field — two copies of an option end up with different
 *  fields, and the reader is the one that loses the field just added).
 *  Decides: nothing. It is a shape, and every field of it is optional: the app gives some, a third party all or none.
 *  NOT here: what each field means (`lib/reader-limits.ts#ReaderLimits`, `lib/page-labels.ts#PageLabelOverride`), nor
 *  what a reading does with it (the readers, and the app's dispatch).
 *  Called by: `extractor/pdf-scanned.ts`, and the app's `src/readers/dispatch.ts` through the published door `lib/pdf.ts`. */

import type { PageLabelOverride } from "doc-ir";
import type { PageLanguage } from "doc-ir";
import type { ReaderLimits } from "doc-ir";

export interface ExtractOptions {
  /** The languages the AI reading may use, when the caller knows them. */
  languages?: string[];
  /** The ONE language the page's labels are written in. */
  pageLanguage?: PageLanguage;
  /** `false` forbids the AI reading of a scan outright. */
  ocr?: boolean;
  /** With `ocr: false`, a PDF every page of which is scanned is returned as page images instead of being refused
   *  (`SCANNED_PDF_NEEDS_AI_OCR`): the caller decides alone whether such a file is acceptable (the manual upload does, by page count). */
  scanAsImages?: boolean;
  /** Read every page, not only the first ones. */
  readAll?: boolean;
  /** The ceilings the caller moves (`lib/reader-limits.ts`). */
  limits?: ReaderLimits;
  /** The caller's own words in place of ours (`lib/page-labels.ts`). */
  labels?: PageLabelOverride;
}
