/** Interval arithmetic on one axis: merging near or overlapping spans, the length they cover, and the binary search
 *  the grid code uses on sorted lists.
 *  NOT here: the tolerance. Each caller passes its own, named and justified where it is used
 *  (`layout/intersection-cells.ts`: ink continuity; `layout/merged-cells.ts`: none).
 *  Called by: `layout/intersection-cells.ts`, `layout/merged-cells.ts`, `layout/vector-grid.ts`. */

export interface Interval {
  lo: number;
  hi: number;
}

/** The spans sorted by start, then joined when one starts at most `tolerance` after the previous one ends. */
export const mergeIntervals = (spans: readonly Interval[], tolerance: number): Interval[] => {
  const sorted = [...spans].sort((a, b) => a.lo - b.lo);
  const out: Interval[] = [];
  let run: Interval | undefined;
  for (const s of sorted) {
    if (run !== undefined && s.lo <= run.hi + tolerance) run = { lo: run.lo, hi: Math.max(run.hi, s.hi) };
    else {
      if (run !== undefined) out.push(run);
      run = { lo: s.lo, hi: s.hi };
    }
  }
  if (run !== undefined) out.push(run);
  return out;
};

/** Total length covered by possibly overlapping intervals: adding them up would count twice what is painted twice. */
export const unionLength = (intervals: readonly (readonly [number, number])[]): number => {
  let total = 0;
  for (const run of mergeIntervals(
    intervals.map(([lo, hi]) => ({ lo, hi })),
    0,
  ))
    total += run.hi - run.lo;
  return total;
};

/** The first index in `[0, length]` whose `predicate` holds, for a predicate that is false then true. */
export function lowerBound(length: number, predicate: (index: number) => boolean): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (predicate(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
