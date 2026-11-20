/**
 * A note call or an ordinal suffix that follows a word is a `sup` run of its own (19/10/2026, corpus 008 p5 « Money2. », 057 p4 « 0.5th »).
 * The rule needs the smaller body AND the raised baseline; either alone leaves the text as it was.
 */
import { describe, expect, it } from "vitest";
import { linesFromGroups } from "./pdf-lines";

const at = (text: string, x: number, width: number, y: number, fontSize: number) => ({ text, x, y, width, fontSize });

describe("linesFromGroups — raised calls", () => {
  it("smaller and raised 0.3 em after a word: its own sup run", () => {
    const [line] = linesFromGroups([[at("Money", 10, 30, 100, 10), at("2", 40, 3, 103, 6), at(".", 43, 3, 100, 10)]]);
    expect(line!.runs.map((r) => [r.text, r.sup === true])).toEqual([
      ["Money", false],
      ["2", true],
      [".", false],
    ]);
    expect(line!.text).toBe("Money2.");
  });

  it("counter-proof: smaller on the baseline, or raised at full size, is no call", () => {
    const small = linesFromGroups([[at("Money", 10, 30, 100, 10), at("2", 40, 3, 100, 6)]])[0]!;
    const raised = linesFromGroups([[at("Money", 10, 30, 100, 10), at("2", 40, 5, 103, 10)]])[0]!;
    expect([small, raised].map((l) => l.runs.some((r) => r.sup === true))).toEqual([false, false]);
  });

  it("🔴 a raised smaller DIGIT that opens the line, ending 0.2 em before its first word, is a note number: a sup run (05/11/2026)", () => {
    // The foot of a Federal Register column (`sd-4133285` p1, 25 numbers): « 7 » at 4.55 pt, raised 1.8 pt, ends
    // 1.2 pt before « Id. » at 7 pt. Until 05/11 a leading raised item was never a call (« nothing to hang on »),
    // and the note read « 7 Id. » with a plain 7 — which no paragraph rule could tell from a line's first word.
    const [line] = linesFromGroups([[at("7", 5, 3, 103, 6), at("Id.", 10, 30, 100, 10)]]);
    expect(line!.runs.map((r) => [r.text, r.sup === true])).toEqual([
      ["7", true],
      [" Id.", false],
    ]);
  });

  it("a raised smaller LETTER that opens the line is not a call (nothing to hang on)", () => {
    const [line] = linesFromGroups([[at("e", 5, 3, 103, 6), at("Money", 10, 30, 100, 10)]]);
    expect(line!.runs.some((r) => r.sup === true)).toBe(false);
  });

  it("a raised smaller digit a whole body before the line is not its number", () => {
    const [line] = linesFromGroups([[at("7", 0, 3, 103, 6), at("Id.", 13, 30, 100, 10)]]);
    expect(line!.runs.some((r) => r.sup === true)).toBe(false);
  });
});
