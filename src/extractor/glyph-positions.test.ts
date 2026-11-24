/**
 * Operator lists WRITTEN BY HAND — decision of 09/09/2026, and it has
 * a history. Two generated fixtures have already lied by omission: the
 * `12-Archive-OCR-Ancien.pdf` whose image covered only 8.7% of the page
 * where the threshold asks for 80, and `makePdfWithVectorGrid` which embodied
 * exactly the two assumptions that the first real document violates (no
 * page frame, borders in continuous strokes). In both cases the
 * generator produced a CONVENIENT pattern rather than the intended one.
 *
 * Here, each fixture SAYS what it tests: a `Td` per glyph, a `TJ` with
 * kerning, a rotated matrix. We do not hope that a producer emits them
 * by chance.
 *
 * THE VALUES ARE NOT INVENTED. They are taken from a real document,
 * a school report card — entered into the repository on 17/09/2026, `fixtures/pdf/`, while
 * this sentence still said it was outside. What this file reproduces is the
 * measured SHAPE, with measured values:
 *
 *   setTextMatrix -> { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }    UNWRAPPED since
 *                                                              the boundary; the
 *                                                              four raw encodings
 *                                                              of the former pdf.js
 *                                                              are pinned
 *                                                              in
 *                                                              `pdf-ops.test.ts`
 *   setFont       -> ["g_d0_f1", 75]                           75, for an
 *                                                              EFFECTIVE size
 *                                                              of 9.0008
 *   moveText      -> [763,-90] then [54,0], [42,0], [17,0]     one Td per glyph
 *
 * and the first glyph lands at (119.87 ; 800.10). These two shapes are
 * precisely what made two naive reconstructions return `NaN`.
 */

import { describe, expect, it } from "vitest";

import { buildGlyphFragments, type NamedOp } from "./glyph-positions";

/** The report card's CTM, deduced from the measurements and verified by arithmetic:
 *  763 × 0.12 + 28.31 = 119.87 and −90 × 0.12 + 810.9 = 800.10, i.e. exactly
 *  the coordinates that pdf.js's `getTextContent` returned for the first glyph. 28.3 and
 *  810.9 are moreover the left margin and the top edge measured on the page. */
const CTM: NamedOp = { op: "transform", args: { a: 0.12, b: 0, c: 0, d: 0.12, e: 28.31, f: 810.9 } };

/** A matrix ALREADY UNWRAPPED — since 14/09/2026, `decodeOps` returns
 *  an ordinary `Matrix2D` and this module never sees the four encodings
 *  of the former pdf.js (removed on 01/11/2026) anymore. Those are pinned in `pdf-ops.test.ts`, which is now the
 *  only place in the repository where they are written. */
const identityTextMatrix: NamedOp = { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };

const glyph = (unicode: string, width: number, isSpace = false): Record<string, unknown> => ({
  originalCharCode: unicode.charCodeAt(0),
  fontChar: unicode,
  unicode,
  accent: null,
  width,
  isSpace,
  isInFont: true,
});

describe("buildGlyphFragments — one Td per glyph, the shape of the real document", () => {
  const ops: NamedOp[] = [
    CTM,
    { op: "beginText", args: null },
    identityTextMatrix,
    { op: "setFont", args: ["g_d0_f1", 75] },
    { op: "moveText", args: [763, -90] },
    { op: "showText", args: [[glyph("C", 722)]] },
    { op: "moveText", args: [54, 0] },
    { op: "showText", args: [[glyph("o", 556)]] },
    { op: "moveText", args: [42, 0] },
    { op: "showText", args: [[glyph("l", 222)]] },
    { op: "endText", args: null },
  ];

  it("places the first glyph where pdf.js's getTextContent placed it — 119.87 / 800.10", () => {
    const [first] = buildGlyphFragments(ops);
    expect(first!.text).toBe("C");
    expect(first!.x).toBeCloseTo(119.87, 2);
    expect(first!.y).toBeCloseTo(800.1, 2);
  });

  it("returns the EFFECTIVE size (9.0), never the raw 75 of setFont", () => {
    const [first] = buildGlyphFragments(ops);
    // 75 × 0.12 — the factor comes from the CTM. Composing Tfs without it would give a
    // wrong order of magnitude, hence a plausible one, hence worse than a NaN.
    expect(first!.height).toBeCloseTo(9.0, 3);
  });

  it("accumulates successive Td instead of restarting from the text matrix", () => {
    const frags = buildGlyphFragments(ops);
    // 763 then +54 then +42, all × 0.12 and shifted by 28.31.
    expect(frags.map((f) => f.x)).toEqual([
      expect.closeTo(119.87, 2),
      expect.closeTo(126.35, 2),
      expect.closeTo(131.39, 2),
    ]);
  });

  it("never returns NaN — the exact regression of the two discarded attempts", () => {
    for (const f of buildGlyphFragments(ops)) {
      expect(Number.isFinite(f.x)).toBe(true);
      expect(Number.isFinite(f.y)).toBe(true);
      expect(Number.isFinite(f.width)).toBe(true);
      expect(Number.isFinite(f.height)).toBe(true);
    }
  });

  it("THROWS if the matrix was not unwrapped upstream", () => {
    // The decoding of the four encodings of the former pdf.js left this module at step
    // 4a; its cases live in `pdf-ops.test.ts`. What remains here is the
    // refusal to rebuild on anything but a matrix — silently
    // returning wrong coordinates is precisely what we do not do.
    const brut = ops.map((o) => (o.op === "setTextMatrix" ? { op: "setTextMatrix", args: [1, 0, 0, 1, 0, 0] } : o));
    expect(() => buildGlyphFragments(brut)).toThrow(/expected a decoded matrix/);
  });

  it("gives one runId per painting operation — enough to recompose the text of a cell", () => {
    // The PROPERTY, not the value: two glyphs of the same run share their
    // `runId`, two different runs do not. The value itself
    // is the index in the operator list — useful to trace back to the source,
    // but it is an implementation detail that a test must not freeze.
    const ids = buildGlyphFragments(ops).map((f) => f.runId);
    expect(new Set(ids).size).toBe(3);

    const twoGlyphsOneRun = buildGlyphFragments([
      { op: "beginText", args: null },
      identityTextMatrix,
      { op: "setFont", args: ["f1", 10] },
      { op: "showText", args: [[glyph("A", 500), glyph("B", 500)]] },
      { op: "showText", args: [[glyph("C", 500)]] },
    ]);
    expect(twoGlyphsOneRun[0]!.runId).toBe(twoGlyphsOneRun[1]!.runId);
    expect(twoGlyphsOneRun[2]!.runId).not.toBe(twoGlyphsOneRun[0]!.runId);
  });
});

describe("buildGlyphFragments — TJ and its kerning", () => {
  // Covered from this lot on although the measured document does not emit it: it is
  // the most common text operator, every other producer uses it, and
  // the kerning it carries enters the computation of the advance.
  const withKerning = (kern: number): NamedOp[] => [
    { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { op: "beginText", args: null },
    identityTextMatrix,
    { op: "setFont", args: ["f1", 10] },
    { op: "showSpacedText", args: [[glyph("A", 500), kern, glyph("B", 500)]] },
    { op: "endText", args: null },
  ];

  it("without kerning, the second glyph follows the advance of the first", () => {
    const [, second] = buildGlyphFragments(withKerning(0));
    expect(second!.x).toBeCloseTo(5, 6); // 500/1000 × 10
  });

  it("a NEGATIVE number moves apart to the right", () => {
    const [, second] = buildGlyphFragments(withKerning(-200));
    expect(second!.x).toBeCloseTo(5 + 2, 6); // −(−200)/1000 × 10
  });

  it("a POSITIVE number moves closer to the left", () => {
    const [, second] = buildGlyphFragments(withKerning(300));
    expect(second!.x).toBeCloseTo(5 - 3, 6);
  });
});

describe("buildGlyphFragments — T* and TL, the other way to move down one line", () => {
  // Covered on 09/09/2026 because the FIVE PDF fixtures of the repository emit
  // `T*` and never `Td` — the exact opposite of the real document. As long as `T*`
  // threw, the oracle had no subject in the repository and the central
  // property was exercised on nothing.
  const lines = (leading: number): NamedOp[] => [
    { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { op: "beginText", args: null },
    { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 700 } },
    { op: "setFont", args: ["f1", 10] },
    { op: "setLeading", args: [leading] },
    { op: "showText", args: [[glyph("A", 500)]] },
    { op: "nextLine", args: null },
    { op: "showText", args: [[glyph("B", 500)]] },
    { op: "nextLine", args: null },
    { op: "showText", args: [[glyph("C", 500)]] },
    { op: "endText", args: null },
  ];

  it("moves down by exactly TL per T*, and returns to the line's margin", () => {
    const frags = buildGlyphFragments(lines(12));
    expect(frags.map((f) => f.text)).toEqual(["A", "B", "C"]);
    expect(frags.map((f) => f.y)).toEqual([700, 688, 676]);
    // The return to the margin is half of the contract: T* acts on the LINE
    // matrix, so the x coordinate restarts from it, not from the end of the previous
    // glyph. Without this, each line would drift to the right.
    expect(frags.map((f) => f.x)).toEqual([100, 100, 100]);
  });

  it("follows a TL redefined inside the block", () => {
    const ops = lines(12);
    ops.splice(8, 0, { op: "setLeading", args: [30] });
    expect(buildGlyphFragments(ops).map((f) => f.y)).toEqual([700, 688, 658]);
  });

  it("without TL, T* does not move down — and invents no default leading", () => {
    const ops = lines(12).filter((o) => o.op !== "setLeading");
    expect(buildGlyphFragments(ops).map((f) => f.y)).toEqual([700, 700, 700]);
  });
});

/**
 * Tc, Tw, Tz, TD and q/Q (22/09/2026). Until this date every non-neutral value
 * threw, and 68 pages of 18 PDFs lost all their glyphs — `Tc` first on 54 of
 * them, `TD` on 13, `Tw` on 1. Each expected value below differs from what the
 * old code gave (it threw), and from what a builder that read the operator but
 * ignored its value would give (noted per test).
 */
describe("buildGlyphFragments — the text state: Tc, Tw, Tz, TD, q/Q", () => {
  const at = (...body: NamedOp[]): NamedOp[] => [
    { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { op: "beginText", args: null },
    { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 700 } },
    { op: "setFont", args: ["f1", 10] },
    ...body,
    { op: "endText", args: null },
  ];

  it("Tc 1 moves the second glyph by 1 unscaled unit, and widens the first", () => {
    const [a, b] = buildGlyphFragments(
      at({ op: "setCharSpacing", args: [1] }, { op: "showText", args: [[glyph("A", 500), glyph("B", 500)]] }),
    );
    expect(b!.x).toBeCloseTo(106, 6); // 100 + 5 + 1 ; ignoring Tc gives 105
    expect(a!.width).toBeCloseTo(6, 6);
  });

  it("Tw applies to an isSpace glyph only, as pdf.js did — never to a space not marked as one", () => {
    const run = (spaceIsSpace: boolean): NamedOp[] =>
      at(
        { op: "setWordSpacing", args: [3] },
        { op: "showText", args: [[glyph("A", 500), glyph(" ", 250, spaceIsSpace), glyph("B", 500)]] },
      );
    expect(buildGlyphFragments(run(true))[2]!.x).toBeCloseTo(110.5, 6); // 100 + 5 + 2.5 + 3
    expect(buildGlyphFragments(run(false))[2]!.x).toBeCloseTo(107.5, 6); // Tw not applied
  });

  it("Tz 50 halves the advance AND the kerning of a TJ", () => {
    const [a, b] = buildGlyphFragments(
      at({ op: "setHScale", args: [50] }, { op: "showSpacedText", args: [[glyph("A", 500), -200, glyph("B", 500)]] }),
    );
    expect(a!.width).toBeCloseTo(2.5, 6);
    expect(b!.x).toBeCloseTo(103.5, 6); // 100 + (5 + 2) × 0.5 ; ignoring Tz gives 107
  });

  it("TD 0 −12 moves down 12 AND sets the leading, so the next T* moves down 12 again", () => {
    const frags = buildGlyphFragments(
      at(
        { op: "showText", args: [[glyph("A", 500)]] },
        { op: "setLeadingMoveText", args: [4, -12] },
        { op: "showText", args: [[glyph("B", 500)]] },
        { op: "nextLine", args: null },
        { op: "showText", args: [[glyph("C", 500)]] },
      ),
    );
    expect(frags.map((f) => f.y)).toEqual([700, 688, 676]); // TD read as Td: T* stays at 688
    expect(frags.map((f) => f.x)).toEqual([100, 104, 104]);
  });

  it("q Tc 2 … Q gives Tc back its value from before q", () => {
    const frags = buildGlyphFragments(
      at(
        { op: "save", args: null },
        { op: "setCharSpacing", args: [2] },
        { op: "showText", args: [[glyph("A", 500), glyph("B", 500)]] },
        { op: "restore", args: null },
        { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 600 } },
        { op: "showText", args: [[glyph("C", 500), glyph("D", 500)]] },
      ),
    );
    expect(frags[1]!.x).toBeCloseTo(107, 6);
    expect(frags[3]!.x).toBeCloseTo(105, 6); // without the restore: 107
  });

  it("q/Q also restores Tw, Tz, TL, the font size, the rise and the rendering mode", () => {
    const frags = buildGlyphFragments(
      at(
        { op: "setLeading", args: [12] },
        { op: "save", args: null },
        { op: "setWordSpacing", args: [5] },
        { op: "setHScale", args: [50] },
        { op: "setLeading", args: [40] },
        { op: "setFont", args: ["f1", 20] },
        { op: "setTextRise", args: [3] },
        { op: "setTextRenderingMode", args: [2] },
        { op: "restore", args: null },
        { op: "showText", args: [[glyph(" ", 250, true), glyph("A", 500)]] },
        { op: "nextLine", args: null },
        { op: "showText", args: [[glyph("B", 500)]] },
      ),
    );
    const [space, a, b] = frags;
    expect(space!.width).toBeCloseTo(2.5, 6); // not (5 + 5) × 0.5, nor 5 at size 20
    expect(a!.y).toBe(700); // no rise
    expect(a!.stroked).toBe(false);
    expect(b!.y).toBe(688); // TL 12, not 40
  });

  it('the sequence pdf.js emitted for `"` — T*, Tw, Tc, Tj — lands where the operator puts it', () => {
    // `aw ac (string) "` ≡ `aw Tw ac Tc (string) '` ≡ `aw Tw ac Tc T* (string) Tj`
    // (PDF 32000-1, table 107). pdf.js emitted nextLine, setWordSpacing,
    // setCharSpacing, showText, in that order.
    const frags = buildGlyphFragments(
      at(
        { op: "setLeading", args: [14] },
        { op: "nextLine", args: null },
        { op: "setWordSpacing", args: [2] },
        { op: "setCharSpacing", args: [1] },
        { op: "showText", args: [[glyph("A", 500), glyph(" ", 250, true), glyph("B", 500)]] },
      ),
    );
    expect(frags.map((f) => f.y)).toEqual([686, 686, 686]);
    expect(frags[2]!.x).toBeCloseTo(100 + 6 + 5.5, 6); // A: 5 + Tc ; space: 2.5 + Tc + Tw
  });

  it("the text matrix is NOT part of the graphics state: Q does not move the text back", () => {
    const frags = buildGlyphFragments(
      at(
        { op: "save", args: null },
        { op: "moveText", args: [50, 0] },
        { op: "restore", args: null },
        { op: "showText", args: [[glyph("A", 500)]] },
      ),
    );
    expect(frags[0]!.x).toBe(150);
  });
});

describe("buildGlyphFragments — rotated text", () => {
  it("keeps the matrix, and does not claim a horizontal box", () => {
    // 90°, the exact shape that point 13 describes: the former extractTextItems dropped
    // this rotation and returned a wrong horizontal width.
    const frags = buildGlyphFragments([
      { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "beginText", args: null },
      { op: "setTextMatrix", args: { a: 0, b: 10, c: -10, d: 0, e: 154, f: 320 } },
      { op: "setFont", args: ["f1", 1] },
      { op: "showText", args: [[glyph("2", 500)]] },
      { op: "endText", args: null },
    ]);
    const [g] = frags;
    expect(g!.x).toBeCloseTo(154, 6);
    expect(g!.y).toBeCloseTo(320, 6);
    // The matrix carries the rotation: b and c non-zero, a and d zero.
    expect(g!.matrix.a).toBeCloseTo(0, 6);
    expect(g!.matrix.b).toBeCloseTo(10, 6);
    expect(g!.matrix.c).toBeCloseTo(-10, 6);
  });
});

describe("buildGlyphFragments — failure is loud and NAMES the operator", () => {
  const withOp = (op: string, args: unknown[]): NamedOp[] => [
    { op: "beginText", args: null },
    identityTextMatrix,
    { op: "setFont", args: ["f1", 10] },
    { op, args },
    { op: "showText", args: [[glyph("A", 500)]] },
  ];

  it.each([
    ["nextLineShowText", [[]]],
    ["nextLineSetSpacingShowText", [0, 0, []]],
  ])("refuses %s rather than silently returning a wrong position", (op, args) => {
    // Our reader (`pdf-ops-ours.ts`) rewrites `'` and `"` before they reach this module (as pdf.js did);
    // meeting one means that fact changed.
    expect(() => buildGlyphFragments(withOp(op, args))).toThrow(new RegExp(op));
  });

  it("names vertical writing instead of computing an advance that runs down the page", () => {
    const ops: NamedOp[] = [
      { op: "beginText", args: null },
      identityTextMatrix,
      { op: "setFont", args: ["f1", 10] },
      { op: "showText", args: [[{ ...glyph("縦", 1000), vmetric: [-1000, 500, 880] }]] },
    ];
    expect(() => buildGlyphFragments(ops)).toThrow(/vertical writing/);
  });

  it("names an unknown text operator instead of ignoring it", () => {
    expect(() => buildGlyphFragments(withOp("setTextMatrixSomethingNew", [1]))).toThrow(/setTextMatrixSomethingNew/);
  });

  it("ignores, on the other hand, what moves nothing — colour, rendering mode", () => {
    expect(() =>
      buildGlyphFragments([...withOp("setTextRenderingMode", [3]), { op: "setFillRGBColor", args: [0, 0, 0] }]),
    ).not.toThrow();
  });
});

describe("buildGlyphFragments — spaces are marked, not dropped", () => {
  it("carries isSpace so that the assignment can ignore them without losing them", () => {
    const frags = buildGlyphFragments([
      { op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "beginText", args: null },
      identityTextMatrix,
      { op: "setFont", args: ["f1", 10] },
      { op: "showText", args: [[glyph("A", 500), glyph(" ", 250, true), glyph("B", 500)]] },
      { op: "endText", args: null },
    ]);
    expect(frags.map((f) => f.isSpace)).toEqual([false, true, false]);
    expect(frags.map((f) => f.text)).toEqual(["A", " ", "B"]);
  });
});

describe("the text rendering mode — fake bold", () => {
  /** A minimal run: a font, a text matrix, a glyph. */
  const cycle = (mode: number | undefined, x = 100): NamedOp[] => [
    { op: "beginText", args: [] },
    ...(mode === undefined ? [] : [{ op: "setTextRenderingMode", args: [mode] }]),
    { op: "setFont", args: ["F1", 10] },
    { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: 700 } },
    { op: "showText", args: [[{ unicode: "A", width: 500 }]] },
    { op: "endText", args: [] },
  ];

  it("mode 2 — fill THEN stroke: that is fake bold", () => {
    expect(buildGlyphFragments(cycle(2)).map((g) => g.stroked)).toEqual([true]);
  });

  it("mode 0 by default, and without an explicit operation — fill only", () => {
    expect(buildGlyphFragments(cycle(undefined)).map((g) => g.stroked)).toEqual([false]);
    expect(buildGlyphFragments(cycle(0)).map((g) => g.stroked)).toEqual([false]);
  });

  it("mode 1 — STROKE ONLY, hollow text, never bold", () => {
    // The distinction is not cosmetic: a hollow drop cap or a title
    // effect would pass for bold if we settled for "it strokes".
    expect(buildGlyphFragments(cycle(1)).map((g) => g.stroked)).toEqual([false]);
  });

  it("the mode follows the text state from one cycle to the next", () => {
    // The two runs are written at different X POSITIONS, and this is
    // necessary: at the same point, `collapseOverpaint` would see only one
    // glyph painted twice — its key is the position and the character, not the
    // render mode.
    expect(buildGlyphFragments([...cycle(2), ...cycle(0, 200)]).map((g) => g.stroked)).toEqual([true, false]);
  });

  it("two paintings at the SAME point make one glyph, and the first one wins", () => {
    const merged = buildGlyphFragments([...cycle(2), ...cycle(0)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.paintCount).toBe(2);
    expect(merged[0]?.stroked).toBe(true);
  });
});

describe("buildGlyphFragments — ligature presentation forms, decomposed unlike pdf.js's former runs", () => {
  /**
   * FOUND ON A REAL DOCUMENT (fixture 37, Apple Pages/Quartz), 29/09/2026.
   * A former test measured that pdf.js's `getTextContent()` runs never
   * carried a precomposed ligature (U+FB00-FB06) — true at the time. But
   * that measurement never exercised THIS path: `showText`'s own decoded
   * glyph list. CORRECTED 29/09/2026 by an independent counter-diagnosis:
   * pdf.js's `showText` did NOT carry a different, glyph-name-based unicode
   * resolution — it read the exact same `toUnicode.get(charcode)` result as
   * `getTextContent()` (pdf.worker.mjs `_charToGlyph` ~l.28767, fed to both
   * `handleText` ~l.34704 and the text-content builder ~l.36098), and on
   * fixture 37 and on the synthetic fixture 14 that CMap itself maps TO the
   * precomposed character. What `showText`'s glyph list never went through was
   * `normalizeUnicode()` (~l.720), the NFKC post-processing step
   * `runBidiTransform()` (~l.35856-35859) applied only when building
   * `getTextContent()`'s text. Unfixed, a ligature glyph inside a table cell
   * (`layout/cell-text.ts` reads glyphs, not runs) publishes "eﬃcace" instead
   * of "efficace": measured on fixture 37, 73 occurrences in 5 cells (0
   * outside a table).
   *
   * THE FIX, AND ITS SOURCE. Unicode's own compatibility decomposition for
   * exactly these six code points (UnicodeData.txt, `<compat>` field —
   * U+FB00 ff, FB01 fi, FB02 fl, FB03 ffi, FB04 ffl, FB05/FB06 st) is what
   * `String.prototype.normalize("NFKC")` applies. Applying it only to these
   * six code points keeps every other glyph untouched.
   *
   * NOT the same string pdf.js's `getTextContent()` gave, for U+FB05 alone:
   * pdf.js's own `normalizeUnicode()` (removed since) special-cased it to "ſt" (long s,
   * `NormalizationMap`, pdf.worker.mjs ~l.723) because plain
   * `String.prototype.normalize("NFKC")` gives "st" (plain s) in this
   * engine, losing that distinction. Kept as "st" here anyway: better for
   * search, and this repository does not chase a distinction search does not
   * need.
   */
  const glyph = (unicode: string, width: number): Record<string, unknown> => ({ unicode, width, isSpace: false });
  const oneGlyph = (unicode: string): NamedOp[] => [
    { op: "beginText", args: null },
    { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    { op: "setFont", args: ["F1", 10] },
    { op: "showText", args: [[glyph(unicode, 500)]] },
    { op: "endText", args: null },
  ];

  it.each([
    ["ﬀ", "ff"],
    ["ﬁ", "fi"],
    ["ﬂ", "fl"],
    ["ﬃ", "ffi"],
    ["ﬄ", "ffl"],
    ["ﬅ", "st"],
    ["ﬆ", "st"],
  ])("%s decomposes to %s", (precomposed, decomposed) => {
    const [frag] = buildGlyphFragments(oneGlyph(precomposed));
    expect(frag!.text).toBe(decomposed);
  });

  it("an ordinary glyph is untouched", () => {
    const [frag] = buildGlyphFragments(oneGlyph("é"));
    expect(frag!.text).toBe("\u00e9");
  });
});

describe("buildGlyphFragments — what a text run needs from each glyph", () => {
  const g = (unicode: string, width = 500): Record<string, unknown> => ({ unicode, width, isSpace: false });
  const at = (x: number, y: number): NamedOp => ({ op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: y } });
  const show = (...glyphs: Record<string, unknown>[]): NamedOp => ({ op: "showText", args: [glyphs] });

  it("carries the `Tf` font name, and `q`/`Q` restore it", () => {
    const frags = buildGlyphFragments([
      at(0, 0),
      { op: "setFont", args: ["f1", 10] },
      { op: "save", args: null },
      { op: "setFont", args: ["f2", 10] },
      show(g("a")),
      { op: "restore", args: null },
      show(g("b")),
    ]);
    expect(frags.map((f) => f.font)).toEqual(["f2", "f1"]);
  });

  it("carries the displacement of the text rise in page space (zero without a rise)", () => {
    const frags = buildGlyphFragments([
      at(100, 700),
      { op: "setFont", args: ["f1", 10] },
      show(g("a")),
      { op: "setTextRise", args: [3] },
      show(g("b")),
    ]);
    expect(frags.map((f) => f.rise)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 3 },
    ]);
    expect(frags[1]!.y).toBe(703);
  });

  it("numbers the marked-content and form XObject boundaries, so that two glyphs of one section share a number", () => {
    const frags = buildGlyphFragments([
      at(0, 0),
      { op: "setFont", args: ["f1", 10] },
      show(g("a")),
      { op: "beginMarkedContentProps", args: ["P", 7] },
      show(g("b"), g("c")),
      { op: "endMarkedContent", args: null },
      show(g("d")),
      { op: "paintFormXObjectBegin", args: [null, null] },
      show(g("e")),
      { op: "paintFormXObjectEnd", args: null },
      show(g("f")),
    ]);
    const sections = frags.map((f) => f.section);
    expect(sections[1]).toBe(sections[2]);
    expect(new Set(sections).size).toBe(5);
  });

  it("carries the innermost marked-content id and the artifact flag of any open level", () => {
    const frags = buildGlyphFragments([
      at(0, 0),
      { op: "setFont", args: ["f1", 10] },
      { op: "beginMarkedContentProps", args: ["P", 7] },
      { op: "beginMarkedContentProps", args: ["Artifact", null] },
      show(g("a")),
      { op: "endMarkedContent", args: null },
      show(g("b")),
      { op: "endMarkedContent", args: null },
      show(g("c")),
    ]);
    expect(frags.map((f) => [f.mcid, f.artifact])).toEqual([
      [7, true],
      [7, false],
      [undefined, false],
    ]);
  });

  it("a Type 3 font advances by its own font matrix, not by 1/1000 (fixture 26 declares eight of them)", () => {
    // Glyph width 500 in a 1/1024 glyph space: advance = 500 / 1024 × 10 pt.
    const ops: NamedOp[] = [at(0, 0), { op: "setFont", args: ["t3", 10] }, show(g("a", 500), g("b", 500))];
    const frags = buildGlyphFragments(ops, undefined, (font) => (font === "t3" ? 1 / 1024 : undefined));
    expect(frags[0]!.width).toBeCloseTo((500 / 1024) * 10, 9);
    expect(frags[1]!.x).toBeCloseTo((500 / 1024) * 10, 9);
    // Without the font's matrix the former approximation stays.
    expect(buildGlyphFragments(ops)[0]!.width).toBeCloseTo(5, 9);
  });
});

describe("buildGlyphFragments — the tag of a plain `BMC` (fixture 33, page 6)", () => {
  it("a `BMC` tag given as a name object, as pdf.js's operator list gave it, not a string: still an artifact", () => {
    const frags = buildGlyphFragments([
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "setFont", args: ["f1", 10] },
      { op: "beginMarkedContent", args: [{ name: "Artifact" }] },
      { op: "showText", args: [[{ unicode: "a", width: 500, isSpace: false }]] },
      { op: "endMarkedContent", args: null },
      { op: "beginMarkedContent", args: [{ name: "Span" }] },
      { op: "showText", args: [[{ unicode: "b", width: 500, isSpace: false }]] },
      { op: "endMarkedContent", args: null },
    ]);
    expect(frags.map((f) => f.artifact)).toEqual([true, false]);
  });
});

describe("buildGlyphFragments — a glyph whose Unicode is a base letter plus a combining mark is published precomposed", () => {
  it("« e » + U+0301 (fixture 48, Word 2010: every accented letter) is « é »: runs, links and cells then agree on the length of a word", () => {
    const [frag] = buildGlyphFragments([
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "setFont", args: ["f1", 10] },
      { op: "showText", args: [[{ unicode: "e\u0301", width: 500, isSpace: false }]] },
    ]);
    expect(frag!.text).toBe("é");
  });
});

describe("buildGlyphFragments — a control character a font declares never reaches the text (decision of 24/11/2026)", () => {
  const textsOf = (unicodes: readonly string[]): string[] =>
    buildGlyphFragments([
      { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { op: "setFont", args: ["f1", 10] },
      { op: "showText", args: [unicodes.map((unicode) => ({ unicode, width: 500, isSpace: false }))] },
    ]).map((frag) => frag.text);

  it("a /ToUnicode `<02> <00410007>` paints « A », without the U+0007 (ISO 32000-1 §9.10.3)", () => {
    expect(textsOf(["A\u0007"])).toEqual(["A"]);
  });

  it("removes C0, DEL and C1 controls wherever they sit in the glyph's text", () => {
    expect(textsOf(["\u0001B", "C\u007f", "D\u0085E", "F\r", "G\n"])).toEqual(["B", "C", "DE", "F", "G"]);
  });

  it("a glyph made only of controls still places nothing, as before", () => {
    expect(textsOf(["\u0007", "\u0001\u0002", "\n", "\r", "\u0085"])).toEqual([]);
  });

  it("keeps the tab, alone or beside a letter, as before", () => {
    expect(textsOf(["\t", "A\t"])).toEqual(["\t", "A\t"]);
  });
});
