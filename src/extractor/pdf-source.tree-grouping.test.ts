import { describe, expect, it } from "vitest";

import { hoistAgainstTree, type PdfTextRun } from "./pdf-source";

/** A run in content-stream order (its index in the array), its box (y = bottom, y + height = top), its marked-content id. */
const run = (
  id: string | undefined,
  y: number,
  opts: { x?: number; width?: number; height?: number; text?: string } = {},
): PdfTextRun =>
  ({
    markedContentId: id,
    x: opts.x ?? 72,
    y,
    width: opts.width ?? 400,
    height: opts.height ?? 11,
    text: opts.text ?? "words",
    rotated: false,
    artifact: false,
  }) as unknown as PdfTextRun;

describe("hoistAgainstTree: the content stream and the geometry agree against the structure tree (26/10/2026)", () => {
  it("🔴 docx-reel 10 p9: Word declares its numbered list before the heading that sits above it; the heading comes back first", () => {
    // FAILS WITH: ["l1", "l2", "h", "t"] — the heading « SECTION 2: KEY DATES » published after « 2.1. », its heading rank lost.
    // Stream: h (top of the page), l1 (2.1), t (table), l2 (2.2, under the table). Tree: L(l1, l2), H1(h), Table(t).
    const runs = [run("h", 731), run("l1", 713), run("t", 500), run("l2", 269)];
    expect(hoistAgainstTree(["l1", "l2", "h", "t"], runs)).toEqual(["h", "l1", "t", "l2"]);
  });

  it("🔴 the move is step by step: an id passes only predecessors painted after it AND drawn under it (never one the stream puts first)", () => {
    // FAILS WITH: ["m", "X", "A", "B"] — m jumped X, that the tree AND the stream put before it.
    const runs = [run("X", 800), run("m", 700), run("A", 600), run("B", 500)];
    expect(hoistAgainstTree(["A", "X", "B", "m"], runs)).toEqual(["X", "m", "A", "B"]);
  });

  it("🔴 the order is its own fixed point: a chain moves whole", () => {
    // FAILS WITH: ["m1", "m2", "X"] — one pass leaves m2 after m1, which is painted after it and drawn under it.
    const runs = [run("m2", 700), run("m1", 600), run("X", 500)];
    expect(hoistAgainstTree(["X", "m1", "m2"], runs)).toEqual(["m2", "m1", "X"]);
  });

  it("🔴 an id with no geometry (an empty paragraph, a figure with no text) is transparent: passed, never blocking", () => {
    // FAILS WITH: ["l1", "e", "f", "h"] — an empty paragraph between the list and the heading stopped the move.
    const runs = [run("h", 731), run("l1", 713), run("e", 700, { text: "  " })];
    expect(hoistAgainstTree(["l1", "e", "f", "h"], runs)).toEqual(["h", "l1", "e", "f"]);
  });

  it("🔴 docx-reel 10 p9: Word tags an item's number « 2.1. » apart (x 72-90, its text at 108): the ids that follow each other in the tree on one line form one cluster, which moves whole", () => {
    // FAILS WITH: ["l1n", "h", "l1", "t"] — the centred heading (x 230-366) does not overlap the narrow number, which stopped the move.
    const runs = [
      run("h", 731, { x: 230, width: 136 }),
      run("l1n", 713, { x: 72, width: 18, text: "2.1." }),
      run("l1", 713, { x: 108, width: 376 }),
      run("t", 500),
    ];
    expect(hoistAgainstTree(["l1n", "l1", "h", "t"], runs)).toEqual(["h", "l1n", "l1", "t"]);
  });

  it("🔴 docx-reel 10 p9: the end of a line tagged apart (« ) in the », x 472-523) moves with the rest of its line", () => {
    // FAILS WITH: ["l2", "u", "tail", "h"] — the narrow tail of the line did not overlap the centred heading and stopped the move.
    const runs = [
      run("h", 731, { x: 230, width: 136 }),
      run("l2", 269, { x: 90, width: 433 }),
      run("u", 238, { x: 111, width: 361 }),
      run("tail", 238, { x: 472, width: 51 }),
    ];
    expect(hoistAgainstTree(["l2", "u", "tail", "h"], runs)).toEqual(["h", "l2", "u", "tail"]);
  });

  it("🔴 guard: ids that follow each other in the tree on DIFFERENT lines are not one cluster", () => {
    // FAILS WITH: ["h", "n", "l1", "l2"] — « 3. » (y 713) and l2 (y 690) joined across lines, and the cluster inherited l2's overlap.
    const runs = [
      run("h", 731, { x: 230, width: 136 }),
      run("n", 713, { x: 72, width: 18, text: "3." }),
      run("l1", 713, { x: 108, width: 376 }),
      run("l2", 690, { x: 108, width: 376 }),
    ];
    expect(hoistAgainstTree(["n", "l2", "l1", "h"], runs)).toEqual(["n", "h", "l1", "l2"]);
  });

  it("🔴 guard: a two-column page whose column 2 top is painted first — column 1, numbered items included, keeps its place", () => {
    // FAILS WITH: ["c2", "c1n", "c1a", "c1b"] — the top of column 2 jumped column 1.
    const runs = [
      run("c2", 700, { x: 320, width: 200 }),
      run("c1n", 650, { x: 72, width: 18, text: "1." }),
      run("c1a", 650, { x: 108, width: 182 }),
      run("c1b", 600, { x: 72, width: 218 }),
    ];
    expect(hoistAgainstTree(["c1n", "c1a", "c1b", "c2"], runs)).toEqual(["c1n", "c1a", "c1b", "c2"]);
  });

  it("🔴 docx-reel 08 p5: an id without geometry (the tab Word tags between a bullet and its text) stays glued to the id before it in the tree", () => {
    // FAILS WITH: ["b", "t2", "tab", "n"] — the tab left behind its bullet: its late rank cut the line between « o » and « private schools ».
    // Stream: b (« o »), tab, t2 (the item's text), n (a footnote at the foot of the page). Tree: the note declared after its call, before t2.
    const runs = [
      run("b", 419, { x: 103, width: 7, text: "o" }),
      run("tab", 419, { x: 110, width: 11, text: " " }),
      run("t2", 419, { x: 121, width: 73 }),
      run("n", 76, { x: 49, width: 480 }),
    ];
    expect(hoistAgainstTree(["b", "tab", "n", "t2"], runs)).toEqual(["b", "tab", "t2", "n"]);
  });

  it("🔴 an id without geometry follows the id before it in the tree when that one moves", () => {
    // FAILS WITH: ["l", "b", "n", "tab"] — the tab stayed behind the note its bullet passed.
    const runs = [
      run("l", 700),
      run("b", 600, { x: 103, width: 7, text: "o" }),
      run("tab", 600, { x: 110, width: 11, text: " " }),
      run("n", 76, { x: 49, width: 480 }),
    ];
    expect(hoistAgainstTree(["l", "n", "b", "tab"], runs)).toEqual(["l", "b", "tab", "n"]);
  });

  it("🔴 guard: columns do not overlap — the tree keeps reading column 1 then column 2", () => {
    // FAILS WITH: ["c2", "c1a", "c1b"] — the top of column 2, painted first, jumped column 1.
    const runs = [
      run("c2", 700, { x: 320, width: 200 }),
      run("c1a", 650, { x: 72, width: 200 }),
      run("c1b", 300, { x: 72, width: 200 }),
    ];
    expect(hoistAgainstTree(["c1a", "c1b", "c2"], runs)).toEqual(["c1a", "c1b", "c2"]);
  });

  it("🔴 guard: on one baseline, a 14 pt title and 9 pt text are not one under the other", () => {
    // FAILS WITH: ["t", "s"] — middles 2 pt apart read as « under ».
    // The two overlap horizontally, so only the vertical test decides here.
    const runs = [run("t", 700, { height: 14, width: 100 }), run("s", 700, { x: 120, height: 9, width: 100 })];
    expect(hoistAgainstTree(["s", "t"], runs)).toEqual(["s", "t"]);
  });

  it("🔴 guard: every run of the passed id must be painted after every run of the moving id", () => {
    // FAILS WITH: ["m", "p"] — p has a run painted before m's.
    const runs = [run("p", 650), run("m", 700), run("p", 600)];
    expect(hoistAgainstTree(["p", "m"], runs)).toEqual(["p", "m"]);
  });

  it("rotated runs and artifacts take no part in the geometry", () => {
    const runs = [
      run("h", 731),
      run("l1", 713),
      { ...run("l1", 900), rotated: true } as PdfTextRun,
      { ...run("l1", 950), artifact: true } as PdfTextRun,
    ];
    expect(hoistAgainstTree(["l1", "h"], runs)).toEqual(["h", "l1"]);
  });

  it("an id named twice in the tree is read at its first place (the rule of declaredRanks)", () => {
    const runs = [run("a", 700), run("b", 600)];
    expect(hoistAgainstTree(["a", "b", "a"], runs)).toEqual(["a", "b"]);
  });

  it("nothing to move: the same array", () => {
    const order = ["a", "b"];
    expect(hoistAgainstTree(order, [run("a", 700), run("b", 600)])).toBe(order);
  });
});

describe("hoistAgainstTree on a hostile page: a budget, then the tree as is (review of 26/10/2026)", () => {
  it("🔴 50 000 ids declared in the reverse of the stream and the geometry: the move is abandoned, the tree order comes back", () => {
    // FAILS WITH: the fully reversed order — every cluster climbed past all the others, n²/2 comparisons (4.6 s measured at 50 000).
    const n = 50_000;
    const order = Array.from({ length: n }, (_, i) => `id${i}`);
    // Painted from the last id to the first, each one drawn above the one before it in the tree, each on its own line.
    const runs = Array.from({ length: n }, (_, k) => run(`id${n - 1 - k}`, 20 * (n - 1 - k), { height: 10 }));
    expect(hoistAgainstTree(order, runs)).toEqual(order);
  });
});
