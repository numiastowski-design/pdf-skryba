/** The extractor package's public surface: one import site for everything the
 *  rest of the app may call here.
 *  NOT here: any logic at all — every name is re-exported from the module that
 *  owns it.
 *  Called by: `orchestrator/doc-processor.ts`; the `orchestrator` tests mock it. */

export { classifyMimeType } from "./mime";
export type { MimeClassification } from "./mime";
export { extractDocument } from "./dispatch";
export type { ExtractionInput, ExtractionResult } from "./dispatch";
