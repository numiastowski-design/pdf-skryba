import { describe, expect, it } from "vitest";

import { notesAfterText, type PdfTextRun } from "./pdf-source";

const run = (id: string, y: number, text = "words"): PdfTextRun =>
  ({ markedContentId: id, y, height: 10, text, rotated: false, artifact: false }) as unknown as PdfTextRun;

describe("notesAfterText: a declared note goes after its page's text when it is drawn below it", () => {
  it("moves the note content after the rest, keeping each part's order", () => {
    const runs = [run("a", 700), run("n1", 60), run("b", 680), run("n2", 40)];
    expect(notesAfterText(["a", "n1", "b", "n2"], runs, new Set(["n1", "n2"]))).toEqual(["a", "b", "n1", "n2"]);
  });

  it("🔴 guard: a note drawn level with or above other text keeps the declared order", () => {
    // FAILS WITH: the note moved although the geometry disagrees with the role (a margin note beside the text).
    const runs = [run("a", 700), run("n1", 400), run("b", 300)];
    expect(notesAfterText(["a", "n1", "b"], runs, new Set(["n1"]))).toEqual(["a", "n1", "b"]);
  });

  it("an empty run, an artifact or a rotated run takes no part in the geometry", () => {
    const runs = [
      run("a", 700),
      run("n1", 60),
      { ...run("x", 20), artifact: true } as PdfTextRun,
      run("e", 10, "  "),
      { ...run("r", 5), rotated: true } as PdfTextRun,
    ];
    expect(notesAfterText(["a", "n1", "x"], runs, new Set(["n1"]))).toEqual(["a", "x", "n1"]);
  });

  it("no note: the order is the same array", () => {
    const order = ["a", "b"];
    expect(notesAfterText(order, [run("a", 10), run("b", 5)], new Set())).toBe(order);
  });
});
