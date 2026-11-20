/**
 * Exhaustive audit of 07/10/2026 (P2-F1): four « same visual line » rules. The region order (`visualLines`) keyed on the
 * ROUNDED baseline with a neighbour at ±1 — inclusive, and chained through rounding — while the page's lines
 * (`pdf-lines.ts#groupItemsIntoLines`) anchor on a line's first item, strictly under SAME_LINE_TOLERANCE. Two items 1 pt apart
 * were one line for the region order and two for the paragraphs. One rule for both.
 */
import { describe, expect, it } from "vitest";
import { groupItemsIntoLines } from "./pdf-lines";
import { visualLines } from "./pdf-region-order";
import type { PdfTextRun } from "./pdf-source";

const run = (text: string, x: number, y: number): PdfTextRun => ({
  text,
  x,
  y,
  width: 10,
  height: 10,
  fontSize: 10,
  matrix: { a: 10, b: 0, c: 0, d: 10, e: x, f: y },
  fontId: undefined,
  weight: "regular" as PdfTextRun["weight"],
  rotated: false,
  hasEOL: false,
  dir: "ltr",
  markedContentId: undefined,
  artifact: false,
});

const shape = (lines: readonly PdfTextRun[][]): string[][] =>
  lines.map((l) => l.map((r) => r.text).sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

describe("visualLines — the same line rule as the page's paragraphs", () => {
  it.each([
    ["1 pt apart", [run("a", 0, 10), run("b", 20, 11)]],
    ["a chain through rounding", [run("a", 0, 10), run("b", 20, 10.6), run("c", 40, 11.4)]],
  ])("🔴 %s: the region order and the paragraphs agree", (_name, items) => {
    expect(shape(visualLines(items))).toEqual(shape(groupItemsIntoLines(items)));
  });
});

describe("groupByBaseline — the boundary of the one rule", () => {
  it("exactly SAME_LINE_TOLERANCE apart: two lines; just under: one", async () => {
    const { groupByBaseline, SAME_LINE_TOLERANCE } = await import("../layout/baseline-lines");
    expect(groupByBaseline([run("a", 0, 10), run("b", 20, 10 + SAME_LINE_TOLERANCE)])).toHaveLength(2);
    expect(groupByBaseline([run("a", 0, 10), run("b", 20, 10 + SAME_LINE_TOLERANCE - 0.01)])).toHaveLength(1);
  });
});
