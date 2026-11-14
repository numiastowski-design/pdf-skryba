/** The entries of the font tables a document has made us keep: how they are counted, and the refusal past the ceiling.
 *  Decides: that every `/ToUnicode` table and every CID `/W` table, ALL fonts taken together, is charged to ONE budget
 *  and that the document is refused once it is spent.
 *  NOT here: the tables themselves (`./to-unicode.ts`, `./widths.ts`), the value of the ceiling (`./bounds.ts`).
 *  Called by: `./font-text.ts`, `./widths.ts`, and `../pdf-glyph-source.ts`, which owns the budget of a document. */

import { PdfObjectsRefusal } from "../pdf-objects/refusal";
import { MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT } from "./bounds";

/** What the font tables of a document have cost so far, in entries. */
export interface TableBudget {
  entries: number;
}

/** Charges `entries` more to the budget, and refuses the document (`font-tables-too-many`) past the ceiling. No budget, no charge. */
export function chargeTableEntries(budget: TableBudget | undefined, entries: number): void {
  if (budget === undefined) return;
  budget.entries += entries;
  if (budget.entries > MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT) throw new PdfObjectsRefusal("font-tables-too-many");
}
