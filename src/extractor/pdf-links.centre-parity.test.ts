/**
 * RESULT (12/10/2026): NOT identical, so `centreIn` is KEPT beside the rule (decision: "otherwise we keep both").
 * Smallest counter-example: glyph x=0.1 width=0.6, rectangle left border 0.4 (the exact centre). `centreIn` computes
 * x + w/2 = 0.4 and accepts; the rule compares x + (x + w) = 0.7999999999999999 with 2 * 0.4 = 0.8 and rejects.
 * Away from the exact centre the two agree (second test).
 *
 * Parity of `pdf-links.ts#centreIn` (a glyph's centre inside an annotation rectangle) with the `centre-in-box` rule of
 * `layout/rect-rules.ts`, on decimal coordinates with exact-border cases (12/10/2026, audit point 16).
 */

import { describe, expect, it } from "vitest";

import { holdsRect, RECT_RULES } from "doc-ir/internal";

type Rect = [number, number, number, number];
type Glyph = { x: number; y: number; width: number; height: number };

// Verbatim copy of the pre-merge `centreIn` (pdf-links.ts, 12/10/2026).
const legacyCentreIn = (rect: Rect, g: Glyph): boolean => {
  const x = g.x + g.width / 2;
  const y = g.y + g.height / 2;
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
};

const ruleCentreIn = (rect: Rect, g: Glyph): boolean =>
  holdsRect(
    RECT_RULES["centre-in-box"],
    { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] },
    { x0: g.x, y0: g.y, x1: g.x + g.width, y1: g.y + g.height },
  );

/** mulberry32: deterministic, seedable. */
const generator = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("centreIn against the centre-in-box rule", () => {
  it("smallest counter-example: a border exactly on the centre is judged differently", () => {
    const g: Glyph = { x: 0.1, y: 0, width: 0.6, height: 1 };
    const rect: Rect = [0.4, 0, 1, 1];
    expect(legacyCentreIn(rect, g)).toBe(true);
    expect(ruleCentreIn(rect, g)).toBe(false);
  });

  it("agrees on 20 000 decimal rectangles whose borders are not on the centre", () => {
    const rand = generator(20261012);
    const dec = (scale: number): number => Math.round(rand() * scale * 1000) / 1000;
    const disagreements: string[] = [];
    for (let n = 0; n < 20_000; n++) {
      const g: Glyph = { x: dec(600), y: dec(800), width: dec(20) + 0.001, height: dec(15) + 0.001 };
      const x0 = dec(600);
      const y0 = dec(800);
      const rect: Rect = [x0, y0, x0 + dec(40), y0 + dec(40)];
      if (legacyCentreIn(rect, g) !== ruleCentreIn(rect, g) && disagreements.length < 3)
        disagreements.push(JSON.stringify({ rect, g }));
    }
    expect(disagreements).toEqual([]);
  });

  it("border-on-centre cases disagree at a measurable rate (why the two are kept)", () => {
    const rand = generator(7);
    let differing = 0;
    const total = 20_000;
    for (let n = 0; n < total; n++) {
      const x = Math.round(rand() * 60000) / 100;
      const width = Math.round(rand() * 2000) / 100 + 0.01;
      const g: Glyph = { x, y: 0, width, height: 1 };
      const cx = x + width / 2;
      if (legacyCentreIn([cx, 0, cx + 10, 1], g) !== ruleCentreIn([cx, 0, cx + 10, 1], g)) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });
});
