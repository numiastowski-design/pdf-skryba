import { describe, expect, it } from "vitest";

import type { GlyphFragment } from "./glyph-positions";
import { respaceLetterSpacedRuns, respacedText } from "./pdf-letter-spacing";
import type { PdfTextRun } from "./pdf-source";

const FONT = 20;

const run = (text: string, x: number, width: number, extra: Partial<PdfTextRun> = {}): PdfTextRun => ({
  text,
  x,
  y: 700,
  width,
  height: FONT,
  fontSize: FONT,
  matrix: { a: FONT, b: 0, c: 0, d: FONT, e: x, f: 700 },
  fontId: undefined,
  weight: "normal",
  rotated: false,
  hasEOL: false,
  dir: "ltr",
  markedContentId: undefined,
  artifact: false,
  ...extra,
});

/** One glyph per character, `advance` points apart, as a producer that places
 *  each letter itself writes them. */
const glyphsOf = (chars: string, x: number, advance: number): GlyphFragment[] =>
  [...chars].map((text, i) => ({
    text,
    x: x + i * advance,
    y: 700,
    width: 12,
    height: FONT,
    matrix: { a: FONT, b: 0, c: 0, d: FONT, e: x + i * advance, f: 700 },
    runId: i,
    isSpace: text === " ",
    paintCount: 1,
    stroked: false,
  }));

describe("respacedText — a run pdf.js letter-spaced takes the glyphs' text", () => {
  it("« L I V R E T », one glyph per letter, publishes « LIVRET »", () => {
    // Six letters 17 pt apart: the run gets a space in each 5 pt gap (as pdf.js did).
    expect(respacedText(run("L I V R E T", 100, 97), glyphsOf("LIVRET", 100, 17))).toBe("LIVRET");
  });

  it("keeps the document's real spaces: « 1 | P a g e » → « 1 | Page »", () => {
    expect(respacedText(run("1 | P a g e", 100, 125), glyphsOf("1 | Page", 100, 15))).toBe("1 | Page");
  });

  it("a run that is not letter-spaced is left alone", () => {
    expect(respacedText(run("Livret d’accueil", 100, 200), glyphsOf("Livretd’accueil", 100, 13))).toBeUndefined();
  });

  it("a document that spaces its own letters with real space glyphs reads the same both ways: nothing moves", () => {
    expect(respacedText(run("V I N E T", 100, 110), glyphsOf("V I N E T", 100, 12))).toBeUndefined();
  });

  it("abstains when the two readings disagree on the letters", () => {
    expect(respacedText(run("L I V R E T", 100, 97), glyphsOf("LIVRES", 100, 17))).toBeUndefined();
  });

  it("abstains when the run also holds a word: « Chapitre S T A M P S » is not glued into « ChapitreSTAMPS »", () => {
    // Glyphs with no real space: the word boundary cannot be told from a letter gap.
    expect(respacedText(run("Chapitre S T A M P S", 100, 250), glyphsOf("ChapitreSTAMPS", 100, 17))).toBeUndefined();
  });

  it("abstains when no glyph was read at that place", () => {
    expect(respacedText(run("L I V R E T", 100, 97), [])).toBeUndefined();
  });

  it("abstains on a rotated run, whose box does not describe where it is drawn", () => {
    expect(respacedText(run("L I V R E T", 100, 97, { rotated: true }), glyphsOf("LIVRET", 100, 17))).toBeUndefined();
  });

  it("does not take the next run's space glyph, drawn at a zero gap", () => {
    const glyphs = glyphsOf("LIVRET ", 100, 17);
    expect(respacedText(run("L I V R E T", 100, 97), glyphs)).toBe("LIVRET");
  });
});

describe("respaceLetterSpacedRuns", () => {
  it("replaces only the letter-spaced run, by a copy, and remembers its source", () => {
    const spaced = run("L I V R E T", 100, 97);
    const plain = run("Bienvenue", 100, 90, { y: 600, matrix: { a: FONT, b: 0, c: 0, d: FONT, e: 100, f: 600 } });
    const originalOf = new Map<PdfTextRun, PdfTextRun>();
    const out = respaceLetterSpacedRuns([spaced, plain], glyphsOf("LIVRET", 100, 17), (copy, source) =>
      originalOf.set(copy, source),
    );
    expect(out.map((r) => r.text)).toEqual(["LIVRET", "Bienvenue"]);
    expect(out[1]).toBe(plain);
    expect(spaced.text).toBe("L I V R E T");
    expect(originalOf.get(out[0]!)).toBe(spaced);
    expect(originalOf.size).toBe(1);
  });
});

describe("l'information « lettres espacées » est gardée sur le morceau recomposé (05/11/2026)", () => {
  // Kept in case it becomes useful: no rule reads it.
  it("🔴 la copie recomposée porte letterSpaced: true, un morceau ordinaire rien", () => {
    const spaced = run("L I V R E T", 100, 110);
    const out = respaceLetterSpacedRuns([spaced, run("corps", 300, 40)], glyphsOf("LIVRET", 100, 18));
    expect((out[0] as { letterSpaced?: boolean }).letterSpaced).toBe(true);
    expect((out[1] as { letterSpaced?: boolean }).letterSpaced).toBeUndefined();
  });
});
