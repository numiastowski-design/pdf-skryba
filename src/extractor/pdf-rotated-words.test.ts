/** Vertical text read along its own direction (corpus 282 p9, 19/10/2026): the rule on glyphs built by hand. */
import { describe, expect, it } from "vitest";
import type { GlyphFragment } from "./glyph-positions";
import { gatherRotatedWords } from "./pdf-rotated-words";

const glyph = (text: string, x: number, y: number, up: boolean | undefined, runId = 1): GlyphFragment => ({
  text,
  x,
  y,
  width: 5,
  height: 9,
  matrix:
    up === undefined
      ? { a: 9, b: 0, c: 0, d: 9, e: x, f: y }
      : up
        ? { a: 0, b: 9, c: -9, d: 0, e: x, f: y }
        : { a: 0, b: -9, c: 9, d: 0, e: x, f: y },
  runId,
  isSpace: false,
  paintCount: 1,
  stroked: false,
});
/** A word turned a quarter: letter k lies 5 pt further along the axis (up: higher; down: lower). */
const turned = (word: string, x: number, up: boolean): GlyphFragment[] =>
  [...word].map((ch, k) => glyph(ch, x, 100 + (up ? 5 * k : -5 * k), up));
const texts = (gs: readonly GlyphFragment[]): string[] => gs.map((g) => g.text);

describe("gatherRotatedWords", () => {
  it("a word turned upward (paint order = reading order) is one fragment, not letters in reverse", () => {
    expect(texts(gatherRotatedWords(turned("Verfug", 400, true)))).toEqual(["Verfug"]);
  });

  it("a word turned downward too, and two columns stay two words", () => {
    expect(texts(gatherRotatedWords([...turned("Ab", 400, false), ...turned("Cd", 424, false)]))).toEqual(["Ab", "Cd"]);
  });

  it("counter-proof: horizontal glyphs and a lone rotated glyph are untouched (same objects, same array)", () => {
    const flat = [glyph("a", 10, 100, undefined), glyph("b", 15, 100, undefined), glyph("c", 20, 100, undefined)];
    expect(gatherRotatedWords(flat)).toBe(flat);
    const lone = [...flat, glyph("2", 400, 100, true)];
    expect(gatherRotatedWords(lone)).toBe(lone);
  });

  it("horizontal glyphs around a rotated word keep their places", () => {
    const out = gatherRotatedWords([
      glyph("x", 10, 100, undefined),
      ...turned("Ab", 400, true),
      glyph("y", 20, 100, undefined),
    ]);
    expect(texts(out)).toEqual(["x", "Ab", "y"]);
  });

  it("cost: four times the rotated words read each glyph as often as before, not four times as often", () => {
    // The guarantee: the work grows with the glyphs near each run, never with runs × glyphs (every rotated glyph tested against every run).
    // Held by COUNTING, not by timing: every property read of an input glyph goes through a proxy, and the count per glyph is compared at
    // two sizes. A count is the same on a loaded machine; the duration ratio this test asserted before was not (13.4 against a bound of 9,
    // beside other suites, on linear code: its timed runs lasted 3 to 20 ms, less than one preemption). Linear work keeps the reads per
    // glyph constant; runs × glyphs multiplies them by the factor.
    const SMALL_WORDS = 250;
    const FACTOR = 4;
    // Starting value to calibrate. Measured with this table: 1.00 for the grid (47.5 then 47.7 reads per glyph), 3.93 for the loop over
    // every rotated glyph (1 538 then 6 038).
    const MAX_GROWTH_OF_READS_PER_GLYPH = 1.5;
    const readsPerGlyph = (words: number): number => {
      let reads = 0;
      const counted: ProxyHandler<GlyphFragment> = {
        get: (target, key, receiver) => {
          reads++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      };
      const glyphs = Array.from({ length: words }, (_, w) =>
        turned("Abc", 100 + 24 * (w % 40), true).map(
          (g) => new Proxy({ ...g, y: g.y + 40 * Math.floor(w / 40) }, counted),
        ),
      ).flat();
      expect(gatherRotatedWords(glyphs)).toHaveLength(words);
      return reads / glyphs.length;
    };
    const small = readsPerGlyph(SMALL_WORDS);
    const large = readsPerGlyph(SMALL_WORDS * FACTOR);
    expect(
      large / small,
      `reads per glyph: ${small.toFixed(1)} at ${SMALL_WORDS} words, ${large.toFixed(1)} at ${SMALL_WORDS * FACTOR}`,
    ).toBeLessThan(MAX_GROWTH_OF_READS_PER_GLYPH);
  });

  it("🔴 a word turned half a turn (upside down, paint order = reading order) is read as one word, not letter by letter from the left", () => {
    // A half turn has b = c = 0 (a < 0, d < 0): `isRotated` ignores it, the glyphs stay single and a cell reads them left to right, so the
    // word comes out reversed (« guf reV »). Red today: the glyphs come back untouched, one fragment per letter.
    const half = (word: string): GlyphFragment[] =>
      [...word].map((ch, k) => ({
        ...glyph(ch, 400 - 5 * k, 100, undefined),
        matrix: { a: -9, b: 0, c: 0, d: -9, e: 400 - 5 * k, f: 100 },
      }));
    expect(texts(gatherRotatedWords(half("Verfug")))).toEqual(["Verfug"]);
  });
});

// The reader's half of the synthetic-italic test (19/10/2026): a sheared text matrix (a > 0, b = 0, c != 0) is NOT a
// turned text. What the published page reads for such a sentence is held where the page is rendered.
describe("a synthetic italic (sheared matrix) keeps its place in the reading order", () => {
  it("table path, unit: sheared glyphs (a > 0, b = 0, c = 0.2) are not rotated words: `gatherRotatedWords` returns the same array", () => {
    // ⚠️ Same marker correction as for the two page cases: announced red, green in fact (31/10/2026).
    const sheared = (text: string, x: number): GlyphFragment => ({
      text,
      x,
      y: 100,
      width: 5,
      height: 9,
      matrix: { a: 9, b: 0, c: 1.8, d: 9, e: x, f: 100 },
      runId: 1,
      isSpace: false,
      paintCount: 1,
      stroked: false,
    });
    const glyphs = [...["c", "o", "u", "r"].map((ch, k) => sheared(ch, 10 + 5 * k))];
    expect(gatherRotatedWords(glyphs)).toBe(glyphs);
  });
});
