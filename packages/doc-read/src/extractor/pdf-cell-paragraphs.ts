/** Where one paragraph ends and the next begins INSIDE a table cell — the
 *  ordinary rules applied only where they still hold, and a line break rather
 *  than a paragraph blank everywhere else.
 *  NOT here: the lines themselves and the wraps inside them
 *  (`layout/cell-text.ts`), the predicates this file asks
 *  (`extractor/pdf-line-breaks.ts`), nor the paragraphs of the prose AROUND a
 *  table (`extractor/pdf-paragraphs.ts`).
 *  Called by: `extractor/pdf-table-render.ts`. */

import type { CellLine } from "doc-ir/layout/cell-text";
import { cutAcrossLines } from "doc-ir/layout/cut-word";
import type { Fragment } from "doc-ir/layout/geometry";
import { isDeliberateBreak, startsNewItem } from "./pdf-line-breaks";
import type { Line } from "./pdf-model";
import { PARAGRAPH_BREAK_GAP_RATIO } from "./pdf-paragraphs";

/**
 * A CELL JOINS ITS LINES ONLY IN A TABLE OF ONE COLUMN (23/09/2026).
 * The caller applies that condition; this file assumes it and does nothing else.
 *
 * WHAT CAME BEFORE. Lot « 41 » applied these same predicates in EVERY cell.
 * Measured on the 39 French and English PDFs: 126 joins, 86 right and 40 wrong
 * — the list, document by document, stays at `pdf-table-render.ts` with the two
 * geometric readings that were tried and set aside. The rule was given up whole.
 *
 * WHY ONE COLUMN IS THE RIGHT CONDITION, AND NOT A CONVENIENCE. The measured
 * cause of those 40 wrong joins is written down there: « did the next word fit »
 * is asked against a MARGIN, and a narrow cell has none — the margin is set by
 * the OTHER line of the pair, so the shorter of the two never has room and
 * everything rejoins. IN A TABLE OF ONE COLUMN THE CELL IS THE WHOLE WIDTH, so
 * the margin is real again and the question becomes valid again. The condition
 * restores the situation `paragraphsFromLines` was calibrated in, instead of
 * sorting its results afterwards.
 *
 * IT SEPARATES THE TWO MEASURED POPULATIONS. The Canva booklet is made of
 * one-column page frames and it gains whole sentences. The school reports are
 * grids of several columns — subject, grades, teacher, appreciation — so nothing
 * joins there at all, and that is where « 7,00 » was joining « 6,00 ». Safedocs
 * 0000754 has two content columns on both its pages, so nothing joins there
 * either.
 *
 * WHAT THAT CONDITION ALONE DID NOT DO, and why the margin below changed. With
 * the widest LINE of the cell as the margin, safedocs 0000713 — a one-column
 * table — made 14 joins there, 9 of them WRONG: page 3 published « Présentation
 * de l’organisation sur site Organigramme opérationnel », two entries of a
 * list, and page 5 « Le bilan de la maintenance préventive Le bilan de la
 * maintenance curative ». Both seen on the page images (`pdftoppm -r 110`).
 * Counting the GRID's columns instead of the published ones did not help: page
 * 3 leaves the rule that way, page 5 keeps its two wrong joins.
 *
 * AND A SECOND CONDITION, WHICH APPLIES WITH THE FIRST AND NOT INSTEAD OF IT
 * (23/09/2026): A PIECE THAT IS ONLY A NUMBER NEVER JOINS ANYTHING. A
 * single column can perfectly well hold figures, and two neighbouring numbers
 * are never one sentence cut in two. Where it comes from: the measure of 22-23/09
 * on the real school report, where « 7,00 » and « 6,00 » — the written and the
 * oral GRADE of the same subject — came out as « 7,00 6,00 », one value the
 * document does not carry. `NUMBER_ALONE` below is that guard, and it has its
 * own test.
 *
 * AND A THIRD, THE GRAVEST: THE JOIN MUST NOT FABRICATE A NUMBER. « 7, » then
 * « 6 » joined gives `7,6`, a value the document never carries — see
 * `wouldFabricateNumber`, which holds the whole reasoning.
 *
 * NO THRESHOLD, NO LANGUAGE, NO SHAPE OF WORD. The three conditions are
 * structural and the predicates below are the ordinary ones, unchanged:
 *  1. a CHANGE OF SIZE always opens a paragraph — signal 1 of
 *     `pdf-paragraphs.ts`, a strict equality;
 *  2. a VERTICAL GAP wider than `PARAGRAPH_BREAK_GAP_RATIO` opens one — signal
 *     2 of the same file, the same constant read from there and not copied;
 *  3. a DELIBERATE BREAK ends it — `isDeliberateBreak`, the 0.45 em spare of
 *     lot « 32 »;
 *  4. a MARKER on a line that steps back opens an item — `startsNewItem`.
 * Joins only: this file never ADDS a boundary `recomposeCellText` did not draw.
 *
 * SIGNAL 1 IS NOT DECORATION, IT WAS MEASURED. Left out on 23/09/2026, under an
 * earlier form of this rule that looked at every cell, it published
 * « 8.Environnement de créativité indispensable pour » on booklet 26 page 13 —
 * that page is laid out in two columns and the reading order interleaves them,
 * so a ≈24 pt green title fell between two ≈11 pt body lines of the other
 * column. The one-column condition covers that page too (its table publishes two
 * content columns), so signal 1 is now a second belt; it stays because it is one
 * of the ordinary rules, not because of that page.
 *
 * MEASURED AND SET ASIDE THE SAME DAY, kept in one line because it cost a lot:
 * a « both pieces are prose » gate (the first piece carries a lowercase letter
 * and ends mid-sentence, the second opens on a lowercase letter). It removes
 * every wrong join of lot « 41 », INCLUDING the two of 0000713 above, but it
 * depends on the language, it loses a wrapped ALL-CAPS title (« LIVRET
 * D’ACCUEIL » / « STAGIAIRE »), and it let the booklet page 13 join through.
 *
 * PURE: no I/O, no clock, no randomness, and its input is never mutated.
 */

/**
 * A PIECE THAT IS ONLY A NUMBER — a grade, an amount, a percentage, a count.
 *
 * The grammar is SHORT AND CLOSED, on the model of
 * `layout/page-furniture.ts#PAGE_NUMBER_ALONE`: an optional sign, digits with
 * an optional thousands separator, an optional decimal part behind a comma OR a
 * dot, and an optional percent or currency symbol on either side. Nothing else
 * — no exotic case is invented, and there is no threshold anywhere in it.
 *
 * It is asked of BOTH pieces: a number never continues a sentence, and no
 * sentence continues into a number.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- judged safe 14/10/2026: runs on one trimmed table-cell line
const NUMBER_ALONE = /^[-+−–]?\s*[€$£¥]?\s*\d+(?:[\s.,]\d{3})*(?:[.,]\d+)?\s*[%€$£¥]?$/u;

/** True when the piece, once trimmed, is nothing but a number. */
export const isNumberAlone = (text: string): boolean => NUMBER_ALONE.test(text.trim());

/**
 * THE JOIN WOULD FABRICATE A NUMBER — and this is the gravest defect this
 * product can produce (23/09/2026).
 *
 * A line ending « 7, » followed by a line opening « 6 » does not give a badly
 * assembled sentence when joined: it gives `7,6`, A VALUE THAT IS NOWHERE IN
 * THE DOCUMENT. With a dot, « 7. » then « 6 » gives `7.6`. Commandment 1 says
 * no word is ever invented; an invented FIGURE is worse, because the page looks
 * perfectly normal and the number is false.
 *
 * Refused whenever the first piece ends on a digit — with a comma, with a dot,
 * or with nothing at all, which would run two digits together — and the second
 * opens on a digit.
 *
 * NO SECOND COPY OF THIS RULE EXISTS TO REUSE, and that was checked before
 * writing this one: `pipeline/cut-paragraph-repair.ts`, which joins two
 * paragraphs of the PAGE flow, carries no such guard. It is protected only
 * INDIRECTLY, by `startsLowercaseWord` requiring the second paragraph to open
 * on a lowercase letter, so a digit never opens a join there. That is an
 * implicit protection, not a named one.
 */
const ENDS_ON_A_FIGURE = /\d[.,]?$/u;
const OPENS_ON_A_FIGURE = /^\d/u;
export const wouldFabricateNumber = (previous: string, next: string): boolean =>
  ENDS_ON_A_FIGURE.test(previous.trimEnd()) && OPENS_ON_A_FIGURE.test(next.trimStart());

/** A cell line dressed as a page line, so that the SAME predicates decide
 *  inside a cell and outside one — copying them here would let the two copies
 *  drift. Only the fields those predicates read carry a measurement. */
const asLine = (line: CellLine): Line => ({
  y: line.middle,
  fontSize: line.fontSize,
  text: line.text,
  runs: [{ text: line.text, bold: false }],
  left: line.left,
  right: line.right,
  firstWordWidth: line.firstWordWidth,
  maxInnerGap: 0,
});

/**
 * Do these two logical lines of one cell continue the same paragraph?
 *
 * `marginRight` is the cell's DRAWN right edge — see `joinCellLines`.
 *
 * ABSTENTION: without the next line's first-word advance the typographer's
 * question has no answer, and an unanswered question SEPARATES here. Outside a
 * cell the same absence abstains the other way — there it stops a split, here
 * it stops a join. Both times the abstention keeps the lines apart.
 */
const continuesCellParagraph = (previous: CellLine, next: CellLine, marginRight: number): boolean =>
  next.firstWordWidth > 0 &&
  !isNumberAlone(previous.text) &&
  !isNumberAlone(next.text) &&
  !wouldFabricateNumber(previous.text, next.text) &&
  previous.fontSize === next.startFontSize &&
  next.startFontSize > 0 &&
  (previous.endMiddle - next.middle) / next.startFontSize <= PARAGRAPH_BREAK_GAP_RATIO &&
  !startsNewItem(asLine(previous), asLine(next)) &&
  !isDeliberateBreak(asLine(previous), asLine(next), marginRight);

/** The fragments of two joined lines in reading order, or none when either line has none: half an order is no order. */
const joinedFragments = (a: { fragments?: readonly Fragment[] }, b: { fragments?: readonly Fragment[] }): readonly Fragment[] | undefined =>
  a.fragments !== undefined && b.fragments !== undefined ? [...a.fragments, ...b.fragments] : undefined;

/** The union of two lines' raised calls, or none (`CellLine.raised`). */
const joinedRaised = (a: { raised?: ReadonlySet<Fragment> }, b: { raised?: ReadonlySet<Fragment> }): ReadonlySet<Fragment> | undefined =>
  a.raised === undefined && b.raised === undefined ? undefined : new Set([...(a.raised ?? []), ...(b.raised ?? [])]);

/** Sets `raised` on a line or paragraph being built, or removes it. */
const setRaised = (target: { raised?: ReadonlySet<Fragment> }, raised: ReadonlySet<Fragment> | undefined): void => {
  if (raised === undefined) delete target.raised;
  else target.raised = raised;
};

/** Sets `fragments` on a line or paragraph being built, or removes it. */
const setFragments = (target: { fragments?: readonly Fragment[] }, fragments: readonly Fragment[] | undefined): void => {
  if (fragments === undefined) delete target.fragments;
  else target.fragments = fragments;
};

/**
 * The cell's logical lines, with the ones that continue each other joined. The
 * joined line keeps the FIRST piece's place in the cell — its middle orders it
 * against the images — and ends where the last piece ends.
 *
 * `marginRight` IS THE CELL'S DRAWN RIGHT EDGE, not the widest line it holds,
 * and that choice was reversed twice.
 *  - 22-23/09/2026, SET ASIDE: measured against the widest-line reading over
 *    the 39 French and English PDFs, the cell edge gave 53 joins instead of
 *    126, removed the 11 wrong ones of 0000713 and 0000754 — and left 12 on the
 *    two school reports, whose narrow « Matières » column has padding of its
 *    own. One wrong was enough to refuse it.
 *  - 23/09/2026, REOPENED: the condition « one published column »
 *    removed the very population that condemned it — a school report is a grid
 *    of several columns, so nothing joins there at all any more. The objection
 *    had no subject left.
 * WHY IT IS THE RIGHT MARGIN. « Did the next word fit » is asked against the
 * edge the text could have reached. The widest line of a cell is not that edge:
 * on safedocs 0000713 a list of short entries stops about 230 pt short of the
 * cell's border, so every entry looked as though it had no room and joined its
 * neighbour. The drawn edge is the document's own answer, and it needs no
 * threshold.
 */
export const joinCellLines = (lines: readonly CellLine[], marginRight: number): CellLine[] => {
  if (lines.length < 2) return [...lines];
  const out: CellLine[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous !== undefined && continuesCellParagraph(previous, line, marginRight)) {
      const joined: CellLine = {
        ...previous,
        text: `${previous.text.trimEnd()} ${line.text.trimStart()}`,
        right: line.right,
        widest: Math.max(previous.widest, line.widest),
        fontSize: line.fontSize,
        endMiddle: line.endMiddle,
      };
      setFragments(joined, joinedFragments(previous, line));
      setRaised(joined, joinedRaised(previous, line));
      out[out.length - 1] = joined;
      continue;
    }
    out.push(line);
  }
  return out;
};

/** One paragraph of a cell: its text, line breaks included as `\n`, and the
 *  vertical middle of the FIRST line it opens on — the ordinate an image
 *  placed in the same cell is ordered against (`pdf-table-render.ts`). */
export interface CellParagraph {
  text: string;
  /** The FIRST line's middle — what orders the paragraph among its neighbours. */
  middle: number;
  /** Top of the FIRST line and bottom of the LAST: a paragraph now covers
   *  several visual lines, so `pdf-table-render.ts#imageFrontier` needs the
   *  whole extent it occupies, not one line's. */
  top: number;
  bottom: number;
  /** Its lines' fragments in reading order — see `CellLine.fragments`. Absent when a line has none. */
  fragments?: readonly Fragment[];
  /** The union of its lines' raised calls — see `CellLine.raised`. Absent when none. */
  raised?: ReadonlySet<Fragment>;
}

/**
 * A WORD THE PAPER CUT AT A LINE END, at the junction of two LOGICAL lines of one cell paragraph: the upper line ends on a
 * hyphen glued to a LETTER, and the lower line starts on a LETTER. Nothing else.
 *
 * WHY NOT J2 (`layout/cell-text.ts#wrapSeparator`), WHICH THE FIRST VERSION OF THIS RULE REUSED — a defect of mine, found by
 * the `high` review of the same night, before any deployment. J2 joins on « - » or « _ », and that is right where it lives:
 * it is only ever reached for a line that truly WRAPPED, one whose last word did not fit the cell's drawn edge. At a logical
 * junction there is no such precondition, and the wide rule produced:
 *   « Signature ______ » + « Date »     → « Signature ______Date »
 *   « Chapitre 1 - » + « Introduction » → « Chapitre 1 -Introduction »
 *   « Total - » + « 12,00 »             → « Total -12,00 », a NUMBER that is nowhere in the document
 * The last one is the gravest defect this product can produce — the page looks normal and the figure is false — and it is the
 * very thing `wouldFabricateNumber` above exists to prevent at the other junction.
 * So the rule here is narrower and measured against the same population: the 57 cut words of the 13 corpus documents all
 * pass it (« sous-utilisés », « Net-Zero », « CLARENCE-ROCKLAND », « Gender-Based », « mots-clés. »), and the three
 * counter-examples above are refused by the letter-before-hyphen condition alone.
 * ABSTAINED ON, DELIBERATELY: a lower line starting with a DIGIT (« AG- » + « 002. » is a real cut word on paper). No
 * discriminant separates it from a fabricated number, so the word stays cut rather than risk the figure.
 * Found by a manual three-way test of 29/10/2026 (Acrobat, Chrome, us).
 */
/** La règle elle-même vit dans `layout/cut-word.ts` depuis le 03/11/2026 : le flux de page en a besoin aussi, et une
 *  décision ne s'écrit pas deux fois. L'histoire ci-dessus est restée ici, à sa jonction. */

/** One more logical line added to the paragraph being gathered: a `\n`, which the renderer writes `<br/>`
 *  (`renderer/storage.ts`), unless the paper cut a word across the two. Written as its own function because the branch
 *  inside the loop below cost a `sonarjs/cognitive-complexity` finding, and a quality ratchet is never refrozen upward. */
const continuedWith = (previous: string, line: string): string =>
  cutAcrossLines(previous, line) ? `${previous}${line}` : `${previous}\n${line}`;

/**
 * THE LINES OF A CELL GROUPED INTO PARAGRAPHS: a real paragraph blank opens a
 * new one, an ORDINARY line spacing becomes a line break inside the current one
 * (23/09/2026, lot « 44 »).
 *
 * WHY, AND IT IS A QUESTION OF WHAT WE CLAIM. Until this lot every line of
 * every cell was published as its own `<p>`, and Confluence puts a paragraph
 * blank between two `<p>`: fifteen lines of prose came out as fifteen airy
 * blocks, which is not what the document looks like. The Canva booklet
 * published 245 paragraphs for fifteen pages.
 * A `<br/>` CLAIMS LESS THAN A `<p>`. It says « there is a line break here »,
 * which is true by construction — the PDF drew one. A `<p>` says « these are
 * two distinct paragraphs », which we do not know. So this rule moves from a
 * claim we cannot justify to one that is exact: more faithful AND safer.
 * Nothing is merged, no word moves, and « 7,00 » and « 6,00 » still sit on two
 * separate lines.
 *
 * THE SIGNAL IS THE ONE THAT ALREADY EXISTS, AND IT IS NOT INVENTED HERE: the
 * vertical gap of `PARAGRAPH_BREAK_GAP_RATIO`, signal 2 of `pdf-paragraphs.ts`,
 * read from there — one value, three readers (page flow, cell join above, and
 * this grouping).
 *
 * IT RUNS AFTER `joinCellLines`, NEVER INSTEAD OF IT. That rule produces really
 * continuous prose where it is sure — one column, no number, no fabricated
 * figure — and it is unchanged. This one only decides how what it LEAVES is
 * presented: a `<br/>` instead of a paragraph blank. It applies to EVERY table
 * cell, one column or not, because the claim it makes holds everywhere.
 *
 * AN UNMEASURABLE GAP GIVES A LINE BREAK, and that is a choice made here: with
 * no text size (`startFontSize` 0, a line carrying no measurable glyph) the
 * ratio has no meaning, so no paragraph break is PROVED — and the rule only
 * ever asserts what it can prove. The weaker claim is the line break.
 *
 * ONLY TABLE CELLS. The page flow keeps its own paragraphs
 * (`pdf-paragraphs.ts`), untouched.
 *
 * PURE: no I/O, no clock, no randomness, and its input is never mutated.
 */
export const cellParagraphs = (lines: readonly CellLine[]): CellParagraph[] => {
  const out: CellParagraph[] = [];
  let previous: CellLine | undefined;
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length === 0) continue;
    const last = out[out.length - 1];
    const opensParagraph =
      last === undefined ||
      previous === undefined ||
      (line.startFontSize > 0 && (previous.endMiddle - line.middle) / line.startFontSize > PARAGRAPH_BREAK_GAP_RATIO);
    if (opensParagraph) {
      out.push({
        text,
        middle: line.middle,
        top: line.middle + line.startFontSize / 2,
        bottom: line.endMiddle - line.fontSize / 2,
        ...(line.fragments !== undefined ? { fragments: line.fragments } : {}),
        ...(line.raised !== undefined ? { raised: line.raised } : {}),
      });
    } else {
      last.text = continuedWith(last.text, text);
      last.bottom = line.endMiddle - line.fontSize / 2;
      setFragments(last, joinedFragments(last, line));
      setRaised(last, joinedRaised(last, line));
    }
    previous = line;
  }
  return out;
};
