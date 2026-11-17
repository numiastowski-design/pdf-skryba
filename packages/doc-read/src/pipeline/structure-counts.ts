/** Arithmetic on `StructureCounts` (`lib/reader-types.ts`), the numbers the structure control counts: a zero, a sum, a signed difference, a count of
 *  one heading of a level. Pure functions of numbers.
 *  NOT here: counting anything (`pipeline/published-structure.ts` for the page, `pipeline/source-structure-*.ts` and the `source-reading-*.ts`
 *  for a source), comparing a source with a page (`pipeline/structure-conservation.ts`).
 *  Called by: `pipeline/published-structure.ts`, `pipeline/structure-conservation.ts`, `pipeline/source-structure-*.ts`, `pipeline/source-reading-*.ts`. */

import type { StructureCounts } from "doc-ir/lib/reader-types";

export type HeadingLevels = StructureCounts["headingsByLevel"];

/** A fresh all-zero count: a caller that increments it owns it. */
export const emptyCounts = (): StructureCounts => ({
  headings: 0,
  headingsByLevel: [0, 0, 0, 0, 0, 0],
  tables: 0,
  cells: 0,
  items: 0,
  rows: 0,
});

const combine = (a: StructureCounts, b: StructureCounts, sign: 1 | -1): StructureCounts => ({
  headings: a.headings + sign * b.headings,
  headingsByLevel: a.headingsByLevel.map((n, i) => n + sign * b.headingsByLevel[i]!) as HeadingLevels,
  tables: a.tables + sign * b.tables,
  cells: a.cells + sign * b.cells,
  items: a.items + sign * b.items,
  rows: a.rows + sign * b.rows,
});

export const addCounts = (a: StructureCounts, b: StructureCounts): StructureCounts => combine(a, b, 1);
export const subtractCounts = (a: StructureCounts, b: StructureCounts): StructureCounts => combine(a, b, -1);

/** One more heading of `level` (1 to 6; any other level counts in the total only, which a reading never produces). */
export const addHeading = (counts: StructureCounts, level: number): void => {
  counts.headings++;
  if (level >= 1 && level <= 6) counts.headingsByLevel[level - 1]!++;
};

/** True when every number is zero. */
export const isZeroCounts = (counts: StructureCounts): boolean =>
  counts.headings === 0 &&
  counts.tables === 0 &&
  counts.cells === 0 &&
  counts.items === 0 &&
  counts.rows === 0 &&
  counts.headingsByLevel.every((n) => n === 0);
