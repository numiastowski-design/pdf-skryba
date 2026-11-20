/** Poppler's duplicate suppression on glyphs built by hand (corpus 132 p2, 19/10/2026). */
import { describe, expect, it } from "vitest";
import { dropDoubleDraws } from "./glyph-double-draw";
import type { GlyphFragment } from "./glyph-positions";

const glyph = (text: string, x: number, y: number, size = 10): GlyphFragment => ({
  text,
  x,
  y,
  width: 5,
  height: size,
  matrix: { a: size, b: 0, c: 0, d: size, e: x, f: y },
  runId: 1,
  isSpace: false,
  paintCount: 1,
  stroked: false,
});
const word = (s: string, x: number, y: number, size = 10): GlyphFragment[] =>
  [...s].map((ch, k) => glyph(ch, x + 6 * k, y, size));
const text = (gs: readonly GlyphFragment[]): string => gs.map((g) => g.text).join("");

describe("dropDoubleDraws", () => {
  it("a word drawn again 0.05 em across and 0.01 em along is kept once", () => {
    expect(text(dropDoubleDraws([...word("Street", 10, 100), ...word("Street", 10.1, 100.5)]))).toBe("Street");
  });

  it("🔴 the second drawing 0.23 to 0.5 em across is the same defect: kept once (corpus 132 p2, 23/10/2026)", () => {
    // The pair at y 457.27 / 459.55 (9.96 pt) was kept on 19/10 as « two boxes »; the .docx truth holds each label once, xpdf prints
    // « SSuuiittee » (the two overlap). FAILS WITH: "ClickClick".
    expect(text(dropDoubleDraws([...word("Click", 203, 457.27, 9.96), ...word("Click", 203, 459.55, 9.96)]))).toBe(
      "Click",
    );
    // 0.45 em: past the ±0.3 em the lookup used to scan, still a double (Fable's review).
    expect(text(dropDoubleDraws([...word("City", 10, 100), ...word("City", 10, 104.5)]))).toBe("City");
  });

  it("counter-proofs: 0.8 em across (the tightest legible leading), 0.12 em along, another size, another character are all kept", () => {
    const apart = [...word("Click", 10, 100), ...word("Click", 10, 108)];
    expect(text(dropDoubleDraws(apart))).toBe("ClickClick");
    const along = [glyph("a", 10, 100), glyph("a", 11.2, 100)];
    expect(dropDoubleDraws(along)).toHaveLength(2);
    const size = [glyph("a", 10, 100, 10), glyph("a", 10, 100.2, 12)];
    expect(dropDoubleDraws(size)).toHaveLength(2);
    const other = [glyph("a", 10, 100), glyph("o", 10.1, 100.2)];
    expect(dropDoubleDraws(other)).toHaveLength(2);
  });

  it("🔴 two sizes « the same » within 0.1 % but filed apart (9.994 / 10 pt) are still one glyph drawn twice (Fable, 23/10/2026)", () => {
    // The grid filed glyphs by size rounded to 0.01 pt while « same size » tolerates 0.1 %: 9.994 and 10 met the rule but were never compared.
    // FAILS WITH: "StreetStreet".
    expect(text(dropDoubleDraws([...word("Street", 10, 100, 10), ...word("Street", 10.1, 100.5, 9.994)]))).toBe(
      "Street",
    );
    // At a large ordinate too, where a grid scaled by each glyph's own size puts the two copies in cells several indices apart.
    expect(text(dropDoubleDraws([...word("Street", 500, 790, 10), ...word("Street", 500.1, 790.5, 9.994)]))).toBe(
      "Street",
    );
  });

  it("the same array comes back when nothing is doubled", () => {
    const g = word("ab", 10, 100);
    expect(dropDoubleDraws(g)).toBe(g);
  });
  it("🔴 a glyph of an absurd size (1e16 pt) ends: never compared (Fable's review of b8aa99d5, 23/10/2026)", () => {
    // `bucket++` no longer changes a bucket ≥ 2^53: the lookup never returned. FAILS WITH: the test timing out.
    const huge = [glyph("a", 10, 100, 1e16), glyph("a", 10, 100.5, 1e16)];
    expect(dropDoubleDraws(huge)).toHaveLength(2);
  }, 2_000);

  it("🔴 thousands of tiny glyphs of distinct sizes in one cell stay linear (Fable's review of b8aa99d5, 23/10/2026)", () => {
    // 150 positions on a 0.01 pt grid inside one cell, sizes 0.001 + k·4e-6 pt (never within the 1e-3 size rule): one cell's list grew
    // without bound, 40 000 glyphs took 2.8 s and doubled ×4.5 per doubling. FAILS WITH: the test timing out.
    const tiny: GlyphFragment[] = [];
    for (let i = 0; i < 80_000; i++) {
      const p = i % 150;
      tiny.push(glyph("a", 100 + (p % 5) * 0.01, 300 + Math.floor(p / 5) * 0.01, 0.001 + Math.floor(i / 150) * 4e-6));
    }
    expect(dropDoubleDraws(tiny)).toHaveLength(80_000);
  }, 10_000);
});
