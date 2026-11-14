/** A Word table that is only a page layout becomes a `columns` block: a one-row table of 2 or 3
 *  cells, none merged, each cell either prose of at least LAYOUT_TABLE_MIN_WORDS words or a picture-only cell (and one prose cell at least).
 *  A form (label | value), a spacer cell, a nested table or any merge keeps the table. The cells' blocks pass unchanged, left to right.
 *  A pure pass over the BODY blocks: `docx-reader/index.ts` applies it before the notes are added, so a table of a note, a text box or a
 *  cell is never looked at. The column widths of Word are not taken (written limit): the picture column picks a sidebar layout.
 *  NOT here: how `columns` is written (`renderer/storage.ts`), how the page is checked (`pipeline/structure-conservation.ts`).
 *  `columnsBackToTables` undoes it for a block whose cells stopped qualifying once the images were resolved (a picture can be dropped).
 *  Why: some authors put two or three flows of prose side by side in a one-row table; published as a table the text is squeezed into cells,
 *  and Confluence has layout sections for that (2 or 3 columns, top level only). A label | value form stays a table: only a table keeps the pairs.
 *  Why a pass after reading, on the body only: a table of a note, a text box or a cell is then never a candidate by construction.
 *  Why a cell without words keeps the table: an EMPTY cell (no word, no picture) is a spacer or a form box, and is not split here.
 *  Why the layout names a sidebar: a picture column gets `two_left_sidebar`, `two_right_sidebar` or `three_with_sidebars`, else `two_equal` / `three_equal`.
 *  Measured on 369 Word documents (24/10/2026): 3,147 tables, 125 with one row and 2 or 3 cells (108 + 17, in 37 documents, 124 at top level,
 *  none merged). Of the 30 whose poorest cell has no word: 18 forms with an empty box, 5 prose + empty spacer, 3 pictures only (tables),
 *  4 picture | prose (columns).
 *  Called by: `docx-reader/index.ts`. */

import type { IRBlock } from "doc-ir/lib/ir";
import { wordsOf } from "../../lib/words";

/** Fewest words a cell needs to count as prose. Valeur de départ à calibrer: 62 form tables have a poorest cell of 1 to 3 words, 24 prose
 *  tables of 10 and more (in 12 documents only, 8 of them in one: a narrow sample), 9 tables sit in the 4 to 9 zone and stay tables (we
 *  abstain rather than refine the threshold; 369 Word documents, 24/10/2026). */
export const LAYOUT_TABLE_MIN_WORDS = 10;

type Table = Extract<IRBlock, { kind: "table" }>;
type Columns = Extract<IRBlock, { kind: "columns" }>;
type CellKind = "prose" | "picture" | "other";

/** The words of a block tree, counted with the app's tokenizer; `undefined` when a block is of a kind a layout cell does not hold. */
const wordsOfBlocks = (blocks: readonly IRBlock[]): number | undefined => {
  let total = 0;
  for (const block of blocks) {
    let count: number | undefined;
    switch (block.kind) {
      case "paragraph":
      case "heading":
        count = wordsOf(block.inlines.map((i) => i.text).join("")).length;
        break;
      case "list":
        count = wordsOfBlocks(block.items.flat());
        break;
      case "image":
        count = 0;
        break;
      default:
        count = undefined;
    }
    if (count === undefined) return undefined;
    total += count;
  }
  return total;
};

const cellKind = (blocks: readonly IRBlock[]): CellKind => {
  const words = wordsOfBlocks(blocks);
  if (words === undefined) return "other";
  if (words >= LAYOUT_TABLE_MIN_WORDS) return "prose";
  return words === 0 && blocks.some((b) => b.kind === "image") ? "picture" : "other";
};

/** The `layout` of the kinds of the cells, or `undefined` when the table is not a layout table. */
const layoutOf = (kinds: readonly CellKind[]): Columns["layout"] | undefined => {
  if (kinds.includes("other") || !kinds.includes("prose")) return undefined;
  const [first, , last] = kinds;
  if (kinds.length === 2) {
    if (first === "picture") return "two_left_sidebar";
    return kinds[1] === "picture" ? "two_right_sidebar" : "two_equal";
  }
  return first === "picture" && last === "picture" ? "three_with_sidebars" : "three_equal";
};

const asColumns = (table: Table): Columns | undefined => {
  const [row] = table.rows;
  if (table.rows.length !== 1 || row === undefined || (row.cells.length !== 2 && row.cells.length !== 3)) return undefined;
  if (row.cells.some((c) => c.colspan !== undefined || c.rowspan !== undefined)) return undefined;
  const layout = layoutOf(row.cells.map((c) => cellKind(c.blocks)));
  return layout === undefined ? undefined : { kind: "columns", layout, cells: row.cells.map((c) => c.blocks) };
};

/** The blocks with each qualifying top-level table replaced by its `columns`; every other block comes back as the same object. `keep`: blocks
 *  never converted (the reader's text-box blocks, which join the body's flow). */
export const layoutTablesToColumns = (blocks: readonly IRBlock[], keep: ReadonlySet<IRBlock> = new Set()): IRBlock[] =>
  blocks.map((block) => (block.kind === "table" && !keep.has(block) ? (asColumns(block) ?? block) : block));

/** The blocks with each top-level `columns` whose cells no longer qualify (the cells are classed before `images.resolve`, which may drop a
 *  picture) put back as the one-row table it came from; every other block comes back as the same object. */
export const columnsBackToTables = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.map((block) => {
    if (block.kind !== "columns") return block;
    if (layoutOf(block.cells.map(cellKind)) !== undefined) return block;
    return { kind: "table", rows: [{ cells: block.cells.map((cellBlocks) => ({ blocks: cellBlocks })) }] };
  });
