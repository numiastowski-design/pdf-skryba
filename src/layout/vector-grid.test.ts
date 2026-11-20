import { describe, expect, it } from "vitest";

import type { ClassifiedLine } from "doc-ir/internal";
import { CLUSTER_TOLERANCE, clusterPositions } from "./position-clusters";
import {
  buildGridsFromVectorLines,
  largestAgreeingExtent,
  MAX_MERGED_VERTICALS_PER_PAGE,
  type MergedLine,
  mergeCollinear,
} from "./vector-grid";

/**
 * The ruling marks of two REAL pages of `fixtures/docx-reel/07-moj-data-sharing-guidance-Word.pdf` (Word 365 export,
 * physical pages 10 and 13, i.e. pages 9 and 12 of the bench, which counts from zero), read by the product's own
 * `walkPage` and `classifyLineSegment`, then rounded to 0.01 pt. Cell fills thicker than 3.24 pt are left out: they
 * do not vote. Each tuple is `[position, from, to, thickness]`: x then yMin..yMax for a vertical, y then xMin..xMax
 * for a horizontal.
 *
 * Both pages hold bordered tables AND hyperlink underlines. Word paints an underline as a filled rectangle of
 * 0.6-0.84 pt; its two short sides are two verticals of the same 0.6-0.84 pt, which agree exactly with each other.
 * Before the fix `mergeCollinear` unioned every
 * segment of one abscissa: each border kept ONE extent, so a group of two underline ends (2 votes) beat every border
 * (1 vote), the region failed and no grid was found. Now only segments that join (within `CLUSTER_TOLERANCE`) merge,
 * so the borders of one table agree with each other and win the vote.
 */
const PAGE_10_VERTICALS = [
  [480.58, 589.75, 590.59, 0.84],
  [200.21, 589.75, 590.59, 0.84],
  [71.78, 663.34, 666.58, 0.48],
  [71.3, 663.34, 666.58, 0.48],
  [197.08, 663.34, 666.58, 3.24],
  [71.78, 663.34, 666.58, 3.24],
  [197.57, 662.86, 666.58, 0.48],
  [197.09, 662.86, 666.58, 0.48],
  [556.3, 662.86, 666.58, 0.48],
  [555.82, 662.86, 666.58, 0.48],
  [71.78, 588.31, 662.85, 0.48],
  [71.3, 588.31, 662.85, 0.48],
  [197.57, 588.31, 662.85, 0.48],
  [197.09, 588.31, 662.85, 0.48],
  [556.3, 588.31, 662.85, 0.48],
  [555.82, 588.31, 662.85, 0.48],
  [546.69, 556.27, 557.11, 0.84],
  [359.11, 556.27, 557.11, 0.84],
  [309.65, 541.39, 542.23, 0.84],
  [200.21, 541.39, 542.23, 0.84],
  [71.78, 584.59, 588.31, 0.48],
  [71.3, 584.59, 588.31, 0.48],
  [197.08, 585.07, 588.31, 3.24],
  [71.78, 585.07, 588.31, 3.24],
  [197.57, 584.59, 588.31, 0.48],
  [197.09, 584.59, 588.31, 0.48],
  [556.3, 584.59, 588.31, 0.48],
  [555.82, 584.59, 588.31, 0.48],
  [71.78, 299.09, 584.59, 0.48],
  [71.3, 299.09, 584.59, 0.48],
  [197.08, 296.33, 299.09, 2.76],
  [71.3, 296.33, 299.09, 2.76],
  [197.57, 299.09, 584.59, 0.48],
  [197.09, 299.09, 584.59, 0.48],
  [556.3, 299.09, 584.59, 0.48],
  [555.82, 299.09, 584.59, 0.48],
  [214.96, 193.1, 193.7, 0.6],
  [70.94, 193.1, 193.7, 0.6],
  [551.37, 83.76, 84.48, 0.72],
  [408.91, 83.76, 84.48, 0.72],
];
const PAGE_10_HORIZONTALS = [
  [589.75, 200.21, 480.58, 0.84],
  [590.59, 200.21, 480.58, 0.84],
  [663.34, 71.78, 197.08, 3.24],
  [666.58, 71.78, 197.08, 3.24],
  [662.86, 71.78, 197.08, 0.48],
  [663.34, 71.78, 197.08, 0.48],
  [666.1, 197.57, 555.82, 0.48],
  [666.58, 197.57, 555.82, 0.48],
  [556.27, 359.11, 546.69, 0.84],
  [557.11, 359.11, 546.69, 0.84],
  [541.39, 200.21, 309.65, 0.84],
  [542.23, 200.21, 309.65, 0.84],
  [585.07, 71.78, 197.08, 3.24],
  [588.31, 71.78, 197.08, 3.24],
  [584.59, 71.78, 197.08, 0.48],
  [585.07, 71.78, 197.08, 0.48],
  [587.83, 197.57, 555.82, 0.48],
  [588.31, 197.57, 555.82, 0.48],
  [296.33, 71.3, 197.08, 2.76],
  [299.09, 71.3, 197.08, 2.76],
  [298.61, 197.57, 555.82, 0.48],
  [299.09, 197.57, 555.82, 0.48],
  [193.1, 70.94, 214.96, 0.6],
  [193.7, 70.94, 214.96, 0.6],
  [83.76, 408.91, 551.37, 0.72],
  [84.48, 408.91, 551.37, 0.72],
];
const PAGE_13_VERTICALS = [
  [71.78, 739.3, 741.82, 0.48],
  [71.3, 739.3, 741.82, 0.48],
  [71.78, 741.82, 745.06, 0.48],
  [71.3, 741.82, 745.06, 0.48],
  [184.58, 741.82, 745.06, 3.24],
  [71.78, 741.82, 745.06, 3.24],
  [184.58, 739.3, 741.82, 2.52],
  [71.78, 739.3, 741.82, 2.52],
  [185.06, 739.3, 745.06, 0.48],
  [184.58, 739.3, 745.06, 0.48],
  [553.66, 739.3, 745.06, 0.48],
  [553.18, 739.3, 745.06, 0.48],
  [71.78, 451.99, 739.29, 0.48],
  [71.3, 451.99, 739.29, 0.48],
  [184.58, 448.75, 451.99, 3.24],
  [71.3, 448.75, 451.99, 3.24],
  [185.06, 451.99, 739.29, 0.48],
  [184.58, 451.99, 739.29, 0.48],
  [553.66, 451.99, 739.29, 0.48],
  [553.18, 451.99, 739.29, 0.48],
  [214.96, 89.52, 90.12, 0.6],
  [70.94, 89.52, 90.12, 0.6],
  [480.34, 233.54, 234.38, 0.84],
  [309.53, 233.54, 234.38, 0.84],
  [71.66, 430.49, 433.73, 0.48],
  [71.18, 430.49, 433.73, 0.48],
  [182.3, 430.01, 433.73, 0.48],
  [181.82, 430.01, 433.73, 0.48],
  [553.42, 430.01, 433.73, 0.48],
  [552.94, 430.01, 433.73, 0.48],
  [71.66, 107.52, 430.01, 0.48],
  [71.18, 107.52, 430.01, 0.48],
  [181.82, 104.28, 107.52, 3.24],
  [71.18, 104.28, 107.52, 3.24],
  [182.3, 107.52, 430.01, 0.48],
  [181.82, 107.52, 430.01, 0.48],
  [553.42, 107.52, 430.01, 0.48],
  [552.94, 107.52, 430.01, 0.48],
];
const PAGE_13_HORIZONTALS = [
  [741.82, 71.78, 184.58, 3.24],
  [745.06, 71.78, 184.58, 3.24],
  [739.3, 71.78, 184.58, 2.52],
  [741.82, 71.78, 184.58, 2.52],
  [744.58, 185.06, 553.17, 0.48],
  [745.06, 185.06, 553.17, 0.48],
  [448.75, 71.3, 184.58, 3.24],
  [451.99, 71.3, 184.58, 3.24],
  [451.51, 185.06, 553.17, 0.48],
  [451.99, 185.06, 553.17, 0.48],
  [89.52, 70.94, 214.96, 0.6],
  [90.12, 70.94, 214.96, 0.6],
  [233.54, 309.53, 480.34, 0.84],
  [234.38, 309.53, 480.34, 0.84],
  [430.01, 71.66, 181.82, 0.48],
  [430.49, 71.66, 181.82, 0.48],
  [433.25, 182.3, 552.93, 0.48],
  [433.73, 182.3, 552.93, 0.48],
  [104.28, 71.18, 181.82, 3.24],
  [107.52, 71.18, 181.82, 3.24],
  [107.04, 182.3, 552.93, 0.48],
  [107.52, 182.3, 552.93, 0.48],
];

const toLines = (verticals: readonly number[][], horizontals: readonly number[][]): ClassifiedLine[] => [
  ...verticals.map(([x, yMin, yMax, thickness]) => ({
    orientation: "vertical" as const,
    x: x!,
    yMin: yMin!,
    yMax: yMax!,
    thickness: thickness!,
  })),
  ...horizontals.map(([y, xMin, xMax, thickness]) => ({
    orientation: "horizontal" as const,
    y: y!,
    xMin: xMin!,
    xMax: xMax!,
    thickness: thickness!,
  })),
];

describe("buildGridsFromVectorLines on the real marks of doc 07 (hyperlink underlines beside bordered tables)", () => {
  it("page 10: the table borders win the vote over the two ends of an underline (three columns, not no grid)", () => {
    const grids = buildGridsFromVectorLines(toLines(PAGE_10_VERTICALS, PAGE_10_HORIZONTALS));
    expect(grids).toHaveLength(1);
    const cols = grids[0]!.colBoundaries.map((c) => Math.round(c));
    expect(cols).toEqual([72, 197, 556]);
  });

  it("page 13: the two stacked tables are two grids, each with its own columns", () => {
    const grids = buildGridsFromVectorLines(toLines(PAGE_13_VERTICALS, PAGE_13_HORIZONTALS));
    expect(grids).toHaveLength(2);
    for (const g of grids) {
      const cols = g.colBoundaries.map((c) => Math.round(c));
      expect(cols[0]).toBeGreaterThanOrEqual(71);
      expect(cols[0]).toBeLessThanOrEqual(72);
      expect(cols[cols.length - 1]).toBe(553);
      expect(cols).toHaveLength(3);
    }
  });
});

/**
 * Safedocs 0000713, a third-party PDF of the measurement corpus, physical page 3: a two-column table of eight rows
 * whose RIGHT border is painted in three pieces ([168..168.8], [187.2..728], [747.2..748]), gaps of 18.4 and 19.2 pt,
 * while the LEFT border is one continuous line across them. The pieces are ONE separator and must stay one: a gap is
 * a cut only when no other vertical crosses it (`mergeCollinear`). Marks rounded to 0.01 pt, as read by `walkPage`.
 * FAILURE VALUE (measured with the plain "cut at every gap over 2 pt" rule): the right border loses its extent, so the
 * columns come out wrong or the grid disappears.
 */
describe("buildGridsFromVectorLines on the real marks of safedocs 0000713 page 3 (a border painted in pieces)", () => {
  const ROW_RULES = [168.4, 187.6, 306.8, 350.8, 470, 514.8, 634, 727.6, 747.6];
  it("a right border cut by two gaps, with the left border crossing them, is one separator: two columns", () => {
    const verticals = [
      [172.4, 168, 748, 0.8],
      [543.5, 168, 168.8, 0.8],
      [543.5, 187.2, 728, 0.8],
      [543.5, 747.2, 748, 0.8],
    ];
    const horizontals = ROW_RULES.map((y) => [y, 172, 544, 0.8]);
    const grids = buildGridsFromVectorLines(toLines(verticals, horizontals));
    expect(grids).toHaveLength(1);
    expect(grids[0]!.colBoundaries.map((c) => Math.round(c))).toEqual([172, 544]);
  });
});

/**
 * `fixtures/docx-reel/02-jvmalin-guide-api-Word.pdf`, physical page 13 (bench page 12): seven one-cell code boxes, two
 * of them wide (65.2 pt fills). Each box is painted as lying fills (13, 14.5, 8.6 and 36.1 pt thick), so its borders
 * merge into one vertical per side, plus an INNER pair (x = 74.9 and 520.7) on the wide boxes that is a second group
 * of two agreeing verticals. The vote takes the outer group first; the inner pair comes out on a later pass, inside
 * a band already accepted, and is dropped. Those dropped passes used to count against `MAX_REGIONS_PER_PAGE`: eight
 * passes were spent on six boxes and two dropped inner pairs, and the lowest box (the last by `hi`) was never
 * examined: "GET /v3/networks/{networkId}/stopPoints/{stopPointId}/schedules" came out as prose.
 * Marks as read by `walkPage` and rounded to 0.01 pt, `[position, from, to, thickness]`.
 */
describe("buildGridsFromVectorLines on the real marks of doc 02 page 13 (seven code boxes, two of them wide)", () => {
  const VERTICALS = [
    [472.17, 677.26, 713.38, 36.12],
    [72.02, 677.26, 713.38, 36.12],
    [469.29, 690.22, 704.74, 14.52],
    [74.9, 690.22, 704.74, 14.52],
    [472.17, 704.74, 713.38, 8.64],
    [72.02, 704.74, 713.38, 8.64],
    [472.17, 677.26, 690.22, 12.96],
    [72.02, 677.26, 690.22, 12.96],
    [476.49, 469.27, 505.39, 36.12],
    [72.02, 469.27, 505.39, 36.12],
    [473.49, 482.23, 496.75, 14.52],
    [74.9, 482.23, 496.75, 14.52],
    [476.49, 496.75, 505.39, 8.64],
    [72.02, 496.75, 505.39, 8.64],
    [476.37, 469.27, 482.23, 12.96],
    [72.02, 469.27, 482.23, 12.96],
    [480.09, 418.51, 454.75, 36.24],
    [72.02, 418.51, 454.75, 36.24],
    [477.21, 431.47, 446.11, 14.64],
    [74.9, 431.47, 446.11, 14.64],
    [480.09, 446.11, 454.75, 8.64],
    [72.02, 446.11, 454.75, 8.64],
    [480.09, 418.63, 431.59, 12.96],
    [72.02, 418.63, 431.59, 12.96],
    [523.53, 338.81, 403.99, 65.18],
    [72.02, 338.81, 403.99, 65.18],
    [520.65, 380.81, 395.35, 14.54],
    [74.9, 380.81, 395.35, 14.54],
    [520.65, 366.29, 380.81, 14.52],
    [74.9, 366.29, 380.81, 14.52],
    [520.65, 351.77, 366.29, 14.52],
    [74.9, 351.77, 366.29, 14.52],
    [523.53, 395.35, 403.99, 8.64],
    [72.02, 395.35, 403.99, 8.64],
    [523.53, 338.81, 351.77, 12.96],
    [72.02, 338.81, 351.77, 12.96],
    [523.53, 259.01, 324.17, 65.16],
    [72.02, 259.01, 324.17, 65.16],
    [520.65, 301.01, 315.53, 14.52],
    [74.9, 301.01, 315.53, 14.52],
    [520.65, 286.49, 301.01, 14.52],
    [74.9, 286.49, 301.01, 14.52],
    [520.65, 271.97, 286.49, 14.52],
    [74.9, 271.97, 286.49, 14.52],
    [523.53, 315.53, 324.17, 8.64],
    [72.02, 315.53, 324.17, 8.64],
    [523.53, 259.01, 271.97, 12.96],
    [72.02, 259.01, 271.97, 12.96],
    [414.07, 208.25, 244.37, 36.12],
    [72.02, 208.25, 244.37, 36.12],
    [411.07, 221.21, 235.73, 14.52],
    [74.9, 221.21, 235.73, 14.52],
    [414.07, 235.85, 244.49, 8.64],
    [72.02, 235.85, 244.49, 8.64],
    [413.95, 208.25, 221.21, 12.96],
    [72.02, 208.25, 221.21, 12.96],
    [417.69, 157.58, 193.7, 36.12],
    [72.02, 157.58, 193.7, 36.12],
    [414.81, 170.54, 185.06, 14.52],
    [74.9, 170.54, 185.06, 14.52],
    [417.69, 185.06, 193.7, 8.64],
    [72.02, 185.06, 193.7, 8.64],
    [417.69, 157.58, 170.54, 12.96],
    [72.02, 157.58, 170.54, 12.96],
  ];
  const HORIZONTALS = [
    [677.26, 72.02, 472.17, 36.12],
    [713.38, 72.02, 472.17, 36.12],
    [690.22, 74.9, 469.29, 14.52],
    [704.74, 74.9, 469.29, 14.52],
    [704.74, 72.02, 472.17, 8.64],
    [713.38, 72.02, 472.17, 8.64],
    [677.26, 72.02, 472.17, 12.96],
    [690.22, 72.02, 472.17, 12.96],
    [469.27, 72.02, 476.49, 36.12],
    [505.39, 72.02, 476.49, 36.12],
    [482.23, 74.9, 473.49, 14.52],
    [496.75, 74.9, 473.49, 14.52],
    [496.75, 72.02, 476.49, 8.64],
    [505.39, 72.02, 476.49, 8.64],
    [469.27, 72.02, 476.37, 12.96],
    [482.23, 72.02, 476.37, 12.96],
    [418.51, 72.02, 480.09, 36.24],
    [454.75, 72.02, 480.09, 36.24],
    [431.47, 74.9, 477.21, 14.64],
    [446.11, 74.9, 477.21, 14.64],
    [446.11, 72.02, 480.09, 8.64],
    [454.75, 72.02, 480.09, 8.64],
    [418.63, 72.02, 480.09, 12.96],
    [431.59, 72.02, 480.09, 12.96],
    [338.81, 72.02, 523.53, 65.18],
    [403.99, 72.02, 523.53, 65.18],
    [380.81, 74.9, 520.65, 14.54],
    [395.35, 74.9, 520.65, 14.54],
    [366.29, 74.9, 520.65, 14.52],
    [380.81, 74.9, 520.65, 14.52],
    [351.77, 74.9, 520.65, 14.52],
    [366.29, 74.9, 520.65, 14.52],
    [395.35, 72.02, 523.53, 8.64],
    [403.99, 72.02, 523.53, 8.64],
    [338.81, 72.02, 523.53, 12.96],
    [351.77, 72.02, 523.53, 12.96],
    [259.01, 72.02, 523.53, 65.16],
    [324.17, 72.02, 523.53, 65.16],
    [301.01, 74.9, 520.65, 14.52],
    [315.53, 74.9, 520.65, 14.52],
    [286.49, 74.9, 520.65, 14.52],
    [301.01, 74.9, 520.65, 14.52],
    [271.97, 74.9, 520.65, 14.52],
    [286.49, 74.9, 520.65, 14.52],
    [315.53, 72.02, 523.53, 8.64],
    [324.17, 72.02, 523.53, 8.64],
    [259.01, 72.02, 523.53, 12.96],
    [271.97, 72.02, 523.53, 12.96],
    [208.25, 72.02, 414.07, 36.12],
    [244.37, 72.02, 414.07, 36.12],
    [221.21, 74.9, 411.07, 14.52],
    [235.73, 74.9, 411.07, 14.52],
    [235.85, 72.02, 414.07, 8.64],
    [244.49, 72.02, 414.07, 8.64],
    [208.25, 72.02, 413.95, 12.96],
    [221.21, 72.02, 413.95, 12.96],
    [157.58, 72.02, 417.69, 36.12],
    [193.7, 72.02, 417.69, 36.12],
    [170.54, 74.9, 414.81, 14.52],
    [185.06, 74.9, 414.81, 14.52],
    [185.06, 72.02, 417.69, 8.64],
    [193.7, 72.02, 417.69, 8.64],
    [157.58, 72.02, 417.69, 12.96],
    [170.54, 72.02, 417.69, 12.96],
  ];
  it("finds all seven boxes, the lowest one included (eight passes are not eight regions)", () => {
    const grids = buildGridsFromVectorLines(toLines(VERTICALS, HORIZONTALS));
    expect(grids).toHaveLength(7);
    expect(Math.min(...grids.map((g) => g.rowBoundaries[g.rowBoundaries.length - 1]!))).toBeCloseTo(157.6, 0);
  });
});

/**
 * COST OF A DENSE PAGE (01/10/2026 review, measured). `mergeCollinear` with `cutUncrossedGaps` leaves one piece per
 * painted segment when nothing crosses the gaps, and the vote and the crossing test were quadratic in the pieces:
 * 10 000 short aligned pieces cost 1.9 s and 20 000 cost 7.1 s per page (4 800: 49 ms). The reference functions below
 * are the pre-fix algorithms, kept verbatim as the oracle: the indexed versions must return the SAME results.
 */
const referenceMerge = (segments: readonly MergedLine[], cutUncrossedGaps = false): MergedLine[] => {
  const positions = clusterPositions(segments.map((s) => s.at));
  const unionOf = (members: readonly MergedLine[], at: number): MergedLine => ({
    at,
    lo: Math.min(...members.map((m) => m.lo)),
    hi: Math.max(...members.map((m) => m.hi)),
    thickness: Math.min(...members.map((m) => m.thickness)),
  });
  const membersAt = (at: number): MergedLine[] => segments.filter((s) => Math.abs(s.at - at) <= CLUSTER_TOLERANCE);
  if (!cutUncrossedGaps) return positions.map((at) => unionOf(membersAt(at), at));
  const runsByPosition = positions.map((at) => {
    const runs: MergedLine[] = [];
    for (const m of membersAt(at).sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
      const last = runs[runs.length - 1];
      if (last !== undefined && m.lo <= last.hi + CLUSTER_TOLERANCE) {
        last.hi = Math.max(last.hi, m.hi);
        last.thickness = Math.min(last.thickness, m.thickness);
      } else runs.push({ at, lo: m.lo, hi: m.hi, thickness: m.thickness });
    }
    return runs;
  });
  const crossed = (a: MergedLine, b: MergedLine): boolean =>
    runsByPosition.some(
      (runs) =>
        runs.length > 0 &&
        Math.abs(runs[0]!.at - a.at) > CLUSTER_TOLERANCE &&
        runs.some((r) => r.lo <= a.hi + CLUSTER_TOLERANCE && r.hi >= b.lo - CLUSTER_TOLERANCE),
    );
  return runsByPosition.flatMap((runs) => {
    const out: MergedLine[] = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last !== undefined && crossed(last, r)) {
        last.hi = Math.max(last.hi, r.hi);
        last.thickness = Math.min(last.thickness, r.thickness);
      } else out.push({ ...r });
    }
    return out;
  });
};

const referenceVote = (lines: readonly MergedLine[]): { extent: MergedLine; members: MergedLine[] } | undefined => {
  let best: { extent: MergedLine; members: MergedLine[] } | undefined;
  for (const seed of lines) {
    const agreeing = lines.filter(
      (o) => Math.abs(o.lo - seed.lo) <= CLUSTER_TOLERANCE && Math.abs(o.hi - seed.hi) <= CLUSTER_TOLERANCE,
    );
    const better =
      best === undefined ||
      agreeing.length > best.members.length ||
      (agreeing.length === best.members.length &&
        (seed.hi > best.extent.hi || (seed.hi === best.extent.hi && seed.lo < best.extent.lo)));
    if (better) best = { extent: seed, members: agreeing };
  }
  return best;
};

/** A deterministic pseudo-random sequence (a test fixture, not product code). */
const sequence = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

/** `columns` abscissae, each painted as `pieces` separate pieces of 10 pt with a 4 pt gap that no other abscissa bridges. */
const pieceMarks = (columns: number, pieces: number): MergedLine[] =>
  Array.from({ length: columns }, (_, c) =>
    Array.from({ length: pieces }, (_, p) => ({ at: 20 + c * 10, lo: p * 14, hi: p * 14 + 10, thickness: 0.5 })),
  ).flat();

describe("mergeCollinear and largestAgreeingExtent: indexed, and equal to the pre-fix algorithms", () => {
  it("returns exactly what the quadratic algorithms returned, on random marks with jitter, chains, gaps and bridges", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = sequence(seed);
      const count = 5 + Math.floor(next() * 120);
      const marks: MergedLine[] = Array.from({ length: count }, () => {
        const lo = Math.floor(next() * 40) * 5 + (next() < 0.3 ? next() * 2.5 : 0);
        return {
          at: Math.floor(next() * 12) * 7 + (next() < 0.5 ? next() * 3 : 0),
          lo,
          hi: lo + 1 + Math.floor(next() * 12) * 5 + (next() < 0.3 ? next() * 2.5 : 0),
          thickness: next() < 0.3 ? 3 + next() * 20 : next() * 2,
        };
      });
      for (const cut of [false, true]) {
        expect(mergeCollinear(marks, cut), `merge seed ${seed} cut ${cut}`).toEqual(referenceMerge(marks, cut));
      }
      const merged = referenceMerge(marks, true);
      const got = largestAgreeingExtent(merged);
      const want = referenceVote(merged);
      expect(got?.extent, `vote seed ${seed}`).toEqual(want?.extent);
      expect(
        got?.members.map((m) => merged.indexOf(m)),
        `members seed ${seed}`,
      ).toEqual(want?.members.map((m) => merged.indexOf(m)));
    }
  });

  it("does not choke on 20 000 short aligned pieces (the pre-fix merge alone took 7 s)", () => {
    const marks = pieceMarks(40, 500);
    const start = performance.now();
    const merged = mergeCollinear(marks, true);
    const vote = largestAgreeingExtent(merged.slice(0, 2_000));
    const elapsed = performance.now() - start;
    expect(merged).toHaveLength(20_000);
    expect(vote).toBeDefined();
    expect(elapsed).toBeLessThan(1_000);
  });

  it("abstains from vector grids on a page whose merged verticals exceed the cap, and finds the grid just under it", () => {
    const grid = (columns: number) =>
      buildGridsFromVectorLines(
        toLines(
          Array.from({ length: columns }, (_, i) => [i * 5, 0, 100, 0.5]),
          [
            [0, 0, columns * 5, 0.5],
            [50, 0, columns * 5, 0.5],
            [100, 0, columns * 5, 0.5],
          ],
        ),
      );
    expect(grid(MAX_MERGED_VERTICALS_PER_PAGE)).toHaveLength(1);
    expect(grid(MAX_MERGED_VERTICALS_PER_PAGE + 1)).toEqual([]);
  });

  it("stays fast on a dense page of separate pieces (the pre-fix page of 10 000 pieces took 1.9 s)", () => {
    const verticals = pieceMarks(40, 250).map((m) => [m.at, m.lo, m.hi, m.thickness]);
    const start = performance.now();
    buildGridsFromVectorLines(
      toLines(verticals, [
        [0, 20, 410, 0.5],
        [140, 20, 410, 0.5],
        [280, 20, 410, 0.5],
      ]),
    );
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

/**
 * The ruling marks of physical page 18 of the same document (the "Cohorts" table under "Section Five: Safe Data", a 3 x 2
 * bordered table below a long bordered table), same extraction as above, fills thicker than 3.24 pt left out. The first
 * pass elects the long table; the second used to elect the two ends of ONE hyperlink underline (x 242.57 and 539.38,
 * 2 votes, against 1 for each border of the Cohorts table), found no region there, and ended the search: the Cohorts
 * table was never examined and its words flowed as prose.
 */
const PAGE_18_VERTICALS = [
  [539.38, 696.58, 697.42, 0.84],
  [242.57, 696.58, 697.42, 0.84],
  [211.13, 681.7, 682.54, 0.84],
  [187.73, 681.7, 682.54, 0.84],
  [384.55, 622.18, 623.02, 0.84],
  [187.73, 622.18, 623.02, 0.84],
  [71.78, 739.78, 742.3, 0.48],
  [71.3, 739.78, 742.3, 0.48],
  [71.78, 742.3, 745.06, 0.48],
  [71.3, 742.3, 745.06, 0.48],
  [184.58, 742.3, 745.06, 2.76],
  [71.78, 742.3, 745.06, 2.76],
  [184.58, 739.78, 742.3, 2.52],
  [71.78, 739.78, 742.3, 2.52],
  [185.06, 739.78, 745.06, 0.48],
  [184.58, 739.78, 745.06, 0.48],
  [553.66, 739.78, 745.06, 0.48],
  [553.18, 739.78, 745.06, 0.48],
  [71.78, 605.74, 739.78, 0.48],
  [71.3, 605.74, 739.78, 0.48],
  [185.06, 605.74, 739.78, 0.48],
  [184.58, 605.74, 739.78, 0.48],
  [553.66, 605.74, 739.78, 0.48],
  [553.18, 605.74, 739.78, 0.48],
  [71.78, 600.43, 605.73, 0.48],
  [71.3, 600.43, 605.73, 0.48],
  [184.58, 602.98, 605.74, 2.76],
  [71.78, 602.98, 605.74, 2.76],
  [184.58, 600.43, 602.97, 2.54],
  [71.78, 600.43, 602.97, 2.54],
  [185.06, 600.43, 605.73, 0.48],
  [184.58, 600.43, 605.73, 0.48],
  [553.66, 600.43, 605.73, 0.48],
  [553.18, 600.43, 605.73, 0.48],
  [71.78, 543.79, 600.43, 0.48],
  [71.3, 543.79, 600.43, 0.48],
  [185.06, 543.79, 600.43, 0.48],
  [184.58, 543.79, 600.43, 0.48],
  [553.66, 543.79, 600.43, 0.48],
  [553.18, 543.79, 600.43, 0.48],
  [71.78, 538.51, 543.79, 0.48],
  [71.3, 538.51, 543.79, 0.48],
  [184.58, 541.03, 543.79, 2.76],
  [71.78, 541.03, 543.79, 2.76],
  [184.58, 538.51, 541.03, 2.52],
  [71.78, 538.51, 541.03, 2.52],
  [185.06, 538.51, 543.79, 0.48],
  [184.58, 538.51, 543.79, 0.48],
  [553.66, 538.51, 543.79, 0.48],
  [553.18, 538.51, 543.79, 0.48],
  [71.78, 419.93, 538.51, 0.48],
  [71.3, 419.93, 538.51, 0.48],
  [185.06, 419.93, 538.51, 0.48],
  [184.58, 419.93, 538.51, 0.48],
  [553.66, 419.93, 538.51, 0.48],
  [553.18, 419.93, 538.51, 0.48],
  [71.78, 414.65, 419.93, 0.48],
  [71.3, 414.65, 419.93, 0.48],
  [184.58, 417.17, 419.93, 2.76],
  [71.78, 417.17, 419.93, 2.76],
  [184.58, 414.65, 417.17, 2.52],
  [71.78, 414.65, 417.17, 2.52],
  [185.06, 414.65, 419.93, 0.48],
  [184.58, 414.65, 419.93, 0.48],
  [553.66, 414.65, 419.93, 0.48],
  [553.18, 414.65, 419.93, 0.48],
  [71.78, 354.05, 414.65, 0.48],
  [71.3, 354.05, 414.65, 0.48],
  [185.06, 354.05, 414.65, 0.48],
  [184.58, 354.05, 414.65, 0.48],
  [553.66, 354.05, 414.65, 0.48],
  [553.18, 354.05, 414.65, 0.48],
  [71.78, 348.77, 354.05, 0.48],
  [71.3, 348.77, 354.05, 0.48],
  [184.58, 351.29, 354.05, 2.76],
  [71.78, 351.29, 354.05, 2.76],
  [184.58, 348.77, 351.29, 2.52],
  [71.78, 348.77, 351.29, 2.52],
  [185.06, 348.77, 354.05, 0.48],
  [184.58, 348.77, 354.05, 0.48],
  [553.66, 348.77, 354.05, 0.48],
  [553.18, 348.77, 354.05, 0.48],
  [71.78, 300.29, 348.77, 0.48],
  [71.3, 300.29, 348.77, 0.48],
  [185.06, 300.29, 348.77, 0.48],
  [184.58, 300.29, 348.77, 0.48],
  [553.66, 300.29, 348.77, 0.48],
  [553.18, 300.29, 348.77, 0.48],
  [71.78, 295.01, 300.29, 0.48],
  [71.3, 295.01, 300.29, 0.48],
  [184.58, 297.53, 300.29, 2.76],
  [71.78, 297.53, 300.29, 2.76],
  [184.58, 295.01, 297.53, 2.52],
  [71.78, 295.01, 297.53, 2.52],
  [185.06, 295.01, 300.29, 0.48],
  [184.58, 295.01, 300.29, 0.48],
  [553.66, 295.01, 300.29, 0.48],
  [553.18, 295.01, 300.29, 0.48],
  [71.78, 259.1, 295, 0.48],
  [71.3, 259.1, 295, 0.48],
  [185.06, 259.1, 295, 0.48],
  [184.58, 259.1, 295, 0.48],
  [553.66, 259.1, 295, 0.48],
  [553.18, 259.1, 295, 0.48],
  [71.42, 217.94, 221.18, 0.48],
  [70.94, 217.94, 221.18, 0.48],
  [147.86, 217.94, 221.18, 3.24],
  [71.42, 217.94, 221.18, 3.24],
  [148.34, 217.46, 221.18, 0.48],
  [147.86, 217.46, 221.18, 0.48],
  [555.46, 217.46, 221.18, 0.48],
  [554.98, 217.46, 221.18, 0.48],
  [71.42, 136.34, 217.46, 0.48],
  [70.94, 136.34, 217.46, 0.48],
  [147.86, 133.58, 136.34, 2.76],
  [70.94, 133.58, 136.34, 2.76],
  [148.34, 136.34, 217.46, 0.48],
  [147.86, 136.34, 217.46, 0.48],
  [555.46, 136.34, 217.46, 0.48],
  [554.98, 136.34, 217.46, 0.48],
];

const PAGE_18_HORIZONTALS = [
  [696.58, 242.57, 539.38, 0.84],
  [697.42, 242.57, 539.38, 0.84],
  [681.7, 187.73, 211.13, 0.84],
  [682.54, 187.73, 211.13, 0.84],
  [622.18, 187.73, 384.55, 0.84],
  [623.02, 187.73, 384.55, 0.84],
  [742.3, 71.78, 184.58, 2.76],
  [745.06, 71.78, 184.58, 2.76],
  [739.78, 71.78, 184.58, 2.52],
  [742.3, 71.78, 184.58, 2.52],
  [744.58, 185.06, 553.17, 0.48],
  [745.06, 185.06, 553.17, 0.48],
  [602.98, 71.78, 184.58, 2.76],
  [605.74, 71.78, 184.58, 2.76],
  [600.43, 71.78, 184.58, 2.54],
  [602.97, 71.78, 184.58, 2.54],
  [605.26, 185.06, 553.17, 0.48],
  [605.74, 185.06, 553.17, 0.48],
  [541.03, 71.78, 184.58, 2.76],
  [543.79, 71.78, 184.58, 2.76],
  [538.51, 71.78, 184.58, 2.52],
  [541.03, 71.78, 184.58, 2.52],
  [543.31, 185.06, 553.17, 0.48],
  [543.79, 185.06, 553.17, 0.48],
  [417.17, 71.78, 184.58, 2.76],
  [419.93, 71.78, 184.58, 2.76],
  [414.65, 71.78, 184.58, 2.52],
  [417.17, 71.78, 184.58, 2.52],
  [419.45, 185.06, 553.17, 0.48],
  [419.93, 185.06, 553.17, 0.48],
  [351.29, 71.78, 184.58, 2.76],
  [354.05, 71.78, 184.58, 2.76],
  [348.77, 71.78, 184.58, 2.52],
  [351.29, 71.78, 184.58, 2.52],
  [353.57, 185.06, 553.17, 0.48],
  [354.05, 185.06, 553.17, 0.48],
  [297.53, 71.78, 184.58, 2.76],
  [300.29, 71.78, 184.58, 2.76],
  [295.01, 71.78, 184.58, 2.52],
  [297.53, 71.78, 184.58, 2.52],
  [299.81, 185.06, 553.17, 0.48],
  [300.29, 185.06, 553.17, 0.48],
  [258.62, 185.06, 553.17, 0.48],
  [259.1, 185.06, 553.17, 0.48],
  [217.94, 71.42, 147.86, 3.24],
  [221.18, 71.42, 147.86, 3.24],
  [217.46, 71.42, 147.86, 0.48],
  [217.94, 71.42, 147.86, 0.48],
  [220.7, 148.34, 554.97, 0.48],
  [221.18, 148.34, 554.97, 0.48],
  [133.58, 70.94, 147.86, 2.76],
  [136.34, 70.94, 147.86, 2.76],
  [135.86, 148.34, 554.97, 0.48],
  [136.34, 148.34, 554.97, 0.48],
];

describe("buildGridsFromVectorLines on the real marks of doc 07 page 18 (a table below a table, underline ends in between)", () => {
  it("finds the Cohorts table after the long table, past a vote won by the ends of one underline", () => {
    const grids = buildGridsFromVectorLines(toLines(PAGE_18_VERTICALS, PAGE_18_HORIZONTALS));
    const bottoms = grids.map((g) => Math.round(g.rowBoundaries[g.rowBoundaries.length - 1]!));
    expect(bottoms).toContain(136);
    const cohorts = grids.find((g) => Math.round(g.rowBoundaries[g.rowBoundaries.length - 1]!) === 136)!;
    expect(cohorts.colBoundaries.map((c) => Math.round(c))).toEqual([72, 148, 554]);
  });
});

/**
 * A search that goes on past a FAILED vote (the two ends of one underline, which tie with a real table and win by sitting
 * higher). Synthetic marks, built like doc 07 p18: a first table T1 (three borders agreeing, taken first), then the underline
 * (2 votes), then T2 whose two outer borders agree (2 votes, lower on the page) and whose middle border is shorter.
 */
describe("buildGridsFromVectorLines past a failed vote (doc 07 p18)", () => {
  const v = (x: number, yMin: number, yMax: number, thickness = 0.48): ClassifiedLine => ({
    orientation: "vertical",
    x,
    yMin,
    yMax,
    thickness,
  });
  const h = (y: number, xMin: number, xMax: number, thickness = 0.48): ClassifiedLine => ({
    orientation: "horizontal",
    y,
    xMin,
    xMax,
    thickness,
  });
  const t1 = [v(50, 400, 700), v(300, 400, 700), v(550, 400, 700), h(700, 50, 550), h(550, 50, 550), h(400, 50, 550)];
  /** Two thin ends of one hyperlink underline, 0.84 pt tall, higher than T2. */
  const underline = (y: number, x1: number, x2: number): ClassifiedLine[] => [
    v(x1, y, y + 0.84, 0.84),
    v(x2, y, y + 0.84, 0.84),
  ];
  const t2 = [v(50, 100, 300), v(550, 100, 300), v(300, 100, 250), h(300, 50, 550), h(200, 50, 550), h(100, 50, 550)];
  const tops = (lines: ClassifiedLine[]): number[] => buildGridsFromVectorLines(lines).map((g) => g.rowBoundaries[0]!);

  it("finds T2 after the first table and a failed vote: exactly the two grids, a 2 x 2 accepted", () => {
    const grids = buildGridsFromVectorLines([...t1, ...underline(790, 100, 400), ...t2]);
    expect(grids.map((g) => [g.rowBoundaries.length - 1, g.colBoundaries.length - 1])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(tops([...t1, ...underline(790, 100, 400), ...t2])).toEqual([700, 300]);
  });

  it("keeps the old brake on a page with no accepted grid yet: the failed vote ends the search", () => {
    expect(buildGridsFromVectorLines([...underline(790, 100, 400), ...t2])).toEqual([]);
  });

  it("two consecutive failed votes end the search", () => {
    expect(tops([...t1, ...underline(790, 100, 400), ...underline(770, 120, 420), ...t2])).toEqual([700]);
  });

  it("accepts a one-row strip after a failed vote (27/10/2026: the Cohorts fragment of 07 p18 IS this shape and the Word truth holds one row; junk strips are absorbed downstream, measured on five documents)", () => {
    const strip = [v(50, 100, 300), v(550, 100, 300), v(300, 100, 250), h(300, 50, 550), h(100, 50, 550)];
    expect(tops([...t1, ...underline(790, 100, 400), ...strip])).toEqual([700, 300]);
  });

  it("accepts a one-column box after a failed vote: the render flattens a one-content-column region, so nothing tabular leaks (27/10/2026)", () => {
    const box = [v(50, 100, 300), v(550, 100, 300), h(300, 50, 550), h(200, 50, 550), h(100, 50, 550)];
    expect(tops([...t1, ...underline(790, 100, 400), ...box])).toEqual([700, 300]);
  });

  // Licence 2, not 3: an earlier guard refused to reopen the search on a title strip, for fear of a cascade that a
  // later measure did not reproduce.
  it("a one-row strip licenses the search past a failed vote (licence 2 since 28/10/2026)", () => {
    const title = [v(50, 400, 700), v(300, 400, 700), v(550, 400, 700), h(700, 50, 550), h(400, 50, 550)];
    expect(tops([...title, ...underline(790, 100, 400), ...t2])).toEqual([700, 300]);
  });
});
