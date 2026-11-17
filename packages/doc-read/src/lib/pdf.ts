/**
 * THE DOOR OF THE PUBLISHED PDF PACKAGE (`pdf-skryba`, named `skryba` until 0.6.2), and nothing else (09/11/2026: « séparer la partie pdf,
 * pour que skryba ne gère QUE le pdf »).
 *
 * WHY A DOOR AND NOT A FOLDER, for now. The package is an esbuild BUNDLE: what it contains is what its entry REACHES,
 * never where a file sits. Measured on 09/11/2026, before writing a line: this entry swallows 136 files of the
 * repository — 75 of the PDF reader, 61 shared — and **zero** file of the docx/pptx/xlsx/Google readers, **zero** file
 * of the zip and XML bounded readers. The all-formats entry it replaces swallowed 243. The two reader families do not
 * touch each other; the boundary existed in the code, it only lacked a door to make it visible.
 * (An earlier count, made on the source's import statements, said the PDF reached the zip reader through
 * `pipeline/conservation-source.ts`. It does not: that is an `import type`, which esbuild erases. The bundle is the
 * measure, not the specifiers.)
 * That boundary is held by a TEST on the built artefact (`tools/build-library.test.ts`), not by the filesystem — so it
 * is DETECTED, not impossible. The maintainer took the physical split as the next chantier, which is where it becomes
 * impossible; this door and that guard survive it.
 *
 * Decides: what a third party may call to read a PDF, and nothing more. One name per thing it needs.
 * NOT here: the app's own door (`lib/index.ts`, which still dispatches every format for Miksumia Publisher), the
 * reader-free half (`lib/light.ts`, published as `pdf-skryba/light`: the conservation checks, the types, the bounds), nor
 * the readers of the declared formats, which leave for their own package.
 * Called by: nobody in this repository — it is a PUBLISHED door, so its callers are third parties that install
 * the package, and `tools/build-library.ts`, which builds it and holds what it may reach.
 */

export { extractPdfWithVision as extractPdf } from "../extractor/pdf-scanned";
export type { ExtractOptions } from "./reader-options";
export type { PdfDocumentFacts } from "../extractor/pdf-facts";
export type { PdfTableDetection, PdfTableOrigin } from "doc-ir/layout/geometry";
/** The language of a document, read from its own text: a PDF carries no declared language. */
export { detectLanguage } from "doc-ir/pipeline/detect-language";
