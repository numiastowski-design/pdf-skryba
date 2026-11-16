/**
 * The READING door of the library: what reads a document or checks a render — `extractDocument` and the mime classification of its
 * own door, the conservation checks, the language detector, the PDF facts and the two PDF guards — plus the types of their results
 * (docs/PLAN-BIBLIOTHEQUE.md §3 and §5, step 8).
 * Decides: which names the app may take from the library's heavy half — exactly the names it uses, one line per source module, and
 * nothing else. Importing this door loads the readers (about 0.3 s, measured 28/10/2026): a file that needs only a constant, a
 * type or a small helper imports `./light.ts` instead, and a file `light-index` reaches MUST (`adapters/light-handlers.test.ts`).
 * `extractDocument` and `classifyMimeType` are re-exported from `../extractor` (its `index.ts`), not from the modules that define
 * them, so a test that mocks `../extractor` still replaces them.
 * NOT here: the small things (`./light.ts`), any logic (every name is re-exported from the module that owns it), the dashboard
 * (it embeds no reader).
 * Called by: `orchestrator/doc-processor.ts`, `core/reader-bridge.ts`, `adapters/` (the Forge entry points, the PDF guards, the Drive
 * and Slides adapters) and a few types in `ports/`, `sim/`, `core/entities.ts`; never a library file.
 */

export { classifyMimeType, extractDocument } from "../extractor";
export type { ExtractionInput, ExtractionResult, MimeClassification } from "../extractor";
export { assertZipDeclaredSizesSafe } from "doc-gate/extractor/attachment-safety";
export type { GoogleSheetMeta } from "../extractor/google-sheet";
export { isPng } from "doc-ir/extractor/image-pixel-width";
export type { PdfDocumentFacts } from "../extractor/pdf-facts";
export type { PdfTableDetection, PdfTableOrigin } from "doc-ir/layout/geometry";
export { diagramTextWords, undrawnDiagramWords } from "../pipeline/declared-format-conservation";
export { detectLanguage } from "doc-ir/pipeline/detect-language";
// `conservationOfRender`, `ConservationSource` and `StructureSets` left this door on 09/11/2026: their modules read
// and write a RENDER, so they are app code (`library-boundary.test.support.ts#STAYS_IN_APP`) and an app file names
// them directly. What crosses here instead is what the render side needs OF THE LIBRARY and that loads the readers.
// La décision du recollage : son `noWorse` ne compare pas les mêmes choses que celui des mots collés, donc la porte
// les nomme distinctement plutôt que de laisser l'appelant deviner.
export { cutParagraphEdits, noWorse as joinNoWorse } from "../pipeline/cut-paragraph-repair";
export { XmlFragmentParser } from "../extractor/xml/xml-parser";
export { attrOf, kidsOf, tagOf } from "../pipeline/source-reading-package";
export type { N } from "../pipeline/source-reading-package";
