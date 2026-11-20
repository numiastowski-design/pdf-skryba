/** Defects of the glyph builder found by the high review: unbounded save stack, ignored form XObject boundaries. */
import { describe, expect, it } from "vitest";

import { GRAPHICS_STATE_MAX_DEPTH, buildGlyphFragments, type NamedOp } from "./glyph-positions";

const glyph = (unicode: string, width = 500): Record<string, unknown> => ({
  originalCharCode: unicode.charCodeAt(0),
  fontChar: unicode,
  unicode,
  accent: null,
  width,
  isSpace: false,
  isInFont: true,
});
const translate = (e: number, f: number): NamedOp => ({ op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e, f } });
const save: NamedOp = { op: "save", args: null };
const restore: NamedOp = { op: "restore", args: null };
const begin = (matrix: ArrayLike<number> | null): NamedOp => ({ op: "paintFormXObjectBegin", args: [matrix, null] });
const end: NamedOp = { op: "paintFormXObjectEnd", args: null };

/** One glyph "A" drawn at the origin of the current matrix. */
const drawA: NamedOp[] = [
  { op: "beginText", args: null },
  { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
  { op: "setFont", args: ["f1", 10] },
  { op: "showText", args: [[glyph("A")]] },
  { op: "endText", args: null },
];
const positions = (ops: NamedOp[]) => buildGlyphFragments(ops).map((f) => [f.x, f.y]);

describe("D5 - the save stack is bounded, the surplus stays paired", () => {
  it("exports GRAPHICS_STATE_MAX_DEPTH = 256", () => {
    expect(GRAPHICS_STATE_MAX_DEPTH).toBe(256);
  });

  it("control: a normal q / cm / Q restores the matrix", () => {
    expect(positions([save, translate(100, 200), ...drawA, restore, ...drawA])).toEqual([
      [100, 200],
      [0, 0],
    ]);
  });

  it("100_000 q then 100_000 Q leaves the state equal to the initial one", () => {
    const ops = [
      ...Array.from({ length: 100_000 }, () => save),
      translate(7, 9),
      ...Array.from({ length: 100_000 }, () => restore),
      ...drawA,
    ];
    expect(positions(ops)).toEqual([[0, 0]]);
  });

  it("past the cap no more state is pushed: the first surplus Q pops nothing", () => {
    const depth = 256 + 44; // literal: the export is pinned by its own test
    const nested = Array.from({ length: depth }, () => [save, translate(1, 0)]).flat();
    const surplus = Array.from({ length: 44 }, () => restore);
    // Unbounded stack: 44 Q undo 44 translations, x = depth - 44. Bounded + counted: they pair with the unpushed q, x = depth.
    expect(positions([...nested, ...surplus, ...drawA])).toEqual([[depth, 0]]);
    const rest = Array.from({ length: depth - 44 }, () => restore);
    expect(positions([...nested, ...surplus, ...rest, ...drawA])).toEqual([[0, 0]]);
  });
});

// The cap also bounds nested FORM XObjects (`GraphicsStateStack.form`, audit 07/10): until then only the `q` branch was held by a test.
describe("past the cap a nested form XObject is not isolated, and its end pairs with the unpushed form", () => {
  it("the first surplus end of a form pops nothing", () => {
    const depth = 256 + 44; // literal, as above
    const nested = Array.from({ length: depth }, () => [begin(null), translate(1, 0)]).flat();
    const surplus = Array.from({ length: 44 }, () => end);
    // Unbounded stack: 44 ends undo 44 translations, x = depth - 44. Bounded + counted: they pair with the unpushed forms, x = depth.
    expect(positions([...nested, ...surplus, ...drawA])).toEqual([[depth, 0]]);
    const rest = Array.from({ length: depth - 44 }, () => end);
    expect(positions([...nested, ...surplus, ...rest, ...drawA])).toEqual([[0, 0]]);
  });
});

describe("D3 - paintFormXObjectBegin / End isolate the graphics state of the form", () => {
  it("a cm set inside the form without q/Q does not leak onto the rest of the page", () => {
    const without = positions(drawA);
    expect(positions([begin(null), translate(50, 700), ...drawA, end, ...drawA])).toEqual([[50, 700], ...without]);
  });

  it("the form /Matrix shifts the content inside it by (10, 20) only", () => {
    expect(positions([begin([1, 0, 0, 1, 10, 20]), ...drawA, end, ...drawA])).toEqual([
      [10, 20],
      [0, 0],
    ]);
  });

  it("an unnormalised /Matrix (Float32Array) is composed too", () => {
    expect(positions([begin(new Float32Array([1, 0, 0, 1, 10, 20])), ...drawA, end, ...drawA])).toEqual([
      [10, 20],
      [0, 0],
    ]);
  });

  it("the form /Matrix composes with the current matrix and is undone at End", () => {
    expect(positions([translate(100, 100), begin([1, 0, 0, 1, 10, 20]), ...drawA, end, ...drawA])).toEqual([
      [110, 120],
      [100, 100],
    ]);
  });

  it("a font size set inside the form does not survive it", () => {
    const frags = buildGlyphFragments([
      { op: "setFont", args: ["f1", 10] },
      begin(null),
      { op: "setFont", args: ["f1", 40] },
      end,
      ...drawA.filter((o) => o.op !== "setFont"),
    ]);
    expect(frags[0]!.width).toBeCloseTo(5, 6); // 500/1000 * 10
  });

  it("a stray End at the base level does not throw nor pop the initial state", () => {
    expect(positions([end, translate(5, 5), ...drawA])).toEqual([[5, 5]]);
  });
});
