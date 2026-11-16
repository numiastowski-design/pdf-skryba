/** The size caps of a table (`MAX_TABLE_COLS` and `MAX_TABLE_ROWS`, 08/10/2026): a table wider than the column cap, measured on
 *  its GRID after the empty columns are removed (`table-empty-parts.ts`, a merged cell counting for its span), or longer than the
 *  row cap (its rows after the empty header row is removed), is not published; the walk
 *  counts the ones it takes out so the document can say so (`table-withheld` notice, `reader-limits.ts#unpublishedPartNotices`).
 *  The ONE rule of docx, pptx and PDF (Google Docs and Slides go through the docx and pptx readers).
 *  `tableExceedsCaps` is the ONE decision, on COUNTS only: the control readings of Word and PowerPoint
 *  (`pipeline/source-reading-*.ts`) count from their own XML and ask it, so the page and the check withhold the same tables.
 *  NOT here: the cap of a worksheet tab (`extractor/sheet-workbook.ts`, same constant), the removal of the empty columns from
 *  what is published (`renderer/storage.ts`), nor the wording of the remark.
 *  A table taken out reports its texts to `recordRemoval` (the PDF declares them as deliberate removals of the text check).
 *  Called by: `extractor/docx-reader/index.ts`, `extractor/pptx.ts`, `extractor/pdf.ts`; `tableExceedsCaps` also by
 *  `pipeline/source-reading-table.ts`. */

import { mapBlockChildren, walkInlineRuns } from "./ir-walk";
import type { IRBlock } from "./ir";
import { NO_CAP, type ReaderLimits } from "./reader-limits";
import { tableGridWidth, withoutEmptyTableParts } from "./table-empty-parts";

/** True when a table of `gridWidth` grid columns and `rows` rows, both counted AFTER its empty columns and empty header row are
 *  removed, is not published. `limits` CARRIES the two caps; a cap it leaves out is NOT a cap at all (`NO_CAP`), so
 *  nothing is withheld — since 09/11/2026 the ceilings live in the app (`core/document-caps.ts#PRODUCT_READER_LIMITS`)
 *  and a reading given none holds nothing back. This said « the product's » until 10/11/2026 and was read that way by
 *  the bench, which then published tables the sync withholds. */
export const tableExceedsCaps = (gridWidth: number, rows: number, limits?: ReaderLimits): boolean =>
  gridWidth > (limits?.tableCols ?? NO_CAP) || rows > (limits?.tableRows ?? NO_CAP);

/** The blocks without their too-wide or too-long tables (nested ones included, in lists, cells and tabs), and how many were taken out.
 *  `recordRemoval` receives the text of each inline run (a cell paragraph) of a table taken out, so the text check knows it was removed on purpose. */
export const withholdOversizedTables = (
  blocks: readonly IRBlock[],
  recordRemoval: (text: string) => void = () => {},
  limits?: ReaderLimits,
): { blocks: IRBlock[]; withheld: number } => {
  let withheld = 0;
  const walk = (list: readonly IRBlock[]): IRBlock[] =>
    list.flatMap((block): IRBlock[] => {
      if (block.kind === "table") {
        const useful = withoutEmptyTableParts(block);
        if (useful !== null && tableExceedsCaps(tableGridWidth(useful), useful.rows.length, limits)) {
          withheld++;
          // One removal per run, never per inline: a word cut by a superscript call or a link (« 30 » + sup « 2) ») is one word of the
          // PDF's text layer (« 302) »), and the check matches the removal against it (corpus 043 p15, 23/10/2026: 25 words falsely lost).
          walkInlineRuns([block], (run) => {
            const text = run.map((inline) => inline.text).join("");
            if (text.trim() !== "") recordRemoval(text);
          });
          return [];
        }
      }
      return [mapBlockChildren(block, (inner) => walk(inner))];
    });
  const kept = walk(blocks);
  return { blocks: kept, withheld };
};
