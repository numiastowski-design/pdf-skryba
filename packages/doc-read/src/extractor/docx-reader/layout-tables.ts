/** A Word table that is only a page layout becomes a `columns` block.
 *  Decides: a one-row table of 2 or 3 cells, none merged, each cell either prose of at least LAYOUT_TABLE_MIN_WORDS
 *  words or a picture-only cell, one prose cell at least, is a layout; anything else keeps the table. The cells' blocks
 *  pass unchanged, left to right; a picture column picks a sidebar layout.
 *  Why: some authors put two or three flows of prose side by side in a one-row table; published as a table the text is
 *  squeezed into cells. A label | value form stays a table: only a table keeps the pairs. An EMPTY cell (no word, no
 *  picture) is a spacer or a form box, so it keeps the table.
 *  Why a pass after reading, on the body blocks only: a table of a note, a text box or a cell is then never a candidate
 *  by construction. `columnsBackToTables` undoes it for a block whose cells stopped qualifying once the images were
 *  resolved (a picture can be dropped).
 *  Limit: Word's column widths are not taken.
 *  NOT here: how `columns` is written (`renderer/storage.ts`), how the page is checked
 *  (`conservation/structure-conservation.ts`).
 *  Called by: `docx-reader/index.ts`. */

import type { IRBlock } from "doc-ir/lib/ir";
import { wordsOf } from "../../lib/words";

/** Fewest words a cell needs to count as prose. Starting value to calibrate: 62 form tables have a poorest cell of 1 to 3 words, 24 prose
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
    const count = wordsOfBlock(block);
    if (count === undefined) return undefined;
    total += count;
  }
  return total;
};

/** The words of one block; `undefined` for a kind a layout cell does not hold. */
const wordsOfBlock = (block: IRBlock): number | undefined => {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return wordsOf(block.inlines.map((inline) => inline.text).join("")).length;
    case "list":
      return wordsOfBlocks(block.items.flat());
    case "image":
      return 0;
    default:
      return undefined;
  }
};

const cellKind = (blocks: readonly IRBlock[]): CellKind => {
  const words = wordsOfBlocks(blocks);
  if (words === undefined) return "other";
  if (words >= LAYOUT_TABLE_MIN_WORDS) return "prose";
  return words === 0 && blocks.some((block) => block.kind === "image") ? "picture" : "other";
};

/** The `layout` of the kinds of the cells, or `undefined` when the table is not a layout table. */
const layoutOf = (kinds: readonly CellKind[]): Columns["layout"] | undefined => {
  if (kinds.includes("other") || !kinds.includes("prose")) return undefined;
  const [first, second, last] = kinds;
  if (kinds.length === 2) {
    if (first === "picture") return "two_left_sidebar";
    return second === "picture" ? "two_right_sidebar" : "two_equal";
  }
  return first === "picture" && last === "picture" ? "three_with_sidebars" : "three_equal";
};

const asColumns = (table: Table): Columns | undefined => {
  if (table.rows.length !== 1) return undefined;
  const [row] = table.rows;
  if (row === undefined || (row.cells.length !== 2 && row.cells.length !== 3)) return undefined;
  if (row.cells.some((cell) => cell.colspan !== undefined || cell.rowspan !== undefined)) return undefined;
  const layout = layoutOf(row.cells.map((cell) => cellKind(cell.blocks)));
  return layout === undefined ? undefined : { kind: "columns", layout, cells: row.cells.map((cell) => cell.blocks) };
};

/** The blocks with each qualifying top-level table replaced by its `columns`; every other block comes back as the same object. `neverConverted`: blocks
 *  never converted (the reader's text-box blocks, which join the body's flow). */
export const layoutTablesToColumns = (
  blocks: readonly IRBlock[],
  neverConverted: ReadonlySet<IRBlock> = new Set(),
): IRBlock[] =>
  blocks.map((block) => (block.kind === "table" && !neverConverted.has(block) ? (asColumns(block) ?? block) : block));

/** The blocks with each top-level `columns` whose cells no longer qualify (the cells are classed before `images.resolve`, which may drop a
 *  picture) put back as the one-row table it came from; every other block comes back as the same object. */
export const columnsBackToTables = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.map((block) => {
    if (block.kind !== "columns") return block;
    if (layoutOf(block.cells.map(cellKind)) !== undefined) return block;
    return { kind: "table", rows: [{ cells: block.cells.map((cellBlocks) => ({ blocks: cellBlocks })) }] };
  });
