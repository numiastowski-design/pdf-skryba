import { describe, expect, it } from "vitest";

import { groupIntoReseatedLines } from "./baseline-lines";

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

const run = (text: string, x: number, y: number, size: number, width = size * 0.5 * text.length): Run => ({
  text,
  x,
  y,
  width,
  size,
});
const linesOf = (runs: Run[]): string[] =>
  groupIntoReseatedLines(runs, (r) => r.size).map((line) => line.map((r) => r.text).join("|"));

describe("a lone list marker joins the text that starts to its right", () => {
  it("joins when its baseline is 2 pt lower (fixture 50: 12 pt marker, 10 pt text)", () => {
    expect(linesOf([run("•", 78, 659.89, 12), run("Prepare the draft", 96, 661.89, 10)])).toEqual([
      "•|Prepare the draft",
    ]);
  });

  it("joins when its baseline is 2 pt higher", () => {
    expect(linesOf([run("•", 78, 663.89, 12), run("Prepare the draft", 96, 661.89, 10)])).toEqual([
      "•|Prepare the draft",
    ]);
  });

  it("does not join text a full line lower (12 pt)", () => {
    expect(linesOf([run("•", 78, 649.89, 12), run("Prepare the draft", 96, 661.89, 10)])).toEqual([
      "Prepare the draft",
      "•",
    ]);
  });

  it("does not join a text line that lies to its left", () => {
    expect(linesOf([run("Prepare the draft", 10, 661.89, 10), run("•", 200, 659.89, 12)])).toEqual([
      "Prepare the draft",
      "•",
    ]);
  });

  it("does not join text that starts far to its right", () => {
    expect(linesOf([run("•", 78, 659.89, 12), run("Prepare the draft", 400, 661.89, 10)])).toEqual([
      "Prepare the draft",
      "•",
    ]);
  });

  it("does not move a short run that is not a marker", () => {
    expect(linesOf([run("a", 78, 659.89, 12), run("Prepare the draft", 96, 661.89, 10)])).toEqual([
      "Prepare the draft",
      "a",
    ]);
  });

  it("does not join a marker to another marker", () => {
    expect(linesOf([run("•", 78, 659.89, 12), run("•", 96, 661.89, 10)])).toEqual(["•", "•"]);
  });
});
