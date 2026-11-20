/** The second reading built from our glyph geometry (`pdf-reference-ours.ts`): one cycle per shown operator, hidden
 *  letters left out, the vertical centre, the marked-content identifier, the artifact and rotation flags. */
import { describe, expect, it } from "vitest";

import type { GlyphFragment } from "./glyph-positions";
import { referenceOfGlyphs } from "./pdf-reference-ours";

/** A glyph with the fields the reference reads; the rest is what a painted glyph carries and the reference ignores. */
function glyph(text: string, runId: number, over: Partial<GlyphFragment> = {}): GlyphFragment {
  return {
    text,
    x: 0,
    y: 100,
    width: 5,
    height: 10,
    matrix: { a: 10, b: 0, c: 0, d: 10, e: 0, f: 100 },
    runId,
    isSpace: false,
    paintCount: 1,
    stroked: false,
    ...over,
  };
}

describe("referenceOfGlyphs: la seconde lecture, depuis notre géométrie", () => {
  it("un cycle par opérateur, ses lettres dans l'ordre de peinture", () => {
    const cycles = referenceOfGlyphs([glyph("A", 0), glyph("B", 0), glyph("C", 1)], "p3R");
    expect(cycles.map((c) => c.text)).toEqual(["AB", "C"]);
  });

  it("le centre vertical est y + hauteur / 2, moyenné sur le cycle", () => {
    const cycles = referenceOfGlyphs(
      [glyph("A", 0, { y: 100, height: 10 }), glyph("B", 0, { y: 104, height: 10 })],
      undefined,
    );
    expect(cycles[0]!.middle).toBe((100 + 5 + (104 + 5)) / 2);
  });

  it("un texte masqué ne compte pas", () => {
    const cycles = referenceOfGlyphs([glyph("X", 0, { hidden: "layer" }), glyph("Y", 0)], undefined);
    expect(cycles.map((c) => c.text)).toEqual(["Y"]);
  });

  it("l'identifiant de contenu balisé est celui de la page, comme celui de la structure", () => {
    const cycles = referenceOfGlyphs([glyph("A", 0, { mcid: 7 })], "p3R");
    expect(cycles[0]!.markedContentId).toBe("p3R_mc7");
  });

  it("un artefact et un texte tourné sont marqués", () => {
    const [artifact] = referenceOfGlyphs([glyph("A", 0, { artifact: true })], undefined);
    expect(artifact!.artifact).toBe(true);
    const [rotated] = referenceOfGlyphs(
      [glyph("R", 0, { matrix: { a: 0, b: 10, c: -10, d: 0, e: 0, f: 0 } })],
      undefined,
    );
    expect(rotated!.rotated).toBe(true);
  });
});
