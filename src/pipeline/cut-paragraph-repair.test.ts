/**
 * The cut-paragraph join AS THE PACKAGE PUBLISHES IT (`cutParagraphEdits`, `joinNoWorse`): two adjacent units become
 * one ONLY when both are joinable, the shape says « cut in mid-sentence » AND the PDF reads their edge words in a
 * row, at one size; and the rule that keeps or undoes a join refuses a re-check that is worse in anything. Every case
 * names the value a broken join would give; each fixture is built so it differs from the expected one.
 *
 * THE PAIRING. Each case is the one of the same name in the app's test of the same file name (same source runs, same
 * page, same expected values); only the factory of the page changes: the `PublishedPage` is written by hand here —
 * its blocks and its units — with no markup reader behind it.
 *
 * THE FORM OF THE ASSERTIONS. Where the app's case states the page that comes out, this file states the TEXT of the
 * blocks after the library's joins are applied by `joinedBlocks` below: the last block of the unit an edit names and
 * the first block of the next unit become one, a space between. The edit is a unit index, so the list of block texts
 * is its honest reading. A case whose page must stay as it is asserts that the library hands back no edit.
 *
 * NOT here: the marks of each part surviving a join, which is markup; and the four containers a destination may put
 * two paragraphs in (one cell, two cells, one list item, the items of a cell): they are ONE page for this check — a
 * single unit that is not joinable, holding both blocks — so they are held once, under the first of their names.
 *
 * Run: npx vitest run --project=main packages/reader/src/pipeline/cut-paragraph-repair.test.ts
 */

import { describe, expect, it } from "vitest";

import {
  cutParagraphEdits,
  joinNoWorse,
  textConservation,
  type ConservationRun,
  type ConservationVerdict,
  type PageEdit,
  type PublishedPage,
} from "../lib/pdf-light";

const line = (text: string, i: number, fontSize = 10): ConservationRun => ({
  text,
  x: 0,
  y: 800 - 20 * i,
  width: 5 * text.length,
  fontSize,
  hasEOL: true,
});
const lines = (...texts: string[]): ConservationRun[] => texts.map((t, i) => line(t, i));

/** One unit of a hand-written page: the texts of its blocks, and what the destination treats it as. */
interface UnitSpec {
  texts: string[];
  paragraphOrHeading: boolean;
  joinable: boolean;
}

const p = (text: string): UnitSpec => ({ texts: [text], paragraphOrHeading: true, joinable: true });
const heading = (text: string): UnitSpec => ({ texts: [text], paragraphOrHeading: true, joinable: false });
/** A table or a list: whatever it holds, it cannot be merged with anything. */
const container = (...texts: string[]): UnitSpec => ({ texts, paragraphOrHeading: false, joinable: false });
/** A picture standing alone between two units: it holds no word, so no block. */
const PICTURE: UnitSpec = { texts: [], paragraphOrHeading: false, joinable: false };

/** The page these units make, side by side with nothing between them: blocks numbered in order, each unit adjacent
 *  to the next one. Something of the page BETWEEN two paragraphs is a unit of its own (`PICTURE`), not a flag. */
const pageOf = (...specs: UnitSpec[]): PublishedPage => {
  let next = 0;
  const units = specs.map((spec, i) => ({
    blocks: spec.texts.map(() => next++),
    paragraphOrHeading: spec.paragraphOrHeading,
    joinable: spec.joinable,
    adjacentToNext: i < specs.length - 1,
  }));
  return { blocks: specs.flatMap((spec) => spec.texts), extras: [], units };
};

/** The block texts with each join applied, in the order the library hands them (right to left, so a join never
 *  shifts a block still to join): the last block of the unit and the first of the next become one, a space between. */
const joinedBlocks = (page: PublishedPage, edits: readonly PageEdit[]): string[] => {
  const blocks = [...page.blocks];
  for (const edit of edits) {
    if (edit.kind !== "join-units") throw new Error(`unexpected edit: ${edit.kind}`);
    const first = page.units?.[edit.unit]?.blocks.slice(-1)[0];
    const second = page.units?.[edit.unit + 1]?.blocks[0];
    if (first === undefined || second !== first + 1) throw new Error(`units ${edit.unit} and the next do not touch`);
    blocks.splice(first, 2, `${blocks[first]} ${blocks[second]}`);
  }
  return blocks;
};

/** Check, decide, apply, re-check: the verdicts on both sides of the join, and the library's answer on keeping it. */
const joined = (runs: ConservationRun[], page: PublishedPage) => {
  const before = textConservation([runs], page);
  const { edits, joined: count } = cutParagraphEdits(page, before);
  const blocks = joinedBlocks(page, edits);
  const after = textConservation([runs], { blocks });
  return { edits, joined: count, blocks, before, after, kept: joinNoWorse(before, after) };
};

const CUT = lines("Alpha beta gamma", "delta epsilon.");
const CUT_PAGE = pageOf(p("Alpha beta gamma"), p("delta epsilon."));

describe("joinCutParagraphs — a paragraph cut in mid-sentence is one paragraph again", () => {
  it("two paragraphs, the first unterminated, the second lowercase, read in a row by the PDF: one paragraph, a space between", () => {
    // Failure value: the page unchanged.
    const r = joined(CUT, CUT_PAGE);
    expect(r.edits).toEqual([{ kind: "join-units", unit: 0 }]);
    expect(r.blocks).toEqual(["Alpha beta gamma delta epsilon."]);
    expect(r).toMatchObject({ joined: 1, kept: true });
    expect(r.after).toMatchObject({ decision: "ok", lostLetters: 0 });
  });

  it("a paragraph cut twice is joined whole", () => {
    // Failure values: two paragraphs (one join only) or three.
    const r = joined(
      lines("Un deux trois", "quatre cinq six", "sept huit."),
      pageOf(p("Un deux trois"), p("quatre cinq six"), p("sept huit.")),
    );
    expect(r.blocks).toEqual(["Un deux trois quatre cinq six sept huit."]);
    expect(r.joined).toBe(2);
  });

  it("a short paragraph (fewer than three words) is compared on the words it has", () => {
    const r = joined(lines("Voir la", "suite ici."), pageOf(p("Voir la"), p("suite ici.")));
    expect(r.blocks).toEqual(["Voir la suite ici."]);
  });
});

describe("joinCutParagraphs — the shape must say « cut »", () => {
  it("a first paragraph ending with a full stop is a real end", () => {
    // The PDF reads the two in a row: only the shape keeps them apart.
    const page = pageOf(p("Alpha beta gamma."), p("delta epsilon."));
    const r = joined(lines("Alpha beta gamma.", "delta epsilon."), page);
    expect(r.blocks).toEqual(page.blocks);
    expect(r.joined).toBe(0);
  });

  it("a second paragraph starting with a capital is a new sentence", () => {
    const page = pageOf(p("Alpha beta gamma"), p("Delta epsilon."));
    expect(joined(lines("Alpha beta gamma", "Delta epsilon."), page).joined).toBe(0);
  });

  it("a second paragraph starting with a list marker (« a. ») is never a continuation", () => {
    // « a » is a lowercase word and the PDF reads it right after « gamma »: only the marker rule decides.
    const page = pageOf(p("Alpha beta gamma"), p("a. delta epsilon."));
    expect(joined(lines("Alpha beta gamma", "a. delta epsilon."), page).edits).toEqual([]);
  });

  it("a second paragraph opening on a token of ONE letter is never a continuation — a bullet drawn « x »", () => {
    // The bullet of a spec list is drawn « x » in the text layer, right after the line before.
    // Failure value: the two joined.
    const page = pageOf(p("Autonomie de la pile: Approx. 5 ans"), p("x 1 seconde par jour"));
    const r = joined(lines("Autonomie de la pile: Approx. 5 ans", "x 1 seconde par jour"), page);
    expect(r.blocks).toEqual(page.blocks);
    expect(r.joined).toBe(0);
  });

  it("the written limit of that rule: a real continuation opening on « y » is refused too", () => {
    const page = pageOf(p("Rien de plus simple qu’il"), p("y a trois ans."));
    expect(joined(lines("Rien de plus simple qu’il", "y a trois ans."), page).edits).toEqual([]);
  });

  it("two headings, or a heading and a paragraph, are not joined (only paragraphs, this lot)", () => {
    expect(joined(CUT, pageOf(heading("Alpha beta gamma"), p("delta epsilon."))).joined).toBe(0);
  });
});

describe("joinCutParagraphs — the PDF must read the two parts in a row", () => {
  it("two parts the PDF does not read in a row stay apart (two columns interleaved)", () => {
    // The shape holds (« gamma » ‖ « delta »), but the PDF reads « zeta eta. » in between.
    const runs = lines("Alpha beta gamma", "zeta eta.", "delta epsilon.");
    const page = pageOf(p("Alpha beta gamma"), p("delta epsilon."), p("zeta eta."));
    expect(joined(runs, page).edits).toEqual([]);
  });

  it("the three words on each side must follow, not only the two edge words", () => {
    // « gamma delta » is read in a row, but « beta » is not right before « gamma » in the PDF.
    const runs = lines("Alpha", "omega", "beta", "psi gamma", "delta epsilon.");
    const page = pageOf(p("omega psi"), p("Alpha beta gamma"), p("delta epsilon."));
    expect(joined(runs, page).edits).toEqual([]);
  });

  it("a page word the PDF does not have, inside the window, prevents the join", () => {
    const page = pageOf(p("Alpha beta gamma"), p("delta extra epsilon."));
    expect(joined(lines("Alpha beta gamma", "delta epsilon."), page).joined).toBe(0);
  });

  it("two parts set in different sizes stay apart", () => {
    const runs = [line("Alpha beta gamma", 0, 10), line("delta epsilon.", 1, 16)];
    expect(joined(runs, CUT_PAGE).joined).toBe(0);
  });

  it("two paragraphs of ONE table cell are NOT joined — measured, then refused", () => {
    // Everything else holds: only the container decides. Failure value: the two joined.
    expect(joined(CUT, pageOf(container("Alpha beta gamma", "delta epsilon."))).edits).toEqual([]);
  });

  it("an image between the two paragraphs keeps them apart", () => {
    expect(joined(CUT, pageOf(p("Alpha beta gamma"), PICTURE, p("delta epsilon."))).edits).toEqual([]);
  });
});

describe("joinCutParagraphs — re-checked like every repair", () => {
  it("a verdict where the readings disagree is never used", () => {
    // Failure value: the join of the first case, proposed on a tiling nobody trusts.
    const honest = textConservation([CUT], CUT_PAGE);
    const disagreeing: ConservationVerdict = { ...honest, decision: "abstain", rule: "readings-disagree" };
    expect(cutParagraphEdits(CUT_PAGE, honest).joined).toBe(1);
    expect(cutParagraphEdits(CUT_PAGE, disagreeing)).toEqual({ edits: [], joined: 0 });
  });

  it("a re-check that comes out worse in anything undoes the whole join", () => {
    // Failure value: `joinNoWorse` answering true on a page that carries a word the PDF lacks.
    const r = joined(CUT, CUT_PAGE);
    expect(r.kept).toBe(true);
    expect(joinNoWorse(r.before, { ...r.after, unmatchedPageWords: 1 })).toBe(false);
  });
});
