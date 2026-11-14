/** What counts as the SAME position on a page: the tolerance that merges
 *  near-duplicate coordinates into one line, and the minimum number of
 *  boundaries below which there is no grid at all.
 *  NOT here: what is done with the clusters — grids from painted lines
 *  (`layout/vector-grid.ts`), from aligned columns (`layout/aligned-grid.ts`),
 *  cells from intersections (`layout/intersection-cells.ts`).
 *  Called by: those three modules, `layout/cell-text.ts`, and the
 *  `layout/geometry.ts` façade. */
import { SAME_POSITION_PT } from "./tolerances";

// Two line positions within this many PDF points are the same grid line —
// real-world stroked lines/rectangle edges are never pixel-perfect
// duplicates even when the PDF generator intended one straight border.
export const CLUSTER_TOLERANCE = SAME_POSITION_PT;

// A grid needs at least this many boundary lines per axis (⇒ at least one
// real row/column) — two collinear points don't make a table.
export const MIN_BOUNDARIES = 2;

export interface PositionGroup<T> {
  center: number;
  members: T[];
}

/** Groups items by CHAINING: sorted by position, an item joins the group while it is within `tolerance` of the group's
 *  LAST member (so a border painted at 100, 102, 104, 106 is one group of centre 103). The group's members are exactly the
 *  items chained, never a window around the centre. Sorted ascending by position (stable for equal positions).
 *  Other groupers differ on purpose: `pdf-bands.ts#columnEdge` and `pdf-line-breaks.ts#valueColumnStarts` ANCHOR on the
 *  first key seen, `slide-layout.ts#chainedGroups` and `gutter.ts` chain with their own tolerance. */
export function clusterGroups<T>(items: readonly T[], positionOf: (item: T) => number, tolerance = CLUSTER_TOLERANCE): PositionGroup<T>[] {
  if (items.length === 0) return [];
  const sorted = items.map((item) => ({ item, at: positionOf(item) })).sort((a, b) => a.at - b.at);
  const groups: { at: number[]; members: T[] }[] = [{ at: [sorted[0]!.at], members: [sorted[0]!.item] }];
  for (let i = 1; i < sorted.length; i++) {
    const { item, at } = sorted[i]!;
    const current = groups[groups.length - 1]!;
    if (at - current.at[current.at.length - 1]! <= tolerance) {
      current.at.push(at);
      current.members.push(item);
    } else groups.push({ at: [at], members: [item] });
  }
  return groups.map((g) => ({ center: g.at.reduce((a, b) => a + b, 0) / g.at.length, members: g.members }));
}

/** Merges near-duplicate positions (e.g. the same intended border line,
 *  stroked as several path segments with slightly different endpoints)
 *  into cluster centers. Input order doesn't matter; output is sorted
 *  ascending — callers that need descending (rows) reverse it themselves. */
export function clusterPositions(values: readonly number[], tolerance = CLUSTER_TOLERANCE): number[] {
  return clusterGroups(values, (v) => v, tolerance).map((g) => g.center);
}
