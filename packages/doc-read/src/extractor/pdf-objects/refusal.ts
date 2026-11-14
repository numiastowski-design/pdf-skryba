/** The one failure the PDF object reader throws: a closed reason, and at most two technical positions — the
 *  number of the object being read, and the offset the refusal happened at when the caller knows it.
 *  Decides: the message is composed here from the REASON ALONE; no input byte, name or string reaches a message
 *  or a field, and neither position reaches the message.
 *  NOT here: the places that refuse (every module of this folder), the user-facing wording (mapped by callers).
 *  Called by: `parse.ts`, `xref.ts`, `streams.ts`, `document.ts`, `content.ts`; modelled on `ZipEntryRefusal`
 *  (`extractor/zip/zip-package.ts`). */

import { ReaderError } from "doc-ir/lib/reader-error";

export type PdfObjectsRefusalReason =
  | "syntax"
  | "truncated"
  | "nesting-too-deep"
  | "token-too-long"
  | "string-too-long"
  | "stream-length"
  | "stream-end"
  | "length-unresolved"
  // Slice A2, the cross-reference section (§7.5.4-7.5.6).
  | "startxref-missing"
  | "xref-offset"
  | "xref-syntax"
  | "xref-chain"
  | "xref-too-large"
  // Slice A3, stream decoding, cross-reference streams and object streams (§7.4.4, §7.5.7-7.5.8).
  | "filter-unsupported"
  | "predictor"
  | "stream-decode"
  | "object-stream"
  | "xref-stream"
  // Slice A4, the document and its page tree (§7.3.10, §7.7.2-7.7.3).
  | "xref-stale"
  | "ref-hops"
  | "page-tree"
  | "page-box"
  // Slice A5, content streams (§7.8.2, §8.9.7).
  | "content-syntax"
  | "content-operands"
  | "content-too-long"
  | "inline-image"
  // POC of 31/10/2026: decryption (§7.6).
  | "encrypted"
  // The unicode layer (POC of 31/10/2026): the `/ToUnicode` CMap (§9.10.3).
  | "to-unicode"
  // Security review of 31/10/2026: what a hostile file makes us work on.
  | "value-too-large"
  | "document-too-large"
  // The glyph layer (`extractor/pdf-glyph-source.ts`), same review.
  | "glyphs-too-many"
  | "forms-too-many"
  | "font-tables-too-many"
  | "page-missing";

export class PdfObjectsRefusal extends ReaderError {
  constructor(
    readonly reason: PdfObjectsRefusalReason,
    readonly objectNumber?: number,
    /** Where in the bytes being read the refusal happened, when the caller knows it. A technical position, like
     *  an object number: it never reaches the message, and it lets a DEVELOPMENT tool say where to look instead
     *  of bisecting a stream by hand (POC of 31/10/2026). */
    readonly offset?: number,
  ) {
    super("EXTRACT_FAILED", objectNumber === undefined ? `pdf-objects: ${reason}` : `pdf-objects: ${reason} (object ${objectNumber})`);
    this.name = "PdfObjectsRefusal";
  }
}
