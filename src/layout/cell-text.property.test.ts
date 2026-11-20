/**
 * The central property of cell-text recomposition: nothing lost, nothing duplicated, nothing reordered inside a line.
 *
 *     recomposed text, whitespace removed  ===  glyphs in reading order, whitespace removed
 *
 * What it does not guarantee:
 * 1. the order between cells: two swapped cells would pass;
 * 2. the grouping into visual lines: the expected value uses the same grouping function as the implementation, so
 *    the property exercises the joining, the depth and the assembly, not the sort;
 * 3. whether a join was the right one: joining two lines wrongly keeps every character.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { recomposeCellText, type CellBounds } from "./cell-text";
import { groupFragmentsIntoVisualLines, type Fragment } from "./geometry";
import { fuzzRuns } from "../lib/pdf-fuzz-runs.test.support";

const stripped = (s: string): string => s.replace(/\s+/gu, "");

/** Plausible glyphs on several visual lines with varied start abscissas, to exercise both the joining and the depth. */
const glyphArb = (): fc.Arbitrary<Fragment[]> =>
  fc
    .array(
      fc.record({
        chars: fc.string({ minLength: 1, maxLength: 12 }),
        x0: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        y: fc.integer({ min: 0, max: 20 }),
        w: fc.double({ min: 0.5, max: 30, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((rows) =>
      rows.flatMap((r) =>
        [...r.chars].map((ch, i) => ({ text: ch, x: r.x0 + i * r.w, y: r.y * 10, width: r.w, height: 8 })),
      ),
    );

const boundsArb = (): fc.Arbitrary<CellBounds> =>
  fc
    .tuple(
      fc.double({ min: -50, max: 200, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 400, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([left, width]) => ({ left, right: left + width }));

describe("recomposeCellText — propriété de conservation", () => {
  it("ne perd, ne duplique ni ne réordonne un seul caractère", () => {
    fc.assert(
      fc.property(glyphArb(), boundsArb(), (glyphs, bounds) => {
        const expected = stripped(
          groupFragmentsIntoVisualLines(glyphs)
            .flat()
            .map((f) => f.text)
            .join(""),
        );
        const actual = stripped(
          recomposeCellText(glyphs, bounds)
            .map((l) => l.text)
            .join(""),
        );
        expect(actual).toBe(expected);
      }),
      { numRuns: fuzzRuns(300, process.env) },
    );
  });

  it("rend une profondeur entière, positive, et toujours définie", () => {
    fc.assert(
      fc.property(glyphArb(), boundsArb(), (glyphs, bounds) => {
        for (const l of recomposeCellText(glyphs, bounds)) {
          expect(Number.isInteger(l.depth)).toBe(true);
          expect(l.depth).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: fuzzRuns(200, process.env) },
    );
  });

  it("ne rend jamais une ligne vide — une cellule sans texte rend un tableau vide, pas une ligne blanche", () => {
    fc.assert(
      fc.property(glyphArb(), boundsArb(), (glyphs, bounds) => {
        for (const l of recomposeCellText(glyphs, bounds)) expect(l.text.length).toBeGreaterThan(0);
      }),
      { numRuns: fuzzRuns(200, process.env) },
    );
  });

  it("est déterministe : deux appels sur la même entrée rendent la même sortie", () => {
    fc.assert(
      fc.property(glyphArb(), boundsArb(), (glyphs, bounds) => {
        expect(recomposeCellText(glyphs, bounds)).toEqual(recomposeCellText(glyphs, bounds));
      }),
      { numRuns: fuzzRuns(100, process.env) },
    );
  });
});
