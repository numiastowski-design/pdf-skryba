/**
 * The text runs of a page built from OUR glyphs, not from pdf.js `getTextContent()` (docs/CONCEPTION-TEXTE-PDF-GLYPHES.md,
 * option decided by on 13/10/2026). Each case is a rule of that design, fed as named operators, the shape
 * `decodeOps` gives.
 */

import { describe, expect, it } from "vitest";

import type { NamedOp } from "./glyph-positions";
import { glyphRuns } from "./glyph-runs";

const glyph = (unicode: string, width: number, isSpace = false): Record<string, unknown> => ({
  originalCharCode: unicode.charCodeAt(0),
  fontChar: unicode,
  unicode,
  accent: null,
  width,
  isSpace,
  isInFont: true,
});

const show = (text: string, width = 500): NamedOp => ({
  op: "showText",
  args: [[...text].map((c) => glyph(c, width, c === " "))],
});
const font = (name: string, size = 10): NamedOp => ({ op: "setFont", args: [name, size] });
const at = (x: number, y: number): NamedOp => ({ op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: y } });
const BT: NamedOp = { op: "beginText", args: null };
const ET: NamedOp = { op: "endText", args: null };

const textsOf = (ops: NamedOp[]): string[] => glyphRuns([BT, ...ops, ET]).map((r) => r.text);

describe("glyphRuns — where a run closes", () => {
  it("one font, glyphs side by side: one run", () => {
    expect(textsOf([font("f1"), at(100, 700), show("abc")])).toEqual(["abc"]);
  });

  it("a font change closes the run, and the next run starts exactly where the last glyph's advance ends (« é » + « lectrique », fixture 48)", () => {
    const runs = glyphRuns([BT, font("f2"), at(100, 700), show("é"), font("f1"), show("lectrique"), ET]);
    expect(runs.map((r) => r.text)).toEqual(["é", "lectrique"]);
    expect(runs.map((r) => r.fontId)).toEqual(["f2", "f1"]);
    expect(runs[1]!.x).toBeCloseTo(runs[0]!.x + runs[0]!.width, 6);
  });

  it("a size change closes the run", () => {
    expect(textsOf([font("f1", 10), at(100, 700), show("ab"), font("f1", 12), show("cd")])).toEqual(["ab", "cd"]);
  });

  it("a gap wider than 0.6 em closes the run (columns and cells keep their edges)", () => {
    // 10 pt font: 0.6 em = 6 pt. « ab » ends at 110; the next glyph starts at 117.
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(117, 700), show("cd")])).toEqual(["ab", "cd"]);
  });

  it("a step back of more than 0.2 em closes the run", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(107, 700), show("cd")])).toEqual(["ab", "cd"]);
  });

  it("a baseline a line lower closes the run", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(110, 688), show("cd")])).toEqual(["ab", "cd"]);
  });

  it("a superscript raised by the text rise at the same size stays in the run (defect H, 22/09/2026)", () => {
    const runs = textsOf([
      font("f1"),
      at(100, 700),
      show("18"),
      { op: "setTextRise", args: [3] },
      show("th"),
      { op: "setTextRise", args: [0] },
      show(" May"),
    ]);
    expect(runs).toEqual(["18th May"]);
  });

  it("a marked-content boundary closes the run, and each run carries its own marked content", () => {
    const runs = glyphRuns([
      BT,
      font("f1"),
      at(100, 700),
      { op: "beginMarkedContentProps", args: ["Artifact", null] },
      show("12"),
      { op: "endMarkedContent", args: null },
      show("ab"),
      ET,
    ]);
    expect(runs.map((r) => [r.text, r.artifact])).toEqual([
      ["12", true],
      ["ab", false],
    ]);
  });
});

describe("glyphRuns — where a run gets a space", () => {
  it("a blank glyph of the document is a space", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab cd")])).toEqual(["ab cd"]);
  });

  it("a gap over 0.1 em with no blank glyph is a space (Poppler's rule, TextOutputDev.cc l. 2773)", () => {
    // « ab » ends at 110; « cd » starts 1.5 pt later = 0.15 em.
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(111.5, 700), show("cd")])).toEqual(["ab cd"]);
  });

  it("a gap of 0.1 em or less is no space", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(110.5, 700), show("cd")])).toEqual(["abcd"]);
  });

  // Bench of 14/10/2026: a blank dropped where a run closes glued « Version 4Page 3 of 9 » (doc 38, its footer no longer
  // seen as repeated) and « 3.Indicateurs » (doc 49). pdf.js emitted that blank as an item of its own; so do we, ONE per cut.
  it("blanks between two runs that a cut separates become one blank run, as pdf.js emits", () => {
    expect(
      textsOf([font("f1"), at(100, 700), show("ab"), font("f2"), show("  "), font("f1"), at(140, 700), show("cd")]),
    ).toEqual(["ab", " ", "cd"]);
  });

  it("a font change right after a blank keeps the blank between the two runs (« 3. Indicateurs », doc 49)", () => {
    expect(textsOf([font("f2"), at(100, 700), show("3. "), font("f5"), show("Indicateurs")])).toEqual([
      "3.",
      " ",
      "Indicateurs",
    ]);
  });

  it("a wide gap after a blank keeps the blank between the two runs (« Version 4 Page 3 of 9 », doc 38)", () => {
    expect(textsOf([font("f1"), at(56.7, 800), show("Version 4 "), at(498, 800), show("Page 3 of 9")])).toEqual([
      "Version 4",
      " ",
      "Page 3 of 9",
    ]);
  });

  it("blanks at the end of one run and in another font make ONE blank run, never two", () => {
    expect(
      textsOf([font("f1"), at(100, 700), show("ab "), font("f2"), show(" "), font("f1"), at(140, 700), show("cd")]),
    ).toEqual(["ab", " ", "cd"]);
  });

  it("a blank that starts the run after a wide gap is kept between the two", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab"), at(200, 700), show(" cd")])).toEqual(["ab", " ", "cd"]);
  });

  it("no blank run at a line change", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab "), at(100, 680), show("cd")])).toEqual(["ab", "cd"]);
  });

  // Counter-review of 14/10/2026: a line change that comes with a font change is still a line change, so no blank run.
  it("no blank run across a line change that also changes font (blank at the end of the first line)", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab "), font("f2"), at(100, 680), show("cd")])).toEqual([
      "ab",
      "cd",
    ]);
  });

  it("no blank run across a line change that also changes font (blank at the start of the next line)", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab"), font("f2"), at(100, 680), show(" cd")])).toEqual([
      "ab",
      "cd",
    ]);
  });

  // Fixture 25 (diagnosis of 14/10/2026): a « fi » ligature is followed by a blank glyph drawn back over it, then « cheur »;
  // a viewer shows « afficheur ». A blank that steps back over the previous letter is no space.
  it("a blank drawn back over the previous letter makes no blank run (« l'affi cheur », fixture 25)", () => {
    expect(
      textsOf([font("f1"), at(100, 700), show("ab"), at(107.5, 700), show(" "), at(110, 700), show("cd")]),
    ).toEqual(["ab", "cd"]);
  });

  it("no run is made of blanks only when no letter follows them", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ab  ")])).toEqual(["ab"]);
  });
});

describe("glyphRuns — what a run carries", () => {
  it("origin, size and width come from the glyphs; the font is the `Tf` name", () => {
    const [run] = glyphRuns([BT, font("g_d0_f1", 10), at(100, 700), show("abcd"), ET]);
    expect(run).toMatchObject({
      text: "abcd",
      x: 100,
      y: 700,
      fontSize: 10,
      fontId: "g_d0_f1",
      rotated: false,
      dir: "ltr",
    });
    expect(run!.width).toBeCloseTo(20, 6);
  });

  it("a ligature presentation form is published as its letters", () => {
    expect(textsOf([font("f1"), at(100, 700), show("ﬁn")])).toEqual(["fin"]);
  });

  it("a glyph a viewer does not show makes no run (text rendering mode 3)", () => {
    expect(
      textsOf([
        font("f1"),
        at(100, 700),
        { op: "setTextRenderingMode", args: 3 },
        show("hidden"),
        { op: "setTextRenderingMode", args: 0 },
        at(200, 700),
        show("shown"),
      ]),
    ).toEqual(["shown"]);
  });
});

describe("l'italique SYNTHÉTIQUE : un cisaillement de la matrice de texte (05/11/2026)", () => {
  // A caption written in the same font as the rest and slanted by the text matrix: an italic the PDF declares by its
  // geometry, not by its font. A rotation (b ≠ 0) is not one.
  const sheared = (x: number, y: number, c: number, b = 0): NamedOp => ({
    op: "setTextMatrix",
    args: { a: 1, b, c, d: 1, e: x, f: y },
  });

  it("🔴 un fragment cisaillé est en italique, un fragment droit non", () => {
    const runs = glyphRuns([BT, font("F5", 8), at(10, 100), show("dont"), sheared(40, 100, 0.19), show("Adieu"), ET]);
    expect(runs.map((r) => `${r.text}:${String(r.italic)}`)).toEqual(["dont:false", "Adieu:true"]);
  });

  it("une rotation n'est pas un italique", () => {
    const runs = glyphRuns([
      BT,
      font("F5", 8),
      { op: "setTextMatrix", args: { a: 0, b: 1, c: -1, d: 0, e: 10, f: 100 } },
      show("vertical"),
      ET,
    ]);
    expect(runs.map((r) => r.italic)).toEqual([false]);
  });
});
