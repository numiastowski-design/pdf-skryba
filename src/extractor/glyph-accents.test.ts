import { describe, expect, it } from "vitest";

import { CENTRE_EM, composeAccents, RAISE_EM } from "./glyph-accents";
import type { GlyphFragment } from "./glyph-positions";
import { IDENTITY_MATRIX } from "../layout/geometry";

/**
 * An accent and its letter are one character. TeX paints the accent, then sets the letter under it; NFKC then splits
 * an acute, a diaeresis, a cedilla or a macron into a space plus a combining mark, which cut the word in two.
 *
 * A geometric guard, not the sequence of glyphs alone: an accent that stands between two letters without covering
 * either must not be composed, or the reader invents a letter. An accent set on its letter has its centre on the
 * letter's; one that separates two letters sits a third of an em away.
 */

const EM = 10;

const glyph = (text: string, over: Partial<GlyphFragment> = {}): GlyphFragment => ({
  text,
  x: 0,
  y: 100,
  width: EM * 0.5,
  height: EM,
  matrix: IDENTITY_MATRIX,
  runId: 1,
  isSpace: false,
  paintCount: 1,
  stroked: false,
  font: "F15",
  ...over,
});

/** An accent and the letter it sits on: same centre, the accent raised. `raise` and `shift` are in em. */
const onTopOf = (
  accent: string,
  letter: string,
  { raise = 0, shift = 0 }: { raise?: number; shift?: number } = {},
): GlyphFragment[] => [
  glyph(accent, { x: 0, y: 100 + raise * EM, width: EM * 0.5 }),
  glyph(letter, { x: shift * EM, y: 100, width: EM * 0.5 }),
];

const textsOf = (glyphs: readonly GlyphFragment[]): string[] => glyphs.map((g) => g.text);

describe("composeAccents", () => {
  it("compose l'accent et la lettre qu'il surmonte en UN caractère", () => {
    expect(textsOf(composeAccents(onTopOf("´", "e")))).toEqual(["é"]);
    expect(textsOf(composeAccents(onTopOf("`", "a")))).toEqual(["à"]);
    expect(textsOf(composeAccents(onTopOf("ˆ", "o")))).toEqual(["ô"]);
    expect(textsOf(composeAccents(onTopOf("¨", "u")))).toEqual(["ü"]);
    expect(textsOf(composeAccents(onTopOf("¸", "c")))).toEqual(["ç"]);
  });

  it("garde la position et la taille de la LETTRE, pas de l'accent", () => {
    const [composed] = composeAccents(onTopOf("´", "e", { raise: 0.3 }));
    expect(composed).toMatchObject({ text: "é", y: 100, height: EM });
  });

  // The guard against an invented letter: both offsets were measured on real documents.
  it("🔴 NE compose PAS un accent qui ne recouvre pas la lettre : « nature´s » reste « nature », « ´ », « s »", () => {
    expect(textsOf(composeAccents(onTopOf("´", "s", { shift: 0.335 })))).toEqual(["´", "s"]);
    expect(textsOf(composeAccents(onTopOf("´", "a", { shift: 0.403 })))).toEqual(["´", "a"]);
  });

  it("compose jusqu'à CENTRE_EM d'écart, et pas au-delà", () => {
    expect(textsOf(composeAccents(onTopOf("´", "e", { shift: CENTRE_EM * 0.9 })))).toEqual(["é"]);
    expect(textsOf(composeAccents(onTopOf("´", "e", { shift: CENTRE_EM * 1.1 })))).toEqual(["´", "e"]);
  });

  // TeX raises the accent of a capital by 0.276 em, past the baseline-change threshold of `glyph-runs.ts`.
  it("compose une MAJUSCULE accentuée, dont l'accent est relevé plus haut (PRÉPARATION)", () => {
    expect(textsOf(composeAccents(onTopOf("´", "E", { raise: 0.276 })))).toEqual(["É"]);
    expect(textsOf(composeAccents(onTopOf("´", "E", { raise: RAISE_EM * 1.1 })))).toEqual(["´", "E"]);
  });

  // A circumflex on a dotless i composes only once the i gets its dot back: NFC alone leaves two code points.
  it("rend son point au i sans point avant de composer (connaˆıtre)", () => {
    expect(textsOf(composeAccents(onTopOf("ˆ", "ı")))).toEqual(["î"]);
  });

  // Not a cedilla on an e: that pair has a precomposed form (U+0229), so the test would pass for the wrong reason.
  it("s'abstient quand la combinaison n'a pas de forme précomposée : les deux dessins restent", () => {
    expect(textsOf(composeAccents(onTopOf("´", "q")))).toEqual(["´", "q"]);
    expect(textsOf(composeAccents(onTopOf("ˇ", "b")))).toEqual(["ˇ", "b"]);
    // The counter-proof: the same accent composes on a letter that has a precomposed form.
    expect(textsOf(composeAccents(onTopOf("ˇ", "c")))).toEqual(["č"]);
  });

  it("s'abstient hors d'une lettre, d'une même police, d'une même taille ou d'un texte droit", () => {
    expect(textsOf(composeAccents(onTopOf("´", "3")))).toEqual(["´", "3"]);
    expect(textsOf(composeAccents([glyph("´"), glyph("e", { font: "F58" })]))).toEqual(["´", "e"]);
    expect(textsOf(composeAccents([glyph("´"), glyph("e", { height: EM * 2 })]))).toEqual(["´", "e"]);
    const turned = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    expect(textsOf(composeAccents([glyph("´", { matrix: turned }), glyph("e", { matrix: turned })]))).toEqual([
      "´",
      "e",
    ]);
  });

  it("laisse un accent SEUL en fin de page, et ne touche pas à du texte ordinaire", () => {
    expect(textsOf(composeAccents([glyph("´")]))).toEqual(["´"]);
    expect(textsOf(composeAccents([glyph("P"), glyph("r"), glyph("o")]))).toEqual(["P", "r", "o"]);
  });

  it("compose plusieurs fois dans la même suite, sans manger la lettre suivante", () => {
    const glyphs = [...onTopOf("´", "e"), glyph("t", { x: 20 }), ...onTopOf("´", "e"), glyph("s", { x: 40 })];
    expect(textsOf(composeAccents(glyphs))).toEqual(["é", "t", "é", "s"]);
  });
});
