/**
 * Exhaustive audit of 07/10/2026 (P2-F6): positions are grouped by CHAINING (each ≤ 2 pt from the previous), then each group's
 * members were re-found by a WINDOW of ±2 pt around the group's mean. A border painted in pieces at x = 100, 102, 104, 106 is one
 * group of mean 103, but the window kept only 102 and 104: pieces 100 and 106 left the border's extent. The members are the group's.
 */
import { describe, expect, it } from "vitest";
import { mergeCollinear, type MergedLine } from "./vector-grid";

const piece = (at: number, lo: number, hi: number): MergedLine => ({ at, lo, hi, thickness: 1 });

describe("mergeCollinear — every piece of a chained group counts", () => {
  it("🔴 pieces at 100, 102, 104, 106: one line spanning all their lengths", () => {
    const merged = mergeCollinear([piece(100, 0, 10), piece(102, 10, 20), piece(104, 20, 30), piece(106, 30, 40)]);
    expect(merged).toHaveLength(1);
    expect([merged[0]!.lo, merged[0]!.hi]).toEqual([0, 40]);
  });
});
