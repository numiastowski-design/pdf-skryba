/** The content of a page as ONE stream (ISO 32000-1 §7.7.3.3: an array of streams "shall be treated as a single stream").
 *  Decides: how the streams of `/Contents` are joined (each followed by a line feed) and that the total is bounded.
 *  Also decides: that the decoded content of a page and the tokenized operators of a FORM are read once per document, whichever reader asks
 *  (`pageContentOf`, `parsedFormOf`), kept in the document's one cache (`document-cache.ts`).
 *  NOT here: reading the operators (`pdf-objects/content.ts`), decoding one stream (`pdf-objects/streams.ts`).
 *  Called by: `pdf-ops-ours.ts`, `pdf-glyph-source.ts`, `pdf-symbol-page.ts` — one definition for the three readers that walk a page's content. */

import { documentCacheOf } from "./document-cache";
import { HEAP_PER_NODE, HEAP_PER_OPERATOR, MAX_DECODED_STREAM_BYTES } from "./pdf-objects/bounds";
import { tokenizeContent, type ContentOp } from "./pdf-objects/content";
import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import type { PdfStream } from "./pdf-objects/objects";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

const PAGE = Symbol("page content");
const FORM = Symbol("tokenized form");

/** The operators of a form, tokenized ONCE per document, whichever page or reader draws it (a marker drawn five thousand times was tokenized
 *  five thousand times, and again by the font walk). Tokenizing is the heavy part of drawing a form, not decoding it, and the decoded bytes are
 *  not kept once tokenized. What it costs in the cache: what it retains, an estimate, `HEAP_PER_OPERATOR` for each operator and `HEAP_PER_NODE` for each node
 *  its operands make (a count of operators alone priced `[0 0 0 …] TJ`, two arrays of a million numbers, at a few bytes), plus ALL the bytes it was
 *  read from, even a view of the file: the tokenizer COPIES every string operand, so those bytes can be retained up to their length.
 *  🔴 Errs by EXCESS on purpose, twice: the node counter counts an operand twice (about 1.8 times too much on `1 0 0 1 5 5 cm`), and a filtered
 *  form's decoded bytes are counted though not kept. Measured on real forms (190 + 139) the largest holds 12 358 operators, about 100 KB: the cost
 *  is far from the cap, and it is the hostile form, not the real one, that this overstates (reviews of 02/11/2026). */
export function parsedFormOf(doc: PdfObjectsDocument, form: PdfStream): readonly ContentOp[] {
  let cost = 0;
  return documentCacheOf(doc).getOrCompute<readonly ContentOp[]>(
    FORM,
    form,
    () => cost,
    () => {
      const bytes = doc.streamBytes(form);
      const { ops, nodes } = tokenizeContent(bytes);
      cost = bytes.length + ops.length * HEAP_PER_OPERATOR + nodes * HEAP_PER_NODE;
      return ops;
    },
  );
}

/** The decoded streams of the page, joined, in one allocation. Refused (`content-too-long`) past `MAX_DECODED_STREAM_BYTES` IN ALL:
 *  each stream was bounded to that size and the document to 200 MB, but the page used to be assembled three or four times over
 *  (security review of 02/11/2026), so two streams under the ceiling each held about four times their size at once. Kept in the document's cache:
 *  the operators of a page, then its fonts, then its glyphs each asked for it and each decode inflated the streams again, charged to the document. */
export function pageContentOf(doc: PdfObjectsDocument, page: PdfPageEntry): Uint8Array {
  let cost = 0;
  return documentCacheOf(doc).getOrCompute<Uint8Array>(
    PAGE,
    page,
    () => cost,
    () => {
      const bytes = decodedPageContent(doc, page);
      // A page of one stream with no filter, in a file that is not encrypted, is a VIEW of the file: it holds no memory of its own.
      cost = isViewOnFile(doc, only(doc, page)) ? 0 : bytes.length;
      return bytes;
    },
  );
}

/** The one stream a page's `/Contents` is made of, or `undefined` when it is several (or none). */
function only(doc: PdfObjectsDocument, page: PdfPageEntry): PdfStream | undefined {
  const contents = doc.resolve(page.dict.get("Contents"));
  let one = contents;
  if (contents?.kind === "array") one = contents.items.length === 1 ? doc.resolve(contents.items[0]) : undefined;
  return one?.kind === "stream" ? one : undefined;
}

/** A stream with no filter, in a file that is not encrypted, decodes to a VIEW of the file: it holds no memory of its own. Every doubt prices in full. */
function isViewOnFile(doc: PdfObjectsDocument, stream: PdfStream | undefined): boolean {
  return stream !== undefined && !doc.trailer().has("Encrypt") && stream.dict.get("Filter") === undefined;
}

function decodedPageContent(doc: PdfObjectsDocument, page: PdfPageEntry): Uint8Array {
  const contents = doc.resolve(page.dict.get("Contents"));
  if (contents === undefined) return new Uint8Array(0);
  const streams = contents.kind === "array" ? contents.items.map((item) => doc.resolve(item)) : [contents];
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const stream of streams) {
    if (stream?.kind !== "stream") continue;
    const bytes = doc.streamBytes(stream);
    total += bytes.length + 1;
    if (total > MAX_DECODED_STREAM_BYTES) throw new PdfObjectsRefusal("content-too-long");
    parts.push(bytes);
  }
  // The usual page has ONE stream: nothing to join, no second copy (a page near the ceiling would peak at twice its size). The tokenizer
  // already reads a form's stream, which has no line feed after it, to its end.
  if (parts.length === 1) return parts[0]!;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    joined[at + part.length] = 0x0a;
    at += part.length + 1;
  }
  return joined;
}
