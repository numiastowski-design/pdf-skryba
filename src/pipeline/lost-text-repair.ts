/** Decides WHERE a passage the render lost goes back into the published page, as its own paragraph between the two adjacent top-level paragraphs that hold its source neighbours — and hands the caller the edit and the letters it puts back, or why it abstains.
 *  NOT here: finding the lost words and their neighbours (`pipeline/text-conservation.ts`), glued words (`pipeline/glued-word-repair.ts`), nor applying an edit, checking the page again and keeping or undoing the repair: all three are the caller's.
 *  Called by: a caller of the published light door (`lib/pdf-light.ts`), once per checked PDF render. */

/**
 * THE RULE (21/09/2026, lot 5). A lost passage is a run of
 * consecutive source words neither reading found. Its neighbours are the
 * source words right before and right after it. It goes back ONLY when:
 *  - each neighbour is a word the page matched (not an alt text, a list
 *    number, a re-spacing: those have no single place in the page);
 *  - the neighbour before is the LAST word of a top-level paragraph or
 *    heading, the one after the FIRST word of the next top-level element,
 *    with nothing between the two elements;
 *  - at the start or the end of the document, the one neighbour opens the
 *    page's first text block, or closes its last one.
 * Anything else abstains by name and the page stays « lost », visible on the
 * dashboard: a loss inside a paragraph, a table cell, a list, an image
 * between the two paragraphs. A paragraph cut in the wrong place reads as if
 * nothing were wrong; a « N characters are not published » line does not.
 *
 * WHY THE XHTML AND NOT THE DOCUMENT MODEL (as lot 4). The check locates each
 * neighbour by block and word in the XHTML it read; the insertion goes at an
 * element boundary of that same XHTML, so no second mapping can disagree. The
 * inserted paragraph is the words as the PDF reads them, joined by single
 * spaces, escaped by the serializer's own `escapeText`.
 *
 * THE UNDO IS THE CALLER'S, NOT THIS MODULE'S. A caller applies the edits,
 * checks the repaired page again, and decides alone whether to keep it or to
 * restore the original page and its verdict. This module publishes only what
 * that re-check needs: for each passage placed, the edit and the number of
 * letters it puts back (`LostTextInsertion`); for each passage left where it
 * was, why (`LostTextAbstention`). A caller that wants an exact repair keeps
 * it only when the lost letters drop by EXACTLY the letters handed back here
 * and nothing else of the page moves: that rule is written where it is run.
 *
 * WHERE IT LANDS IS THE SOURCE'S ORDER, NOT THE RENDER'S. The neighbours are
 * read in content-stream order. Measured on 871 paragraphs cut from the 45
 * fixture renders (21/09/2026): 426 put back with the page's letters exactly
 * as before, 22 put back elsewhere — where the stream reads them. Some of
 * those read better than the render did (a form label, 0000523), some worse
 * (a second column read line by line, fixture 11). Tried and NOT kept: also
 * requiring the blocks on each side to follow the source's order — it
 * caught 8 of the 22 and cost 17 exact repairs. Text back in the page is what
 * search needs; a paragraph slightly out of place is the lesser defect.
 *
 * ⚠️ CLIENT TEXT, in memory only, like the verdict it reads.
 */

import {
  conservationKey,
  wordKeysOf,
  type LostPassage,
  type PageEdit,
  type PageWordAt,
  type PublishedPage,
} from "doc-ir";

/** Why a lost passage was not put back — a closed list. */
export type LostTextAbstention =
  | "no-anchor"
  | "anchor-unmatched"
  | "anchors-out-of-order"
  | "anchor-in-container"
  | "loss-inside-block"
  | "blocks-not-adjacent";

/** One passage placed: the edit the caller applies, and the letters it puts back (for the caller's accounting). */
export interface LostTextInsertion {
  edit: PageEdit;
  letters: number;
}

/** Where each lost passage goes, as an edit for the caller to apply — or why it does not go anywhere.
 *
 * It reasons on the page's UNITS (`PublishedPage.units`), never on markup (09/11/2026): a passage is put back between
 * two units only when the source word before it is the LAST word of its unit, the one after it the FIRST of the next,
 * both units are prose or a title, and nothing of the page sits between them. Anything less certain abstains by name,
 * and the name travels to the caller so a reader of the dashboard knows why nothing was repaired.
 *
 * `units` absent (the caller cannot say what a unit is): every passage abstains with `anchor-in-container` — the same
 * answer as a page whose anchors sit somewhere a paragraph may not go.
 */
export function placeLostPassages(
  page: PublishedPage,
  passages: readonly LostPassage[],
): { insertions: LostTextInsertion[]; abstentions: LostTextAbstention[] } {
  const insertions: LostTextInsertion[] = [];
  const abstentions: LostTextAbstention[] = [];
  if (passages.length === 0) return { insertions, abstentions };
  const units = page.units;
  const words = page.blocks.map((text) => wordKeysOf(text).length);
  const lastBlock = words.length - 1;
  const unitOf = (block: number): number => units?.findIndex((unit) => unit.blocks.includes(block)) ?? -1;

  /** The anchor's unit, or why it cannot anchor. */
  const edgeOf = (at: PageWordAt, side: "before" | "after"): number | LostTextAbstention => {
    const u = unitOf(at.block);
    if (u < 0 || units?.[u]?.paragraphOrHeading !== true) return "anchor-in-container";
    // The last word of the unit (before) or its first (after): the loss must sit at the unit's edge, not inside it.
    const neighbourBlock = side === "before" ? at.block + 1 : at.block - 1;
    const atEdge = side === "before" ? at.word === (words[at.block] ?? 0) - 1 : at.word === 0;
    if (!atEdge || unitOf(neighbourBlock) === u) return "loss-inside-block";
    return u;
  };

  /** The unit the passage goes AFTER (`-1`: before the first unit), or why it does not. */
  const place = (passage: LostPassage): number | LostTextAbstention => {
    const { before, after } = passage;
    if (before === "unanchored" || after === "unanchored") return "anchor-unmatched";
    if (before === "document-edge" && after === "document-edge") return "no-anchor";
    if (before !== "document-edge" && after !== "document-edge") {
      if (after.block < before.block || (after.block === before.block && after.word <= before.word))
        return "anchors-out-of-order";
    }
    const u1 = before === "document-edge" ? undefined : edgeOf(before, "before");
    if (typeof u1 === "string") return u1;
    const u2 = after === "document-edge" ? undefined : edgeOf(after, "after");
    if (typeof u2 === "string") return u2;
    if (u1 === undefined) return after !== "document-edge" && after.block === 0 ? u2! - 1 : "no-anchor";
    if (u2 === undefined) return before !== "document-edge" && before.block === lastBlock ? u1 : "no-anchor";
    return u2 === u1 + 1 && units?.[u1]?.adjacentToNext === true ? u1 : "blocks-not-adjacent";
  };

  for (const passage of passages) {
    const at = place(passage);
    if (typeof at === "string") abstentions.push(at);
    else {
      insertions.push({
        edit: { kind: "insert-unit-after", unit: at, text: passage.sourceWords.join(" ") },
        letters: passage.sourceWords.reduce((n, w) => n + conservationKey(w).length, 0),
      });
    }
  }
  return { insertions, abstentions };
}
