/** Test helper: the pages of a PDF read as ONE flat document (page order preserved), for the tests that look at the blocks or the text of a whole document without the tab frames.
 *  NOT here: the published form (`extractor/pdf-page-tabs.ts#pdfPageTabs`). Called by: the PDF extraction tests. */

import type { IRBlock, IRDoc } from "doc-ir";

export const flattenPdfPages = (pages: IRBlock[][]): IRDoc => ({ blocks: pages.flat() });
