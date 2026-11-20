/**
 * The glued-word repair AS THE PACKAGE PUBLISHES IT (`gluedWordEdits`, `noWorse`): a page token is re-split only where
 * the source reading proves the boundaries, and the rule that keeps or undoes a repair refuses a re-check that is worse
 * in any way. Every case names the value a broken repair would give; for most, it is « unchanged ».
 *
 * THE PAIRING. Each case is the one of the same name in the app's test of the same file name (same source runs, same
 * page, same expected values); only the factory of the page changes: the `PublishedPage` is written by hand here, with
 * no markup reader behind it.
 *
 * THE FORM OF THE ASSERTIONS. Where the app's case states the page that comes out, this file states the TEXT of the
 * blocks after the library's edits are applied by `spaced` below — one space per edit, at the block and character the
 * edit names, nothing else. An edit is a coordinate, so the block text is its honest reading: a space at the wrong
 * character gives another text. The coordinate itself is pinned where it is the point of the case (a second block, a
 * character the markup writes as an entity, a zero-width space).
 *
 * NOT here: anything about markup — a bold run left intact, a link's attribute left alone, an entity kept encoded —
 * nor the loop that refuses a verdict whose readings disagree. Those belong to whoever writes the page.
 *
 * Run: npx vitest run --project=main packages/reader/src/pipeline/glued-word-repair.test.ts
 */

import { describe, expect, it } from "vitest";

import {
  gluedWordEdits,
  noWorse,
  textConservation,
  type ConservationRun,
  type ConservationVerdict,
  type PageEdit,
  type PublishedPage,
  type Respacing,
} from "../lib/pdf-light";

const lines = (...texts: string[]): ConservationRun[] =>
  texts.map((text, i) => ({ text, x: 0, y: 800 - 20 * i, width: 10 * text.length, fontSize: 10, hasEOL: true }));

const glued = (block: number, word: number, sourceWords: string[]): Respacing => ({
  kind: "glued",
  page: 1,
  pageWords: [{ block, word }],
  sourceWords,
});

/** A page of plain paragraphs side by side, one block each. */
const paragraphs = (...texts: string[]): PublishedPage => ({
  blocks: texts,
  extras: [],
  units: texts.map((_, i) => ({
    blocks: [i],
    paragraphOrHeading: true,
    joinable: true,
    adjacentToNext: i < texts.length - 1,
  })),
});

/** The block texts with one space per edit, back to front so no space shifts the character of another. */
const spaced = (page: PublishedPage, edits: readonly PageEdit[]): string[] => {
  const blocks = [...page.blocks];
  const spaces = edits.map((edit) => {
    if (edit.kind !== "insert-space") throw new Error(`unexpected edit: ${edit.kind}`);
    return edit;
  });
  for (const { block, atChar } of [...spaces].sort((a, b) => b.atChar - a.atChar)) {
    const text = blocks[block];
    if (text === undefined) throw new Error(`no block ${block}`);
    blocks[block] = `${text.slice(0, atChar)} ${text.slice(atChar)}`;
  }
  return blocks;
};

/** Decide the edits, apply them to the block texts. */
const respaceGluedWords = (page: PublishedPage, respacings: readonly Respacing[]) => {
  const { edits, repaired } = gluedWordEdits(page, respacings);
  return { blocks: spaced(page, edits), edits, repaired };
};

/** Check, decide, apply, re-check: the verdicts on both sides of the repair, and the library's answer on keeping it. */
const repaired = (runs: ConservationRun[], page: PublishedPage) => {
  const before = textConservation([runs], page);
  const out = respaceGluedWords(page, before.respacings);
  const after = textConservation([runs], { blocks: out.blocks });
  return { ...out, before, after, kept: noWorse(before, after, out.repaired) };
};

describe("respaceGluedWords — where the space goes", () => {
  it("« foisl'application » at a bold edge gets its space, and the bold run is intact", () => {
    // Failure value: the page unchanged. The space lands after « fois », character 8 of the block.
    const page = paragraphs("une foisl’application ouverte");
    const out = respaceGluedWords(page, [glued(0, 1, ["fois", "l’application"])]);
    expect(out.repaired).toBe(1);
    expect(out.edits).toEqual([{ kind: "insert-space", block: 0, atChar: 8 }]);
    expect(out.blocks).toEqual(["une fois l’application ouverte"]);
  });

  it("inside one text node, the space lands between the two source words", () => {
    const page = paragraphs("une foisl'application ouverte");
    const out = respaceGluedWords(page, [glued(0, 1, ["fois", "l’application"])]);
    expect(out).toMatchObject({ blocks: ["une fois l'application ouverte"], repaired: 1 });
  });

  it("punctuation between the letters goes with the word the source gives it to", () => {
    // « IV.1.1)Vrsta »: the « ) » closes the first word.
    // Failure value: « IV.1.1 )Vrsta », a space before the punctuation.
    const out = respaceGluedWords(paragraphs("IV.1.1)Vrsta postupka"), [glued(0, 0, ["IV.1.1)", "Vrsta"])]);
    expect(out.blocks).toEqual(["IV.1.1) Vrsta postupka"]);
  });

  it("an opening bracket goes with the word after it", () => {
    const out = respaceGluedWords(paragraphs("voir(annexe)"), [glued(0, 0, ["voir", "(annexe)"])]);
    expect(out.blocks).toEqual(["voir (annexe)"]);
  });

  it("three source words glued get two spaces, an entity counted as one character", () => {
    // The block is the text as published: « & » is one character here, whatever the markup writes for it.
    // Failure value: the second space one or more characters too far.
    const out = respaceGluedWords(paragraphs("a&bpluscd"), [glued(0, 0, ["a&b", "plus", "cd"])]);
    expect(out.edits).toEqual([
      { kind: "insert-space", block: 0, atChar: 3 },
      { kind: "insert-space", block: 0, atChar: 7 },
    ]);
    expect(out.blocks).toEqual(["a&b plus cd"]);
  });

  it("a link keeps its markup: the space goes before the link, never into its attribute", () => {
    const out = respaceGluedWords(paragraphs("voirici"), [glued(0, 0, ["voir", "ici"])]);
    expect(out.blocks).toEqual(["voir ici"]);
  });

  it("a token whose letters are NOT exactly the source words is left untouched", () => {
    // One letter more than « fois » + « l'application »: the rule does not apply.
    const page = paragraphs("une foisxl'application ouverte");
    expect(gluedWordEdits(page, [glued(0, 1, ["fois", "l’application"])])).toEqual({ edits: [], repaired: 0 });
  });

  it("punctuation between the letters that the source does not carry is not guessed: untouched", () => {
    const page = paragraphs("fois-application");
    expect(gluedWordEdits(page, [glued(0, 0, ["fois", "application"])])).toEqual({ edits: [], repaired: 0 });
  });

  it("a split is never joined in this lot", () => {
    const split: Respacing = {
      kind: "split",
      page: 1,
      pageWords: [
        { block: 0, word: 0 },
        { block: 0, word: 1 },
      ],
      sourceWords: ["l'application"],
    };
    expect(gluedWordEdits(paragraphs("l'appli cation"), [split])).toEqual({ edits: [], repaired: 0 });
  });

  it("the macro parameters are not counted as blocks: block 0 is the first document paragraph", () => {
    // Failure value: the space in « premier », or no edit at all.
    const out = respaceGluedWords(paragraphs("premier", "foisl'application"), [glued(1, 0, ["fois", "l'application"])]);
    expect(out.edits).toEqual([{ kind: "insert-space", block: 1, atChar: 4 }]);
    expect(out.blocks).toEqual(["premier", "fois l'application"]);
  });
});

describe("repairGluedWords — check, repair, re-check, and undo when worse", () => {
  it("a proved glue is repaired and the final verdict is ok", () => {
    // Failure value: glued 1, the page unchanged.
    const r = repaired(lines("une fois l’application ouverte"), paragraphs("une foisl’application ouverte"));
    expect(r.blocks).toEqual(["une fois l’application ouverte"]);
    expect(r.repaired).toBe(1);
    expect(r.after).toMatchObject({ decision: "ok", gluedWords: 0, lostLetters: 0 });
    expect(r.kept).toBe(true);
  });

  it("a glue the letters only cover stays glued, and the page is unchanged", () => {
    const page = paragraphs("Le cost est là.");
    const r = repaired(lines("Le tsoc est là."), page);
    expect(r.edits).toEqual([]);
    expect(r.blocks).toEqual(page.blocks);
    expect(r.repaired).toBe(0);
    expect(r.before).toMatchObject({ decision: "glued", gluedWords: 1 });
  });

  it("🔴 a repair whose re-check is worse is UNDONE: the original page and verdict are kept", () => {
    // Forged boundaries: the source reads « ab cd », the finding claims « a » + « bcd ». The letters match, so the
    // rule lets it through — and the re-check sees two words the source never had.
    // Failure value: `noWorse` answering true, which keeps « a bcd ».
    const runs = lines("ab cd ef");
    const page = paragraphs("abcd ef");
    const recheck = (blocks: readonly string[]): ConservationVerdict => textConservation([runs], { blocks });
    const honest = textConservation([runs], page);
    expect(honest.respacings).toEqual([glued(0, 0, ["ab", "cd"])]);
    const forged: ConservationVerdict = { ...honest, respacings: [glued(0, 0, ["a", "bcd"])] };
    const bad = respaceGluedWords(page, forged.respacings);
    expect(bad).toMatchObject({ blocks: ["a bcd ef"], repaired: 1 }); // the bad repair is reachable

    expect(noWorse(forged, recheck(bad.blocks), bad.repaired)).toBe(false);
    // The same rule keeps the honest repair of the same page: the refusal above is not a rule that refuses everything.
    const good = respaceGluedWords(page, honest.respacings);
    expect(good.blocks).toEqual(["ab cd ef"]);
    expect(noWorse(honest, recheck(good.blocks), good.repaired)).toBe(true);
  });
});

describe("respaceGluedWords — the zero-width space before a superscript (PLATFORM-STATUS §81)", () => {
  it("« Money​<sup>2</sup> » against the source « Money » « 2 » gets its space, before the zero-width space", () => {
    // Failure value: the page unchanged (the U+200B between the letters read as punctuation the source does not carry),
    // or the space after the U+200B (character 6).
    const out = respaceGluedWords(paragraphs("Money​2"), [glued(0, 0, ["Money", "2"])]);
    expect(out.edits).toEqual([{ kind: "insert-space", block: 0, atChar: 5 }]);
    expect(out).toMatchObject({ blocks: ["Money ​2"], repaired: 1 });
  });
});
