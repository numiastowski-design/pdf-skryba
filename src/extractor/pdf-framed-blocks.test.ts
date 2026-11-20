/** Characterisation (06/11/2026, written before the cost rewrite of `splitFramed`, same answers after it): membership of a
 *  line in a frame, innermost frame wins, one group per frame, a border that holds every line frames nothing. */
import { describe, expect, it } from "vitest";

import { splitFramed } from "./pdf-framed-blocks";
import type { PdfTextRun } from "./pdf-source";

const run = (text: string, x: number, y: number, width = 40): PdfTextRun =>
  ({ text, x, y, width, height: 10, fontSize: 10 }) as unknown as PdfTextRun;
const box = (left: number, bottom: number, right: number, top: number) => ({ left, bottom, right, top }) as never;
const texts = (lines: readonly (readonly PdfTextRun[])[]): string[] => lines.map((l) => l.map((i) => i.text).join(" "));

describe("splitFramed", () => {
  const lines = [
    [run("a", 10, 700)],
    [run("b", 110, 690)],
    [run("c", 10, 680)],
    [run("d", 110, 670)],
    [run("free", 300, 600)],
  ];

  it("gathers one group per frame, at the place of its first line, the other lines staying in the flow", () => {
    const left = box(0, 670, 90, 710);
    const right = box(100, 660, 200, 700);
    const { groups, rest } = splitFramed(lines, [right, left]);
    expect(groups.map((g) => [g.at, texts(g.lines)])).toEqual([
      [0, ["a", "c"]],
      [1, ["b", "d"]],
    ]);
    expect(rest.map((r) => [r.at, texts([r.line])[0]])).toEqual([[4, "free"]]);
  });

  it("the innermost frame wins when a box is drawn inside a box", () => {
    const outer = box(0, 660, 210, 710);
    const inner = box(100, 660, 200, 700);
    const { groups } = splitFramed(lines, [outer, inner]);
    expect(groups.find((g) => g.frame === inner)!.lines.map((l) => l[0]!.text)).toEqual(["b", "d"]);
  });

  it("a rectangle that holds every inked line frames nothing, nor does one that holds none", () => {
    const border = box(0, 590, 400, 710);
    const elsewhere = box(500, 0, 600, 100);
    expect(splitFramed(lines, [border, elsewhere]).groups).toEqual([]);
  });

  it("a line half out of a frame stays in the flow", () => {
    const frame = box(0, 670, 90, 710);
    const { groups, rest } = splitFramed([[run("in", 10, 700), run("out", 150, 700)]], [frame]);
    expect(groups).toEqual([]);
    expect(rest).toHaveLength(1);
  });
});
