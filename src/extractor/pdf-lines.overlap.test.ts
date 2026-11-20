/**
 * Two texts drawn on top of each other on one baseline are two words, not one (16/10/2026, safedocs 47-GrandSoissons in tab mode: the footer
 * « PR0090-PR0068 V3.33 page 2/21 » at x 28 (90 pt wide) and « Contrat de prêt n° 138624… » at x 34, both 6 pt: published « …page 2/21Contrat »,
 * 60 invented words on 15 pages; the check's own reading separates them because the first run ends its line).
 */
import { describe, expect, it } from "vitest";
import { linesFromGroups } from "./pdf-lines";

const item = (text: string, x: number, width: number, fontSize = 6) => ({ text, x, y: 32, width, fontSize });

describe("linesFromGroups — items that overlap on one baseline", () => {
  it("a second item starting well inside the first (more than one em) is separated by a space", () => {
    const [line] = linesFromGroups([
      [item("PR0090-PR0068 V3.33 page 2/21", 28, 90), item("Contrat de prêt n° 138624", 34, 140)],
    ]);
    expect(line!.text).toBe("PR0090-PR0068 V3.33 page 2/21 Contrat de prêt n° 138624");
  });

  it("a kerning overlap (a fraction of an em) stays glued: « AV » and « To » style pairs", () => {
    const [line] = linesFromGroups([[item("A", 10, 6, 10), item("V", 15.5, 6, 10)]]);
    expect(line!.text).toBe("AV");
  });

  it("items that touch, as before: no space", () => {
    const [line] = linesFromGroups([[item("Inter", 10, 20, 10), item("net", 30, 15, 10)]]);
    expect(line!.text).toBe("Internet");
  });
});
