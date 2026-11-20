/**
 * Hostile inputs for regexes that were quadratic (sonarjs/super-linear-regex triage, 14/10/2026). Each case asserts
 * the RESULT and a loose time bound; the time measured before the fix is given per case.
 * The cases of the PDF reader's own functions: until 19/11/2026 they sat with the publisher's app's cases, in one file.
 * Run: npx vitest run --project=pdf-serial packages/reader/src/regex-linear-time.test.ts
 */
import { describe, expect, it } from "vitest";

import type { GlyphFragment } from "./extractor/glyph-positions";
import { joinCellLines } from "./extractor/pdf-cell-paragraphs";
import { respacedText } from "./extractor/pdf-letter-spacing";
import { textToParagraphs } from "./extractor/pdf-scanned";
import type { PdfTextRun } from "./extractor/pdf-source";
import { recomposeCellText } from "./layout/cell-text";
import type { CellLine } from "./layout/cell-text";
import type { Fragment } from "./layout/geometry";

/**
 * Starting value to calibrate (10/11/2026). Two populations:
 *  - healthy code: most cases under 7 ms at DOUBLE size; `recomposeCellText` 180 to 765 ms on one input, and 790.8 ms
 *    in a red CI run on unchanged code;
 *  - the defect: 4 100 to 6 700 ms, noted per case on 14/10/2026 and not re-measured.
 * 500 ms sat under the healthy worst case. This bound WAS raised: 2 000 ms is about 2.5 x the worst healthy time and 2 x
 * under the fastest defect. The margin is thin: external load tripling 790 ms would reach 2 370 ms.
 * Tried and dropped the same day: a ratio between sizes n and 2n. Most cases stay under measurement noise, the first
 * call is cold and the second warm, and a ratio only means something when what is doubled dominates the measure.
 */
const LIMIT_MS = 2_000;
const glyph = (text: string, x: number): GlyphFragment => ({
  text,
  x,
  y: 700,
  width: 12,
  height: 20,
  matrix: { a: 20, b: 0, c: 0, d: 20, e: x, f: 700 },
  runId: 0,
  isSpace: false,
  paintCount: 1,
  stroked: false,
});
const run = (text: string, x: number, width: number): PdfTextRun => ({
  text,
  x,
  y: 700,
  width,
  height: 20,
  fontSize: 20,
  matrix: { a: 20, b: 0, c: 0, d: 20, e: x, f: 700 },
  fontId: undefined,
  weight: "normal",
  rotated: false,
  hasEOL: false,
  dir: "ltr",
  markedContentId: undefined,
  artifact: false,
});
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

describe("linear-time regexes on hostile input", () => {
  it("OCR paragraphs: a long whitespace run with no newline, and newline joins", () => {
    // before the fix: 4.9 to 5.5 s
    const { value, ms } = timed(() => textToParagraphs(`a${" ".repeat(60_000)}b`));
    expect(value).toHaveLength(1);
    expect(
      textToParagraphs("one \n two\n  \n three\n\nfour").map(
        (b) => (b as { inlines: { text: string }[] }).inlines[0]!.text,
      ),
    ).toEqual(["one two three", "four"]);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("cell join: a long inner whitespace run in the previous line", () => {
    // before the fix: 4.6 to 5.1 s
    const mk = (text: string, middle: number): CellLine => ({
      text,
      depth: 0,
      middle,
      endMiddle: middle,
      left: 0,
      right: 100,
      widest: 100,
      fontSize: 10,
      startFontSize: 10,
      firstWordWidth: 20,
    });
    const { value, ms } = timed(() => joinCellLines([mk(`a${" ".repeat(60_000)}b`, 90), mk("c", 80)], 100));
    expect(value).toHaveLength(1);
    expect(value[0]!.text.endsWith("b c")).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("cell recomposition: a wrapped line holding a long inner whitespace run", () => {
    // before the fix: 4.8 s at 60k (0.8 s at 20k)
    const n = 60_000;
    const glyphs = (text: string, y: number): Fragment[] =>
      [...text].map((ch, i) => ({ text: ch, x: i * 0.005, y, width: 0.005, height: 8 }));
    const cell = [...glyphs(`a${" ".repeat(n)}b`, 700), ...glyphs("c", 690)];
    const { value, ms } = timed(() => recomposeCellText(cell, { left: 0, right: n * 0.005 + 0.02 }));
    expect(value.map((l) => l.text.endsWith("b c") || l.text)).toEqual([true]);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("letter-spaced run: a long inner whitespace run", () => {
    // before the fix: 4.1 to 4.4 s
    const text = `P a g e${" ".repeat(60_000)}x`;
    const glyphs = [..."Page"].map((t, i) => glyph(t, 100 + i * 17)).concat(glyph("x", 400));
    const { value, ms } = timed(() => respacedText(run(text, 100, 400), glyphs));
    expect(value).toBe("Pagex");
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
