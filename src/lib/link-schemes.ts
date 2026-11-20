/** The schemes an external link may leave a published page with: ONE definition (review of 27/09/2026, arbitrage of 28/09/2026).
 *  NOT here: rendering a link (`renderer/storage.ts`), tying a PDF link annotation to words (`extractor/pdf-links.ts`), nor
 *  which target of an Office file may become a link at all (`lib/external-link-target.ts`).
 *  Called by: `renderer/storage.ts`, `extractor/pdf-links.ts`. */

/** http, https, mailto — anything else (javascript:, file:, tel:…) leaves the words as plain text. */
export const PUBLISHED_SCHEME = /^(?:https?|mailto):/i;
