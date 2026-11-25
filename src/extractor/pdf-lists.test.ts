/**
 * THE LISTS a page of lines publishes (16/09/2026): the lettered items and the ordered lists, on lines built here.
 *
 * `src/layout/list.test.ts` tests the RULE on fabricated candidates; this file tests the paragraphs and lists
 * `paragraphsFromLines` hands over.
 * NOT here: the cases on real documents the package may not carry, held by the app.
 */
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import type { Line } from "./pdf-model";
import { paragraphsFromLines } from "./pdf-paragraphs";

const texteOf = (block: IRBlock): string => ("inlines" in block ? block.inlines.map((i) => i.text).join("") : "");

/**
 * A LETTER OR A ROMAN NUMERAL STAYS IN THE ITEM (22/09/2026). The IR list
 * has no marker type: stripping « a. » and letting `<ol>` number the items published
 * « 1. 2. 3. » instead, and the letters were gone. Measured on a document of the measurement corpus, p7:
 * 16 letters lost once the glyph repair split the items.
 */
describe("lettered items keep their letter", () => {
  const at = (left: number, y: number, text: string): Line => ({
    y,
    fontSize: 10,
    text,
    runs: [{ text, bold: false }],
    left,
    right: left + 200,
    firstWordWidth: 0,
    maxInnerGap: 0,
  });
  const itemTexts = (blocks: readonly IRBlock[]): string[] =>
    blocks.flatMap((b) => (b.kind === "list" ? b.items.flat().map(texteOf) : []));

  it("a run of « a. b. c. » is a bullet list whose items keep their letter", () => {
    // Items 30 pt apart: each one its own paragraph whatever the break rules say.
    const blocks = paragraphsFromLines([
      at(72, 700, "The letter should include:"),
      at(72, 670, "and nothing else."),
      at(90, 640, "a. Purpose"),
      at(90, 610, "b. Niceties about previous support"),
      at(90, 580, "c. Number of crew?"),
      at(72, 550, "Back to the body."),
    ]);
    const list = blocks.find((b): b is Extract<IRBlock, { kind: "list" }> => b.kind === "list");
    expect(list?.ordered).toBe(false);
    expect(itemTexts(blocks)).toEqual(["a. Purpose", "b. Niceties about previous support", "c. Number of crew?"]);
  });

  it("a numbered list still hands its number to `<ol>`; a run of bullets is no list at all", () => {
    const numbered = paragraphsFromLines([
      at(72, 700, "Body."),
      at(72, 670, "Body."),
      at(90, 640, "1. one"),
      at(90, 610, "2. two"),
      at(72, 580, "Body."),
    ]);
    expect(itemTexts(numbered)).toEqual(["one", "two"]);
    const bullets = paragraphsFromLines([
      at(72, 700, "Body."),
      at(72, 670, "Body."),
      at(90, 640, "• one"),
      at(90, 610, "• two"),
      at(72, 580, "Body."),
    ]);
    expect(itemTexts(bullets)).toEqual([]);
    expect(bullets.map(texteOf)).toContain("• one");
  });
});

/**
 * AN UNNUMBERED BLOCK IS NEVER AN ITEM OF ITS OWN IN AN ORDERED LIST (
 * 22/09/2026). `<ol>` counts its `<li>`: an unnumbered block let in as an item
 * shifts every number after it. Measured: a document of the measurement corpus, p8, published « 1. » to
 * « 5. » as 3 to 7, two introduction paragraphs having entered the list.
 */
describe("an ordered list publishes the document's own numbers", () => {
  /** A line whose first item is its marker and whose text resumes at `textAt`,
   *  the way Word lays out « 1.<tab>text ». */
  const at = (left: number, y: number, text: string, textAt?: number): Line => ({
    y,
    fontSize: 10,
    text,
    runs: [{ text, bold: false }],
    left,
    right: left + 200,
    firstWordWidth: 0,
    maxInnerGap: 0,
    ...(textAt !== undefined ? { lead: { text: text.split(" ")[0]!, nextLeft: textAt } } : {}),
  });
  const lists = (blocks: readonly IRBlock[]): Extract<IRBlock, { kind: "list" }>[] =>
    blocks.filter((b): b is Extract<IRBlock, { kind: "list" }> => b.kind === "list");
  const texts = (blocks: readonly IRBlock[]): string[] => blocks.map(texteOf);
  // Body at 54, numbers at 72, item text at 90; lines 30 pt apart, so each one is
  // its own paragraph whatever the break rules say.
  const body = (y: number): Line => at(54, y, "Body text.");

  it("a block aligned on the TEXT of the item before it is that item's next paragraph", () => {
    const blocks = paragraphsFromLines([
      body(700),
      body(670),
      at(72, 640, "1. one", 90),
      at(90, 610, "more about one"),
      at(72, 580, "2. two", 90),
      body(550),
    ]);
    const [list] = lists(blocks);
    expect(list?.ordered).toBe(true);
    expect(list?.items.map(texts)).toEqual([["one", "more about one"], ["two"]]);
  });

  it("an unnumbered block aligned elsewhere closes the list, and what follows keeps its own numbers", () => {
    // Enough body lines that the body, not the list, sets the page's indent.
    const blocks = paragraphsFromLines([
      body(820),
      body(790),
      body(760),
      body(730),
      body(700),
      body(670),
      at(72, 640, "1. one", 90),
      at(72, 610, "2. two", 90),
      at(72, 580, "An aside at the number's edge."),
      at(72, 550, "3. three", 90),
      at(72, 520, "4. four", 90),
      body(490),
    ]);
    const [first, second] = lists(blocks);
    expect(first?.items.map(texts)).toEqual([["one"], ["two"]]);
    expect(first?.start).toBeUndefined();
    expect(second?.items.map(texts)).toEqual([["three"], ["four"]]);
    expect(second?.start).toBe(3);
    expect(blocks.find((b) => texteOf(b) === "An aside at the number's edge.")?.kind).toBe("paragraph");
  });

  it("a block before the first number stays a paragraph", () => {
    const blocks = paragraphsFromLines([
      body(700),
      body(670),
      at(72, 640, "Please read the steps below."),
      at(72, 610, "1. one", 90),
      at(72, 580, "2. two", 90),
      body(550),
    ]);
    expect(blocks.find((b) => texteOf(b) === "Please read the steps below.")?.kind).toBe("paragraph");
    expect(lists(blocks)[0]?.items.map(texts)).toEqual([["one"], ["two"]]);
  });

  it("a GAP in the numbers: no list, every point keeps its written number", () => {
    const blocks = paragraphsFromLines([
      body(700),
      body(670),
      at(72, 640, "1. one", 90),
      at(72, 610, "2. two", 90),
      at(72, 580, "4. four", 90),
      body(550),
    ]);
    expect(lists(blocks)).toEqual([]);
    expect(texts(blocks)).toEqual(expect.arrayContaining(["1. one", "2. two", "4. four"]));
  });

  it("a DUPLICATE number: no list either", () => {
    const blocks = paragraphsFromLines([
      body(700),
      body(670),
      at(72, 640, "1. one", 90),
      at(72, 610, "2. two", 90),
      at(72, 580, "2. again", 90),
      body(550),
    ]);
    expect(lists(blocks)).toEqual([]);
    expect(texts(blocks)).toEqual(expect.arrayContaining(["1. one", "2. two", "2. again"]));
  });

  it("in the fallback, an item's next paragraph stays a paragraph right after it", () => {
    const blocks = paragraphsFromLines([
      body(700),
      body(670),
      at(72, 640, "1. one", 90),
      at(90, 610, "more about one"),
      at(72, 580, "3. three", 90),
      body(550),
    ]);
    expect(lists(blocks)).toEqual([]);
    const t = texts(blocks);
    expect(t.indexOf("more about one")).toBe(t.indexOf("1. one") + 1);
  });
});
