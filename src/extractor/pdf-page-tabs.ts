/** The last step of the PDF path: the pages read, published as one native tab per page (the only PDF layout).
 *  NOT here: how a page is read (`extractor/pdf.ts`), nor how a tab is drawn (`renderer/storage.ts#renderTabs`).
 *  Called by: `extractor/pdf.ts` (re-exports `flattenPdfPages`), `extractor/pdf-scanned.ts`, `tools/bench/render.ts`. */

import { type IRBlock, type IRDoc, type IRTab } from "doc-ir";
import { emptyTabBlocks } from "doc-ir/internal";
import { type PageLabelOverride } from "doc-ir";
import { resolveLabels } from "doc-ir/internal";
import type { PageLanguage } from "doc-ir";

/** One tab per page, in file order, the page's rank written `pageNumber` (the renderer labels it « Page N » in the page language).
 *  A page with no block is an empty tab. Nothing comes before or after the tabs. Today every page of the cap is published, so the
 *  rank is the page's index plus one; removing tabs later renumbers (docs/CONCEPTION-PDF-ONGLETS.md §2.2). */
export const pdfPageTabs = (
  pages: readonly (readonly IRBlock[])[],
  language: PageLanguage,
  labels?: PageLabelOverride,
): IRDoc => {
  const label = resolveLabels(language, labels).pdfPageTabTitle;
  const tabs: IRTab[] = pages.map((blocks, index) => ({
    title: label(index + 1),
    pageNumber: index + 1,
    blocks: blocks.length > 0 ? [...blocks] : emptyTabBlocks(),
  }));
  return { blocks: [{ kind: "tabs", tabs }] };
};
