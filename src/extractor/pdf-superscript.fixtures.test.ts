/**
 * Superscripts and subscripts (defect H, 22/09/2026): five French and English corpus PDFs raise a character above its
 * line, and before the fix each of them published that character SOMEWHERE ELSE. The rule itself is pure and its
 * abstentions are pinned below without opening a document; the subscripts are read on fixture 48.
 * NOT here: the superscript specimens, documents the package may not carry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";
import { groupItemsIntoLines } from "./pdf-lines";

const here = dirname(fileURLToPath(import.meta.url));
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", name)));

/** One host line, « ab » then « cd », 10 pt, baseline 100, from x = 0 to x = 22. */
const host = [
  { text: "ab", x: 0, y: 100, width: 10, fontSize: 10 },
  { text: "cd", x: 12, y: 100, width: 10, fontSize: 10 },
];
const linesOf = (raised: { text: string; x: number; y: number; width: number; fontSize: number }) =>
  groupItemsIntoLines([raised, ...host]).map((g) => g.map((i) => i.text).join(""));

describe("the rule abstains unless BOTH readings agree", () => {
  it("takes a raised, smaller character inside the line: 0.3 em up, 0.65 of the size", () => {
    expect(linesOf({ text: "e", x: 10, y: 103, width: 2, fontSize: 6.5 })).toEqual(["abecd"]);
  });

  it("leaves a raised character of the SAME size alone — a second line, not an exponent", () => {
    expect(linesOf({ text: "e", x: 10, y: 103, width: 2, fontSize: 10 })).toEqual(["e", "abcd"]);
  });

  it("leaves a smaller character raised a whole body alone — the line above, not an exponent", () => {
    expect(linesOf({ text: "e", x: 10, y: 109, width: 2, fontSize: 6.5 })).toEqual(["e", "abcd"]);
  });

  it("leaves a smaller character to the LEFT of the line alone — it follows nothing", () => {
    expect(linesOf({ text: "e", x: -5, y: 103, width: 2, fontSize: 6.5 })).toEqual(["e", "abcd"]);
  });

  it("leaves a smaller character past the RIGHT end of the line alone — another column", () => {
    expect(linesOf({ text: "e", x: 25, y: 103, width: 2, fontSize: 6.5 })).toEqual(["e", "abcd"]);
  });
});

describe("a subscript is published inside its own word (fixture 48, issue defaut-file n° 33, 13/10/2026)", () => {
  it("fixture 48 page 5 reads « CO2 », « N2 » and « H2O », and publishes no « 222 » of subscripts gathered elsewhere", async () => {
    const page5 = (
      await extractPdf(bytesOf("48-Programme-Terminale-Spe-Word2010.pdf"), "fr", { pageLimit: Infinity })
    ).pages[4]!.map((b) => JSON.stringify(b)).join("\n"); // a two-column table: its text is in the cells
    expect(page5).toContain("CO2");
    expect(page5).toContain("N2");
    expect(page5).toContain("H2O");
    expect(page5).not.toMatch(/\b222\b/);
  }, 120_000);

  /** The shape measured on fixture 48: body 11.04 pt, the « 2 » of « CO2 » at 6.96 pt, its baseline 1.6 pt lower. */
  const run = (text: string, x: number, y: number, fontSize: number) => ({
    text,
    x,
    y,
    width: text.length * fontSize * 0.5,
    fontSize,
    hasEOL: false,
  });

  it("the rule: a lowered, smaller item joins the line above it", () => {
    const lines = groupItemsIntoLines([
      run("et CO", 200, 330.1, 11.04),
      run("2", 242.4, 328.5, 6.96),
      run(" et H", 246.3, 330.1, 11.04),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.map((r) => r.text).join("")).toBe("et CO2 et H");
  });

  it("the next line of body text, a full line lower, is not a subscript", () => {
    const lines = groupItemsIntoLines([run("une ligne", 70, 330.1, 11.04), run("la suivante", 70, 317.5, 11.04)]);
    expect(lines).toHaveLength(2);
  });

  it("a small caption line just under a line but outside its span stays apart", () => {
    const lines = groupItemsIntoLines([run("texte", 70, 330.1, 11.04), run("note", 400, 328.5, 6.96)]);
    expect(lines).toHaveLength(2);
  });
});
