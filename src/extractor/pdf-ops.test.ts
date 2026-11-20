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

describe("decodeOps — le fnArray numérique de pdf.js → des opérations nommées", () => {
  it("nomme les opérations par leur code", () => {
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

  it("IGNORE un code inconnu plutôt que d'inventer un nom", () => {
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

describe("decodeOps — LA NORMALISATION DES MATRICES, le décodage qui a produit des NaN", () => {
  const six = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };

  it("six nombres à plat", () => {
    expect(decodeOps(list([[12, [1, 2, 3, 4, 5, 6]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("MESURÉ : un objet à clés numériques ENVELOPPÉ dans un tableau", () => {
    // The real shape returned by pdf.js for `setTextMatrix`:
    //   `setTextMatrix -> [{"0":1,"1":0,"2":0,"3":1,"4":0,"5":0}]`
    // `args as number[]` gives `undefined` everywhere there — one of the two causes
    // of the `NaN`s of the first reconstruction (09/09/2026).
    const wrapped = [{ 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 }];
    expect(decodeOps(list([[42, wrapped]]), OPS)[0]).toEqual({ op: "setTextMatrix", args: six });
  });

  it("un Float32Array, enveloppé ou non", () => {
    const f32 = Float32Array.from([1, 2, 3, 4, 5, 6]);
    expect(decodeOps(list([[12, f32]]), OPS)[0]).toEqual({ op: "transform", args: six });
    expect(decodeOps(list([[12, [f32]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("LA LECTURE EST INDEXÉE, JAMAIS FONDÉE SUR `.length`", () => {
    // A `Float32Array` has a length, an object with numeric keys does not,
    // and both shapes are met. We check what we need — six
    // numbers at indices 0 to 5 — not the type of the container. An array of more
    // than six numbers is therefore accepted on its first six.
    expect(decodeOps(list([[12, [1, 2, 3, 4, 5, 6, 7, 8]]]), OPS)[0]).toEqual({ op: "transform", args: six });
  });

  it("LÈVE sur une forme non reconnue, plutôt que de rendre une matrice partielle", () => {
    // Returning wrong coordinates silently is exactly what we refuse
    // everywhere else: a page published on an invented geometry reads
    // without anyone noticing.
    expect(() => decodeOps(list([[12, [1, 2, 3]]]), OPS)).toThrow(/unrecognized argument shape/);
    expect(() => decodeOps(list([[42, "pas une matrice"]]), OPS)).toThrow(/unrecognized argument shape/);
    expect(() => decodeOps(list([[42, [1, 2, 3, 4, 5, null]]]), OPS)).toThrow(/unrecognized argument shape/);
  });

  it("ne touche PAS aux arguments des autres opérations", () => {
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

describe("readPathArg — la forme de `constructPath`, déballage compris", () => {
  it("MESURÉ : les segments sont ENVELOPPÉS dans un tableau à un élément", () => {
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

  it("MESURÉ : un chemin SANS segments (`args[1][0] === null`) rend zéro sous-chemin, il ne lève pas", () => {
    // 14 of the 34 `constructPath` of the corpus are in this case. The old code never
    // saw it: it decoded after filtering on the painting
    // operation. It is the oracle that found it, by stumbling on it.
    expect(readPathArg([20, [null], undefined])).toEqual({ paintOp: 20, subpaths: [] });
  });

  it("accepte aussi la forme NON enveloppée, au cas où elle change (jamais observée : 34 sur 34 sont enveloppées)", () => {
    expect(readPathArg([20, [0, 10, 20], undefined]).subpaths).toEqual([[{ x: 10, y: 20 }]]);
  });

  it("`minMax` est optionnel", () => {
    expect(readPathArg([22, [[0, 10, 20]]]).minMax).toBeUndefined();
    expect(readPathArg([22, [[0, 10, 20]], null]).minMax).toBeUndefined();
  });

  it("MESURÉ : `minMax` est un Float32Array, et le jeter fait disparaître les pastilles", () => {
    // 20 out of 20 of those that carry one. `Array.isArray` returns `false` there — and
    // the detection of colour discs rests ENTIRELY on this box:
    // a disc is a path with curves that `decodePathSubpaths` refuses, so
    // `minMax` is the only trace of its footprint.
    const mm = Float32Array.from([10, 20, 30, 40]);
    expect(readPathArg([22, [[0, 1, 2]], mm]).minMax).toEqual([10, 20, 30, 40]);
  });

  it("LÈVE sur une forme non reconnue plutôt que de rendre un chemin vide", () => {
    // An empty path would be indistinguishable from a path without segments: the
    // detector would conclude "no border" instead of "I do not know".
    expect(() => readPathArg("pas un chemin")).toThrow(/unrecognized argument shape/);
    expect(() => readPathArg([])).toThrow(/unrecognized argument shape/);
  });

  it("NOMME l'opération de peinture — elle vit dans le même espace de codes qu'`OPS`", () => {
    // `args[0]` of `constructPath` is literally `OPS.stroke`, `OPS.fill`…
    // (checked on 04/09/2026 by printing the two side by side). Naming it here
    // saves the consumer from needing `OPS` to classify a painting,
    // and it is what lets `walkPage` become pure.
    expect(readPathArg([20, [[0, 1, 2]]], OPS).paint).toBe("stroke");
    expect(readPathArg([22, [[0, 1, 2]]], OPS).paint).toBe("fill");
  });

  it("un code de peinture INCONNU rend `undefined`, pas une erreur", () => {
    // A clipping path alone is never painted: it has no painting
    // name, and that is not an anomaly.
    expect(readPathArg([777, [[0, 1, 2]]], OPS).paint).toBeUndefined();
    // Without a code table, no name — the shape stays readable all the same.
    expect(readPathArg([20, [[0, 1, 2]]]).paint).toBeUndefined();
    expect(readPathArg([20, [[0, 1, 2]]]).paintOp).toBe(20);
  });

  it("`decodeOps` normalise `constructPath` comme il normalise les matrices", () => {
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
  it("décode un rectangle moveTo/lineTo…/closePath", () => {
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

  it("décode une simple ligne à deux points", () => {
    expect(decodePathSubpaths([0, 50, 500, 1, 250, 500])).toEqual([
      [
        { x: 50, y: 500 },
        { x: 250, y: 500 },
      ],
    ]);
  });

  it("un closePath sur un sous-chemin réduit à son point de départ n'ajoute rien", () => {
    expect(decodePathSubpaths([0, 10, 20, 4])).toEqual([[{ x: 10, y: 20 }]]);
  });

  it("S'ARRÊTE sur un code inconnu plutôt que de lire une courbe comme une ligne", () => {
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
