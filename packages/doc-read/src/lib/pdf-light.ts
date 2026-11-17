/**
 * THE READER-FREE HALF OF THE PDF PACKAGE (`pdf-skryba/light`): the conservation check of a PDF and the shapes it speaks
 * in, with no reader behind them — importing this loads no PDF, no zip, no XML.
 *
 * WHY IT IS NOT `lib/light.ts`. That one is the APP's light door, and the app publishes every format: it carries the
 * DECLARED-format comparison (`missingWordGroups`, `DeclaredFormatConservationSource`), the Office MIME constants and
 * the diagram helpers. A PDF package has no use for any of it, and measured on 09/11/2026 it cost the package eight
 * type declarations of the docx/xlsx/zip families and three Office MIME strings — carried for nothing.
 *
 * WHAT A PDF CONSUMER CHECKS WITH. It hands the text it published, block by block (`PublishedPage`), and gets back
 * what was lost, invented, glued or split — in the coordinates of its own blocks, never its markup. The three repairs
 * come back as `PageEdit`s it applies itself: the library proves WHAT and WHERE, writing the page is the caller's.
 * NOT here: the readers (`lib/pdf.ts`, published as the package's main entry), the declared formats' own check, nor
 * anything that reads a rendered page — that knowledge belongs to whoever owns the markup.
 * Called by: nobody in this repository — it is a PUBLISHED door, so its callers are third parties that install
 * the package, and `tools/build-library.ts`, which builds it and holds what it may reach.
 */

export { conservationKey, lostWords, textConservation, wordKeysOf } from "doc-ir/pipeline/text-conservation";
export type {
  ConservationRule,
  ConservationRun,
  ConservationVerdict,
  PageEdit,
  PageWordAt,
  PublishedPage,
  Respacing,
  SourceWordLink,
} from "doc-ir/pipeline/text-conservation";

/** The three repairs, as DECISIONS: each says what to change and where, and writes nothing. */
export { gluedWordEdits, noWorse } from "../pipeline/glued-word-repair";
export { cutParagraphEdits, noWorse as joinNoWorse } from "../pipeline/cut-paragraph-repair";
export { placeLostPassages } from "../pipeline/lost-text-repair";
export type { LostPassage } from "doc-ir/pipeline/text-conservation";
export type { LostTextAbstention, LostTextInsertion } from "../pipeline/lost-text-repair";

/** The document the reader hands back, and what it could not publish. */
export type { IRBlock, IRDoc, IRTab, ImageRef, Inline, InlineMark, TableData } from "doc-ir/lib/ir";
export type { DocumentNotice, PageLanguage, PdfTextUnreadReason, PictureRefusal } from "doc-ir/lib/reader-types";
export { ReaderError } from "doc-ir/lib/reader-error";
export type { ReaderCountDetail } from "doc-ir/lib/reader-error";
export type { ReaderLimits } from "doc-ir/lib/reader-limits";
export { MAX_PAYLOAD_BYTES } from "doc-ir/lib/reader-limits";
export type { VisionPort, VisionResult } from "doc-ir/lib/vision-port";
export type { PageLabelOverride } from "doc-ir/lib/page-labels";
