/**
 * THE DOOR OF THE PUBLISHED DECLARED-FORMATS PACKAGE (`docs-scribe`), and nothing else (Mikolaj, 09/11/2026).
 *
 * WHAT IT READS, AND WHY IT IS NOT THE PDF'S. Word, PowerPoint, Excel and the Google exports DECLARE their structure:
 * a heading says it is a heading, a table says it is a table. A PDF declares none of it and infers everything from
 * geometry. The two readers share the representation they produce and almost nothing else — measured on 09/11/2026,
 * an entry on these four swallows 100 files of the repository and ZERO file of the PDF reader, while the PDF entry
 * swallows 136 and zero of these. The boundary was already in the code; these doors make it visible, and a test on
 * the built artefact keeps it that way.
 *
 * WHAT COMES WITH THEM, deliberately: the zip and XML BOUNDED READERS (`extractor/zip/`, `extractor/xml/`). These
 * formats are archives of XML, so refusing a bomb is part of reading them, not an option beside it: no DTD is ever
 * read — so entity expansion cannot happen — and `assertZipDeclaredSizesSafe` refuses an archive on its DECLARED
 * sizes, before inflating a byte.
 *
 * Decides: what a third party may call to read a document that declares its structure.
 * NOT here: the PDF (`lib/pdf.ts`, published as `skryba`), the reader-free half (`lib/docs-light.ts`, published as
 * `docs-scribe/light`), nor the app's own door (`lib/index.ts`, which dispatches every format for Miksumia Publisher).
 * Called by: nobody in this repository — it is a PUBLISHED door, so its callers are third parties that install
 * the package, and `tools/build-library.ts`, which builds it and holds what it may reach.
 */

export { extractDocx } from "../extractor/docx";
export { extractPptx } from "../extractor/pptx";
export { extractXlsx } from "../extractor/xlsx";
export { extractGoogleSheet } from "../extractor/google-sheet";
export { extractGoogleDoc } from "../extractor/google-doc";
export type { GoogleSheetMeta } from "../extractor/google-sheet";

/** Refuse an archive on its DECLARED sizes, before inflating anything: the other shape of a zip bomb, and the
 *  overlapping entries that hide one. The readers do not call it for you. */
export { assertZipDeclaredSizesSafe } from "doc-gate/extractor/attachment-safety";

/** The language of a document, read from its own text when the file declares none. */
export { detectLanguage } from "doc-ir/pipeline/detect-language";

/** The words a diagram carries, and those its picture does not show: a caller that counts words needs both, because a
 *  diagram is published as a DRAWING and its text is not on the page. */
export { diagramTextWords, undrawnDiagramWords } from "../pipeline/declared-format-conservation";
