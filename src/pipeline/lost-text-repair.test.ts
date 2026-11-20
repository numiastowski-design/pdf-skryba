/**
 * The lost-text repair AS THE PACKAGE PUBLISHES IT (`placeLostPassages`): a passage the page lost is placed as a unit
 * of its own ONLY between two adjacent units of prose whose edge words are its source neighbours; every other case
 * abstains by name. Every case names the value a broken repair would give; the fixture is built so it differs from
 * the expected one.
 *
 * THE PAIRING. Each case is the one of the same name in the app's test of the same file name (same source runs, same
 * page, same expected values); only the factory of the page changes: the `PublishedPage` is written by hand here —
 * its blocks and its units — with no markup reader behind it.
 *
 * THE FORM OF THE ASSERTIONS. Where the app's case states the page that comes out, this file states the TEXT of the
 * blocks after the library's insertions are applied by `withPassages` below: each passage becomes a block of its own,
 * right after the blocks of the unit the edit names. The edit is a unit index and a text, so the list of block texts
 * is its honest reading. The letters the app reports as repaired are the `letters` of the insertions, and « not
 * undone » is the re-check gaining exactly those letters.
 *
 * NOT here: the escaping of the passage, which is markup; the loop that refuses a verdict other than « lost »; and
 * the rule that undoes a repair whose re-check is not the exact gain. That rule is the caller's own: this file only
 * holds the facts it reads (the insertion, its letters, the re-check of the page that carries it).
 *
 * Run: npx vitest run --project=main packages/reader/src/pipeline/lost-text-repair.test.ts
 */

import { describe, expect, it } from "vitest";

import { placeLostPassages, textConservation, type ConservationRun, type PublishedPage } from "../lib/pdf-light";

const lines = (...texts: string[]): ConservationRun[] =>
  texts.map((text, i) => ({ text, x: 0, y: 800 - 20 * i, width: 10 * text.length, fontSize: 10, hasEOL: true }));

/** One unit of a hand-written page: the texts of its blocks, and what the destination treats it as. */
interface UnitSpec {
  texts: string[];
  paragraphOrHeading: boolean;
  joinable: boolean;
}

/** A plain paragraph; several texts are the lines of ONE paragraph, cut by line breaks. */
const p = (...texts: string[]): UnitSpec => ({ texts, paragraphOrHeading: true, joinable: true });
const heading = (text: string): UnitSpec => ({ texts: [text], paragraphOrHeading: true, joinable: false });
/** A table or a list: whatever it holds, it is neither prose nor a title. */
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

type Insertions = ReturnType<typeof placeLostPassages>["insertions"];

/** The block texts with each placed passage as a block of its own, right after the blocks of the unit its edit names
 *  (`-1`: before the first block). Back to front; two passages at one place keep the order they were given in. */
const withPassages = (page: PublishedPage, insertions: Insertions): string[] => {
  const blocks = [...page.blocks];
  const placed = insertions.map(({ edit }) => {
    if (edit.kind !== "insert-unit-after") throw new Error(`unexpected edit: ${edit.kind}`);
    const before = (page.units ?? []).slice(0, edit.unit + 1).flatMap((unit) => unit.blocks);
    return { at: Math.max(-1, ...before) + 1, text: edit.text };
  });
  for (const { at, text } of [...placed].reverse().sort((a, b) => b.at - a.at)) blocks.splice(at, 0, text);
  return blocks;
};

/** Check, place, apply, re-check. */
const repaired = (runs: ConservationRun[], page: PublishedPage) => {
  const before = textConservation([runs], page);
  const placed = placeLostPassages(page, before.lostPassages);
  const blocks = withPassages(page, placed.insertions);
  const after = textConservation([runs], { blocks });
  const repairedLetters = placed.insertions.reduce((n, insertion) => n + insertion.letters, 0);
  return { ...placed, before, blocks, after, repairedLetters };
};

/** Why each lost passage was not placed, for a page. */
const abstentions = (runs: ConservationRun[], page: PublishedPage) =>
  placeLostPassages(page, textConservation([runs], page).lostPassages).abstentions;

const THREE = lines("Alpha beta.", "Perdu ici.", "Gamma delta.");

describe("repairLostText — the passage goes back between its two neighbours", () => {
  it("a paragraph lost between two paragraphs is re-inserted between them, escaped, and the verdict is ok", () => {
    // Failure value: the page unchanged and « lost ». The text handed back is the passage as the source reads it:
    // escaping it is the caller's.
    const r = repaired(
      lines("Alpha beta.", "Tom&Jerry <3 ici.", "Gamma delta."),
      pageOf(p("Alpha beta."), p("Gamma delta.")),
    );
    expect(r.before).toMatchObject({ decision: "lost", lostLetters: 12 });
    expect(r.insertions).toEqual([
      { edit: { kind: "insert-unit-after", unit: 0, text: "Tom&Jerry <3 ici." }, letters: 12 },
    ]);
    expect(r.blocks).toEqual(["Alpha beta.", "Tom&Jerry <3 ici.", "Gamma delta."]);
    expect(r.after).toMatchObject({ decision: "ok", lostLetters: 0 });
    expect(r).toMatchObject({ repairedLetters: 12, abstentions: [] });
    expect(r.after.lostLetters).toBe(r.before.lostLetters - r.repairedLetters);
  });

  it("a heading counts as a top-level paragraph: the passage goes between a heading and a paragraph", () => {
    const r = repaired(THREE, pageOf(heading("Alpha beta."), p("Gamma delta.")));
    expect(r.blocks).toEqual(["Alpha beta.", "Perdu ici.", "Gamma delta."]);
  });

  it("the tail of a paragraph lost goes back as its own paragraph right after it", () => {
    // « perdu ici » ended the first paragraph. Failure value: unchanged.
    const r = repaired(lines("Alpha beta perdu ici.", "Gamma delta."), pageOf(p("Alpha beta"), p("Gamma delta.")));
    expect(r.blocks).toEqual(["Alpha beta", "perdu ici.", "Gamma delta."]);
    expect(r.after.decision).toBe("ok");
  });

  it("a passage lost at the very start goes before the first paragraph", () => {
    // Failure value: the passage after « Alpha beta. » (unit 0 instead of -1), or nothing placed.
    const r = repaired(lines("Perdu ici.", "Alpha beta."), pageOf(p("Alpha beta.")));
    expect(r.insertions.map((insertion) => insertion.edit)).toEqual([
      { kind: "insert-unit-after", unit: -1, text: "Perdu ici." },
    ]);
    expect(r.blocks).toEqual(["Perdu ici.", "Alpha beta."]);
    expect(r.after.decision).toBe("ok");
  });

  it("a passage lost at the very end goes after the last paragraph", () => {
    const r = repaired(lines("Alpha beta.", "Perdu ici."), pageOf(p("Alpha beta.")));
    expect(r.blocks).toEqual(["Alpha beta.", "Perdu ici."]);
  });

  it("a page that loses nothing is handed back as it came", () => {
    const page = pageOf(p("Alpha beta."), p("Perdu ici."), p("Gamma delta."));
    const r = repaired(THREE, page);
    expect(r.blocks).toEqual(page.blocks);
    expect(r).toMatchObject({ repairedLetters: 0, insertions: [], abstentions: [] });
  });
});

describe("placeLostPassages — each abstention, by name", () => {
  it("the neighbours in the wrong order in the page: anchors-out-of-order", () => {
    expect(abstentions(THREE, pageOf(p("Gamma delta."), p("Alpha beta.")))).toEqual(["anchors-out-of-order"]);
  });

  it("a neighbour inside a table cell: anchor-in-container", () => {
    // Failure value: [] — the two blocks are adjacent in the reading, the cell is the only obstacle.
    expect(abstentions(THREE, pageOf(container("Alpha beta."), p("Gamma delta.")))).toEqual(["anchor-in-container"]);
  });

  it("a neighbour inside a list item: anchor-in-container", () => {
    expect(abstentions(THREE, pageOf(p("Alpha beta."), container("Gamma delta.")))).toEqual(["anchor-in-container"]);
  });

  it("words lost inside a paragraph: loss-inside-block", () => {
    expect(abstentions(lines("Alpha beta perdu ici gamma delta."), pageOf(p("Alpha beta gamma delta.")))).toEqual([
      "loss-inside-block",
    ]);
  });

  it("words lost at a line break inside one paragraph: loss-inside-block, though the two text blocks touch", () => {
    // Failure value: [] — block 0 ends with « beta », block 1 starts with « gamma ».
    expect(abstentions(THREE, pageOf(p("Alpha beta.", "Gamma delta.")))).toEqual(["loss-inside-block"]);
  });

  it("an image between the two paragraphs: blocks-not-adjacent, though the two TEXT blocks are consecutive", () => {
    // Failure value: [] — the image carries no word, so the text blocks are 0 and 1.
    expect(abstentions(THREE, pageOf(p("Alpha beta."), PICTURE, p("Gamma delta.")))).toEqual(["blocks-not-adjacent"]);
  });

  it("a neighbour the check found in a list number, not in the page's words: anchor-unmatched", () => {
    // The number the destination draws in front of the item is an extra: it absorbs the source's « 1 », which then
    // has no place in the page. Failure value: a placement or another abstention name.
    const page: PublishedPage = { ...pageOf(p("Voir la"), container("Gamma delta.")), extras: ["1"] };
    expect(abstentions(lines("Voir la", "1", "Perdu ici.", "Gamma delta."), page)).toEqual(["anchor-unmatched"]);
  });

  it("a neighbour found only in an image's alt text is lost with the passage, so nothing is placed (07/10/2026)", () => {
    // A picture's description is not page text: the lost passage is « figure Perdu ici. », and the picture sits
    // between its neighbours. Failure value: [] or « anchor-unmatched ».
    expect(
      abstentions(
        lines("Voir la", "figure", "Perdu ici.", "Gamma delta."),
        pageOf(p("Voir la"), PICTURE, p("Gamma delta.")),
      ),
    ).toEqual(["blocks-not-adjacent"]);
  });

  it("everything lost: no-anchor", () => {
    expect(abstentions(lines("Perdu ici."), pageOf(p("Autre chose.")))).toEqual(["no-anchor"]);
  });

  it("lost at the start, but its neighbour does not open the page: no-anchor", () => {
    // « Alpha » is block 1: something the source puts AFTER the passage comes first in the page.
    expect(
      abstentions(lines("Perdu ici.", "Alpha beta.", "Gamma delta."), pageOf(p("Gamma delta."), p("Alpha beta."))),
    ).toEqual(["no-anchor"]);
  });

  it("lost at the end, but its neighbour does not close the page: no-anchor", () => {
    expect(
      abstentions(lines("Alpha beta.", "Gamma delta.", "Perdu ici."), pageOf(p("Gamma delta."), p("Alpha beta."))),
    ).toEqual(["no-anchor"]);
  });

  it("an abstained passage leaves the page and the « lost » verdict untouched", () => {
    const page = pageOf(p("Alpha beta."), PICTURE, p("Gamma delta."));
    const r = repaired(THREE, page);
    expect(r.blocks).toEqual(page.blocks);
    expect(r.before.decision).toBe("lost");
    expect(r).toMatchObject({ repairedLetters: 0, insertions: [], abstentions: ["blocks-not-adjacent"] });
  });
});

describe("repairLostText — the re-check and the undo", () => {
  it("🔴 a wrong insertion is UNDONE: a passage carrying a word the page already has", () => {
    // Forged passage: « Perdu ici » plus « Gamma », which is NOT lost. The insertion is reachable, and the re-check
    // sees one « gamma » too many: a word the source lacks, and a gain that is not the letters inserted.
    // Failure value: a re-check that looks like the exact gain, which publishes « Perdu ici. Gamma. ».
    const page = pageOf(p("Alpha beta."), p("Gamma delta."));
    const honest = textConservation([THREE], page);
    expect(honest.lostPassages).toHaveLength(1);
    const forged = [{ ...honest.lostPassages[0]!, sourceWords: ["Perdu", "ici.", "Gamma."] }];
    const { insertions } = placeLostPassages(page, forged);
    expect(insertions).toHaveLength(1); // the bad repair is reachable
    const blocks = withPassages(page, insertions);
    expect(blocks).toEqual(["Alpha beta.", "Perdu ici. Gamma.", "Gamma delta."]);

    const after = textConservation([THREE], { blocks });
    expect(honest.unmatchedPageWords).toBe(0);
    expect(after.unmatchedPageWords).toBe(1);
    expect(after.lostLetters).not.toBe(honest.lostLetters - insertions[0]!.letters);
  });
});
