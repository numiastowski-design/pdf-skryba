/** The LINKS of a page (ISO 32000-1:2008 §12.5.6.5 `/Link`, §12.6.4.5 `/URI` action), read by OUR reader, in the
 *  form the product keeps (`linkAnnotationsOf`). Decides: which link annotations
 *  are visible, and which URI target they carry — the rules are those pdf.js applied before its removal, taken over one by one:
 *  - the target goes through the same treatment: `www.x.y` gets `http://` (addDefaultProtocol), then
 *    WHATWG parsing (`URL`); it is kept only if its protocol is http, https, ftp, mailto or tel;
 *  - a `/NewWindow` action (boolean) is dropped, as the product drops it.
 *  NOT here: the final filter of publishable targets (`extractor/pdf-links.ts#PUBLISHED_SCHEME`), the binding to words.
 *  Called by: `extractor/pdf-source.ts`, `pdf-links-ours.test.ts`. */

import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import type { PdfLinkAnnotation } from "./pdf-source";

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** §12.5.3 Table 165: the annotation flags that make it invisible on screen. */
const FLAG_INVISIBLE = 1;
const FLAG_HIDDEN = 2;
const FLAG_NOVIEW = 32;

/** The protocols accepted from a target — those pdf.js accepted (`_isValidProtocol`), checked in the bundle before its removal. */
const VALID_PROTOCOLS = new Set(["http:", "https:", "ftp:", "mailto:", "tel:"]);

/** Takes over pdf.js's `stringToUTF8String`: each character is taken for a BYTE, and the sequence is read as UTF-8.
 *  A string that is not valid UTF-8, or that carries a character beyond the byte range, stays as it is —
 *  exactly what pdf.js did, whose `decodeURIComponent` threw and returned the original string. */
function utf8Reinterpreted(text: string): string {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return text;
    bytes[i] = code;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/** The target of a URI action, treated as pdf.js did: `www.` prefix completed, UTF-8 conversion, then absolute parsing
 *  and protocol. ORDER MATTERS: pdf.js completed `www.` on the original string, then converted. */
export function absoluteTargetOf(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  let text = raw;
  if (text.startsWith("www.") && (text.match(/\./g)?.length ?? 0) >= 2) text = `http://${text}`;
  text = utf8Reinterpreted(text);
  try {
    const url = new URL(text);
    return VALID_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The rectangle of an annotation: four finite numbers, normalised (the product normalises likewise). */
function rectOf(doc: PdfObjectsDocument, annot: PdfDict): [number, number, number, number] | undefined {
  const rect = doc.resolve(annot.get("Rect"));
  if (rect?.kind !== "array" || rect.items.length !== 4) return undefined;
  const values = rect.items.map((item) => {
    const v = doc.resolve(item);
    return v?.kind === "number" && Number.isFinite(v.value) ? v.value : Number.NaN;
  });
  if (!values.every((v) => Number.isFinite(v))) return undefined;
  const [x0, y0, x1, y1] = values as [number, number, number, number];
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Is an annotation visible on screen? Decided by the `/F` flags (§12.5.3). The rule pdf.js had on
 *  `/QuadPoints` is NOT taken over here: it is only true if measurement shows it (`tools/poc/links-shadow.ts` (deleted, see git history)). */
function isVisible(doc: PdfObjectsDocument, annot: PdfDict): boolean {
  const flags = doc.resolve(annot.get("F"));
  const bits = flags?.kind === "number" ? flags.value : 0;
  return (bits & (FLAG_INVISIBLE | FLAG_HIDDEN | FLAG_NOVIEW)) === 0;
}

/** The links of a page, in the product's format: an absolute URI target and its rectangle. */
export function linkAnnotationsOfPage(doc: PdfObjectsDocument, page: PdfPageEntry): PdfLinkAnnotation[] {
  const links: PdfLinkAnnotation[] = [];
  const annots = doc.resolve(page.dict.get("Annots"));
  if (annots?.kind !== "array") return links;
  for (const item of annots.items) {
    const annot = doc.dictOf(item);
    if (annot === undefined || nameOf(doc.resolve(annot.get("Subtype"))) !== "Link") continue;
    if (!isVisible(doc, annot)) continue;
    const action = doc.dictOf(annot.get("A"));
    if (action === undefined || nameOf(doc.resolve(action.get("S"))) !== "URI") continue;
    // `/NewWindow` is dropped, as the product drops it: a target that opens in another window is not a link.
    if (doc.resolve(action.get("NewWindow")) !== undefined) continue;
    const uriValue = doc.resolve(action.get("URI"));
    if (uriValue?.kind !== "string") continue;
    // A URI target is a SEQUENCE OF BYTES (§12.6.4.7), not a text string: we do NOT apply PDFDocEncoding decoding
    // to it (which would turn 0xA0 into a euro). pdf.js took the bytes as they are, then re-read them as UTF-8 (and so do we).
    const url = absoluteTargetOf(Buffer.from(uriValue.bytes).toString("latin1"));
    const rect = rectOf(doc, annot);
    if (url === undefined || rect === undefined) continue;
    links.push({ url, rect });
  }
  return links;
}
