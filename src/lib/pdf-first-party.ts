/**
 * THE FIRST-PARTY ENTRY OF THE PDF PACKAGE: what the publisher's own app takes from it beyond the two published doors.
 * NOT a promise to third parties — a name here may change or leave without notice.
 *
 * WHY THESE NAMES ARE NOT IN THE APP. Each is the PDF reader's own domain: the link schemes it lets through, the shapes
 * of its conservation source, the table band its furniture rule reads, and `chunk`, a helper the reader owns and the
 * app borrows. Load-free: importing this loads no reader and no layout.
 * THREE REPAIRS ARE REPEATED HERE, on purpose: `gluedWordEdits`, `noWorse` and `placeLostPassages` are published by
 * `./pdf-light.ts`, but that door also carries the paragraph repair, which reads the list layout. The app's light
 * functions must not load a layout file, so they take the three here.
 *
 * Decides: which names of the PDF package the app may take without their being public;
 * `src/app-library-surface.test.ts` pins the list and refuses a name nobody takes.
 * NOT here: the published doors (`./pdf.ts`, `./pdf-light.ts`), nor any logic — every name is re-exported from the
 * module that owns it.
 * Called by: `src/readers/light.ts`, `src/readers/conservation-source-union.ts`.
 */

export { chunk } from "./chunk";
export { PUBLISHED_SCHEME } from "./link-schemes";
export type { TableBand } from "../layout/page-furniture";
export { gluedWordEdits, noWorse } from "../pipeline/glued-word-repair";
export { placeLostPassages } from "../pipeline/lost-text-repair";
export type { LostTextAbstention } from "../pipeline/lost-text-repair";
export type { PdfConservationSource, ReferenceCycle } from "../pipeline/pdf-conservation-source";
