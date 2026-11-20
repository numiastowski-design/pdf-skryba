/** A URL cut from one table row to the next comes back whole.
 *  Decides: when the last cell of a row ends on a URL and the next row has a single cell that continues it, the two
 *  halves are joined with no separator, and nothing else.
 *
 *  The discriminant is the URL, not the narrow row: a quarter of the rows measured are narrower than their grid, and
 *  the candidates that do not end on a URL would glue independent cells. Written weakness: one known case; the rule
 *  repairs it and cannot be shown to generalise.
 *
 *  Its predicate is its own, never shared: a hyphen predicate borrowed from `layout/cell-text.ts` once glued a dash to
 *  an amount, a number the document does not carry. Here the URL is the precondition and the hyphen plays no part.
 *  Chosen bias: a URL a document really writes in two pieces comes out joined. Ugly and visible rather than cut and
 *  not findable.
 *
 *  NOT here: the join of two lines of one cell (`layout/cell-text.ts#wrapSeparator`), that of two lines of a paragraph
 *  (`extractor/pdf-cell-paragraphs.ts#cutAcrossLines`), nor the repair of cut paragraphs of the published page
 *  (`pipeline/cut-paragraph-repair.ts`, which never touches a table).
 *  Called by: `extractor/pdf-table-render.ts`. */

import type { IRBlock } from "doc-ir";

/** A URL that ends the cell, with no blank after it: a trailing blank is a separator the document wrote. */
const URL_AT_END = /https?:\/\/\S*$/u;
/** The continuation starts with a character a URL path carries, never a blank. */
const URL_CONTINUES = /^[\p{L}\p{N}/\-._~%?#=&+]/u;

type TableBlock = Extract<IRBlock, { kind: "table" }>;
type Row = TableBlock["rows"][number];
type Cell = Row["cells"][number];

type Paragraph = Extract<IRBlock, { kind: "paragraph" }>;

const paragraphOf = (block: IRBlock | undefined): Paragraph | undefined =>
  block?.kind === "paragraph" ? block : undefined;
const textOf = (paragraph: Paragraph): string => paragraph.inlines.map((inline) => inline.text).join("");

/** The two halves of a URL, from the last cell of a row to the single cell of the next: returned, not only
 *  recognised, so that the reading that decides is the one used afterwards and no precondition is checked twice. */
const urlHalves = (
  above: Cell | undefined,
  alone: Cell | undefined,
): { end: Paragraph; start: Paragraph } | undefined => {
  const end = paragraphOf(above?.blocks[above.blocks.length - 1]);
  const start = paragraphOf(alone?.blocks[0]);
  if (end === undefined || start === undefined) return undefined;
  const text = textOf(end);
  if (text !== text.trimEnd() || !URL_AT_END.test(text) || !URL_CONTINUES.test(textOf(start))) return undefined;
  return { end, start };
};

/** The cell above, its last paragraph extended by that of the one-cell row, with no separator, then the remaining
 *  blocks of that row. */
const extended = (above: Cell, alone: Cell, halves: { end: Paragraph; start: Paragraph }): Cell => ({
  ...above,
  blocks: [
    ...above.blocks.slice(0, -1),
    { ...halves.end, inlines: [...halves.end.inlines, ...halves.start.inlines] },
    ...alone.blocks.slice(1),
  ],
});

/** The rows of a table, those that only continue a URL folded into the row above. Pure: never mutates its input. */
export function joinCutUrlRows(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const previous = out[out.length - 1];
    // A one-cell row under a row of several cells: the only shape the rule looks at.
    const alone =
      row.cells.length === 1 && previous !== undefined && previous.cells.length > 1 ? row.cells[0] : undefined;
    const above = previous?.cells[previous.cells.length - 1];
    const halves = urlHalves(above, alone);
    if (previous === undefined || alone === undefined || above === undefined || halves === undefined) {
      out.push(row);
      continue;
    }
    const cells = [...previous.cells];
    cells[cells.length - 1] = extended(above, alone, halves);
    out[out.length - 1] = { ...previous, cells };
  }
  return out;
}
