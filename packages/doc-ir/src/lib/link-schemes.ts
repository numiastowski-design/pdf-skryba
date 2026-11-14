/** The schemes an external link may leave a published page with: ONE definition (review of 27/09/2026, arbitrage of 28/09/2026).
 *  NOT here: rendering a link (`renderer/storage.ts`), nor tying a PDF link annotation to words (`extractor/pdf-links.ts`).
 *  Called by: `renderer/storage.ts`, `extractor/pdf-links.ts`. */
import { INTERNAL_HREF_FORM } from "./ir";

/** http, https, mailto — anything else (javascript:, file:, tel:…) leaves the words as plain text. */
export const PUBLISHED_SCHEME = /^(?:https?|mailto):/i;

/** The ONE provenance filter for a link read from a file: only an External relationship's target may become an
 *  href, and never one of OUR internal forms (`lib/ir.ts#INTERNAL_HREF_FORM`). The scheme guard stays the
 *  renderer's (`PUBLISHED_SCHEME`). Called by the docx, pptx and xlsx readers. */
export const externalLinkTarget = (link: { external: boolean; target: string } | undefined): string | undefined =>
  link?.external && !INTERNAL_HREF_FORM.test(link.target) ? link.target : undefined;
