/** Test helper: reads one of the real corpus PDFs kept under `fixtures/pdf-corpus-cases/` and lists the text of a published page, table cells and list items included.
 *  NOT here: any rule about the text (the tests `pdf-*.fixtures.test.ts` that call it). Called by: the PDF corpus-case tests. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IRBlock, Inline } from "doc-ir";
import type { PageLanguage } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));

/** The published pages (blocks per page, 0-based) of a corpus case. `lang` is the corpus.csv language of the entry. */
export const publishedPagesOf = async (file: string, lang: string): Promise<IRBlock[][]> =>
  (
    await extractPdf(
      new Uint8Array(readFileSync(join(here, "../../fixtures/pdf-corpus-cases", file))),
      lang as PageLanguage,
    )
  ).pages;

/** An inline's text as a reader or a search index sees it: a superscript is a token of its own, so a space stands before it. */
const inlineText = (i: Inline, first: boolean): string => (!first && i.marks?.includes("sup") ? ` ${i.text}` : i.text);
export const textOfInlines = (inlines: readonly Inline[]): string =>
  inlines.map((i, k) => inlineText(i, k === 0)).join("");

/** Every text unit of the blocks (paragraph, heading, table cell paragraph, list item paragraph), in document order. */
export const textUnitsOf = (blocks: readonly IRBlock[]): string[] =>
  blocks.flatMap((b): string[] => {
    if (b.kind === "table") return b.rows.flatMap((r) => r.cells.flatMap((c) => textUnitsOf(c.blocks)));
    if (b.kind === "list") return b.items.flatMap((item) => textUnitsOf(item));
    return "inlines" in b ? [textOfInlines(b.inlines)] : [];
  });
