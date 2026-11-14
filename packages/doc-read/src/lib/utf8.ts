/** The length of a text in UTF-8 bytes: the unit of every byte bound on text (audit fields, stored facts, the rendered page,
 *  record sizes). Written once; `Buffer.byteLength` is the same number.
 *  NOT here: the bounds themselves (`core/bounds.ts`), nor cutting a text to a byte size (each caller's own truncation).
 *  Called by: `adapters/ops-endpoint.ts`, `extractor/slide-svg.ts`, `orchestrator/audit-log.ts`, `orchestrator/document-facts.ts`,
 *  `renderer/storage.ts`. */
const encoder = new TextEncoder();
export const utf8Length = (text: string): number => encoder.encode(text).length;
