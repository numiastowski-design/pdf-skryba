/**
 * OVERPAINTING — and it is NOT an exception to conservation.
 *
 * **A glyph is identified by its character AND its position.** Two marks at the
 * same point are not two characters: they are **one mark painted twice**.
 * The conservation property holds entirely by this definition,
 * and there is nothing to frame or argue.
 *
 * The wording matters, and it is deliberate. Presented as a
 * "narrow exception", someone would one day find it and widen it —
 * *since the principle is already breached*. Presented as the DEFINITION of what
 * a glyph is, it opens nothing.
 *
 * Practical consequence: the merge is **not restricted** to a
 * particular context. Two strictly co-located glyphs are a painting duplicate
 * everywhere. Measured on real documents — overpainting exists
 * only on the header line (0.6 % to 1.7 % of glyphs, all at a single
 * ordinate per page) — so restricting would protect from nothing and would add
 * a condition that would need explaining.
 *
 * **It is the STRICT condition that protects**: same character, same position within
 * the floating-point tolerance. A real case that would violate it — two different
 * characters at the same point, or the same character at distinct points —
 * is not merged and comes out as is.
 */

import { describe, expect, it } from "vitest";

import { buildGlyphFragments, type NamedOp } from "./glyph-positions";

const glyph = (unicode: string, width = 500): Record<string, unknown> => ({
  originalCharCode: unicode.charCodeAt(0),
  fontChar: unicode,
  unicode,
  accent: null,
  width,
  isSpace: false,
  isInFont: true,
});

/** Matrix ALREADY UNPACKED: since 14/09/2026, `decodeOps` returns an
 *  ordinary `Matrix2D`. The four raw encodings that pdf.js emitted (removed since) are pinned
 *  in `pdf-ops.test.ts`, the only place in the repository where they are written. */
const identityTextMatrix: NamedOp = { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };

/** Paints `text` at abscissa `x0`, `times` times in a row — exactly what
 *  a bulletin's generator does for a merged header: one pass per
 *  covered sub-column, all at the same place. */
const overpaint = (text: string, x0: number, times: number): NamedOp[] => {
  const ops: NamedOp[] = [
    { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { op: "beginText", args: null },
    identityTextMatrix,
    { op: "setFont", args: ["f1", 10] },
  ];
  for (let i = 0; i < times; i++) {
    ops.push({ op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x0, f: 700 } });
    ops.push({ op: "showText", args: [[...text].map((c) => glyph(c))] });
  }
  ops.push({ op: "endText", args: null });
  return ops;
};

describe("buildGlyphFragments — a mark painted several times stays ONE mark", () => {
  it("returns a single glyph per position, whatever the number of passes", () => {
    const frags = buildGlyphFragments(overpaint("AB", 100, 4));
    expect(frags.map((f) => f.text)).toEqual(["A", "B"]);
  });

  it("carries the number of passes on the surviving glyph — the information is not lost", () => {
    // It serves as a SECOND signal for the colspan: the generator paints the label
    // of a merged cell once per covered sub-column.
    expect(buildGlyphFragments(overpaint("AB", 100, 4)).map((f) => f.paintCount)).toEqual([4, 4]);
  });

  it("is 1 for a glyph painted only once — the case of all the rest of a page", () => {
    expect(buildGlyphFragments(overpaint("AB", 100, 1)).map((f) => f.paintCount)).toEqual([1, 1]);
  });

  it("does NOT merge two different characters at the same point", () => {
    const ops: NamedOp[] = [
      { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "beginText", args: null },
      { op: "setFont", args: ["f1", 10] },
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 700 } },
      { op: "showText", args: [[glyph("A")]] },
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 700 } },
      { op: "showText", args: [[glyph("B")]] },
      { op: "endText", args: null },
    ];
    expect(buildGlyphFragments(ops).map((f) => f.text)).toEqual(["A", "B"]);
  });

  it("does NOT merge the same character at distinct points", () => {
    const ops: NamedOp[] = [
      { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "beginText", args: null },
      { op: "setFont", args: ["f1", 10] },
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 700 } },
      { op: "showText", args: [[glyph("A")]] },
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 140, f: 700 } },
      { op: "showText", args: [[glyph("A")]] },
      { op: "endText", args: null },
    ];
    const frags = buildGlyphFragments(ops);
    expect(frags).toHaveLength(2);
    expect(frags.map((f) => f.paintCount)).toEqual([1, 1]);
  });

  it("keeps the FIRST occurrence, hence the document's reading order", () => {
    const frags = buildGlyphFragments([...overpaint("A", 100, 3), ...overpaint("B", 140, 2)]);
    expect(frags.map((f) => f.text)).toEqual(["A", "B"]);
    expect(frags.map((f) => f.paintCount)).toEqual([3, 2]);
  });
});
