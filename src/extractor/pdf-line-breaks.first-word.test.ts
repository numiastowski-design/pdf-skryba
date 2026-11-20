/**
 * Exhaustive audit of 07/10/2026 (F2): the page's first-word width stopped at a LEADING space and gave 0 (« unknown », so the
 * deliberate-break judgement abstained), while the cell reader (`layout/cell-text.ts#firstWordWidthOf`) skips leading blanks —
 * the comments call them the same measure. A line indented with spaces (common under Word) is measured from its first word.
 */
import { describe, expect, it } from "vitest";
import type { GlyphFragment } from "./glyph-positions";
import { firstWordWidthReader } from "./pdf-line-breaks";

const glyph = (text: string, x: number, width: number): GlyphFragment => ({
  text,
  x,
  y: 100,
  width,
  height: 10,
  matrix: { a: 1, b: 0, c: 0, d: 1, e: x, f: 100 },
  runId: 0,
  isSpace: text === " ",
  paintCount: 1,
  stroked: false,
});

describe("firstWordWidthReader — leading spaces", () => {
  it("🔴 a line opening with a space is measured from its first word", () => {
    const read = firstWordWidthReader([
      glyph(" ", 0, 3),
      glyph("H", 3, 5),
      glyph("i", 8, 2),
      glyph(" ", 10, 3),
      glyph("x", 13, 4),
    ]);
    expect(read(100)).toBe(7);
  });

  it("a line with no leading space is unchanged", () => {
    const read = firstWordWidthReader([glyph("H", 3, 5), glyph("i", 8, 2), glyph(" ", 10, 3), glyph("x", 13, 4)]);
    expect(read(100)).toBe(7);
  });
});

// MEASURED (06/11/2026, Alouette bulletin p3, fixture 58 p1, `corpus-local/diag-alouette-premier-mot.ts`): the width read for
// the line « parlementaire » (column 2, x 208) was 27.7 pt — the word « Comme » of column 1 on the same baseline — instead of
// its own 70.3 pt. The deliberate-break question (« would the next word have fit? ») was then answered for the wrong word:
// spare 349.8 − 286.9 − 27.7 = 35 pt ≥ 0.45 em, so the two-line subheading « Un rôle de vigie / parlementaire » split in two
// headings; with its own word, −7 pt: a wrap. The reader takes the line's LEFT edge and measures from there.
describe("firstWordWidthReader — the first word of THIS line, not of the leftmost column at that height", () => {
  it("🔴 glyphs left of the line's own left edge are not its first word", () => {
    const read = firstWordWidthReader([
      glyph("C", 53, 6),
      glyph("o", 59, 5),
      glyph(" ", 64, 3),
      glyph("p", 208, 6),
      glyph("a", 214, 5),
      glyph("r", 219, 4),
      glyph(" ", 223, 3),
      glyph("x", 226, 4),
    ]);
    // Failure value (today): 11, « Co » of the column at x 53.
    expect(read(100, 208)).toBe(15);
  });

  it("without a left edge the reading is unchanged: the leftmost word of the line", () => {
    const read = firstWordWidthReader([glyph("C", 53, 6), glyph("o", 59, 5), glyph(" ", 64, 3), glyph("p", 208, 6)]);
    expect(read(100)).toBe(11);
  });
});
