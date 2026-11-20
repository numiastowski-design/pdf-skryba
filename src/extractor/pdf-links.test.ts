/**
 * The tie rule of `pdf-links.ts` on hand-written runs and glyphs (no pdf.js). The real documents are in the app's
 * `google-app/src/pipeline/normalize-links.pdf-links.fixtures.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { GlyphFragment } from "./glyph-positions";
import { linesFromGroups } from "./pdf-lines";
import { fillBetween, linkSpansOfPage, linkTieOfPage, PDF_MAX_LINKS_PER_PAGE } from "./pdf-links";
import { paragraphsFromLines } from "./pdf-paragraphs";
import type { PdfLinkAnnotation, PdfTextRun } from "./pdf-source";

const ADVANCE = 5;
const SIZE = 10;

/** One run at (x, y), one glyph per non-space character, each `ADVANCE` wide. */
const runAt = (text: string, x = 100, y = 700, rotated = false): { run: PdfTextRun; glyphs: GlyphFragment[] } => {
  const glyphs: GlyphFragment[] = [];
  [...text].forEach((ch, i) => {
    if (/\s/u.test(ch)) return;
    glyphs.push({
      text: ch,
      x: x + i * ADVANCE,
      y,
      width: ADVANCE,
      height: SIZE,
      matrix: { a: SIZE, b: 0, c: 0, d: SIZE, e: x + i * ADVANCE, f: y },
      runId: 0,
      isSpace: false,
      paintCount: 1,
      stroked: false,
    });
  });
  const run: PdfTextRun = {
    text,
    x,
    y,
    width: [...text].length * ADVANCE,
    height: SIZE,
    fontSize: SIZE,
    matrix: { a: SIZE, b: 0, c: 0, d: SIZE, e: x, f: y },
    fontId: undefined,
    weight: "unknown",
    rotated,
    hasEOL: false,
    dir: "ltr",
    markedContentId: undefined,
    artifact: false,
  };
  return { run, glyphs };
};

/** The rectangle over characters [from, to) of a run made by `runAt`, slightly larger, as producers draw it. */
const over = (from: number, to: number, url: string, x = 100, y = 700): PdfLinkAnnotation => ({
  url,
  rect: [x + from * ADVANCE - 1, y - 2, x + to * ADVANCE + 1, y + SIZE + 1],
});

const linked = (text: string, links: readonly PdfLinkAnnotation[], rotated = false): string[] => {
  const { run, glyphs } = runAt(text, 100, 700, rotated);
  const spans = linkSpansOfPage([run], glyphs, links).get(run) ?? [];
  return spans.map((s) => `${text.slice(s.start, s.end)} -> ${s.href}`);
};

const TEXT = "Visit example.com today";
//            0123456789012345678901

describe("linkSpansOfPage: a glyph belongs to its run by its CENTRE", () => {
  it("a wide glyph starting more than 0.25 em before the run, centre inside it, still takes the link (the start window of letter-spacing would drop it and the link would abstain)", () => {
    const { run, glyphs } = runAt("a b");
    glyphs[0] = { ...glyphs[0]!, x: 96, width: 8 }; // starts 4 pt before the run (0.25 em = 2.5 pt), centre at 100
    const link: PdfLinkAnnotation = { url: "https://example.com/", rect: [99, 698, 106, 711] };
    const spans = linkSpansOfPage([run], glyphs, [link]).get(run) ?? [];
    expect(spans.map((s) => `${run.text.slice(s.start, s.end)} -> ${s.href}`)).toEqual(["a -> https://example.com/"]);
  });
});

describe("linkSpansOfPage: a link goes on the words its rectangle covers", () => {
  it("a rectangle over « example.com » links exactly those characters", () => {
    expect(linked(TEXT, [over(6, 17, "https://example.com/")])).toEqual(["example.com -> https://example.com/"]);
  });

  it("several words under one rectangle make one link, the spaces between them included", () => {
    expect(linked(TEXT, [over(0, 17, "https://example.com/")])).toEqual(["Visit example.com -> https://example.com/"]);
  });

  it("http, https and mailto are kept whatever their case", () => {
    expect(linked(TEXT, [over(6, 17, "HTTP://example.com/")])).toEqual(["example.com -> HTTP://example.com/"]);
    expect(linked(TEXT, [over(6, 17, "mailto:a@example.com")])).toEqual(["example.com -> mailto:a@example.com"]);
  });

  it("any other scheme gives no link and the text is unchanged", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "tel:+33100000000",
      "ftp://example.com/",
      "drive:abc",
      "#anchor",
    ]) {
      expect(linked(TEXT, [over(6, 17, url)])).toEqual([]);
    }
  });

  it("a rectangle over PART of a word abstains for the whole link", () => {
    // « Visit exam » : « Visit » whole, « example » cut.
    expect(linked(TEXT, [over(0, 10, "https://example.com/")])).toEqual([]);
  });

  it("punctuation glued to a linked word follows the rectangle, never beyond it", () => {
    // « (example.com) » : the parentheses are outside the rectangle, the dot inside.
    const text = "see (example.com) now";
    expect(linked(text, [over(5, 16, "https://example.com/")])).toEqual(["example.com -> https://example.com/"]);
  });

  it("a rectangle over no word links nothing", () => {
    expect(linked(TEXT, [over(5, 6, "https://example.com/")])).toEqual([]);
  });

  it("two rectangles holding the same word with different targets: both abstain", () => {
    expect(linked(TEXT, [over(6, 17, "https://a.example/"), over(0, 23, "https://b.example/")])).toEqual([]);
  });

  it("two rectangles holding the same word with the same target: the link stays", () => {
    expect(linked(TEXT, [over(6, 17, "https://a.example/"), over(6, 23, "https://a.example/")])).toEqual([
      "example.com today -> https://a.example/",
    ]);
  });

  it("a run whose glyphs do not read as its text abstains", () => {
    const { run, glyphs } = runAt(TEXT);
    const spans = linkSpansOfPage([run], glyphs.slice(1), [over(6, 17, "https://example.com/")]);
    expect(spans.get(run)).toBeUndefined();
  });

  it("a rotated run abstains", () => {
    expect(linked(TEXT, [over(6, 17, "https://example.com/")], true)).toEqual([]);
  });

  it("lines and paragraphs: a link keeps its words across a line break, and no space of the text joins a link it does not continue", () => {
    const one = runAt("You can read the Data", 100, 700);
    const two = runAt("Protection Act today", 100, 688);
    const three = runAt("or see example.com", 100, 676);
    const four = runAt("for more", 100, 664);
    const law = "https://law.example/";
    const site = "https://example.com/";
    const withLinks = [
      { ...one.run, links: [{ start: 17, end: 21, href: law }] },
      { ...two.run, links: [{ start: 0, end: 14, href: law }] },
      { ...three.run, links: [{ start: 7, end: 18, href: site }] },
      four.run,
    ];
    const blocks = paragraphsFromLines(linesFromGroups(withLinks.map((run) => [run])));
    expect(blocks).toHaveLength(1);
    const inlines = blocks[0]!.kind === "paragraph" ? blocks[0].inlines : [];
    expect(inlines.map((i) => [i.text, i.href])).toEqual([
      ["You can read the ", undefined],
      ["Data Protection Act", law],
      [" today or see ", undefined],
      ["example.com", site],
      [" for more", undefined],
    ]);
  });

  it("one line, two runs with two links: the word-break space between them carries neither", () => {
    // « a.example » ends at 145; « b.example » starts at 150, a gap of 0.5 em.
    const first = { ...runAt("a.example", 100).run, links: [{ start: 0, end: 9, href: "https://a.example/" }] };
    const second = { ...runAt("b.example", 150).run, links: [{ start: 0, end: 9, href: "https://b.example/" }] };
    const [line] = linesFromGroups([[first, second]]);
    expect(line!.runs.map((r) => [r.text, r.href])).toEqual([
      ["a.example", "https://a.example/"],
      [" ", undefined],
      ["b.example", "https://b.example/"],
    ]);
  });

  it("a long run of unlinked punctuation (a table of contents' dot leader) is read in linear work", () => {
    // « a ......(n)...... b », « a » and « b » linked to the same target: the dots are flanked, they take it.
    const n = 20_000;
    const text = `a${".".repeat(n)}b`;
    const cells: (number | undefined)[] = new Array<number | undefined>(text.length).fill(undefined);
    cells[0] = 0;
    cells[text.length - 1] = 0;
    let reads = 0;
    const counted = new Proxy(cells, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    fillBetween(text, counted, () => "https://example.com/");
    expect(cells.every((link) => link === 0)).toBe(true);
    expect(reads).toBeLessThan(10 * text.length);
  });

  it(`a page with more than PDF_MAX_LINKS_PER_PAGE (${PDF_MAX_LINKS_PER_PAGE}) kept links gets none`, () => {
    const one = over(6, 17, "https://example.com/");
    const elsewhere = { url: "https://elsewhere.example/", rect: [0, 0, 1, 1] as const };
    expect(linked(TEXT, [one, ...Array.from({ length: PDF_MAX_LINKS_PER_PAGE - 1 }, () => elsewhere)])).toHaveLength(1);
    expect(linked(TEXT, [one, ...Array.from({ length: PDF_MAX_LINKS_PER_PAGE }, () => elsewhere)])).toEqual([]);
  });
});

describe("linkTieOfPage: one tie for the whole page, read per run and per glyph", () => {
  const site = "https://example.com/";

  it("a link that abstains on a later run abstains on the earlier one too (the abstentions are all known before any span is made)", () => {
    const first = runAt("see example.com", 100, 700);
    const second = runAt("alphabeta", 100, 690);
    // One tall rectangle: it holds « example.com » of the first run whole and only the right part of « alphabeta ».
    const tall: PdfLinkAnnotation = { url: site, rect: [119, 688, 176, 711] };
    const { spansByRun, hrefByGlyph } = linkTieOfPage(
      [first.run, second.run],
      [...first.glyphs, ...second.glyphs],
      [tall],
    );
    expect(spansByRun.size).toBe(0);
    expect(hrefByGlyph.size).toBe(0);
    // Witness: the same rectangle on the first run alone links it.
    const alone = linkTieOfPage([first.run], first.glyphs, [{ url: site, rect: [119, 698, 176, 711] }]);
    expect([...alone.spansByRun.values()].flat().map((s) => first.run.text.slice(s.start, s.end))).toEqual([
      "example.com",
    ]);
  });

  it("each run keeps its own spans, and each glyph its own href: the glyphs of a linked word, none of the others", () => {
    const first = runAt("see example.com", 100, 700);
    const second = runAt("other words", 100, 680);
    const a = "https://a.example/";
    const b = "https://b.example/";
    const { spansByRun, hrefByGlyph } = linkTieOfPage(
      [first.run, second.run],
      [...first.glyphs, ...second.glyphs],
      [over(4, 15, a, 100, 700), over(6, 11, b, 100, 680)],
    );
    expect(spansByRun.get(first.run)).toEqual([{ start: 4, end: 15, href: a }]);
    expect(spansByRun.get(second.run)).toEqual([{ start: 6, end: 11, href: b }]);
    const hrefs = (glyphs: GlyphFragment[]) => glyphs.map((g) => hrefByGlyph.get(g));
    expect(hrefs(first.glyphs)).toEqual([undefined, undefined, undefined, ...Array<string>(11).fill(a)]);
    expect(hrefs(second.glyphs)).toEqual([...Array<undefined>(5).fill(undefined), ...Array<string>(5).fill(b)]);
  });

  it("punctuation glued to a linked word is linked on BOTH sides while the glyph centre stays in the rectangle, and stops at the first one outside", () => {
    const text = "x...example.com,,,y";
    //            0123456789012345678
    const { run, glyphs } = runAt(text);
    // The rectangle holds the centres of characters 2 to 16: the last two dots before « example », the comma-run after « com » up to its second comma.
    const rect: [number, number, number, number] = [100 + 2 * ADVANCE, 698, 100 + 17 * ADVANCE, 711];
    const { spansByRun, hrefByGlyph } = linkTieOfPage([run], glyphs, [{ url: site, rect }]);
    expect(spansByRun.get(run)).toEqual([{ start: 2, end: 17, href: site }]);
    expect(glyphs.map((g, i) => (hrefByGlyph.has(g) ? i : -1)).filter((i) => i >= 0)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 2),
    );
  });

  it("punctuation glued to the very first or the very last character of a run is reached too", () => {
    const text = "..example..";
    const { run, glyphs } = runAt(text);
    const { spansByRun } = linkTieOfPage([run], glyphs, [
      { url: site, rect: [99, 698, 100 + text.length * ADVANCE + 1, 711] },
    ]);
    expect(spansByRun.get(run)).toEqual([{ start: 0, end: 11, href: site }]);
  });

  it("two links side by side keep their own punctuation: the first link to reach a mark keeps it", () => {
    const text = "ab.cd";
    const { run, glyphs } = runAt(text);
    const a = "https://a.example/";
    const b = "https://b.example/";
    // Both rectangles hold the centre of the dot (x = 112.5): [99, 113] and [112, 126].
    const rectA: [number, number, number, number] = [99, 698, 113, 711];
    const rectB: [number, number, number, number] = [112, 698, 126, 711];
    const { spansByRun } = linkTieOfPage([run], glyphs, [
      { url: a, rect: rectA },
      { url: b, rect: rectB },
    ]);
    expect(spansByRun.get(run)).toEqual([
      { start: 0, end: 3, href: a },
      { start: 3, end: 5, href: b },
    ]);
  });

  it("the spaces between linked words take the link in the run's spans but are no glyph: the map holds the page's glyphs only", () => {
    const { run, glyphs } = runAt("one two three");
    const { spansByRun, hrefByGlyph } = linkTieOfPage([run], glyphs, [over(0, 13, "https://example.com/")]);
    expect(spansByRun.get(run)).toEqual([{ start: 0, end: 13, href: "https://example.com/" }]);
    expect(hrefByGlyph.size).toBe(glyphs.length);
    expect([...hrefByGlyph.keys()].every((g) => glyphs.includes(g))).toBe(true);
  });

  it("a glyph that paints two characters (a ligature) of a linked word keeps the link", () => {
    const { run, glyphs } = runAt("find");
    const ligature: GlyphFragment = { ...glyphs[0]!, text: "fi", width: 2 * ADVANCE };
    const page = [ligature, { ...glyphs[2]! }, { ...glyphs[3]! }];
    const { hrefByGlyph } = linkTieOfPage([run], page, [over(0, 4, "https://example.com/")]);
    expect(page.map((g) => hrefByGlyph.get(g))).toEqual(Array(3).fill("https://example.com/"));
  });

  it("glyphs that are spaces, or blank without being marked so, are left out of the reading of a run", () => {
    const { run, glyphs } = runAt("a b");
    const space = { ...glyphs[0]!, text: " ", x: 105, isSpace: true };
    const blank = { ...glyphs[0]!, text: " ", x: 105, isSpace: false };
    const link = over(0, 3, "https://example.com/");
    for (const page of [
      [glyphs[0]!, space, glyphs[1]!],
      [glyphs[0]!, blank, glyphs[1]!],
    ]) {
      expect(linkTieOfPage([run], page, [link]).spansByRun.get(run)).toEqual([
        { start: 0, end: 3, href: "https://example.com/" },
      ]);
    }
  });

  it("a run of blanks, and a link that touches no run, give nothing", () => {
    const blank = runAt("   ");
    expect(linkTieOfPage([blank.run], blank.glyphs, [over(0, 3, site)]).spansByRun.size).toBe(0);
    const far = runAt("far away", 100, 400);
    expect(linkTieOfPage([far.run], far.glyphs, [over(0, 8, site, 100, 700)]).spansByRun.size).toBe(0);
  });
});
