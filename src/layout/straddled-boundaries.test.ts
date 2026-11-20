import { describe, expect, it } from "vitest";

import { mergeDoubledBoundaries } from "./straddled-boundaries";

/**
 * Rule A2 (conception-A section 2): two consecutive COLUMN boundaries closer than DELTA with no fragment centre between them are the
 * doubled edge of ONE thick rule. An inner qualifying segment (a pair, or a chain of three boundaries) merges in one pass to the midpoint
 * of its extremes; a segment touching the grid's hull keeps the outer edge; a chain of four or more boundaries abstains, and so does a
 * fragment centred in a gap. Starting value DELTA = 4 pt, measured 27/10/2026: doubled rules 3.7-3.84 pt (141 p70), narrowest real column
 * WITH text 4.73 pt (106-fedramp p24, protected by the centre guard too), and a midpoint must stay within SAME_POSITION_PT (2 pt) of the
 * painted strokes for merged-cells to recognise it, so DELTA <= 2 x 2. The module is pure (numbers in, numbers out) and the product feeds
 * it COLUMN boundaries only: row gaps are indistinguishable from real thin rows (module header).
 */
const DELTA = 4;

describe("mergeDoubledBoundaries", () => {
  it("replaces a doubled pair with no text between them by its midpoint (3.8 pt, the measured rail)", () => {
    expect(mergeDoubledBoundaries([0, 100, 103.8, 200], [50, 150], DELTA)).toEqual([0, 101.9, 200]);
  });

  it("merges a pair whose gap is exactly delta (the bound is inclusive)", () => {
    expect(mergeDoubledBoundaries([0, 100, 104, 200], [50, 150], DELTA)).toEqual([0, 102, 200]);
  });

  it("keeps a pair above delta (4.73 pt is the narrowest real column measured)", () => {
    expect(mergeDoubledBoundaries([0, 100, 104.73, 200], [50, 150], DELTA)).toEqual([0, 100, 104.73, 200]);
  });

  it("keeps a pair when a fragment centre falls between the two boundaries (a comb box, a tick column)", () => {
    expect(mergeDoubledBoundaries([0, 100, 104, 200], [50, 102, 150], DELTA)).toEqual([0, 100, 104, 200]);
  });

  it("treats a fragment centre exactly on a boundary as inside the closed interval [b1, b2]", () => {
    expect(mergeDoubledBoundaries([0, 100, 104, 200], [100], DELTA)).toEqual([0, 100, 104, 200]);
    expect(mergeDoubledBoundaries([0, 100, 104, 200], [104], DELTA)).toEqual([0, 100, 104, 200]);
  });

  it("is not stopped by fragment centres that fall OUTSIDE the gap", () => {
    expect(mergeDoubledBoundaries([0, 100, 104, 200], [99.9, 104.1], DELTA)).toEqual([0, 102, 200]);
  });

  it("merges a chain of three (measured 207.8 / 211.6 / 215.3) into its midpoint", () => {
    expect(mergeDoubledBoundaries([0, 10, 14, 18, 100], [5, 60], DELTA)).toEqual([0, 14, 100]);
  });

  it("cuts a chain at a gap holding a fragment centre: each qualifying segment merges on its own", () => {
    // Gap 10-14 holds a centre (12): kept as a real pair. Gap 14-18 is empty and narrow: merged to 16.
    expect(mergeDoubledBoundaries([0, 10, 14, 18, 100], [5, 12, 60], DELTA)).toEqual([0, 10, 16, 100]);
  });

  it("abstains on a chain of four or more: the boundaries stay as they are", () => {
    expect(mergeDoubledBoundaries([0, 10, 14, 18, 22, 100], [5, 60], DELTA)).toEqual([0, 10, 14, 18, 22, 100]);
    expect(mergeDoubledBoundaries([0, 10, 14, 18, 22, 26, 100], [5, 60], DELTA)).toEqual([0, 10, 14, 18, 22, 26, 100]);
  });

  it("merges two separate doubled pairs independently", () => {
    expect(mergeDoubledBoundaries([0, 100, 104, 200, 300, 304, 400], [50, 150, 250, 350], DELTA)).toEqual([
      0, 102, 200, 302, 400,
    ]);
  });

  it("returns an ordinary grid untouched", () => {
    expect(mergeDoubledBoundaries([0, 100, 200, 300], [50, 150, 250], DELTA)).toEqual([0, 100, 200, 300]);
  });

  describe("a doubled pair on the grid's hull keeps the OUTER edge (the thick rule's envelope bounds the table)", () => {
    it("a pair holding the first boundary collapses to the leftmost edge (141 p70: '(' at 55.39 stays inside [54.2, …])", () => {
      expect(mergeDoubledBoundaries([54.2, 58, 200], [100], DELTA)).toEqual([54.2, 200]);
    });

    it("a pair holding the last boundary collapses to the rightmost edge", () => {
      expect(mergeDoubledBoundaries([0, 100, 196, 200], [50], DELTA)).toEqual([0, 100, 200]);
    });

    it("a chain of three touching the first boundary collapses to the leftmost edge", () => {
      expect(mergeDoubledBoundaries([0, 4, 8, 100], [50], DELTA)).toEqual([0, 100]);
    });

    it("abstains when the segment spans the WHOLE list: both hulls cannot survive a merge", () => {
      expect(mergeDoubledBoundaries([0, 4, 8], [], DELTA)).toEqual([0, 4, 8]);
    });
  });

  describe("extreme sizes", () => {
    it("an empty list stays empty", () => {
      expect(mergeDoubledBoundaries([], [10], DELTA)).toEqual([]);
    });

    it("a single boundary stays alone", () => {
      expect(mergeDoubledBoundaries([42], [], DELTA)).toEqual([42]);
    });

    it("two boundaries only: abstention — merging the only two boundaries would destroy the grid's hull", () => {
      expect(mergeDoubledBoundaries([0, 4], [], DELTA)).toEqual([0, 4]);
      expect(mergeDoubledBoundaries([0, 4], [2], DELTA)).toEqual([0, 4]);
      expect(mergeDoubledBoundaries([0, 50], [25], DELTA)).toEqual([0, 50]);
    });

    it("reads a DESCENDING list (rowBoundaries run top-down) by mirroring it, and gives the caller's order back", () => {
      expect(mergeDoubledBoundaries([200, 104, 100, 0], [150, 50], DELTA)).toEqual([200, 102, 0]);
      expect(mergeDoubledBoundaries([200, 104, 100, 0], [150, 102, 50], DELTA)).toEqual([200, 104, 100, 0]);
    });

    it("does not mutate its inputs", () => {
      const boundaries = [0, 100, 104, 200];
      const centers = [50, 150];
      mergeDoubledBoundaries(boundaries, centers, DELTA);
      expect(boundaries).toEqual([0, 100, 104, 200]);
      expect(centers).toEqual([50, 150]);
    });
  });
});
