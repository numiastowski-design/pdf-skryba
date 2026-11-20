/** Joins two adjacent top-level paragraphs of the storage XHTML into one when the render cut a sentence between them — the shape says so and the PDF reads their edge words in a row, at one size — and undoes the whole join if the re-check comes out worse in any way.
 *  NOT here: where a line break is decided (`extractor/pdf-line-breaks.ts`), the word reading that links page words to source words (`pipeline/text-conservation.ts`), the other repairs (`pipeline/lost-text-repair.ts`, `pipeline/glued-word-repair.ts`), headings cut in two, nor the paragraphs of a table cell or of a list item (measured, then refused — see the module note).
 *  Called by: `pipeline/publish-conservation.ts`, once per checked PDF render, after the other two repairs. */

/**
 * THE RULE (22/09/2026, lot 35 — remedy B of the mid-sentence cuts
 * diagnosis). Two `<p>` children of the SAME element, with nothing between
 * them, become one ONLY when two independent readings agree:
 *  - THE SHAPE, in our render: the first does not end with `. : ; ! ? » " … )`
 *    and the second starts with a word all in lower case (signature S2 of
 *    `tools/render-lint.ts`, rewritten here because `src/` never imports
 *    `tools/`). A second paragraph that opens on a list marker (« a. »,
 *    « iv) », « – », `layout/list.ts#markerOf`) or on a token of ONE letter is
 *    never a continuation.
 *  - THE SOURCE: the last three words of the first and the first three of
 *    the second are six source words in a row in the PDF's reading, furniture
 *    left out, and the two edge words are set at the same size. The link from
 *    page word to source word is the check's own tiling, so nothing is read
 *    twice.
 * Anything else stays as it is. A paragraph cut in two is still all there
 * and searchable; two paragraphs joined by mistake are a sentence that never
 * existed.
 *
 * WHERE IT WORKS: the page's own `<p>` only.
 *
 * ⚠️ MEASURED IN A CELL, THEN REFUSED (condition, 22/09/2026: not
 * one wrong join in a cell). Joining the `<p>` of ONE cell — a cell's lines
 * are each a paragraph (`extractor/pdf-table-render.ts`) — gives 65 joins on
 * the 39 French and English PDFs, 64 of them right, including the two cuts
 * of safedocs 0000754 p2 (defect E) and 49 lines of fixture 26 rejoined.
 * THE ONE WRONG, fixture 26 p13, cell of « Moyens de Communication Interne »:
 * « Le chat via Google drive » ‖ « ordinateur portable pour chaque
 * collaborateur. » are TWO bullets of a list (checked against the page
 * image); the bullet character is DRAWN, absent from the text layer, so the
 * second item opens on a lowercase word the PDF reads right after the first.
 * A cell packs items without markers far more often than prose does — that
 * is what the measurement shows, and why the same rule is not safe there.
 * The two `<p>` of one list item, and two cells side by side, are refused for
 * the same reason (0000713 p5: two items of one cell must stay two).
 *
 * MEASURED on the 39 French and English PDFs, publish path, 22/09/2026: 18
 * joins in 7 documents (16 groups, two of them three paragraphs), 61 → 43
 * pairs of the S2 shape at the top level, every verdict unchanged, no letter
 * lost and none added. Each join was read: 17 right, 1 wrong (below).
 *
 * ⚠️ WHY A TOKEN OF ONE LETTER STOPS THE JOIN. Two joins of a first
 * measurement were wrong, both on fixture 25: the bullet of a three-line spec
 * list is drawn « x » in the text layer, so it reads as a lowercase word, and
 * the PDF does read it right after the line before. `markerOf` does not catch
 * it — nothing in the extraction reads a symbol font's glyph as a bullet.
 * DECIDED (22/09/2026): a paragraph opening on a token of ONE
 * letter is never a continuation. It costs none of the 17 right joins.
 *  - THE LIMIT IT BRINGS, written and accepted: a real continuation opening
 *    on « il », « y », « à », « a » is refused too — « …tout ce qu'il ‖ y a
 *    de plus simple ». No such case in the 39 French and English PDFs.
 *  - TRIED AND SET ASIDE: reading the glyph's FONT to know a drawn bullet.
 *    It is the honest reading, and it needs a new datum — the font of each
 *    run — carried from `extractor/pdf-source.ts` through `ConservationRun`
 *    to here, for two joins on one document. One line of shape beats it.
 *
 * THE ONE WRONG JOIN LEFT, safedocs 0000393: a page of search results, where a result's
 * snippet is joined to the next result's title (« …920cc. 1982 and 1983 » ‖
 * « virago xv535 1100 1981 1994 service manual … - Yamaha club »). Both
 * readings say « continuation »: the title is lower case and the PDF does
 * read it right after. Nothing separates it without reading the meaning.
 *
 * NOT IN THIS LOT. Two consecutive headings (S1): measured, it joins « …GVS
 * 2015 » with « Executive Summary » (fixture 28).
 *
 * THE JOIN. `<p>A</p><p>B</p>` becomes `<p>A B</p>`: each part's inner XHTML
 * as it was, marks included, and one space. No word is added or removed.
 *
 * THE UNDO. The joined page is checked again. Its letters must be exactly the
 * same, in the same order, and it may lose no letter, glue no word, carry no
 * new word the PDF lacks, nor turn the verdict into an abstention; otherwise
 * the original page and its verdict are kept, whole.
 *
 * ⚠️ CLIENT TEXT, in memory only, like the verdict it reads.
 */

import { collapseBlanks } from "doc-ir/internal";
import { markerOf } from "../layout/list";
import {
  conservationKey,
  type ConservationVerdict,
  type PageEdit,
  type PublishedPage,
  type SourceWordLink,
} from "doc-ir";

/** How many words each side of the cut must bring, read in a row by the PDF
 *  (fewer when the paragraph has fewer). Simulated on 39 French and English
 *  PDFs before this lot (diagnosis of 22/09/2026): 41 joins with 3, 48 with
 *  1. The stricter window is kept. */
const WINDOW = 3;

/** A sentence closes on these (`tools/render-lint.ts`, S2). */
const TERMINAL = /[.:;!?»"…)]$/u;
/** « suite de la phrase » yes, « iPhone » no. */
const startsLowercaseWord = (text: string): boolean => /^\p{Ll}+(?![\p{L}\p{N}])/u.test(text);

/** A paragraph opening on a token of ONE letter: a marker drawn with a symbol
 *  font, not a word carried over (22/09/2026 — see the module note). */
const startsOnALoneLetter = (text: string): boolean => conservationKey(text.split(/\s+/)[0] ?? "").length <= 1;

/** The text of one UNIT, as this rule reads it: the texts of the blocks it holds, joined by a space — a line break
 *  inside a paragraph ends a block, and the old rule turned that `<br>` into a space before collapsing blanks. */
const textOfUnit = (page: PublishedPage, blocks: readonly number[]): string =>
  collapseBlanks(blocks.map((b) => page.blocks[b] ?? "").join(" "));

/** Whether the PDF reads `tail` then `head` as source words in a row, the two edge words at one size. */
const readInARow = (tail: readonly (SourceWordLink | null)[], head: readonly (SourceWordLink | null)[]): boolean => {
  const words = [...tail, ...head];
  if (tail.length === 0 || head.length === 0 || words.some((w) => w === null)) return false;
  const links = words as SourceWordLink[];
  for (let k = 1; k < links.length; k++) if (links[k]!.index !== links[k - 1]!.index + 1) return false;
  const last = links[tail.length - 1]!;
  const first = links[tail.length]!;
  return Math.abs(last.lastSize - first.firstSize) < 0.01;
};

/** Whether the re-checked page is no worse than the original in any way. Exported since 09/11/2026: the loop that
 *  applies the joins and re-checks is the caller's — it writes the page — but the rule for keeping or undoing them is
 *  this check's, and a caller that invented its own could keep a page that lost a letter. */
export const noWorse = (before: ConservationVerdict, after: ConservationVerdict): boolean =>
  after.decision !== "abstain" &&
  (after.decision !== "lost" || before.decision === "lost") &&
  after.lostLetters <= before.lostLetters &&
  after.gluedWords <= before.gluedWords &&
  after.unmatchedPageWords <= before.unmatchedPageWords;

/**
 * THE JOINS THIS RULE PROVES, as edits for the caller to apply to its own page (09/11/2026). It writes nothing:
 * removing `</p><p>` from a storage XHTML is knowledge of ONE destination, and this check has none.
 *
 * Reasons it abstains, unchanged: no `units` from the caller (it cannot know what a unit is on its own), a verdict
 * that abstains (the tiling linking the words is not trusted), a unit the caller did not call `joinable`, or anything
 * of the page sitting between the two.
 */
export function cutParagraphEdits(
  page: PublishedPage,
  verdict: ConservationVerdict,
): { edits: PageEdit[]; joined: number } {
  const units = page.units;
  if (units === undefined || verdict.decision === "abstain") return { edits: [], joined: 0 };

  // Each unit's page words, as links to the source: the words of every block the unit holds, in order.
  const links: (SourceWordLink | null)[][] = units.map((unit) =>
    unit.blocks.flatMap((b) => verdict.sourceOfPageWords[b] ?? []),
  );

  const cutAfter = (u: number): boolean => {
    const first = units[u]!;
    const second = units[u + 1]!;
    if (!first.joinable || !second.joinable || !first.adjacentToNext) return false;
    const ta = textOfUnit(page, first.blocks);
    const tb = textOfUnit(page, second.blocks);
    if (ta.length === 0 || TERMINAL.test(ta)) return false;
    if (!startsLowercaseWord(tb) || markerOf(tb) !== undefined || startsOnALoneLetter(tb)) return false;
    return readInARow(links[u]!.slice(-WINDOW), links[u + 1]!.slice(0, WINDOW));
  };

  // Right to left, so a join never shifts the unit still to look at.
  const edits: PageEdit[] = [];
  for (let u = units.length - 2; u >= 0; u--) if (cutAfter(u)) edits.push({ kind: "join-units", unit: u });
  return { edits, joined: edits.length };
}
