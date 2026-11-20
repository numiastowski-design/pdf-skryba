/**
 * The declared reading order, on made-up pages: the guardrail, and the one
 * property the lot rests on — **the segmentation is the IDENTITY when the
 * declared order agrees with the geometric one**.
 *
 * Nothing here opens a PDF: the corpus witnesses live in
 * `pdf-declared-order.fixtures.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { declaredRanks, segmentsInDeclaredOrder } from "./pdf-reading-order";
import type { PdfSourcePage, PdfTextRun } from "./pdf-source";

const run = (text: string, markedContentId: string | undefined, artifact = false): PdfTextRun => ({
  text,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fontSize: 10,
  matrix: { a: 10, b: 0, c: 0, d: 10, e: 0, f: 0 },
  fontId: undefined,
  weight: "normal",
  rotated: false,
  hasEOL: false,
  dir: "ltr",
  markedContentId,
  artifact,
});

const page = (runs: PdfTextRun[], declaredOrder?: readonly string[]): PdfSourcePage => ({
  width: 595,
  height: 842,
  runs,
  hasText: runs.some((r) => r.text.trim() !== ""),
  ops: [],
  links: [],
  readImage: () => undefined,
  imageFailure: () => undefined,
  imageRefusal: () => undefined,
  imageRef: () => undefined,
  glyphs: [],
  ...(declaredOrder !== undefined ? { declaredOrder } : {}),
});

describe("declaredRanks — l'ordre déclaré, ou RIEN", () => {
  it("sans arbre, aucune page n'a d'ordre déclaré", () => {
    expect(declaredRanks(page([run("a", undefined)]))).toBeUndefined();
  });

  it("l'arbre donne le rang de chaque cycle, dans son ordre à lui", () => {
    const runs = [run("deuxième", "p0_mc7"), run("premier", "p0_mc3")];
    expect(declaredRanks(page(runs, ["p0_mc3", "p0_mc7"]))).toEqual([1, 0]);
  });

  it("GARDE-FOU : un seul caractère hors de l'arbre, et la page entière garde sa géométrie", () => {
    const runs = [run("dans l'arbre", "p0_mc0"), run("habillage", undefined)];
    expect(declaredRanks(page(runs, ["p0_mc0"]))).toBeUndefined();
  });

  it("un cycle SANS caractère hors de l'arbre ne coûte pas son ordre à la page", () => {
    // Blank filler items say nothing of where to read: leaving them out of the guard gives no text a place.
    const runs = [run("dans l'arbre", "p0_mc0"), run("   ", undefined)];
    expect(declaredRanks(page(runs, ["p0_mc0"]))).toEqual([0, undefined]);
  });

  it("un texte déclaré /Artifact hors de l'arbre ne coûte pas son ordre à la page", () => {
    // The standard excludes an artifact from the structure tree: requiring it there asked the impossible, and a page
    // lost its whole declared order for a page number.
    const runs = [run("dans l'arbre", "p0_mc0"), run("- 2 -", undefined, true)];
    expect(declaredRanks(page(runs, ["p0_mc0"]))).toEqual([0, undefined]);
  });

  it("GARDE-FOU MAINTENU : de la prose que l'arbre oublie coûte toujours son ordre à la page", () => {
    // Same page as the test above, but the document declares nothing about this line.
    const runs = [run("dans l'arbre", "p0_mc0"), run("de la prose oubliée", undefined, false)];
    expect(declaredRanks(page(runs, ["p0_mc0"]))).toBeUndefined();
  });

  it("un artefact n'a pas de rang : il suit le groupe qu'il suit géométriquement", () => {
    const runs = [run("corps", "p0_mc0"), run("- 2 -", undefined, true)];
    const ranks = declaredRanks(page(runs, ["p0_mc0"]))!;
    const segments = [[[runs[0]!], [runs[1]!]]];
    const rankOf = (item: PdfTextRun): number | undefined => ranks[runs.indexOf(item)];
    expect(segmentsInDeclaredOrder(segments, rankOf).map((s) => s.map((g) => g.map((i) => i.text).join("")))).toEqual([
      ["corps", "- 2 -"],
    ]);
  });

  it("un identifiant nommé deux fois est lu à sa PREMIÈRE place", () => {
    const runs = [run("a", "p0_mc1")];
    expect(declaredRanks(page(runs, ["p0_mc0", "p0_mc1", "p0_mc2", "p0_mc1"]))).toEqual([1]);
  });

  it("un arbre qui ne nomme aucun contenu n'est pas un ordre", () => {
    expect(declaredRanks(page([run("a", "p0_mc0")], []))).toBeUndefined();
  });
});

describe("segmentsInDeclaredOrder — la segmentation d'une page", () => {
  /** A group of lines reduced to its text. */
  const texts = (segments: PdfTextRun[][][]): string[][] =>
    segments.map((s) => s.map((g) => g.map((i) => i.text).join("")));
  const rankOf =
    (order: readonly string[]) =>
    (item: PdfTextRun): number | undefined => {
      const rank = order.indexOf(item.text);
      return rank < 0 ? undefined : rank;
    };

  it("🔴 IDENTITÉ quand les deux ordres concordent : mêmes segments, mêmes groupes", () => {
    const segments = [
      [[run("un", undefined)], [run("deux", undefined)]],
      [[run("trois", undefined)], [run("quatre", undefined)]],
    ];
    const out = segmentsInDeclaredOrder(segments, rankOf(["un", "deux", "trois", "quatre"]));
    expect(texts(out)).toEqual(texts(segments));
    // Nothing was rebuilt: the groups are the same objects.
    expect(out[0]![0]).toBe(segments[0]![0]);
    expect(out[1]![1]).toBe(segments[1]![1]);
  });

  it("deux blocs inversés ressortent inversés, chacun d'un seul tenant", () => {
    const segments = [[[run("B1", undefined)], [run("B2", undefined)], [run("A1", undefined)], [run("A2", undefined)]]];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["A1", "A2", "B1", "B2"])))).toEqual([
      ["A1", "A2"],
      ["B1", "B2"],
    ]);
  });

  it("une coupure ne se fait QU'À l'endroit où l'ordre déclaré quitte le géométrique", () => {
    // Seul « d » remonte : « a b c » reste un segment, « e f » aussi.
    const segments = [[["a"], ["b"], ["c"], ["d"], ["e"], ["f"]].map((g) => g.map((t) => run(t, undefined)))];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["d", "a", "b", "c", "e", "f"])))).toEqual([
      ["d"],
      ["a", "b", "c"],
      ["e", "f"],
    ]);
  });

  it("deux segments géométriques ne fusionnent jamais, même à la suite dans l'ordre déclaré", () => {
    // Otherwise the paragraph reconstruction would see one column run on into the other.
    const segments = [[[run("gauche", undefined)]], [[run("droite", undefined)]]];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["gauche", "droite"])))).toEqual([["gauche"], ["droite"]]);
  });

  it("un groupe sans aucun rang suit celui d'avant plutôt que de partir en tête", () => {
    const segments = [[[run("un", undefined)], [run("   ", undefined)], [run("deux", undefined)]]];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["un", "deux"])))).toEqual([["un", "   ", "deux"]]);
  });
});

describe("segmentsInDeclaredOrder — a visual line that crosses two declared blocks (chantier 4, 22/10/2026)", () => {
  const texts = (segments: PdfTextRun[][][]): string[][] =>
    segments.map((s) => s.map((g) => g.map((i) => i.text).join(" ")));
  const rankOf =
    (order: readonly string[]) =>
    (item: PdfTextRun): number | undefined => {
      const rank = order.indexOf(item.text);
      return rank < 0 ? undefined : rank;
    };

  it("🔴 two columns read line by line by the geometry come out column by column, as declared", () => {
    // FAILS WITH: [["Alex Marianne", "Conseiller Conseillère"]]: each visual line mixes the two columns (doc 287, page 1).
    const segments = [
      [
        [run("Alex", undefined), run("Marianne", undefined)],
        [run("Conseiller", undefined), run("Conseillère", undefined)],
      ],
    ];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["Alex", "Conseiller", "Marianne", "Conseillère"])))).toEqual(
      [["Alex"], ["Conseiller"], ["Marianne"], ["Conseillère"]],
    );
  });

  it("a line whose pieces follow each other in the declared order stays whole (a bold word, a link)", () => {
    const segments = [
      [[run("un", undefined), run("gras", undefined), run("deux", undefined)], [run("trois", undefined)]],
    ];
    const out = segmentsInDeclaredOrder(segments, rankOf(["un", "gras", "deux", "trois"]));
    expect(texts(out)).toEqual([["un gras deux", "trois"]]);
    expect(out[0]![0]).toBe(segments[0]![0]);
  });

  it("an unranked piece stays with the ranked piece before it on its line", () => {
    const segments = [
      [
        [run("Alex", undefined), run(" ", undefined), run("Marianne", undefined)],
        [run("Conseiller", undefined), run("Conseillère", undefined)],
      ],
    ];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf(["Alex", "Conseiller", "Marianne", "Conseillère"])))).toEqual(
      [["Alex  "], ["Conseiller"], ["Marianne"], ["Conseillère"]],
    );
  });

  // Cells centred vertically in one row of a grid the table stage did not rebuild (doc 151 p10, tirage r111, 23/10/2026): the next cell
  // STARTS on a line above, so no foreign rank lies between the two pieces of the crossing line, yet they are not one after the other.
  const rankByText =
    (ranks: Readonly<Record<string, number>>) =>
    (item: PdfTextRun): number | undefined =>
      ranks[item.text];
  const flatTexts = (segments: PdfTextRun[][][]): string[] =>
    segments.flatMap((s) => s.flatMap((g) => g.map((i) => i.text)));

  it("🔴 a line that passes into a cell begun on a line above is cut: the cell comes out whole, after the cell before it", () => {
    // FAILS WITH: ["Business Owner (aka", "SEM-0501", "Product Owner)/Project", …]: « Business Owner (aka » thrown after the first line.
    const segments = [
      [
        [run("Business Owner (aka", undefined)],
        [run("SEM-0501", undefined), run("Product Owner)/Project", undefined)],
        [run("Manager/DTMB Analyst", undefined)],
      ],
    ];
    const ranks = { "SEM-0501": 0, "Business Owner (aka": 1, "Product Owner)/Project": 1, "Manager/DTMB Analyst": 1 };
    expect(flatTexts(segmentsInDeclaredOrder(segments, rankByText(ranks)))).toEqual([
      "SEM-0501",
      "Business Owner (aka",
      "Product Owner)/Project",
      "Manager/DTMB Analyst",
    ]);
  });

  it("🔴 a line whose first cell goes on below is cut too: the cell is read to its end before the next one", () => {
    // FAILS WITH: ["Functional Design", "Manager"…] mixed: « Functional » and « SEM-0501 » on one line while « Functional » continues below.
    const segments = [[[run("Functional", undefined), run("SEM-0501", undefined)], [run("Design", undefined)]]];
    const ranks = { Functional: 0, Design: 0, "SEM-0501": 1 };
    expect(flatTexts(segmentsInDeclaredOrder(segments, rankByText(ranks)))).toEqual([
      "Functional",
      "Design",
      "SEM-0501",
    ]);
  });

  it("LIMIT: the lines of ONE declared block that the geometry spread over two segments keep the geometric order (doc 200 p82, 23/10/2026)", () => {
    // A right-aligned quote (one marked content) beside a table comes out one line in two out of place. Ordering such lines by the file's
    // order was tried and dropped (23/10/2026): on the whole page it also cost two headings (safedocs 0000713, fixture 39) and glued two
    // entries of a cell (0000713 « Prise de connaissance du site » + « Organisation de la prestation »).
    const segments = [
      [[run("l1", undefined)], [run("l3", undefined)]],
      [[run("l2", undefined)], [run("l4", undefined)]],
    ];
    expect(flatTexts(segmentsInDeclaredOrder(segments, () => 0))).toEqual(["l1", "l3", "l2", "l4"]);
  });

  it("a paragraph whose second block starts in the middle of a line and goes on below stays whole, line by line", () => {
    const segments = [
      [[run("un", undefined)], [run("deux", undefined), run("gras", undefined)], [run("suite", undefined)]],
    ];
    const out = segmentsInDeclaredOrder(segments, rankByText({ un: 0, deux: 0, gras: 1, suite: 1 }));
    expect(texts(out)).toEqual([["un", "deux gras", "suite"]]);
    expect(out[0]![1]).toBe(segments[0]![1]);
  });
});

describe("segmentsInDeclaredOrder — a hostile line (review of d33a7c2f, 23/10/2026)", () => {
  it("🔴 40 000 pieces on one line with alternating ranks (0, N, 1, N-1…) are read in linear-logarithmic time, without a RangeError", () => {
    // FAILS WITH: a timeout (each pair of pieces scanned the whole interval between them: O(N²)), or « Maximum call stack size exceeded » (Math.min spread).
    const n = 40_000;
    const items = Array.from({ length: n }, (_, i) => run(String(i), undefined));
    const rank = new Map(items.map((item, i) => [item, i % 2 === 0 ? i / 2 : n - 1 - (i - 1) / 2]));
    const out = segmentsInDeclaredOrder([[items]], (item) => rank.get(item));
    expect(out.flat().flat()).toHaveLength(n);
  }, 5_000);
});

describe("breakRankTies — a follower moves WITH its leader (revue 27/10/2026)", () => {
  const texts = (segments: PdfTextRun[][][]): string[][] =>
    segments.map((s) => s.map((g) => g.map((i) => i.text).join("")));
  const pos = (text: string, x: number, width: number, y: number): PdfTextRun => ({
    ...run(text, undefined),
    x,
    width,
    y,
  });

  it("🔴 an unranked follower group stays glued to its ranked leader when the tie-break swaps the leader", () => {
    // FAILS WITH (port of lot F, before the fix): [["L2"], ["fsuit"], ["L1"]] — the tie-break permuted the two ranked
    // lines among their own places and left the follower stranded between them, detached from its leader L1.
    const rankOf = (item: PdfTextRun): number | undefined => (item.text === "L1" || item.text === "L2" ? 7 : undefined);
    const segments = [[[pos("L1", 0, 100, 10)], [pos("fsuit", 0, 100, 5)]], [[pos("L2", 0, 100, 50)]]];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf))).toEqual([["L2"], ["L1", "fsuit"]]);
  });
});

describe("breakRankTies — the follower rule stops at the segment boundary (revue 27/10/2026, tour 6)", () => {
  const texts = (segments: PdfTextRun[][][]): string[][] =>
    segments.map((s) => s.map((g) => g.map((i) => i.text).join("")));
  const pos = (text: string, x: number, width: number, y: number): PdfTextRun => ({
    ...run(text, undefined),
    x,
    width,
    y,
  });

  it("🔴 an unranked group OPENING another segment is not dragged along as a follower of the previous segment's leader", () => {
    // FAILS WITH (before the fix): [["L2"], ["L1"], ["U"]] — the segment-1 opener U, which only INHERITED L1's rank,
    // travelled with L1 when the tie-break swapped it below L2, leaving its own column's reading position.
    const rankOf = (item: PdfTextRun): number | undefined => (item.text === "L1" || item.text === "L2" ? 7 : undefined);
    const segments = [[[pos("L1", 0, 100, 10)]], [[pos("U", 0, 100, 60)], [pos("L2", 0, 100, 50)]]];
    expect(texts(segmentsInDeclaredOrder(segments, rankOf))).toEqual([["L2"], ["U"], ["L1"]]);
  });
});
