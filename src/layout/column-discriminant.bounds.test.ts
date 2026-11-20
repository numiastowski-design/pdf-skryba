import { describe, expect, it } from "vitest";

import { COLUMN_GUTTER_MAX_SPAN, detectColumnGutter } from "./column-discriminant";
import type { Fragment } from "doc-ir/internal";

const frag = (text: string, x: number, y: number, width: number): Fragment => ({ text, x, y, width, height: 10 });

/** A regular two-column page: left column 50..250, right column 350..550. */
const twoColumns = (): Fragment[][] =>
  Array.from({ length: 12 }, (_, i) => [
    frag("left text", 50, 700 - i * 14, 200),
    frag("right text", 350, 700 - i * 14, 200),
  ]);

describe("detectColumnGutter — bounded work", () => {
  it("control: a normal two-column layout still finds its gutter", () => {
    const g = detectColumnGutter(twoColumns());
    expect(g).toBeDefined();
    expect(g!.start).toBeGreaterThanOrEqual(250);
    expect(g!.end).toBeLessThanOrEqual(350);
  });

  it("exports COLUMN_GUTTER_MAX_SPAN as a positive finite number", () => {
    expect(typeof COLUMN_GUTTER_MAX_SPAN).toBe("number");
    expect(Number.isFinite(COLUMN_GUTTER_MAX_SPAN)).toBe(true);
    expect(COLUMN_GUTTER_MAX_SPAN).toBeGreaterThan(0);
  });

  // 2e6 on purpose, not 3e8: the unfixed code would allocate by it, and 3e8 is a fatal OOM that kills the runner.
  it("abstains when a fragment sits far outside the page (span above the cap)", () => {
    const lines = twoColumns();
    lines[0]!.push(frag("stray", 2_000_000, 700, 10));
    expect(2_000_000).toBeGreaterThan(COLUMN_GUTTER_MAX_SPAN);
    expect(detectColumnGutter(lines)).toBeUndefined();
  });

  it("abstains when a fragment is hugely wide", () => {
    const lines = twoColumns();
    lines[0]!.push(frag("wide", 50, 700, 2_000_000));
    expect(detectColumnGutter(lines)).toBeUndefined();
  });

  it("ignores a NaN fragment: same gutter as without it", () => {
    const expected = detectColumnGutter(twoColumns());
    const lines = twoColumns();
    lines[3]!.push(frag("nan", Number.NaN, 650, 10));
    expect(detectColumnGutter(lines)).toEqual(expected);
  });

  it("ignores Infinity coordinates and widths: same gutter as without them", () => {
    const expected = detectColumnGutter(twoColumns());
    const lines = twoColumns();
    lines[2]!.push(frag("inf-x", Number.POSITIVE_INFINITY, 650, 10));
    lines[4]!.push(frag("inf-w", 60, 650, Number.POSITIVE_INFINITY));
    lines[5]!.push(frag("neg-inf", Number.NEGATIVE_INFINITY, 650, 10));
    expect(detectColumnGutter(lines)).toEqual(expected);
  });

  it("a page made only of non-finite fragments abstains instead of throwing", () => {
    expect(
      detectColumnGutter([[frag("a", Number.NaN, 0, 10)], [frag("b", Number.POSITIVE_INFINITY, 0, 10)]]),
    ).toBeUndefined();
  });
});
