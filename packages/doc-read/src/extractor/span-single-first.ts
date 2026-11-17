/** The ONE rule « a table row whose only non-empty cell is the first publishes as ONE cell with a colspan over the table's full width ».
 *  Decides: which rows of a finished IR table qualify (guards: a header row, a row covered by or anchoring a rowspan, a table narrower than 2
 *  columns are never changed) and rewrites them; also the ONE definition of a cell's visible text (`cellText`).
 *  NOT here: how a table is read or its header cells marked (each reader, BEFORE this runs), nor whether a table is a layout table
 *  (`docx-reader/layout-tables.ts`).
 *  Called by: `extractor/sheet-workbook.ts` (xlsx, Google Sheets), `extractor/docx-reader/body.ts` (docx, Google Doc),
 *  `extractor/pptx.ts#tableBlock` (pptx). */

import type { IRBlock } from "doc-ir/lib/ir";

type Table = Extract<IRBlock, { kind: "table" }>;

/** A ROW WHOSE ONLY TEXT IS IN ITS FIRST CELL SPANS THE TABLE (27/10/2026, on the published page of FAQ_M365_Migration_CNE.xlsx).
 *  Excel lets a text overflow visually from its cell WITHOUT a merge, onto the empty neighbours, the same everywhere (a title, a
 *  subtitle, a note, an inner section label). Published as ordinary cells they choke the first column and wrap the sentence word by
 *  word. Every row whose only non-empty cell is the first one publishes as ONE cell with a colspan over every published column: the
 *  overflow, made faithful. The row stays a row, so nothing moves: positions, structure counts and number checks read the same places.
 *  A lone number or date takes part like any text (it stays in column 0, now spanning). An empty row stays what it was. Two
 *  guards: a row covered by a rowspan or anchoring one is never changed (merge conflict), and a row the file DECLARES as the
 *  header (frozen pane, table span — `markHeaders` runs first) keeps its cells, so the header stays aligned with the data
 *  columns (revue 27/10/2026).
 *  SHARED by both spreadsheet readers (xlsx and Google Sheets): the design needs no cell types (27/10/2026).
 *  WRITTEN BIAS (fixture 12, 27/10/2026): Excel does not overflow text over a FORMULA cell even when it carries no cached value;
 *  this rule treats such a cell as empty and spans over it (the cell was publishing empty anyway, and the formula-cells-empty
 *  notice still counts it).
 *  Genesis: first designed as lifting these rows out as paragraphs, then as border rows only; simplified twice by on 27/10
 *  (« on ne trahit rien »). TRIED AND SET ASIDE: lifting out as paragraphs moved rows and forced three control re-readings
 *  (position, structure, abstentions); the colspan keeps every invariant. */
export const spanSingleFirstRows = (table: Table): Table => {
  const rows = table.rows;
  // By LOOP, never a spread: one argument per ROW, and a docx table is not row-capped before this runs (tour 10).
  const widthOf = (row: Table["rows"][number]): number => row.cells.reduce((n, c) => n + (c.colspan ?? 1), 0);
  let width = 0;
  for (const row of rows) {
    const w = widthOf(row);
    if (w > width) width = w;
  }
  if (width < 2) return table;
  const covered = new Set<number>();
  rows.forEach((row, at) => {
    let reach = 1;
    for (const c of row.cells) if ((c.rowspan ?? 1) > reach) reach = c.rowspan ?? 1;
    for (let k = reach > 1 ? 0 : 1; k < reach; k++) covered.add(at + k);
  });
  // A cell HOLDS CONTENT when any block publishes something: text beyond blanks, an inline ANCHOR (a Word bookmark has empty
  // text and is the target of `#name` links: collapsing over it would break them) or an inline IMAGE, a list or a nested table
  // whose own cells hold something, any other block. Reading the text alone would collapse over them and LOSE them
  // (revue 27/10/2026, tours 5 and 8).
  // THE SAME DEFINITION AS `lib/table-empty-parts.ts#hasContent`, the one the renderer uses to drop empty columns — written
  // here rather than imported because the library takes no NEW edge to the app (`library-boundary.test.ts`: a ceiling only goes
  // down, and that file joins the library at step 2 of docs/PLAN-BIBLIOTHEQUE.md, where this copy is deleted). The two are
  // pinned EQUAL by `span-single-first.test.ts` (a test may import the app freely).
  const holdsContent = (c: { blocks: readonly IRBlock[] }): boolean =>
    c.blocks.some((b) => {
      switch (b.kind) {
        case "paragraph":
        case "heading":
          return b.inlines.some((i) => i.text.trim() !== "" || i.image !== undefined || i.anchor !== undefined);
        case "list":
          return b.items.some((items) => holdsContent({ blocks: items }));
        case "table":
          return b.rows.some((r) => r.cells.some((inner) => holdsContent(inner)));
        default:
          return true;
      }
    });
  const isSingleFirst = (cells: Table["rows"][number]["cells"]): boolean =>
    cells.length > 1 && holdsContent(cells[0]!) && cells.slice(1).every((c) => !holdsContent(c));
  // A RAGGED row (summing under the table's width) ABSTAINS: the rule cannot read why it is short, so it must not widen it
  // (hardening, evening review 27/10/2026 — every current builder emits rectangular rows, pinned by span-single-first.test.ts).
  const fullWidth = (cells: Table["rows"][number]["cells"]): boolean =>
    cells.reduce((n, c) => n + (c.colspan ?? 1), 0) === width;
  return {
    ...table,
    rows: rows.map((row, at) =>
      covered.has(at) || row.cells.some((c) => c.header === true) || !isSingleFirst(row.cells) || !fullWidth(row.cells)
        ? row
        : { cells: [{ ...row.cells[0]!, colspan: width }] },
    ),
  };
};

/** The visible text of a table cell (paragraph and heading inlines, joined, trimmed): the ONE definition, the tests import it too. */
export const cellText = (cell: Table["rows"][number]["cells"][number]): string =>
  cell.blocks
    .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((i) => i.text).join("") : ""))
    .join("")
    .trim();
