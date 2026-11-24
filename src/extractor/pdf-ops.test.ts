/**
 * The ARGUMENT SHAPES inherited from pdf.js (removed on 01/11/2026; our reader reproduces them), pinned here and nowhere else.
 *
 * This file is the counterpart of `pdf-ops.ts`: it carries the REAL
 * encodings measured on documents, so that the day one of them
 * changes, it is THIS test that fails — not coordinates
 * silently wrong in a published page.
 *
 * They used to live as test data of `glyph-positions`, mixed with the
 * reconstruction logic. Moved on 14/09/2026: a single
 * place knows how pdf.js encoded its arguments.
 */

import { describe, expect, it } from "vitest";

import { decodeOps, decodePathSubpaths, HiddenLayerStack, readPathArg, type PdfOp } from "./pdf-ops";

/** A minimal `OPS`, written by hand: this test does not load pdf.js. */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  setTextMatrix: 42,
  moveText: 40,
  setFont: 37,
  showText: 44,
  constructPath: 91,
  stroke: 20,
  fill: 22,
  eoFill: 23,
};

const list = (pairs: [number, unknown][]): { fnArray: number[]; argsArray: unknown[] } => ({
  fnArray: pairs.map(([code]) => code),
  argsArray: pairs.map(([, args]) => args),
});

describe("decodeOps — the numeric fnArray of pdf.js → named operations", () => {
  it("names the operations by their code", () => {
    expect(
      decodeOps(
        list([
          [10, null],
          [11, null],
        ]),
        OPS,
      ),
    ).toEqual<PdfOp[]>([
      { op: "save", args: null },
      { op: "restore", args: null },
    ]);
  });

  it("IGNORES an unknown code rather than inventing a name", () => {
    // The stream contains operators that do not concern us (colours,
    // images). Naming them "unknown" would make `buildGlyphFragments` throw, which
    // only throws on what LOOKS like text.
    expect(
      decodeOps(
        list([
          [999, [1]],
          [10, null],
        ]),
        OPS,
      ),
    ).toEqual<PdfOp[]>([{ op: "save", args: null }]);
  });
});

describe("decodeOps — THE NORMALISATION OF MATRICES, the decoding that produced NaNs", () => {
  const six = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };

  it("six flat numbers", () => {
    expect(decodeOps(list([[12, [1, 2, 3, 4, 5, 6]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("MEASURED: an object with numeric keys WRAPPED in an array", () => {
    // The real shape pdf.js returned for `setTextMatrix`:
    //   `setTextMatrix -> [{"0":1,"1":0,"2":0,"3":1,"4":0,"5":0}]`
    // `args as number[]` gives `undefined` everywhere there — one of the two causes
    // of the `NaN`s of the first reconstruction (09/09/2026).
    const wrapped = [{ 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 }];
    expect(decodeOps(list([[42, wrapped]]), OPS)[0]).toEqual({ op: "setTextMatrix", args: six });
  });

  it("a Float32Array, wrapped or not", () => {
    const f32 = Float32Array.from([1, 2, 3, 4, 5, 6]);
    expect(decodeOps(list([[12, f32]]), OPS)[0]).toEqual({ op: "transform", args: six });
    expect(decodeOps(list([[12, [f32]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("THE READING IS INDEXED, NEVER BASED ON `.length`", () => {
    // A `Float32Array` has a length, an object with numeric keys does not,
    // and both shapes are met. We check what we need — six
    // numbers at indices 0 to 5 — not the type of the container. An array of more
    // than six numbers is therefore accepted on its first six.
    expect(decodeOps(list([[12, [1, 2, 3, 4, 5, 6, 7, 8]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("THROWS on an unrecognised shape, rather than returning a partial matrix", () => {
    // Returning wrong coordinates silently is exactly what we refuse
    // everywhere else: a page published on an invented geometry reads
    // without anyone noticing.
    expect(() => decodeOps(list([[12, [1, 2, 3]]]), OPS)).toThrow(/unrecognized argument shape/);
    expect(() => decodeOps(list([[42, "pas une matrice"]]), OPS)).toThrow(/unrecognized argument shape/);
    expect(() => decodeOps(list([[42, [1, 2, 3, 4, 5, null]]]), OPS)).toThrow(/unrecognized argument shape/);
  });

  it("does NOT touch the arguments of other operations", () => {
    expect(
      decodeOps(
        list([
          [40, [763, -90]],
          [37, ["g_d0_f1", 75]],
        ]),
        OPS,
      ),
    ).toEqual<PdfOp[]>([
      { op: "moveText", args: [763, -90] },
      { op: "setFont", args: ["g_d0_f1", 75] },
    ]);
  });
});

describe("readPathArg — the shape of `constructPath`, unwrapping included", () => {
  it("MEASURED: the segments are WRAPPED in a one-element array", () => {
    // `args = [paintOp, [packedSegments], minMax]` — `args[1][0]`, never
    // `args[1]`. Established empirically on 04/09/2026, undocumented upstream.
    // This unwrapping lived as a comment at two call sites and was tested
    // nowhere: it is exactly the knowledge that a version bump breaks
    // without anything saying so.
    const packed = [0, 50, 500, 1, 250, 500];
    expect(readPathArg([20, [packed], [50, 500, 250, 500]])).toEqual({
      paintOp: 20,
      subpaths: [
        [
          { x: 50, y: 500 },
          { x: 250, y: 500 },
        ],
      ],
      minMax: [50, 500, 250, 500],
    });
  });

  it("MEASURED: a path WITHOUT segments (`args[1][0] === null`) returns zero sub-paths, it does not throw", () => {
    // 14 of the 34 `constructPath` of the corpus are in this case. The old code never
    // saw it: it decoded after filtering on the painting
    // operation. It is the oracle that found it, by stumbling on it.
    expect(readPathArg([20, [null], undefined])).toEqual({ paintOp: 20, subpaths: [] });
  });

  it("also accepts the UNWRAPPED shape, in case it changes (never observed: 34 out of 34 are wrapped)", () => {
    expect(readPathArg([20, [0, 10, 20], undefined]).subpaths).toEqual([[{ x: 10, y: 20 }]]);
  });

  it("`minMax` is optional", () => {
    expect(readPathArg([22, [[0, 10, 20]]]).minMax).toBeUndefined();
    expect(readPathArg([22, [[0, 10, 20]], null]).minMax).toBeUndefined();
  });

  it("MEASURED: `minMax` is a Float32Array, and dropping it makes the colour discs disappear", () => {
    // 20 out of 20 of those that carry one. `Array.isArray` returns `false` there — and
    // the detection of colour discs rests ENTIRELY on this box:
    // a disc is a path with curves that `decodePathSubpaths` refuses, so
    // `minMax` is the only trace of its footprint.
    const mm = Float32Array.from([10, 20, 30, 40]);
    expect(readPathArg([22, [[0, 1, 2]], mm]).minMax).toEqual([10, 20, 30, 40]);
  });

  it("THROWS on an unrecognised shape rather than returning an empty path", () => {
    // An empty path would be indistinguishable from a path without segments: the
    // detector would conclude "no border" instead of "I do not know".
    expect(() => readPathArg("pas un chemin")).toThrow(/unrecognized argument shape/);
    expect(() => readPathArg([])).toThrow(/unrecognized argument shape/);
  });

  it("NAMES the painting operation — it lives in the same code space as `OPS`", () => {
    // `args[0]` of `constructPath` is literally `OPS.stroke`, `OPS.fill`…
    // (checked on 04/09/2026 by printing the two side by side). Naming it here
    // saves the consumer from needing `OPS` to classify a painting,
    // and it is what lets `walkPage` become pure.
    expect(readPathArg([20, [[0, 1, 2]]], OPS).paint).toBe("stroke");
    expect(readPathArg([22, [[0, 1, 2]]], OPS).paint).toBe("fill");
  });

  it("an UNKNOWN painting code returns `undefined`, not an error", () => {
    // A clipping path alone is never painted: it has no painting
    // name, and that is not an anomaly.
    expect(readPathArg([777, [[0, 1, 2]]], OPS).paint).toBeUndefined();
    // Without a code table, no name — the shape stays readable all the same.
    expect(readPathArg([20, [[0, 1, 2]]]).paint).toBeUndefined();
    expect(readPathArg([20, [[0, 1, 2]]]).paintOp).toBe(20);
  });

  it("`decodeOps` normalises `constructPath` as it normalises matrices", () => {
    const decoded = decodeOps({ fnArray: [91], argsArray: [[20, [[0, 1, 2]], undefined]] }, OPS)[0];
    expect(decoded).toEqual({
      op: "constructPath",
      args: { paintOp: 20, paint: "stroke", subpaths: [[{ x: 1, y: 2 }]] },
    });
  });
});

/**
 * THE ENCODING OF THE SEGMENTS — `0` = moveTo (2 coordinates), `1` = lineTo (2),
 * `4` = closePath (none). Checked empirically on 04/09/2026 against the real
 * operator list of the installed version, **undocumented upstream**.
 *
 * These cases come from `pdf-table-detector.test.ts` (14/09/2026): they
 * tested a pdf.js format decoder from a file that tests a
 * detector, and the function itself lived in `layout/geometry.ts`,
 * that is, on the NEUTRAL side of the tree.
 */
describe("decodePathSubpaths", () => {
  it("decodes a moveTo/lineTo…/closePath rectangle", () => {
    const packed = [0, 0, 0, 1, 0, 100, 1, 200, 100, 1, 200, 0, 4];
    expect(decodePathSubpaths(packed)).toEqual([
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
  });

  it("decodes a simple two-point line", () => {
    expect(decodePathSubpaths([0, 50, 500, 1, 250, 500])).toEqual([
      [
        { x: 50, y: 500 },
        { x: 250, y: 500 },
      ],
    ]);
  });

  it("a closePath on a sub-path reduced to its starting point adds nothing", () => {
    expect(decodePathSubpaths([0, 10, 20, 4])).toEqual([[{ x: 10, y: 20 }]]);
  });

  it("STOPS on an unknown code rather than reading a curve as a line", () => {
    // A straight-line table border is what the detector looks for;
    // a curve is never one. Abandoning THIS path is a documented
    // limit, not a silently wrong answer.
    expect(decodePathSubpaths([0, 0, 0, 99, 1, 2, 3, 4, 5, 6])).toEqual([[{ x: 0, y: 0 }]]);
  });
});

describe("HiddenLayerStack", () => {
  const off = () => false;
  const on = () => true;
  it("counts only hidden optional-content sections, nested with plain marked content", () => {
    const s = new HiddenLayerStack();
    expect(s.hidden).toBe(false);
    s.enter("beginMarkedContent", ["Span"], off);
    expect(s.hidden).toBe(false);
    s.enter("beginMarkedContentProps", ["OC", "g1"], off);
    expect(s.hidden).toBe(true);
    s.enter("beginMarkedContent", ["Span"], off);
    s.leave();
    expect(s.hidden).toBe(true);
    s.leave();
    expect(s.hidden).toBe(false);
    s.leave();
    expect(s.hidden).toBe(false);
  });
  it("ignores a surplus EMC, null args, an unreadable group and an absent verdict", () => {
    const s = new HiddenLayerStack();
    s.leave();
    s.enter("beginMarkedContentProps", null, off);
    s.enter("beginMarkedContentProps", ["OC", null], off);
    s.enter("beginMarkedContentProps", ["OC", "g"], undefined);
    s.enter("beginMarkedContentProps", ["OC", "g"], on);
    s.enter("beginMarkedContent", ["OC", "g"], off);
    expect(s.hidden).toBe(false);
  });
});
