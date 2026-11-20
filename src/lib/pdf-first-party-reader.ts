/**
 * THE FIRST-PARTY ENTRY OF THE PDF PACKAGE THAT LOADS THE READER: what the publisher's own measuring tools, scenarios
 * and tests take from it beyond the two published doors, when the name comes with the reader itself. NOT a promise
 * to third parties — a name here may change or leave without notice.
 *
 * WHY THESE NAMES ARE NOT IN THE APP, AND NOT ON A DOOR. The app's bench, its output fingerprints and a few of its
 * tests measure the product one step before the published door: the pages as the reader lays them out before they
 * become tabs (`extractPdfPages`, with its development options), the tabs themselves, the raw text runs the
 * conservation control is compared with, the object layer a declared structure is read from, and the reader's own
 * refusal and bounds. Each is the PDF reader's domain; none is a promise the published doors make.
 * `detectLanguageFromSample` is the base's, handed on as the reader takes it: the base has no first-party entry that
 * may load its language profiles.
 *
 * Decides: which reader-loading names of the PDF package the publisher's tools and tests may take without their
 * being public; `src/app-library-surface.test.ts` pins the list and refuses a name nobody takes.
 * NOT here: the published doors (`./pdf.ts`, `./pdf-light.ts`), the load-free names (`./pdf-first-party.ts`), nor any
 * logic — every name is re-exported from the module that owns it.
 * Called by: the app's tests, `tools/` (the bench, the output fingerprints, the structure measure) and `features/`.
 */

export { detectLanguageFromSample } from "doc-ir/internal";
export { extractPdf as extractPdfPages } from "../extractor/pdf";
export { MAX_EMBEDDED_IMAGE_PIXELS, openEmbeddedImages } from "../extractor/pdf-embedded-images";
export { PRODUCER_MAX_CHARS } from "../extractor/pdf-facts";
export { separatorBefore } from "../extractor/pdf-lines";
export { openPdfObjects } from "../extractor/pdf-objects/document";
export { PdfObjectsRefusal } from "../extractor/pdf-objects/refusal";
export { pdfPageTabs } from "../extractor/pdf-page-tabs";
export { readPdfSource } from "../extractor/pdf-source";
export { walkPage } from "../extractor/pdf-table-detector";
export { DEFAULT_HEADING_SIZE_RATIO } from "../layout/heading-sizes";
