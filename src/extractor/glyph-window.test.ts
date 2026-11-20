import { describe, expect, it } from "vitest";

import { CENTRE_WINDOW, glyphsOfRun, sortedByBaseline, START_WINDOW } from "./glyph-window";
import type { GlyphFragment } from "./glyph-positions";

const FONT = 20;
const RUN = { x: 100, y: 700, width: 100, fontSize: FONT };

const glyph = (text: string, x: number, width = 10, y = 700): GlyphFragment => ({
  text,
  x,
  y,
  width,
  height: FONT,
  matrix: { a: FONT, b: 0, c: 0, d: FONT, e: x, f: y },
  runId: 0,
  isSpace: text === " ",
  paintCount: 1,
  stroked: false,
});

const textOf = (gs: readonly GlyphFragment[]): string => gs.map((g) => g.text).join("");

describe("glyphsOfRun — one baseline selection, two windows", () => {
  it("keeps the glyphs on the baseline (|dy| < 0.25 em), left to right", () => {
    const glyphs = [
      glyph("b", 120),
      glyph("a", 110),
      glyph("x", 130, 10, 704),
      glyph("far", 140, 10, 720),
      glyph("edge", 150, 10, 695),
    ];
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline(glyphs), CENTRE_WINDOW))).toBe("abx");
  });

  it("a glyph starting in the run's last 0.1 em: the start window leaves it to the next run, the centre window takes it", () => {
    // Starts at 199 (run ends at 200, 0.1 em = 2) with a centre at 199.25: inside for a centre, the next run's for a start.
    const wide = glyph("w", 199, 0.5);
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([wide]), START_WINDOW))).toBe("");
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([wide]), CENTRE_WINDOW))).toBe("w");
  });

  it("a glyph starting just before the run: the start window takes it up to 0.25 em, the centre window only by its centre", () => {
    const before = glyph("p", 96, 10); // start 4 pt before the run (< 5 pt = 0.25 em), centre at 101
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([before]), START_WINDOW))).toBe("p");
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([before]), CENTRE_WINDOW))).toBe("p");
    const narrow = glyph("n", 96, 6); // centre at 99, outside
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([narrow]), START_WINDOW))).toBe("n");
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([narrow]), CENTRE_WINDOW))).toBe("");
  });

  it("the centre window keeps the run's right edge, the start window excludes it", () => {
    const atEdge = glyph("e", 200, 0); // centre exactly on the right edge
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([atEdge]), CENTRE_WINDOW))).toBe("e");
    expect(textOf(glyphsOfRun(RUN, sortedByBaseline([atEdge]), START_WINDOW))).toBe("");
  });
});
