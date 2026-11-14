/** One DrawingML table (`a:tbl`) as the slide declares it: its grid
 *  (`a:tblGrid/a:gridCol` widths), its rows (`a:tr`), and each cell (`a:tc`)
 *  that starts a span, with `gridSpan` as colspan and `rowSpan` as rowspan.
 *  A cell absorbed by a span (`hMerge` or `vMerge`) is no cell here: the span
 *  covers it. Close to the IR's `table` block on purpose.
 *  NOT here: what a cell paragraph carries (`pptx-reader/text.ts`), the frame
 *  that holds the table (`pptx-reader/shapes.ts`), borders, fills and table
 *  styles (never read), nor the first column / last row flags (`firstCol`,
 *  `lastRow`: styling, not structure).
 *  Called by: `pptx-reader/shapes.ts`. */

import type { Relationship } from "../ooxml/package";
import { attr, child, children, type XNode } from "../ooxml/xml";
import { isTrue, type PptxParagraph, readParagraph } from "./text";

interface PptxTableCell {
  /** One entry per `a:p` of the cell's `a:txBody`, empty paragraphs included. */
  paragraphs: PptxParagraph[];
  /** `gridSpan`, only when above 1; never past the declared grid's columns. */
  colspan?: number;
  /** `rowSpan`, only when above 1; never past the table's rows. */
  rowspan?: number;
  /** Only `true`, on every cell of the first row when `a:tblPr firstRow` is
   *  on: that is what the file declares a header row to be. */
  header?: true;
}

export interface PptxTable {
  /** `a:gridCol w` in EMU, one per grid column; its length is the column count. */
  columnWidths: number[];
  /** One per `a:tr`, a row whose cells are all absorbed included (with no
   *  cell): the rowspans above count it. */
  rows: { cells: PptxTableCell[] }[];
}

/** A span attribute above 1, clamped to `room` (what the declared grid
 *  leaves past the cell), else nothing (absent, 1, unreadable, or no room).
 *  An EXACT clamp, no threshold of its own: a written rowSpan="999999999"
 *  crossed into the page as a rowspan. */
const spanOf = (value: string | undefined, room: number): number | undefined => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 1 && room > 1 ? Math.min(n, room) : undefined;
};

export const readTable = (tbl: XNode, rels: ReadonlyMap<string, Relationship>, slideNumber?: number): PptxTable => {
  const columnWidths = children(child(tbl, "a:tblGrid") ?? {}, "a:gridCol").map((col) => {
    const w = Number.parseInt(attr(col, "w") ?? "", 10);
    return Number.isInteger(w) && w > 0 ? w : 0;
  });
  const headerRow = isTrue(attr(child(tbl, "a:tblPr") ?? {}, "firstRow"));
  const trs = children(tbl, "a:tr");
  const rows = trs.map((tr, rowIndex) => ({
    // Each `a:tc` is one grid column (an absorbed one included), so a cell's
    // grid position is its rank among ALL the row's `a:tc`: gridSpan is
    // clamped to the declared columns right of it, rowSpan to the rows below.
    cells: children(tr, "a:tc").flatMap((tc, tcIndex): PptxTableCell[] => {
      if (isTrue(attr(tc, "hMerge")) || isTrue(attr(tc, "vMerge"))) return [];
      const colspan = spanOf(attr(tc, "gridSpan"), columnWidths.length - tcIndex);
      const rowspan = spanOf(attr(tc, "rowSpan"), trs.length - rowIndex);
      return [
        {
          paragraphs: children(child(tc, "a:txBody") ?? {}, "a:p").map((p) => readParagraph(p, rels, slideNumber === undefined ? {} : { slideNumber })),
          ...(colspan === undefined ? {} : { colspan }),
          ...(rowspan === undefined ? {} : { rowspan }),
          ...(headerRow && rowIndex === 0 ? { header: true as const } : {}),
        },
      ];
    }),
  }));
  return { columnWidths, rows };
};
