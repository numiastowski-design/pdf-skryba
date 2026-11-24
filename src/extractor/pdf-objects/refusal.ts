/** The one failure the PDF object reader throws: a closed reason, and at most two technical positions — the
 *  number of the object being read, and the offset the refusal happened at when the caller knows it.
 *  Decides: the message is composed here from the REASON ALONE; no input byte, name or string reaches a message
 *  or a field, and neither position reaches the message.
 *  NOT here: the places that refuse (every module of this folder), the user-facing wording (mapped by callers).
 *  Called by: `parse.ts`, `xref.ts`, `streams.ts`, `document.ts`, `content.ts`; `partOrAbsent` by the readers of the
 *  parts that carry no text (`extractor/pdf-source.ts`, `pdf-outline.ts`, `pdf-links-ours.ts`, `pdf-ops-ours.ts`,
 *  `pdf-glyph-source.ts`, `pdf-symbol-page.ts`, `pdf-ccitt-images.ts`); `rethrowSecurityRefusal` by the image
 *  decoders' catches. Modelled on `ZipEntryRefusal`
 *  (`extractor/zip/zip-package.ts`). */

import { ReaderError } from "doc-ir";

export type PdfObjectsRefusalReason =
  | "syntax"
  | "truncated"
  | "nesting-too-deep"
  | "token-too-long"
  | "string-too-long"
  | "stream-length"
  | "stream-end"
  // A decoded stream past `MAX_DECODED_STREAM_BYTES`: a bound, told apart from a damaged stream on 24/11/2026.
  | "stream-too-large"
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
    super(
      "EXTRACT_FAILED",
      objectNumber === undefined ? `pdf-objects: ${reason}` : `pdf-objects: ${reason} (object ${objectNumber})`,
    );
    this.name = "PdfObjectsRefusal";
  }
}

/** The bounds of our object reader: a refusal for one of them is a `limit` that bit — a file REFUSED FOR SECURITY, never
 *  published, attached or retried (decision of 25/10/2026) — and any other refusal a damaged file.
 *  A `Record` so a reason added to `PdfObjectsRefusalReason` does not compile until it is classified here. */
export const REFUSAL_IS_BOUND: Record<PdfObjectsRefusalReason, boolean> = {
  syntax: false,
  truncated: false,
  "nesting-too-deep": true,
  "token-too-long": true,
  "string-too-long": true,
  "stream-length": false,
  "stream-end": false,
  "stream-too-large": true,
  "length-unresolved": false,
  "startxref-missing": false,
  "xref-offset": false,
  "xref-syntax": false,
  "xref-chain": false,
  "xref-too-large": true,
  "filter-unsupported": false,
  predictor: false,
  "stream-decode": false,
  "object-stream": false,
  "xref-stream": false,
  "xref-stale": false,
  "ref-hops": true,
  "page-tree": false,
  "page-box": false,
  "content-syntax": false,
  "content-operands": false,
  "content-too-long": true,
  "inline-image": false,
  encrypted: false,
  "to-unicode": false,
  "value-too-large": true,
  "document-too-large": true,
  "glyphs-too-many": true,
  "forms-too-many": true,
  "font-tables-too-many": true,
  "page-missing": false,
};

/** A refusal for security: a bound of the object reader that bit, or a `FILE_UNSAFE` of ours. Never absorbed by a part:
 *  a trapped file is refused as a whole (decision of 25/10/2026). */
export function isSecurityRefusal(error: unknown): boolean {
  if (error instanceof PdfObjectsRefusal) return REFUSAL_IS_BOUND[error.reason];
  return error instanceof ReaderError && error.code === "FILE_UNSAFE";
}

/** For a catch that leaves one picture unread: a refusal for security goes on up, and refuses the document (decision of
 *  25/10/2026). */
export function rethrowSecurityRefusal(error: unknown): void {
  if (isSecurityRefusal(error)) throw error;
}

/** A part of the document that carries no text — the `/Info` dictionary, an outline item, an image XObject, a link
 *  annotation — read ALONE (decision of 24/11/2026): a refusal of ours that says the part is UNREADABLE (syntax,
 *  truncated, stream-decode...) gives `undefined`, so that part is absent and the read goes on. A refusal for security
 *  (`isSecurityRefusal`) and any other error still propagate.
 *  NOT a repair: the cross-reference table and the page tree stay as strict as before, and an object that carries
 *  text (page content, fonts, `/ToUnicode`) still refuses the document. */
export function partOrAbsent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof PdfObjectsRefusal && !isSecurityRefusal(error)) return undefined;
    throw error;
  }
}
