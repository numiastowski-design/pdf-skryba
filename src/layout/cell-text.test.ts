import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { joinGlyphs, recomposeCellText, type CellBounds } from "./cell-text";
import type { Fragment } from "./geometry";

const here = dirname(fileURLToPath(import.meta.url));

/** One glyph. Spaces are glyphs too: they carry an advance, hence a position. */
const g = (text: string, x: number, y: number, width = 5): Fragment => ({ text, x, y, width, height: 8 });

/** A visual line from a string, one glyph per character. */
const line = (text: string, x0: number, y: number, glyphWidth = 5): Fragment[] =>
  [...text].map((ch, i) => g(ch, x0 + i * glyphWidth, y, glyphWidth));

const NARROW: CellBounds = { left: 28.3, right: 123.3 }; // 95 pt — la colonne « Matières » mesurée
const WIDE: CellBounds = { left: 202.8, right: 567 }; // 364,2 pt — la colonne « Appréciations »

describe("recomposeCellText — l'ordre de lecture", () => {
  it("lit de haut en bas puis de gauche à droite, quel que soit l'ordre d'entrée", () => {
    // Sorting by abscissa alone interleaves the two visual lines of a cell, letter by letter.
    const shuffled = [...line("Mme FINELLE", 29.4, 676), ...line("FRANCAIS", 29.4, 684.2)];
    expect(recomposeCellText(shuffled, NARROW).map((l) => l.text)).toEqual(["FRANCAIS", "Mme FINELLE"]);
  });

  it("rend un tableau vide pour une cellule vide — le cas des niveaux du socle", () => {
    expect(recomposeCellText([], NARROW)).toEqual([]);
  });
});

describe("recomposeCellText — retour à la ligne contre vrai saut", () => {
  /** A line that fills `fill` of the cell's usable width. */
  const filled = (text: string, y: number, bounds: CellBounds, fill: number): Fragment[] => {
    const width = ((bounds.right - bounds.left) * fill) / text.length;
    return line(text, bounds.left + 1, y, width);
  };

  it("JOINT deux lignes quand la première remplit la cellule — c'est un retour à la ligne", () => {
    const cell = [...filled("phrase longue qui va au bout", 700, WIDE, 0.96), ...filled("et sa fin", 690, WIDE, 0.09)];
    expect(recomposeCellText(cell, WIDE).map((l) => l.text)).toEqual(["phrase longue qui va au bout et sa fin"]);
  });

  it("SÉPARE deux lignes courtes — ce sont deux données distinctes", () => {
    const cell = [...filled("FRANCAIS", 684, NARROW, 0.32), ...filled("Mme FINELLE", 676, NARROW, 0.4)];
    expect(recomposeCellText(cell, NARROW).map((l) => l.text)).toEqual(["FRANCAIS", "Mme FINELLE"]);
  });

  it("la dernière ligne ne joint rien, même pleine — il n'y a rien après elle", () => {
    const cell = filled("une ligne pleine sans suite", 700, WIDE, 0.96);
    expect(recomposeCellText(cell, WIDE)).toHaveLength(1);
  });

  it("enchaîne trois lignes d'un même paragraphe", () => {
    const cell = [
      ...filled("premiere ligne pleine", 700, WIDE, 0.95),
      ...filled("deuxieme ligne pleine", 690, WIDE, 0.9),
      ...filled("la fin", 680, WIDE, 0.12),
    ];
    expect(recomposeCellText(cell, WIDE).map((l) => l.text)).toEqual([
      "premiere ligne pleine deuxieme ligne pleine la fin",
    ]);
  });

  it("le seuil est à 85 % : une ligne à 86 % joint, une ligne à 84 % sépare", () => {
    // "Seconde" is uppercase: this test pins the FILL THRESHOLD, not the separator — a one-token upper
    // line followed by a lowercase line belongs to rule J1 (wrap-junction.test.ts).
    const at = (fill: number): string[] =>
      recomposeCellText([...filled("premiere", 700, WIDE, fill), ...filled("Seconde", 690, WIDE, 0.2)], WIDE).map(
        (l) => l.text,
      );
    expect(at(0.86)).toEqual(["premiere Seconde"]);
    expect(at(0.84)).toEqual(["premiere", "Seconde"]);
  });

  it("SÉPARE trois valeurs dans une colonne étroite où toutes les lignes remplissent", () => {
    // The degeneracy guard: in a column this narrow a five-character value fills past the threshold and a
    // four-character one does not, so one column joined its values while its neighbour split them.
    const NOTES: CellBounds = { left: 185.2, right: 203.8 }; // 18,6 pt
    const cell = [
      ...filled("13,83", 700, NOTES, 0.9),
      ...filled("13,85", 690, NOTES, 0.9),
      ...filled("13,80", 680, NOTES, 0.9),
    ];
    expect(recomposeCellText(cell, NOTES).map((l) => l.text)).toEqual(["13,83", "13,85", "13,80"]);
  });

  it("joint encore quand UNE SEULE ligne ne remplit pas — l'asymétrie suffit à décider", () => {
    // The counterpart: once one line misses the threshold it discriminates again, and the guard must not fire.
    const cell = [
      ...filled("premiere pleine", 700, WIDE, 0.95),
      ...filled("deuxieme pleine", 690, WIDE, 0.9),
      ...filled("fin", 680, WIDE, 0.1),
    ];
    expect(recomposeCellText(cell, WIDE).map((l) => l.text)).toEqual(["premiere pleine deuxieme pleine fin"]);
  });

  it("la réserve de la garde, écrite comme un CHOIX : un vrai paragraphe sans asymétrie EST découpé", () => {
    // A paragraph whose every line ends at the cell's edge gives no signal: it is split, ugly and visible rather
    // than wrong and invisible. This test records that the case was seen and accepted.
    const cell = [
      ...filled("un paragraphe qui va au bout", 700, WIDE, 0.95),
      ...filled("et dont la suite aussi", 690, WIDE, 0.95),
    ];
    expect(recomposeCellText(cell, WIDE).map((l) => l.text)).toEqual([
      "un paragraphe qui va au bout",
      "et dont la suite aussi",
    ]);
  });

  it("une cellule de largeur nulle ne joint jamais — pas de division par zéro, pas de jonction devinée", () => {
    const degenerate: CellBounds = { left: 100, right: 100 };
    const cell = [...line("AB", 100, 700), ...line("CD", 100, 690)];
    expect(recomposeCellText(cell, degenerate).map((l) => l.text)).toEqual(["AB", "CD"]);
  });
});

describe("recomposeCellText — la profondeur d'indentation (écart 17, premier temps)", () => {
  it("des lignes également indentées sont toutes à la profondeur 0", () => {
    const cell = [...line("FRANCAIS", 29.4, 684), ...line("Mme FINELLE", 29.4, 676)];
    expect(recomposeCellText(cell, NARROW).map((l) => l.depth)).toEqual([0, 0]);
  });

  it("une sous-ligne indentée prend la profondeur 1 — le motif FRANCAIS / sous-groupes mesuré", () => {
    // This first step keeps the lines apart and records the depth; it concludes nothing from it.
    const cell = [
      ...line("FRANCAIS", 29.5, 682),
      ...line("Mme PROUST", 29.5, 673),
      ...line("FRANCAIS", 89.4, 664),
      ...line("Mme FINELLE", 79.6, 655),
    ];
    const out = recomposeCellText(cell, { left: 28.3, right: 123.3 });
    expect(out.map((l) => l.text)).toEqual(["FRANCAIS", "Mme PROUST", "FRANCAIS", "Mme FINELLE"]);
    expect(out.map((l) => l.depth)).toEqual([0, 0, 1, 1]);
  });

  it("une ligne jointe garde la profondeur de la ligne qui l'ouvre", () => {
    const width = ((WIDE.right - WIDE.left) * 0.95) / 8;
    const cell = [...line("ouvrante", WIDE.left + 40, 700, width), ...line("suite", WIDE.left + 40, 690, 4)];
    const out = recomposeCellText(cell, WIDE);
    expect(out).toHaveLength(1);
    expect(out[0]!.depth).toBe(0);
  });
});

describe("recomposeCellText — les espaces", () => {
  it("conserve les espaces intérieurs, qui sont de vrais glyphes", () => {
    const cell = line("A B", 29.4, 684);
    expect(recomposeCellText(cell, NARROW)[0]!.text).toBe("A B");
  });

  it("insère UNE espace à la jonction de deux lignes, jamais deux", () => {
    const width = ((WIDE.right - WIDE.left) * 0.95) / 9;
    const cell = [...line("ouvrante ", WIDE.left + 1, 700, width), ...line("suite", WIDE.left + 1, 690, 4)];
    expect(recomposeCellText(cell, WIDE)[0]!.text).toBe("ouvrante suite");
  });
});

describe("recomposeCellText — footnote calls hang from the line below", () => {
  // Real glyphs of a merged cell of fixtures/docx-reel/07-moj-data-sharing-guidance-Word.pdf (physical page 10, the
  // bench counts from 0): five visual lines, with calls « 3 », « 4 », « 5 » raised 4 pt over the line « HMCTS, HMCTS
  // Data First data, HMPPS Data First data, and » and « 6 » over « the MoJ DfE share. ». Each call is 8 pt over 12 pt
  // text, at the end of a word, in a DIFFERENT column of the merged cell (x = 242, 378, 514).
  const glyphs = (
    JSON.parse(readFileSync(join(here, "cell-text.superscript.fixture.json"), "utf8")) as [
      string,
      number,
      number,
      number,
      number,
    ][]
  ).map(([text, x, y, width, height]): Fragment => ({ text, x, y, width, height }));
  const MERGED: CellBounds = { left: 195, right: 555 };

  it("keeps each call at the end of its own word, never joined together at the end of the line above", () => {
    const text = recomposeCellText(glyphs, MERGED, 12)
      .map((l) => l.text)
      .join("\n");
    expect(text).not.toContain("345");
    expect(text).toContain("HMCTS3, HMCTS Data First data4, HMPPS Data First data5, and");
    expect(text).toContain("the MoJ DfE share6.");
  });
});

describe("recomposeCellText — a word gap with no space glyph (Google Docs justified text, fixture 34 « thesame », « maybe »)", () => {
  /** Glyphs of `words`, 5 pt wide, 10 pt high, a gap of `gap` pt between words and NO blank glyph. */
  const spaceless = (words: string[], gap: number, y = 700): Fragment[] => {
    const out: Fragment[] = [];
    let x = 210;
    for (const word of words) {
      for (const ch of word) {
        out.push({ text: ch, x, y, width: 5, height: 10 });
        x += 5;
      }
      x += gap;
    }
    return out;
  };

  it("writes a space where two words are 2.5 pt (0.25 em) apart", () => {
    expect(recomposeCellText(spaceless(["this", "may", "be", "the", "same"], 2.5), WIDE)[0]!.text).toBe(
      "this may be the same",
    );
  });

  it("keeps a one-letter word apart from its neighbours: « of a new »", () => {
    expect(recomposeCellText(spaceless(["of", "a", "new"], 2.5), WIDE)[0]!.text).toBe("of a new");
  });

  it("writes nothing inside a word: kerning and rounding stay under 0.1 em", () => {
    expect(recomposeCellText(spaceless(["policy"], 0.4), WIDE)[0]!.text).toBe("policy");
    expect(recomposeCellText(spaceless(["pol", "icy"], 0.8), WIDE)[0]!.text).toBe("policy");
  });

  it("a letter-spaced word is not cut: one gap after EVERY letter (fixture 26, « LIVRET »)", () => {
    expect(recomposeCellText(spaceless([..."LIVRET"], 2.57), WIDE)[0]!.text).toBe("LIVRET");
  });

  it("figures spread one by one (46, 0.446 em) are not cut either", () => {
    expect(recomposeCellText(spaceless([..."2856"], 4.46), WIDE)[0]!.text).toBe("2856");
  });
});

describe("joinGlyphs — tracked lines and run edges (review 15/10/2026)", () => {
  /** `parts`: a word (glyphs `advance` apart + `track` pt of tracking), or " " (a real space glyph, `space` pt wide). */
  const build = (
    parts: string[],
    track: number,
    opts: { advance?: number; space?: number; wordGap?: number } = {},
  ): Fragment[] => {
    const { advance = 5, space = 2.5, wordGap = 0 } = opts;
    const out: Fragment[] = [];
    let x = 210;
    for (const part of parts) {
      if (part === " ") {
        out.push({ text: " ", x, y: 700, width: space, height: 10 });
        x += space + track;
        continue;
      }
      for (const ch of part) {
        out.push({ text: ch, x, y: 700, width: advance, height: 10 });
        x += advance + track;
      }
      x += wordGap;
    }
    return out;
  };

  it("a tracked line WITH real space glyphs keeps its words: « abc def ghi » at 0.15 em tracking", () => {
    expect(joinGlyphs(build(["abc", " ", "def", " ", "ghi"], 1.5))).toBe("abc def ghi");
  });

  it("tracked capitals with a mixed gap near 0.1 em are not cut: « LI V RET »", () => {
    const tracks = [1.2, 0.4, 1.2, 0.4, 1.2];
    const glyphs: Fragment[] = [..."LIVRET"].map((ch, i) => ({
      text: ch,
      x: 210 + i * 5 + tracks.slice(0, i).reduce((a, b) => a + b, 0),
      y: 700,
      width: 5,
      height: 10,
    }));
    expect(joinGlyphs(glyphs)).toBe("LIVRET");
  });

  it("a justified line with word gaps and tight letters is still cut: « thesame » → « the same »", () => {
    expect(joinGlyphs(build(["the", "same", "as", "the"], 0, { wordGap: 2.5 }))).toBe("the same as the");
  });

  it("a letter-spaced run keeps its edges: « word 1 2 3 word2 » → « word 123 word2 »", () => {
    const glyphs = [
      ...build(["word"], 0, { wordGap: 2.5 }),
      ...[..."123"].map((ch, i) => ({ text: ch, x: 237.5 + i * 7.5, y: 700, width: 5, height: 10 })),
      ...build(["word2"], 0).map((f) => ({ ...f, x: f.x + 260 - 210 + 0 })),
    ];
    expect(joinGlyphs(glyphs)).toBe("word 123 word2");
  });

  it("a combining mark or a zero-width glyph never gets a space before it", () => {
    const glyphs: Fragment[] = [
      { text: "e", x: 210, y: 700, width: 5, height: 10 },
      { text: "́", x: 216, y: 700, width: 5, height: 10 },
      { text: "t", x: 222, y: 700, width: 0, height: 10 },
      { text: "x", x: 228, y: 700, width: 5, height: 10 },
    ];
    expect(joinGlyphs(glyphs)).toBe("étx");
  });

  it("two glyphs far apart (a whole em or more) are two words, however few pairs the line has: « C D »", () => {
    expect(
      joinGlyphs([
        { text: "C", x: 110, y: 700, width: 5, height: 10 },
        { text: "D", x: 210, y: 700, width: 5, height: 10 },
      ]),
    ).toBe("C D");
  });

  it("three single glyphs a whole em or more apart are three words: « A B C »", () => {
    const at = (text: string, x: number): Fragment => ({ text, x, y: 700, width: 5, height: 10 });
    expect(joinGlyphs([at("A", 110), at("B", 210), at("C", 310)])).toBe("A B C");
  });

  it("tracking close to the word gap is still tracking: « HEADING » with gaps of 0.12, 0.09, 0.11, 0.08, 0.13, 0.10 em", () => {
    const tracks = [1.2, 0.9, 1.1, 0.8, 1.3, 1.0];
    let x = 210;
    const glyphs: Fragment[] = [..."HEADING"].map((ch, i) => {
      const f = { text: ch, x, y: 700, width: 5, height: 10 };
      x += 5 + (tracks[i] ?? 0);
      return f;
    });
    expect(joinGlyphs(glyphs)).toBe("HEADING");
  });

  it("a size of zero, negative or NaN decides nothing: no cut", () => {
    for (const height of [0, -10, Number.NaN]) {
      const two: Fragment[] = [
        { text: "a", x: 210, y: 700, width: 5, height },
        { text: "b", x: 220, y: 700, width: 5, height },
      ];
      expect(joinGlyphs(two)).toBe("ab");
    }
  });

  it("a two-glyph cell keeps its gap: « A B », « Q 3 », « 5 % » (too few pairs to call a line tracked)", () => {
    const pair = (a: string, b: string): Fragment[] => [
      { text: a, x: 210, y: 700, width: 5, height: 10 },
      { text: b, x: 218, y: 700, width: 5, height: 10 },
    ];
    expect(joinGlyphs(pair("A", "B"))).toBe("A B");
    expect(joinGlyphs(pair("Q", "3"))).toBe("Q 3");
    expect(joinGlyphs(pair("5", "%"))).toBe("5 %");
  });

  it("KNOWN BIAS, pinned: a long line of one- and two-letter words with no space glyph reads as tracked and is not cut (« a b c is it on » → « abcisiton »)", () => {
    expect(joinGlyphs(build(["a", "b", "c", "is", "it", "on"], 0, { wordGap: 2.5 }))).toBe("abcisiton");
  });
});

describe("joinGlyphs — a blank drawn over the letter before it (corpus 219 p2, 19/10/2026)", () => {
  const g = (text: string, x: number, width: number): Fragment => ({ text, x, y: 700, width, height: 10 });

  it("a blank starting 4 pt inside « D » is no space: « DataType »", () => {
    expect(joinGlyphs([g("D", 47.76, 7.47), g(" ", 52.2, 2.77), g("a", 55.2, 4.25), g("t", 59.4, 3.3)])).toBe("Dat");
  });

  it("counter-proof: the same blank after the letter (starting where it ends) stays a space", () => {
    expect(joinGlyphs([g("D", 47.76, 7.47), g(" ", 55.23, 2.77), g("a", 58, 4.25)])).toBe("D a");
  });
});

describe("recomposeCellText — a raised call is SAID per line, the text stays the document's (corpus pdf/15 « dosis2 », 23/10/2026)", () => {
  // A cell's text is plain; the line tells which of its fragments are raised calls, and the cell's inlines mark them `sup`
  // (`extractor/pdf-table-render.ts#cellInlines`). Same reading as the page flow: geometry only, never a word.
  const bounds: CellBounds = { left: 0, right: 200 };
  const word = (text: string, x0: number, y: number, size: number): Fragment[] =>
    [...text].map((c, i) => ({ text: c, x: x0 + i * 6, y, width: 6, height: size }));
  const raisedTexts = (l: { raised?: ReadonlySet<Fragment> }) => [...(l.raised ?? [])].map((f) => f.text).sort();

  it("🔴 a smaller call raised after a word is in the line's raised set; the text keeps it glued, as drawn", () => {
    // FAILS WITH: raised undefined (the line says nothing of the call).
    const [line] = recomposeCellText(
      [...word("dosis", 10, 100, 12), ...word("2", 40, 104, 7), ...word("con", 50, 100, 12)],
      bounds,
      12,
    );
    expect(line!.text).toBe("dosis2 con");
    expect(raisedTexts(line!)).toEqual(["2"]);
  });

  it("🔴 « 4² » alone in its cell: the base glyph is the host even when the two sizes tie (one glyph each)", () => {
    // FAILS WITH: [] (the dominant size of a tie is the SMALLEST: the « 2 » became the host — Fable's review, 23/10/2026).
    const [line] = recomposeCellText([...word("4", 10, 100, 12), ...word("2", 16, 104, 7)], bounds, 12);
    expect(raisedTexts(line!)).toEqual(["2"]);
  });

  it("🔴 a call on the SECOND visual line of a wrapped line is read against its own line", () => {
    const narrow: CellBounds = { left: 0, right: 40 };
    const lines = recomposeCellText(
      [...word("abcdef", 0, 100, 12), ...word("gh", 0, 86, 12), ...word("3", 12, 90, 7), ...word("ij", 18, 86, 12)],
      narrow,
      12,
    );
    expect(lines.flatMap((l) => raisedTexts(l))).toEqual(["3"]);
  });

  it("a same-size digit glued to a word is not raised", () => {
    const [line] = recomposeCellText(word("covid19", 10, 100, 12), bounds, 12);
    expect(raisedTexts(line!)).toEqual([]);
  });
});

describe("recomposeCellText — the host is the line's DOMINANT size, a tie going to the larger (Fable's review, 23/10/2026)", () => {
  const bounds: CellBounds = { left: 0, right: 200 };
  const word = (text: string, x0: number, y: number, size: number): Fragment[] =>
    [...text].map((c, i) => ({ text: c, x: x0 + i * 6, y, width: 6, height: size }));

  it("🔴 a decorative 16 pt initial does not set the host: the call is read against the line's 10 pt text", () => {
    // FAILS WITH: [] (against the largest glyph the call's 2.5 pt rise is 0.16 em, under the 0.2 em floor; against the 10 pt text, 0.25 em).
    const [line] = recomposeCellText(
      [
        ...word("A", 10, 100, 16),
        ...word("bcdef", 20, 100, 10),
        ...word("2", 50, 102.5, 7),
        ...word("gh", 56, 100, 10),
      ],
      bounds,
      10,
    );
    expect([...(line!.raised ?? [])].map((f) => f.text)).toEqual(["2"]);
  });
});
