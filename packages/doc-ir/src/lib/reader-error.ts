/** The ONE failure the reading library throws: a code from a closed list, a message composed by us, and — for a PDF refusal — the
 *  two page counts as structured fields, so no caller ever parses the message. A LEAF module: it imports nothing.
 *  Decides: which codes a reading may end with (the nine below, nothing else), and that a failure of a FOREIGN service the reading
 *  calls (the optional OCR) travels as `cause`, unread: the library does not interpret it, whoever called the reading may.
 *  NOT here: what a code means to the product (retry, dead letter, wording: `core/errors.ts`), nor the conversion to the app's
 *  `AppError` (`core/reader-bridge.ts`, which fails to compile if a code here is not an `ErrorCode` there).
 *  Called by: every reader that refuses a file (`extractor/`, `pipeline/source-reading-package.ts`), and `core/reader-bridge.ts`. */

/** The closed list, in one array so a test reads the same words the type is made of. */
export const READER_ERROR_CODES = [
  "EXTRACT_FAILED",
  "FILE_UNSAFE",
  "UNSUPPORTED_TYPE",
  "DOCUMENT_PASSWORD_PROTECTED",
  "DOCUMENT_TOO_MANY_PAGES",
  "SCANNED_PDF_NEEDS_AI_OCR",
  "OCR_LOW_CONFIDENCE",
  "NO_PUBLISHABLE_SHEET",
  "UNKNOWN",
] as const;

export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

/** The numbers a PDF refusal carries: `scannedPageCount` is the pages to read (all of them for a scan); absent when the refusal came
 *  before anything was read (the page-count cap). */
export interface ReaderCountDetail {
  pageCount?: number;
  scannedPageCount?: number;
}

export class ReaderError extends Error {
  readonly pageCount?: number;
  readonly scannedPageCount?: number;

  /** `options.cause`: what a foreign service threw (the library's `UNKNOWN` « the AI reading failed »). Never part of the message. */
  constructor(
    public readonly code: ReaderErrorCode,
    message: string,
    detail?: ReaderCountDetail,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReaderError";
    if (detail?.pageCount !== undefined) this.pageCount = detail.pageCount;
    if (detail?.scannedPageCount !== undefined) this.scannedPageCount = detail.scannedPageCount;
  }
}
