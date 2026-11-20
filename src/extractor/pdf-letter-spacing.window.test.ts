import { describe, expect, it } from "vitest";

import type { GlyphFragment } from "./glyph-positions";
import { respacedText } from "./pdf-letter-spacing";
import type { PdfTextRun } from "./pdf-source";

// Letter-spacing cuts glyphs by their START (START_WINDOW: from 0.25 em before the run), not by their centre.
const FONT = 20;

const run = (text: string, x: number, width: number): PdfTextRun => ({
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
});

const glyph = (text: string, x: number, width: number, i: number): GlyphFragment => ({
  text,
  x,
  y: 700,
  width,
  height: FONT,
  matrix: { a: FONT, b: 0, c: 0, d: FONT, e: x, f: 700 },
  runId: i,
  isSpace: false,
  paintCount: 1,
  stroked: false,
});

describe("respacedText — the glyph window is anchored on the glyph start", () => {
  it("a first glyph that starts just before the run but whose centre is left of it still belongs to the run", () => {
    // Run starts at x = 100. « L » starts at 98 (inside the 5 pt slack) and is 3 pt wide: centre 99.5 < 100.
    // A centre window would drop it and read « IVRET », which disagrees with the run: the run would be left alone.
    const glyphs = [glyph("L", 98, 3, 0), ...[..."IVRET"].map((c, i) => glyph(c, 117 + i * 17, 12, i + 1))];
    expect(respacedText(run("L I V R E T", 100, 97), glyphs)).toBe("LIVRET");
  });

  it("a glyph that starts in the last 0.1 em of the run belongs to the next run, though its centre is inside", () => {
    // Run spans 100..197; the last 2 pt are the next run's. « X » starts at 195.5 and is 3 pt wide: centre 197 is
    // inside the run. A centre window would take it in and read « LIVRETX », which disagrees: the run would be left alone.
    const glyphs = [...[..."LIVRET"].map((c, i) => glyph(c, 100 + i * 17, 12, i)), glyph("X", 195.5, 3, 6)];
    expect(respacedText(run("L I V R E T", 100, 97), glyphs)).toBe("LIVRET");
  });
});
