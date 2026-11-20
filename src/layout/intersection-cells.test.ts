import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildGridsFromVectorLines,
  findCellsByIntersection,
  isBoxesInVoidsRegion,
  type CellRect,
  type ClassifiedLine,
  type TableGrid,
} from "./geometry";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "boxes-in-voids.fixture.json"), "utf8")) as {
  diagram05p0: ClassifiedLine[];
  libya10: ClassifiedLine[];
};

const box = (xLeft: number, xRight: number, yBottom: number, yTop: number): CellRect => ({
  xLeft,
  xRight,
  yBottom,
  yTop,
});
const gridAround = (cells: readonly CellRect[]): TableGrid => ({
  colBoundaries: [Math.min(...cells.map((c) => c.xLeft)), Math.max(...cells.map((c) => c.xRight))],
  rowBoundaries: [Math.max(...cells.map((c) => c.yTop)), Math.min(...cells.map((c) => c.yBottom))],
});

describe("isBoxesInVoidsRegion on real marks", () => {
  it("05-Groupes-tournes2 p0: two boxes with a void between them (the page background must not count) is NOT a table", () => {
    const cells = findCellsByIntersection(fixture.diagram05p0);
    const grids = buildGridsFromVectorLines(fixture.diagram05p0);
    expect(grids).toHaveLength(1);
    expect(cells).toHaveLength(3); // two boxes + the 960x540 background fill
    expect(isBoxesInVoidsRegion(grids[0]!, cells)).toBe(true);
  });

  it("05-libya p10: the 2x4 table of touching cells is kept", () => {
    const cells = findCellsByIntersection(fixture.libya10);
    const grids = buildGridsFromVectorLines(fixture.libya10);
    expect(grids).toHaveLength(1);
    expect(cells).toHaveLength(8);
    expect(isBoxesInVoidsRegion(grids[0]!, cells)).toBe(false);
  });
});

describe("isBoxesInVoidsRegion on constructed cells", () => {
  it("a lone box stays a (1x1) table: one painted cell is not enough", () => {
    const cells = [box(0, 100, 0, 50)];
    expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(false);
  });

  it("two cells sharing an edge touch", () => {
    const cells = [box(0, 100, 0, 50), box(100, 200, 0, 50)];
    expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(false);
  });

  it("two boxes 40 pt apart do not touch", () => {
    const cells = [box(0, 100, 0, 50), box(140, 240, 0, 50)];
    expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(true);
  });

  it("a corner-only contact does not count as touching", () => {
    const cells = [box(0, 100, 0, 50), box(100, 200, 50, 100)];
    expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(true);
  });

  it("a region where any two cells touch is kept, even with a lone box beside them", () => {
    const cells = [box(0, 100, 0, 50), box(100, 200, 0, 50), box(400, 500, 0, 50)];
    expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(false);
  });

  it("a cell that encloses another is ignored (page background fill)", () => {
    const cells = [box(0, 960, 0, 540), box(30, 140, 70, 115), box(30, 140, 380, 427)];
    expect(isBoxesInVoidsRegion(gridAround(cells.slice(1)), cells)).toBe(true);
  });

  it("cells outside the grid extent are not the region's cells", () => {
    const cells = [box(0, 100, 0, 50), box(500, 600, 0, 50)];
    expect(isBoxesInVoidsRegion({ colBoundaries: [0, 100], rowBoundaries: [50, 0] }, cells)).toBe(false);
  });
});

/**
 * COST OF A BIG REGION (01/10/2026 review, measured): the enclosure filter compared every cell with every other one,
 * 7 ms for 1 000 cells and 334 ms for 8 000, per grid and per page. The oracle below is the pre-fix function, verbatim.
 */
describe("isBoxesInVoidsRegion: indexed, and equal to the pre-fix quadratic version", () => {
  const T = 2;
  const referenceEncloses = (outer: CellRect, inner: CellRect): boolean =>
    outer.xLeft <= inner.xLeft &&
    outer.xRight >= inner.xRight &&
    outer.yBottom <= inner.yBottom &&
    outer.yTop >= inner.yTop &&
    (outer.xLeft < inner.xLeft ||
      outer.xRight > inner.xRight ||
      outer.yBottom < inner.yBottom ||
      outer.yTop > inner.yTop);
  const referenceTouches = (a: CellRect, b: CellRect): boolean => {
    const xOverlap = Math.min(a.xRight, b.xRight) - Math.max(a.xLeft, b.xLeft);
    const yOverlap = Math.min(a.yTop, b.yTop) - Math.max(a.yBottom, b.yBottom);
    return (xOverlap >= -T && yOverlap > T) || (yOverlap >= -T && xOverlap > T);
  };
  const reference = (grid: TableGrid, cells: readonly CellRect[]): boolean => {
    if (grid.colBoundaries.length === 0 || grid.rowBoundaries.length === 0) return false;
    const xMin = Math.min(...grid.colBoundaries) - T;
    const xMax = Math.max(...grid.colBoundaries) + T;
    const yMin = Math.min(...grid.rowBoundaries) - T;
    const yMax = Math.max(...grid.rowBoundaries) + T;
    const inside = cells.filter((c) => c.xLeft >= xMin && c.xRight <= xMax && c.yBottom >= yMin && c.yTop <= yMax);
    const boxes = inside.filter((c) => !inside.some((o) => o !== c && referenceEncloses(c, o)));
    if (boxes.length < 2) return false;
    return boxes.every((c, i) => boxes.every((o, j) => i === j || !referenceTouches(c, o)));
  };
  const sequence = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  };

  it("agrees with the pre-fix version on random layouts of boxes, nested boxes, touching boxes and corner contacts", () => {
    let trues = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const next = sequence(seed);
      const count = 1 + Math.floor(next() * 14);
      const spread = next() < 0.5 ? 30 : 120;
      const cells = Array.from({ length: count }, () => {
        const xLeft = Math.floor(next() * spread);
        const yBottom = Math.floor(next() * spread);
        return box(xLeft, xLeft + 3 + Math.floor(next() * 25), yBottom, yBottom + 3 + Math.floor(next() * 25));
      });
      const grid = gridAround(cells);
      const want = reference(grid, cells);
      if (want) trues++;
      expect(isBoxesInVoidsRegion(grid, cells), `seed ${seed}`).toBe(want);
    }
    expect(trues).toBeGreaterThan(20);
  });

  it("stays fast when cells share a left edge: one tall column, full-width bands (window on x only: 1.8 s for 20 000)", () => {
    const n = 20_000;
    const column = Array.from({ length: n }, (_, i) => box(0, 10, i * 20, i * 20 + 10));
    const bands = Array.from({ length: n }, (_, i) => box(0, 1_000, i * 20, i * 20 + 10));
    const touching = Array.from({ length: n }, (_, i) => box(0, 10, i * 10, i * 10 + 10));
    for (const [cells, expected] of [
      [column, true],
      [bands, true],
      [touching, false],
    ] as const) {
      const start = performance.now();
      expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(expected);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it("agrees with the pre-fix version on random layouts sharing left edges and tall cells", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = sequence(seed * 7919);
      const count = 2 + Math.floor(next() * 14);
      const cells = Array.from({ length: count }, () => {
        const xLeft = Math.floor(next() * 3) * 10;
        const yBottom = Math.floor(next() * 80);
        return box(
          xLeft,
          xLeft + 3 + Math.floor(next() * 25),
          yBottom,
          yBottom + 2 + Math.floor(next() * (next() < 0.2 ? 70 : 12)),
        );
      });
      const grid = gridAround(cells);
      expect(isBoxesInVoidsRegion(grid, cells), `seed ${seed}`).toBe(reference(grid, cells));
    }
  });

  it("stays fast on 8 000 cells, isolated or tiled (pre-fix: 7.5 s on the isolated page)", () => {
    const side = 90;
    const isolated = Array.from({ length: side * side }, (_, i) =>
      box((i % side) * 20, (i % side) * 20 + 10, Math.floor(i / side) * 20, Math.floor(i / side) * 20 + 10),
    );
    const tiled = Array.from({ length: side * side }, (_, i) =>
      box((i % side) * 10, (i % side) * 10 + 10, Math.floor(i / side) * 10, Math.floor(i / side) * 10 + 10),
    );
    for (const [cells, expected] of [
      [isolated, true],
      [tiled, false],
    ] as const) {
      const start = performance.now();
      expect(isBoxesInVoidsRegion(gridAround(cells), cells)).toBe(expected);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});
