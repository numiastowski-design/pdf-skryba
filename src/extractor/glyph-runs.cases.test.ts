/**
 * Cases found by measuring the runs against pdf.js on the fixtures (14/10/2026), each pinned by a hand-written operator list.
 */

import { describe, expect, it } from "vitest";

import type { NamedOp } from "./glyph-positions";
import { glyphRuns } from "./glyph-runs";

const at = (x: number, y: number): NamedOp => ({ op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: y } });
const font: NamedOp = { op: "setFont", args: ["f1", 10] };

describe("glyphRuns — cases measured on the fixtures", () => {
  it("a glyph pdf.js flags `isSpace` (character code 32) but whose text is a letter is not blank: « » » of fixture 31, page 1", () => {
    // A subset font may give code 32 to any glyph; `isSpace` follows the code, the text follows the glyph.
    const guillemet = { unicode: "»", width: 500, isSpace: true };
    const runs = glyphRuns([
      at(100, 700),
      font,
      { op: "showText", args: [[{ unicode: "0", width: 500, isSpace: false }, guillemet]] },
    ]);
    expect(runs.map((r) => r.text)).toEqual(["0»"]);
    const alone = glyphRuns([at(100, 700), font, { op: "showText", args: [[guillemet]] }]);
    expect(alone.map((r) => r.text)).toEqual(["»"]);
  });

  // A space is 2.5 pt here (a quarter of the 10 pt em), a letter 5 pt.
  const glyph = (c: string): Record<string, unknown> => ({
    unicode: c,
    width: c === " " ? 250 : 500,
    isSpace: c === " ",
  });
  const show = (text: string): NamedOp => ({ op: "showText", args: [[...text].map(glyph)] });

  it("a run neither starts nor ends with a blank, as pdf.js's cycles: its origin is the first letter, its width ends with the last (the blank is spacing, not text)", () => {
    const [run] = glyphRuns([at(100, 700), font, show(" ab ")]);
    expect(run!.text).toBe("ab");
    expect(run!.x).toBe(102.5);
    expect(run!.width).toBeCloseTo(10, 6);
  });

  it("two blank glyphs between two words make ONE space", () => {
    expect(glyphRuns([at(100, 700), font, show("a  b")]).map((r) => r.text)).toEqual(["a b"]);
  });

  it("a blank glyph and a wide gap together make one space, not two", () => {
    const runs = glyphRuns([at(100, 700), font, show("a "), at(120, 700), show("b")]);
    // The cut keeps its blank as a run of its own (14/10/2026), one space and not two.
    expect(runs.map((r) => r.text)).toEqual(["a", " ", "b"]);
    const near = glyphRuns([at(100, 700), font, show("a "), at(108, 700), show("b")]);
    expect(near.map((r) => r.text)).toEqual(["a b"]);
  });

  it("blank glyphs do not hide a wide gap: two words padded with spaces stay two runs (safedocs 0000523, page 2: « …002283 ··········· 3. BIR… »)", () => {
    // « ab » ends at 110; ten blanks of 2.5 pt put « cd » at 135, 2.5 em from the last letter.
    const runs = glyphRuns([at(100, 700), font, show("ab" + " ".repeat(10) + "cd")]);
    expect(runs.map((r) => r.text)).toEqual(["ab", " ", "cd"]);
  });

  it("a few blanks under 0.6 em stay inside the run as one space (3 blanks = 0.75 em close it, 2 do not)", () => {
    expect(glyphRuns([at(100, 700), font, show("ab  cd")]).map((r) => r.text)).toEqual(["ab cd"]);
    expect(glyphRuns([at(100, 700), font, show("ab   cd")]).map((r) => r.text)).toEqual(["ab", " ", "cd"]);
  });
});
