/**
 * Glyphs outside the page's view box (CropBox within MediaBox) make no run: the filter pdf.js applied in `getTextContent`
 * (worker `compareWithLastPosition`), which the runs built from our glyphs must keep (09/10/2026, choice B:
 * what the PDF hides is not taken). Tested through the published page in `pdf-invisible-text.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { NamedOp } from "./glyph-positions";
import { glyphRuns } from "./glyph-runs";

const glyph = (unicode: string): Record<string, unknown> => ({ unicode, width: 500, isSpace: unicode === " " });
const page = (x: number, y: number, text: string): NamedOp[] => [
  { op: "beginText", args: null },
  { op: "setFont", args: ["f1", 10] },
  { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: y } },
  { op: "showText", args: [[...text].map(glyph)] },
  { op: "endText", args: null },
];

describe("glyphRuns — the view box", () => {
  const view = [0, 0, 300, 792] as const;

  it("a word wholly outside the view makes no run", () => {
    expect(glyphRuns(page(400, 600, "outside"), { view }).map((r) => r.text)).toEqual([]);
  });

  it("a word that crosses the edge keeps its glyphs inside (each 5 pt wide, edge at 300)", () => {
    // « straddle » starts at 280: glyphs at 280, 285, ..., 300 are in (a glyph at x = 300 is in: x > 300 is out).
    expect(glyphRuns(page(280, 600, "straddle"), { view }).map((r) => r.text)).toEqual(["strad"]);
  });

  it("without a view nothing is cut", () => {
    expect(glyphRuns(page(400, 600, "outside")).map((r) => r.text)).toEqual(["outside"]);
  });
});
