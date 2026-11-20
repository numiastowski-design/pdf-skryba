import { describe, expect, it } from "vitest";

import { maxOf, minOf } from "./extent";

describe("minOf / maxOf", () => {
  it("answer like Math.min / Math.max, empty list included", () => {
    const xs = [3, -1, 7];
    expect(minOf(xs, (x) => x)).toBe(Math.min(...xs));
    expect(maxOf(xs, (x) => x * 2)).toBe(14);
    expect(minOf([], (x: number) => x)).toBe(Infinity);
    expect(maxOf([], (x: number) => x)).toBe(-Infinity);
  });

  it("take 300 000 items without throwing", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => i);
    expect(minOf(big, (x) => x)).toBe(0);
    expect(maxOf(big, (x) => x)).toBe(299_999);
  });
});
