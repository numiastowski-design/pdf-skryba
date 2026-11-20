/**
 * The ceilings the tests of the PDF reader read a document with: the page count past which a PDF is refused, and the
 * size of a table past which it is withheld.
 * Decides: the values these tests use, and nothing about a reading: the library holds no destination cap of its own
 * (`doc-ir/lib/reader-limits.ts`: a field left out is `NO_CAP`), a caller sets them, and here the caller is a test.
 * The values are those of a page of the publisher's application on the day the fixtures were written; they are this
 * package's own copy, so that its tests depend on nothing outside it.
 * NOT here: the reader's own bounds (`doc-ir/lib/reader-limits.ts`, `pdf-objects/bounds.ts`), nor the caps of the
 * declared formats' tests (`page-caps.test.support.ts`).
 * Called by: `pdf.test.ts`, `pdf.long-table.test.ts`, `pdf.wide-table.test.ts`, `pdf-open.invalid.test.ts`.
 */

import type { ReaderLimits } from "doc-ir";

/** Pages past which a PDF is refused. */
export const DOCUMENT_PAGE_LIMIT = 15;

/** Rows of a table. */
export const MAX_TABLE_ROWS = 200;

/** Columns of a table. */
export const MAX_TABLE_COLS = 21;

/** The caps above as a reading takes them, in one object. */
export const PAGE_SIZED_LIMITS = {
  pageLimit: DOCUMENT_PAGE_LIMIT,
  tableRows: MAX_TABLE_ROWS,
  tableCols: MAX_TABLE_COLS,
} as const satisfies ReaderLimits;
