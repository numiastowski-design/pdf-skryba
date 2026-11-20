import { describe, expect, it } from "vitest";

import {
  blockReading,
  bulletRuns,
  itemTextLeft,
  listRuns,
  markerOf,
  orderedPieces,
  quantiseIndent,
  type BlockLine,
  type ListCandidate,
} from "./list";

const item = (text: string, indented = true): ListCandidate => ({ indented, marker: markerOf(text) });
const prose = (): ListCandidate => ({ indented: false, marker: undefined });

describe("le marqueur se LIT, il ne s'interprète pas", () => {
  it("une puce dit « non ordonnée »", () => {
    expect(markerOf("• Développer, ajouter ou connecter")?.kind).toBe("bullet");
    expect(markerOf("– un tiret cadratin")?.kind).toBe("bullet");
  });

  it("un numéro dit « ordonnée », et il porte sa valeur", () => {
    expect(markerOf("1. Introduction")).toMatchObject({ kind: "ordered", value: 1 });
    expect(markerOf("12) Douzième point")).toMatchObject({ kind: "ordered", value: 12 });
  });

  it("a letter or a Roman numeral is a marker the text KEEPS (22/09/2026)", () => {
    // Before: kind "ordered", stripped, and renumbered 1, 2, 3 by the list — the
    // 16 letters of safedocs 0000609 p7 lost once glyph advances are read.
    expect(markerOf("a) premier")?.kind).toBe("letter");
    expect(markerOf("IV. quatrième")?.kind).toBe("letter");
  });

  it("a run of lettered items is NOT ordered: its letters stay in the text, a bullet list carries them", () => {
    const runs = listRuns([item("a. Purpose"), item("b. Niceties"), item("c. Number of crew?")]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ordered: false });
  });

  it("une phrase ordinaire n'en porte aucun", () => {
    expect(markerOf("Ce paragraphe occupe toute la largeur.")).toBeUndefined();
    expect(markerOf("2026 restera une année")).toBeUndefined();
  });

  it("🔴 A DASH GLUED TO ITS WORD IS NOT A MARKER — written limit, 22/09/2026", () => {
    // Fixture 28 p2 writes its 7 items « -Ensures Safety… » with no blank. They
    // stay 7 paragraphs, one per line: reading the dash is what would let us
    // REMOVE it, and it is a character of the document. See `list.ts#DASH`.
    expect(markerOf("-Ensures Safety of the patient, provider and community")).toBeUndefined();
    expect(markerOf("-30-")).toBeUndefined();
    expect(markerOf("–positive advanced nonsquamous non–small-cell lung cancer.")).toBeUndefined();
  });

  it("🔴 A BULLET PAINTED IN A SYMBOL FONT IS NOT READ — written limit, 22/09/2026", () => {
    // The text layer LIES about it and only the font would tell: safedocs
    // 0000609 gets a private codepoint (Wingdings 0xFC), fixture 25 gets the
    // LETTER « x » (SymbolMT 0x78). Both stay prose, and both already publish
    // one line per item. See the written limits at the top of `list.ts`.
    expect(markerOf(" A valid Passport with at least 6 months remaining")).toBeUndefined();
    expect(markerOf("x Toutes les opérations mentionnées dans cette section")).toBeUndefined();
  });
});

describe("une liste est une SUITE d'items retirés, dont la moitié porte un marqueur", () => {
  it("trois puces retirées ne font PLUS de liste (23/09/2026)", () => {
    expect(listRuns([prose(), item("• un"), item("• deux"), item("• trois"), prose()])).toEqual([]);
  });

  it("trois LETTRES retirées, elles, font toujours une liste non ordonnée", () => {
    // The witness of the bullets case above: without it, "no list" would not differ from "no run recognised at all".
    const runs = listRuns([prose(), item("a. un"), item("b. deux"), item("c. trois"), prose()]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 1, end: 3, ordered: false });
  });

  it("une suite MIXTE à majorité de puces n'est pas une liste ; l'égalité aussi tombe côté abstention", () => {
    expect(listRuns([item("• un"), item("• deux"), item("1. trois")])).toEqual([]);
    expect(listRuns([item("• un"), item("1. deux")])).toEqual([]);
  });

  it("trois numéros font une liste ORDONNÉE, et elle garde son premier numéro", () => {
    const candidates = [item("3. trois"), item("4. quatre"), item("5. cinq")];
    const runs = listRuns(candidates);
    expect(runs[0]).toMatchObject({ ordered: true });
    expect(orderedPieces(candidates, 0, 2)).toEqual([{ kind: "list", first: 3, items: [[0], [1], [2]] }]);
  });

  it("un item ISOLÉ n'est pas une liste", () => {
    expect(listRuns([prose(), item("a. seul"), prose()])).toEqual([]);
  });

  it("SANS RETRAIT, rien — même avec des marqueurs partout", () => {
    // A dash opening a sentence or a date "12." carries a marker without making a list.
    expect(listRuns([item("a. un", false), item("b. deux", false), item("c. trois", false)])).toEqual([]);
  });

  it("des lignes retirées SANS marqueur ne suffisent pas non plus", () => {
    // The indent alone catches tables, headings and quotations: both conditions are needed.
    expect(listRuns([item("une citation", true), item("qui continue", true), item("et finit", true)])).toEqual([]);
  });

  it("la MOITIÉ des items suffit — une continuation ne porte pas de marqueur", () => {
    const runs = listRuns([item("1. un"), item("suite du premier"), item("2. deux"), item("suite du second")]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, end: 3, ordered: true });
  });

  it("deux listes séparées par de la prose restent deux listes", () => {
    const runs = listRuns([item("a. a"), item("b. b"), prose(), item("1. x"), item("2. y")]);
    expect(runs.map((r) => r.ordered)).toEqual([false, true]);
  });
});

describe("le retrait est quantifié", () => {
  it("deux lignes à un demi-point d'écart sont au même niveau", () => {
    expect(quantiseIndent(53.8)).toBe(quantiseIndent(54.1));
  });

  it("le corps à 72 et les puces à 54 ne le sont pas — la géométrie de la fixture 29", () => {
    expect(quantiseIndent(72)).not.toBe(quantiseIndent(54));
  });
});

describe("an item's text start is read twice, and the two readings must agree", () => {
  it("agreeing readings give the text start; one reading stands alone", () => {
    expect(itemTextLeft({ afterMarker: 107.2, secondLine: 107.2 })).toBe(107.2);
    expect(itemTextLeft({ afterMarker: 107.2 })).toBe(107.2);
    expect(itemTextLeft({ secondLine: 106.9 })).toBe(106.9);
    expect(itemTextLeft({})).toBeUndefined();
  });

  it("disagreeing readings abstain — 0000609 p7: the second line is a lettered sub-item, 18 pt further", () => {
    expect(itemTextLeft({ afterMarker: 88.9, secondLine: 106.9 })).toBeUndefined();
  });
});

describe("an ordered run: an unnumbered block is a continuation or a closing, never an item", () => {
  const numbered = (text: string, left = 72, textLeft = 90): ListCandidate => ({
    indented: true,
    marker: markerOf(text),
    left,
    textLeft,
  });
  const unnumbered = (left: number, text = "plain"): ListCandidate => ({
    indented: true,
    marker: markerOf(text),
    left,
  });

  it("aligned on the item's text: the item's next paragraph", () => {
    const c = [numbered("1. a"), unnumbered(90), numbered("2. b")];
    expect(orderedPieces(c, 0, 2)).toEqual([{ kind: "list", first: 1, items: [[0, 1], [2]] }]);
  });

  it("a LETTER has no number: aligned on the item's text, it continues the item too", () => {
    const c = [numbered("1. a"), unnumbered(90, "b) sub-point"), numbered("2. b")];
    expect(orderedPieces(c, 0, 2)).toEqual([{ kind: "list", first: 1, items: [[0, 1], [2]] }]);
  });

  it("aligned on the NUMBER: it closes the list", () => {
    const c = [numbered("1. a"), numbered("2. b"), unnumbered(72), numbered("3. c"), numbered("4. d")];
    expect(orderedPieces(c, 0, 4)).toEqual([
      { kind: "list", first: 1, items: [[0], [1]] },
      { kind: "paragraph", index: 2 },
      { kind: "list", first: 3, items: [[3], [4]] },
    ]);
  });

  it("no text reading on the item: nothing can continue it", () => {
    const c: ListCandidate[] = [
      { indented: true, marker: markerOf("1. a"), left: 72 },
      unnumbered(90),
      numbered("2. b"),
      numbered("3. c"),
    ];
    expect(orderedPieces(c, 0, 3)).toEqual([
      { kind: "paragraph", index: 0 },
      { kind: "paragraph", index: 1 },
      { kind: "list", first: 2, items: [[2], [3]] },
    ]);
  });

  it("text not right of the number (no hanging indent): nothing can continue it", () => {
    const c = [numbered("1. a", 72, 72), unnumbered(72), numbered("2. b", 72, 72), numbered("3. c", 72, 72)];
    expect(orderedPieces(c, 0, 3)[0]).toEqual({ kind: "paragraph", index: 0 });
  });

  it("a gap or a duplicate: every block stays a paragraph, continuations included", () => {
    const gap = [numbered("1. a"), unnumbered(90), numbered("3. c")];
    expect(orderedPieces(gap, 0, 2)).toEqual([0, 1, 2].map((index) => ({ kind: "paragraph", index })));
    const duplicate = [numbered("1. a"), numbered("1. again")];
    expect(orderedPieces(duplicate, 0, 1)).toEqual([0, 1].map((index) => ({ kind: "paragraph", index })));
  });
});

describe("the simple bulleted run is a list again (14/10/2026)", () => {
  // One bullet block: bullet run at `marker`, text at `text`, optional wrapped lines at `wrap`; y goes down the page.
  const bullet = (
    y: number,
    opts: { marker?: number; text?: number; wrap?: number[]; char?: string; line?: string } = {},
  ): ListCandidate => {
    const { marker = 72, text = 90, wrap = [], char = "•", line = "item words" } = opts;
    const lines: BlockLine[] = [
      { text: `${char} ${line}`, left: marker, y, lead: { text: char, nextLeft: text } },
      ...wrap.map((left, k) => ({ text: "wrapped words", left, y: y - 12 * (k + 1) })),
    ];
    return { indented: false, marker: markerOf(lines[0]!.text), ...blockReading(lines) };
  };
  const plain = (y: number, left: number): ListCandidate => ({
    indented: false,
    marker: undefined,
    ...blockReading([{ text: "more words", left, y }]),
  });

  it("two bullets, own run, one marker x and one text x: a list; indentation is not asked", () => {
    expect(bulletRuns([plain(700, 72), bullet(600), bullet(580), plain(500, 72)])).toEqual([{ start: 1, end: 2 }]);
  });

  it("a wrapped line back at the marker x is not a list", () => {
    expect(bulletRuns([bullet(600, { wrap: [72] }), bullet(560)])).toEqual([]);
  });

  it("wrapped lines at the item-text x keep it a list", () => {
    expect(bulletRuns([bullet(600, { wrap: [90, 90.5] }), bullet(560)])).toEqual([{ start: 0, end: 1 }]);
  });

  it("bullets laid out in two columns (fixture 33 p5) are not a list", () => {
    const twoColumns = (y: number) => bullet(y, { line: "Safe Operations ▪ Delivery of care", char: "▪" });
    expect(bulletRuns([twoColumns(600), twoColumns(580)])).toEqual([]);
  });

  it("markers or texts at different x are not one list", () => {
    expect(bulletRuns([bullet(600), bullet(580, { marker: 80, text: 98 })])).toEqual([]);
    expect(bulletRuns([bullet(600), bullet(580, { text: 95 })])).toEqual([]);
  });

  it("a dash run, a mixed bullet/dash run and a symbol-font letter are not lists", () => {
    expect(bulletRuns([bullet(600, { char: "-" }), bullet(580, { char: "-" })])).toEqual([]);
    expect(bulletRuns([bullet(600), bullet(580, { char: "–" })])).toEqual([]);
    expect(bulletRuns([bullet(600, { char: "x" }), bullet(580, { char: "x" })])).toEqual([]);
  });

  it("a bullet glued to its text (no run of its own) is not read", () => {
    const glued = (y: number): ListCandidate => {
      const lines: BlockLine[] = [{ text: "•Comité", left: 72, y }];
      return { indented: false, marker: markerOf(lines[0]!.text), ...blockReading(lines) };
    };
    expect(bulletRuns([glued(600), glued(580)])).toEqual([]);
  });

  it("an unmarked block at the item-text x right under the last item is its tail (spacing measured from the wrapped lines)", () => {
    // Last item: first line y 560, wrapped line y 548 (pitch 12); the tail starts at 536 (gap 12).
    expect(bulletRuns([bullet(600, { wrap: [90] }), bullet(560, { wrap: [90] }), plain(536, 90)])).toEqual([
      { start: 0, end: 1, tail: 2 },
    ]);
  });

  it("a block at the item-text x after a larger gap is a paragraph of its own: the list stays, the block stays out", () => {
    expect(bulletRuns([bullet(600, { wrap: [90] }), bullet(560, { wrap: [90] }), plain(500, 90)])).toEqual([
      { start: 0, end: 1 },
    ]);
  });

  it("items of one line each still have a spacing — the pitch between two items — and the tail is measured against it (05/11/2026)", () => {
    // Until 05/11 the whole list was rejected when no item wrapped (fixture 29: five one-line questions, then a block
    // at the item-text x). The inter-item pitch (20 pt here) is the list's own spacing; 12 pt under the last item is a tail.
    expect(bulletRuns([bullet(600), bullet(580), plain(568, 90)])).toEqual([{ start: 0, end: 1, tail: 2 }]);
    // Far beyond that spacing, the block is a paragraph of its own and the list stays.
    expect(bulletRuns([bullet(600), bullet(580), plain(540, 90)])).toEqual([{ start: 0, end: 1 }]);
  });

  // Review of 14/10/2026: a block read after a jump UP the page (another column) gave a negative gap, under the limit.
  it("a block at the item-text x but ABOVE the last item (another column) is no tail", () => {
    expect(bulletRuns([bullet(600, { wrap: [90] }), bullet(560, { wrap: [90] }), plain(700, 90)])).toEqual([
      { start: 0, end: 1 },
    ]);
  });

  it("a block elsewhere than the item-text x is no tail and no obstacle", () => {
    expect(bulletRuns([bullet(600), bullet(580), plain(568, 72)])).toEqual([{ start: 0, end: 1 }]);
  });

  it("a single bullet is not a list", () => {
    expect(bulletRuns([plain(700, 72), bullet(600), plain(580, 72)])).toEqual([]);
  });
});
