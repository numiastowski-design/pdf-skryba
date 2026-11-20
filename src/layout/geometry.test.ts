import { describe, expect, it } from "vitest";
import {
  assignFragmentsToCells,
  buildGridFromAlignedRows,
  buildGridFromVectorLines,
  buildGridsFromVectorLines,
  withoutImageFrames,
  classifyLineSegment,
  findCellsByIntersection,
  clusterPositions,
  detectAlignedColumns,
  detectColumnGutter,
  groupFragmentsIntoRowBands,
  groupFragmentsIntoVisualLines,
  hasRepeatedSecondRhythm,
  hasWeakTabularitySignal,
  identifyAlignedTableLines,
  looksLikeTextColumns,
  verticalRhythm,
  type ClassifiedLine,
  type Fragment,
  type TableGrid,
} from "./geometry";

describe("classifyLineSegment", () => {
  it("classifies a horizontal segment", () => {
    expect(classifyLineSegment({ x1: 10, y1: 100, x2: 200, y2: 100.2 })).toEqual({
      orientation: "horizontal",
      y: 100.1,
      xMin: 10,
      xMax: 200,
    });
  });

  it("classifies a vertical segment", () => {
    expect(classifyLineSegment({ x1: 50, y1: 300, x2: 50.3, y2: 100 })).toEqual({
      orientation: "vertical",
      x: 50.15,
      yMin: 100,
      yMax: 300,
    });
  });

  it("discards a genuinely diagonal segment (rotated tables are out of scope for jalon 1)", () => {
    expect(classifyLineSegment({ x1: 0, y1: 0, x2: 100, y2: 100 })).toBeUndefined();
  });

  it("discards a degenerate point (both axes within tolerance)", () => {
    expect(classifyLineSegment({ x1: 10, y1: 10, x2: 10.1, y2: 10.1 })).toBeUndefined();
  });
});

describe("clusterPositions", () => {
  it("returns an empty array for no input", () => {
    expect(clusterPositions([])).toEqual([]);
  });

  it("keeps far-apart values distinct", () => {
    expect(clusterPositions([10, 100, 500])).toEqual([10, 100, 500]);
  });

  it("merges near-duplicates into their average", () => {
    expect(clusterPositions([100, 101, 99.5])).toEqual([100.16666666666667]);
  });

  it("respects a custom tolerance", () => {
    expect(clusterPositions([100, 110], 5)).toEqual([100, 110]);
    expect(clusterPositions([100, 110], 15)).toEqual([105]);
  });
});

describe("buildGridFromVectorLines", () => {
  // A real 2x2 grid: 3 horizontal borders (y=300,200,100) x 3 vertical borders (x=0,100,200).
  const realGrid: ClassifiedLine[] = [
    { orientation: "horizontal", y: 300, xMin: 0, xMax: 200 },
    { orientation: "horizontal", y: 200, xMin: 0, xMax: 200 },
    { orientation: "horizontal", y: 100, xMin: 0, xMax: 200 },
    { orientation: "vertical", x: 0, yMin: 100, yMax: 300 },
    { orientation: "vertical", x: 100, yMin: 100, yMax: 300 },
    { orientation: "vertical", x: 200, yMin: 100, yMax: 300 },
  ];

  it("detects a real grid: row boundaries descending, column boundaries ascending", () => {
    expect(buildGridFromVectorLines(realGrid)).toEqual({
      rowBoundaries: [300, 200, 100],
      colBoundaries: [0, 100, 200],
    });
  });

  it("is undefined with fewer than 2 lines on either axis", () => {
    expect(
      buildGridFromVectorLines([
        { orientation: "horizontal", y: 100, xMin: 0, xMax: 200 },
        { orientation: "vertical", x: 0, yMin: 100, yMax: 300 },
      ]),
    ).toBeUndefined();
    expect(buildGridFromVectorLines([])).toBeUndefined();
  });

  it("ignores an unrelated short mark elsewhere on the page (a footer rule) instead of corrupting the real grid", () => {
    const withNoise: ClassifiedLine[] = [...realGrid, { orientation: "horizontal", y: 5, xMin: 150, xMax: 160 }];
    expect(buildGridFromVectorLines(withNoise)).toEqual({
      rowBoundaries: [300, 200, 100],
      colBoundaries: [0, 100, 200],
    });
  });

  it("the minimum valid grid is 2 boundaries per axis (one row, one column)", () => {
    const minimal: ClassifiedLine[] = [
      { orientation: "horizontal", y: 200, xMin: 0, xMax: 100 },
      { orientation: "horizontal", y: 100, xMin: 0, xMax: 100 },
      { orientation: "vertical", x: 0, yMin: 100, yMax: 200 },
      { orientation: "vertical", x: 100, yMin: 100, yMax: 200 },
    ];
    expect(buildGridFromVectorLines(minimal)).toEqual({ rowBoundaries: [200, 100], colBoundaries: [0, 100] });
  });
});

/**
 * The shape of a real, fully ruled table: six bordered columns, fourteen rows, a page frame around. The fixtures
 * above hold the two assumptions it breaks: they have no page frame, and each border is one continuous stroke.
 * The values below were measured on the document.
 */
describe("buildGridFromVectorLines — écart 14, sur la forme d'un tableau RÉEL", () => {
  const COLS = [28.3, 123.3, 141.7, 166.1, 184.5, 202.8, 567.0];
  const TABLE_TOP = 707;
  const TABLE_BOTTOM = 305;
  const ROW_COUNT = 14;
  const rowYs = Array.from(
    { length: ROW_COUNT + 1 },
    (_, i) => TABLE_TOP - (i * (TABLE_TOP - TABLE_BOTTOM)) / ROW_COUNT,
  );

  /** `clusterPositions` returns the mean of a group's members, and summing 28.3 fourteen times does not give 28.3
   *  back: the boundaries are compared to 1e-6. */
  const rounded = (values: readonly number[]): number[] => values.map((n) => Number(n.toFixed(6)));

  /** Defect A: each cell draws its own border, so a column separator is a stack of segments one row high. */
  const perCellVerticals = (x: number): ClassifiedLine[] =>
    rowYs.slice(0, -1).map((top, i) => ({ orientation: "vertical" as const, x, yMin: rowYs[i + 1]!, yMax: top }));

  const tableLines: ClassifiedLine[] = [
    ...rowYs.map((y) => ({ orientation: "horizontal" as const, y, xMin: COLS[0]!, xMax: COLS[COLS.length - 1]! })),
    ...COLS.flatMap(perCellVerticals),
  ];

  /** Defect B: the page frame, which set the reference extent to the whole sheet and the threshold far above a
   *  cell separator's height. */
  const pageFrame: ClassifiedLine[] = [
    { orientation: "horizontal", y: 810.9, xMin: 28.3, xMax: 567 },
    { orientation: "horizontal", y: 27.9, xMin: 28.3, xMax: 567 },
    { orientation: "vertical", x: 567, yMin: 27.9, yMax: 810.9 },
  ];

  it("A — reconstruit la grille quand chaque cellule dessine sa propre bordure", () => {
    const grid = buildGridFromVectorLines(tableLines);
    expect(grid).toBeDefined();
    expect(rounded(grid!.colBoundaries)).toEqual(COLS);
    expect(grid!.rowBoundaries).toHaveLength(ROW_COUNT + 1);
  });

  it("B — trouve le tableau malgré le cadre de page, qui ne doit pas fonder l'étendue de référence", () => {
    const grid = buildGridFromVectorLines([...tableLines, ...pageFrame]);
    expect(grid).toBeDefined();
    expect(rounded(grid!.colBoundaries)).toEqual(COLS);
  });

  it("B — les horizontales du CADRE ne deviennent pas des lignes du tableau", () => {
    const grid = buildGridFromVectorLines([...tableLines, ...pageFrame]);
    // Without this guard the grid would open on the whole sheet and pull the page header and footer into the table.
    expect(grid!.rowBoundaries).not.toContain(810.9);
    expect(grid!.rowBoundaries).not.toContain(27.9);
    expect(Math.max(...grid!.rowBoundaries)).toBeLessThanOrEqual(TABLE_TOP + 1);
    expect(Math.min(...grid!.rowBoundaries)).toBeGreaterThanOrEqual(TABLE_BOTTOM - 1);
  });

  it("garde la protection d'origine : une marque isolée ne fabrique toujours pas de colonne", () => {
    const stray: ClassifiedLine[] = [
      ...tableLines,
      { orientation: "vertical", x: 400, yMin: 500, yMax: 508 },
      { orientation: "horizontal", y: 5, xMin: 150, xMax: 160 },
    ];
    expect(rounded(buildGridFromVectorLines(stray)!.colBoundaries)).toEqual(COLS);
  });
});

/**
 * A LYING FILL DOES NOT VOTE (22/09/2026). The short side of a filled rectangle
 * wider than tall is a vertical whose length is its own thickness: it tied with a
 * real table's borders, won the tie by height, and stopped the search. Shape
 * measured on safedocs 0000754 p1: a 3-row, 2-column table drawn in 0.48-pt
 * filled rules, and above it a 107.25 × 58.5 logo fill and a 504.75 × 61.45 white
 * frame.
 */
describe("buildGridsFromVectorLines — a lying fill does not vote", () => {
  const RULE = 0.48;
  const v = (x: number, yMin: number, yMax: number, thickness = RULE): ClassifiedLine => ({
    orientation: "vertical",
    x,
    yMin,
    yMax,
    thickness,
  });
  const h = (y: number, xMin: number, xMax: number, thickness = RULE): ClassifiedLine => ({
    orientation: "horizontal",
    y,
    xMin,
    xMax,
    thickness,
  });
  /** The four edges of a filled rectangle, each carrying its smaller side as thickness. */
  const fill = (xMin: number, xMax: number, yMin: number, yMax: number): ClassifiedLine[] => {
    const thickness = Math.min(xMax - xMin, yMax - yMin);
    return [
      v(xMin, yMin, yMax, thickness),
      v(xMax, yMin, yMax, thickness),
      h(yMin, xMin, xMax, thickness),
      h(yMax, xMin, xMax, thickness),
    ];
  };

  const table: ClassifiedLine[] = [
    v(29.07, 115.62, 634.5),
    v(600.27, 115.62, 634.5),
    v(204.3, 115.62, 621.18),
    ...[634.62, 621.5, 451.74, 280.56, 115.38].map((y) => h(y, 29.28, 600.06)),
  ];
  const logo = fill(485.25, 592.5, 710.25, 768.75);
  const whiteFrame = fill(72.55, 577.3, 702.3, 763.75);

  it("safedocs 0000754 p1: the table is found under the logo and the white frame", () => {
    // Before: `[]` — the logo's two short sides won the tie and the region failed.
    expect(buildGridsFromVectorLines([...table, ...logo, ...whiteFrame])).toEqual([
      { rowBoundaries: [634.62, 621.5, 451.74, 280.56, 115.38], colBoundaries: [29.07, 204.3, 600.27] },
    ]);
  });

  it("a STANDING bar 9 × 100 pt still votes: its length exceeds its thickness", () => {
    // The bars of gap 15 are standing fills; dropping every thick vertical would lose them.
    expect(buildGridsFromVectorLines(fill(100, 109, 200, 300))).toEqual([
      { rowBoundaries: [300, 200], colBoundaries: [100, 109] },
    ]);
  });

  it("a table drawn in 0.48-pt filled rectangles still votes, short ends included", () => {
    // Gap 14: some producers paint every border as a thin fill. Each horizontal rule then
    // also yields two 0.48-pt verticals at its ends, whose length equals their thickness.
    const painted: ClassifiedLine[] = [
      ...[29.07, 204.3, 600.27].flatMap((x) => fill(x, x + RULE, 115.38, 634.62)),
      ...[634.62, 451.74, 115.38].flatMap((y) => fill(29.07, 600.27, y, y + RULE)),
    ];
    const grids = buildGridsFromVectorLines(painted);
    expect(grids).toHaveLength(1);
    expect(grids[0]!.colBoundaries).toHaveLength(3);
  });

  it("WRITTEN LIMIT: a 0.8-pt underline still wins the tie and stops the search (safedocs 0000713 p2)", () => {
    // The thin half of the rule was measured and set aside — see `vector-grid.ts`, step 2.
    const underline = fill(51, 300, 780, 780.8);
    const oneColumn: ClassifiedLine[] = [
      v(29.07, 115.38, 634.62),
      v(600.27, 115.38, 634.62),
      h(634.62, 29.07, 600.27),
      h(115.38, 29.07, 600.27),
    ];
    expect(buildGridsFromVectorLines(oneColumn)).toHaveLength(1);
    expect(buildGridsFromVectorLines([...oneColumn, ...underline])).toEqual([]);
  });
});

/**
 * AN IMAGE FRAME IS NOT A GRID BORDER (22/09/2026). Safedocs 0000754 strokes a grey 1-pt
 * rectangle around each screenshot, 0.5 pt outside the image. Two frames share an
 * abscissa, merge, cover 60.5 % of the table's height, and add two empty columns.
 */
describe("withoutImageFrames", () => {
  const v = (x: number, yMin: number, yMax: number): ClassifiedLine => ({
    orientation: "vertical",
    x,
    yMin,
    yMax,
    thickness: 1,
  });
  const h = (y: number, xMin: number, xMax: number): ClassifiedLine => ({
    orientation: "horizontal",
    y,
    xMin,
    xMax,
    thickness: 1,
  });
  type Box = { xMin: number; xMax: number; yMin: number; yMax: number };
  /** The four sides of a rectangle `out` points outside `box`. */
  const frame = (b: Box, out = 0.5): ClassifiedLine[] => [
    v(b.xMin - out, b.yMin - out, b.yMax + out),
    v(b.xMax + out, b.yMin - out, b.yMax + out),
    h(b.yMin - out, b.xMin - out, b.xMax + out),
    h(b.yMax + out, b.xMin - out, b.xMax + out),
  ];
  // Measured on 0000754 p1: `img_p0_5` and its frame; a second capture below it, same x.
  const upper: Box = { xMin: 252.3, xMax: 547.6, yMin: 468.57, yMax: 609.32 };
  const lower: Box = { xMin: 252.3, xMax: 547.6, yMin: 296.54, yMax: 440 };
  const table: ClassifiedLine[] = [
    v(29.07, 115.62, 634.5),
    v(600.27, 115.62, 634.5),
    v(204.3, 115.62, 621.18),
    ...[634.62, 621.5, 451.74, 280.56, 115.38].map((y) => h(y, 29.28, 600.06)),
  ];

  it("safedocs 0000754 p1: the capture frames add two columns; without them the table has its 2", () => {
    const lines = [...table, ...frame(upper), ...frame(lower)];
    expect(buildGridsFromVectorLines(lines)[0]!.colBoundaries).toHaveLength(5);
    expect(buildGridsFromVectorLines(withoutImageFrames(lines, [upper, lower]))[0]!.colBoundaries).toEqual([
      29.07, 204.3, 600.27,
    ]);
  });

  it("removes the four sides of a frame, and nothing else", () => {
    expect(withoutImageFrames([...table, ...frame(upper)], [upper])).toEqual(table);
  });

  it("three sides are not a frame: nothing is removed", () => {
    const threeSides = frame(upper).slice(0, 3);
    expect(withoutImageFrames(threeSides, [upper])).toEqual(threeSides);
  });

  it("a real cell border around an image overhangs it: kept even on all four sides", () => {
    // Real borders near an image overhang its side by 29.15 pt or more (bulletin T2 p2).
    const cell = frame(upper, 0.5).map((l): ClassifiedLine =>
      l.orientation === "vertical"
        ? { ...l, yMin: l.yMin - 30, yMax: l.yMax + 30 }
        : { ...l, xMin: l.xMin - 30, xMax: l.xMax + 30 },
    );
    expect(withoutImageFrames(cell, [upper])).toEqual(cell);
  });

  it("a rectangle 3 pt away is not a frame", () => {
    const loose = frame(upper, 3);
    expect(withoutImageFrames(loose, [upper])).toEqual(loose);
  });
});

describe("detectAlignedColumns", () => {
  it("detects 2 columns recurring across enough lines, sorted ascending", () => {
    const fragmentsByLine: Fragment[][] = [
      [
        { text: "a", x: 10, y: 300, width: 20, height: 10 },
        { text: "b", x: 100, y: 300, width: 20, height: 10 },
      ],
      [
        { text: "c", x: 10, y: 290, width: 20, height: 10 },
        { text: "d", x: 100, y: 290, width: 20, height: 10 },
      ],
      [
        { text: "e", x: 10, y: 280, width: 20, height: 10 },
        { text: "f", x: 100, y: 280, width: 20, height: 10 },
      ],
    ];
    expect(detectAlignedColumns(fragmentsByLine)).toEqual([10, 100]);
  });

  it("is undefined for ordinary unaligned prose", () => {
    const fragmentsByLine: Fragment[][] = [
      [{ text: "The quick brown fox", x: 10, y: 300, width: 150, height: 10 }],
      [{ text: "jumps over the lazy", x: 12, y: 290, width: 150, height: 10 }],
      [{ text: "dog near the river", x: 9, y: 280, width: 150, height: 10 }],
    ];
    expect(detectAlignedColumns(fragmentsByLine)).toBeUndefined();
  });

  it("requires the alignment to recur across at least MIN_ALIGNED_ROWS lines, not just 2", () => {
    const fragmentsByLine: Fragment[][] = [
      [
        { text: "a", x: 10, y: 300, width: 20, height: 10 },
        { text: "b", x: 100, y: 300, width: 20, height: 10 },
      ],
      [
        { text: "c", x: 10, y: 290, width: 20, height: 10 },
        { text: "d", x: 100, y: 290, width: 20, height: 10 },
      ],
    ];
    expect(detectAlignedColumns(fragmentsByLine)).toBeUndefined();
  });
});

describe("hasWeakTabularitySignal (the missing gate before reporting `no-grid` — never on ordinary prose)", () => {
  it("is false for ordinary single-run paragraph lines (one fragment per line)", () => {
    const fragmentsByLine: Fragment[][] = [
      [{ text: "The quick brown fox jumps", x: 10, y: 300, width: 150, height: 10 }],
      [{ text: "over the lazy dog near the", x: 10, y: 285, width: 150, height: 10 }],
      [{ text: "river bank at dawn today", x: 10, y: 270, width: 150, height: 10 }],
    ];
    expect(hasWeakTabularitySignal(fragmentsByLine)).toBe(false);
  });

  it("is false for a single line with a wide gap (a title + page number) — one line proves nothing", () => {
    const fragmentsByLine: Fragment[][] = [
      [
        { text: "Annual Report", x: 10, y: 300, width: 60, height: 10 },
        { text: "12", x: 350, y: 300, width: 10, height: 10 },
      ],
    ];
    expect(hasWeakTabularitySignal(fragmentsByLine)).toBe(false);
  });

  it("is true when several DIFFERENT lines each show an unusually wide gap between fragments (an unparseable table, no clean grid or alignment)", () => {
    const fragmentsByLine: Fragment[][] = [
      [
        { text: "Matière", x: 10, y: 300, width: 40, height: 10 },
        { text: "16,25", x: 200, y: 300, width: 30, height: 10 },
      ],
      [
        { text: "Français", x: 12, y: 285, width: 40, height: 10 },
        { text: "14,50", x: 205, y: 285, width: 30, height: 10 },
      ],
      [
        { text: "Histoire", x: 8, y: 270, width: 40, height: 10 },
        { text: "12,00", x: 198, y: 270, width: 30, height: 10 },
      ],
    ];
    expect(hasWeakTabularitySignal(fragmentsByLine)).toBe(true);
  });

  it("a normal single space between two words on the same line is never mistaken for a wide gap", () => {
    const fragmentsByLine: Fragment[][] = [
      [
        { text: "Hello", x: 10, y: 300, width: 30, height: 10 },
        { text: "world", x: 42, y: 300, width: 30, height: 10 },
      ], // gap = 2, well under height*3
      [
        { text: "Foo", x: 10, y: 285, width: 20, height: 10 },
        { text: "bar", x: 32, y: 285, width: 20, height: 10 },
      ],
    ];
    expect(hasWeakTabularitySignal(fragmentsByLine)).toBe(false);
  });
});

describe("groupFragmentsIntoVisualLines", () => {
  it("groups fragments sharing (near enough) the same y into one line, in encounter order", () => {
    const fragments: Fragment[] = [
      { text: "Matière", x: 50, y: 300, width: 40, height: 10 },
      { text: "Note", x: 200, y: 300.3, width: 30, height: 10 }, // same visual line, sub-point y jitter
      { text: "Français", x: 50, y: 280, width: 40, height: 10 },
    ];
    expect(groupFragmentsIntoVisualLines(fragments)).toEqual([[fragments[0], fragments[1]], [fragments[2]]]);
  });

  it("drops a truly empty fragment (zero-length text) but keeps a whitespace-only one", () => {
    const fragments: Fragment[] = [
      { text: "a", x: 0, y: 300, width: 10, height: 10 },
      { text: "", x: 20, y: 300, width: 5, height: 10 },
      { text: " ", x: 30, y: 300, width: 5, height: 0 },
    ];
    expect(groupFragmentsIntoVisualLines(fragments)[0]!.map((f) => f.text)).toEqual(["a", " "]);
  });
});

describe("groupFragmentsIntoRowBands", () => {
  const rowBoundaries = [300, 200, 100]; // 2 bands: [300,200] and [200,100]

  it("buckets fragments into the row band their center falls into", () => {
    const fragments: Fragment[] = [
      { text: "row0-a", x: 0, y: 250, width: 10, height: 10 },
      { text: "row0-b", x: 50, y: 260, width: 10, height: 10 },
      { text: "row1-a", x: 0, y: 150, width: 10, height: 10 },
    ];
    const bands = groupFragmentsIntoRowBands(fragments, rowBoundaries);
    expect(bands).toHaveLength(2);
    expect(bands[0]!.map((f) => f.text)).toEqual(["row0-a", "row0-b"]);
    expect(bands[1]!.map((f) => f.text)).toEqual(["row1-a"]);
  });

  it("keeps a wrapped multi-line cell's two visual lines in the SAME band", () => {
    const fragments: Fragment[] = [
      { text: "wrapped line 1", x: 0, y: 270, width: 10, height: 10 },
      { text: "wrapped line 2", x: 0, y: 255, width: 10, height: 10 },
    ];
    const bands = groupFragmentsIntoRowBands(fragments, rowBoundaries);
    expect(bands[0]!.map((f) => f.text)).toEqual(["wrapped line 1", "wrapped line 2"]);
  });
});

describe("assignFragmentsToCells", () => {
  // 2x2 grid: rows [300,200,100] (2 bands), cols [0,100,200] (2 bands).
  const grid: TableGrid = { rowBoundaries: [300, 200, 100], colBoundaries: [0, 100, 200] };

  it("assigns a well-contained fragment per cell to the right (row,col), no ambiguity", () => {
    const fragments: Fragment[] = [
      { text: "r0c0", x: 10, y: 250, width: 20, height: 10 },
      { text: "r0c1", x: 110, y: 250, width: 20, height: 10 },
      { text: "r1c0", x: 10, y: 150, width: 20, height: 10 },
      { text: "r1c1", x: 110, y: 150, width: 20, height: 10 },
    ];
    const { cells, ambiguous, outside } = assignFragmentsToCells(fragments, grid);
    expect(cells[0]![0]!.map((f) => f.text)).toEqual(["r0c0"]);
    expect(cells[0]![1]!.map((f) => f.text)).toEqual(["r0c1"]);
    expect(cells[1]![0]!.map((f) => f.text)).toEqual(["r1c0"]);
    expect(cells[1]![1]!.map((f) => f.text)).toEqual(["r1c1"]);
    expect(ambiguous).toEqual([]);
    expect(outside).toEqual([]);
  });

  it("puts a fragment entirely outside the grid's bounds in `outside`, never in a cell", () => {
    const outsideFragment: Fragment = { text: "caption below the table", x: 10, y: 50, width: 20, height: 10 };
    const { cells, outside } = assignFragmentsToCells([outsideFragment], grid);
    expect(outside).toEqual([outsideFragment]);
    expect(cells.flat().flat()).toEqual([]);
  });

  it("flags a fragment whose bounding box crosses a COLUMN boundary as ambiguous — still placed, never dropped (a merged cell)", () => {
    const mergedCellFragment: Fragment = { text: "Moyennes T2", x: 60, y: 250, width: 80, height: 10 }; // spans x=60..140, crossing the x=100 boundary
    const { cells, ambiguous } = assignFragmentsToCells([mergedCellFragment], grid);
    expect(ambiguous).toEqual([mergedCellFragment]);
    expect(cells.flat().flat()).toEqual([mergedCellFragment]); // placed exactly once, by its center
  });

  it("flags a fragment whose bounding box crosses a ROW boundary as ambiguous (a wrapped line nudging past the next row)", () => {
    const tallFragment: Fragment = { text: "spans two rows", x: 10, y: 190, width: 20, height: 30 }; // y=190..220, crossing the y=200 boundary
    const { cells, ambiguous } = assignFragmentsToCells([tallFragment], grid);
    expect(ambiguous).toEqual([tallFragment]);
    expect(cells.flat().flat()).toEqual([tallFragment]);
  });
});

// A page with prose before/after a borderless, aligned table — the shape
// jalon 2's régime 1 (stage 2) actually needs to handle, per the result
// measured on real school reports (alignment-no-borders, not vector-borders).
const proseAndTableFixture: Fragment[][] = [
  [{ text: "Bulletin Trimestre 1", x: 10, y: 340, width: 120, height: 12 }], // prose title — doesn't match either column
  [
    { text: "Matière", x: 50, y: 300, width: 40, height: 10 },
    { text: "Note", x: 200, y: 300, width: 30, height: 10 },
  ],
  [
    { text: "Français", x: 50, y: 280, width: 40, height: 10 },
    { text: "14", x: 200, y: 280, width: 15, height: 10 },
  ],
  [
    { text: "Maths", x: 50, y: 260, width: 40, height: 10 },
    { text: "16", x: 200, y: 260, width: 15, height: 10 },
  ],
  [{ text: "Fin du document", x: 10, y: 220, width: 90, height: 10 }], // prose footer — doesn't match either column
];
const proseAndTableColumns = [50, 200];

describe("identifyAlignedTableLines (§8 jalon 2, régime 1 stage 2 — which lines are the table, not the surrounding prose)", () => {
  it("finds the contiguous table range, excluding prose before and after", () => {
    expect(identifyAlignedTableLines(proseAndTableFixture, proseAndTableColumns)).toEqual({ startLine: 1, endLine: 3 });
  });

  it("is undefined when no line matches at least 2 of the given columns", () => {
    const allProse: Fragment[][] = [[{ text: "Just a paragraph", x: 10, y: 300, width: 150, height: 10 }]];
    expect(identifyAlignedTableLines(allProse, proseAndTableColumns)).toBeUndefined();
  });

  it("includes a non-matching line strictly BETWEEN two matching ones (a blank spacer row inside the table)", () => {
    const withSpacer: Fragment[][] = [
      proseAndTableFixture[1]!,
      [{ text: "", x: 50, y: 290, width: 0, height: 10 }], // spacer line, matches neither column
      proseAndTableFixture[2]!,
    ];
    expect(identifyAlignedTableLines(withSpacer, proseAndTableColumns)).toEqual({ startLine: 0, endLine: 2 });
  });
});

describe("buildGridFromAlignedRows (§8 jalon 2, régime 1 stage 2 — a grid with no vector lines to read)", () => {
  it("builds row boundaries (descending) matching the line count, and column boundaries (ascending) matching the column count", () => {
    const tableLines = proseAndTableFixture.slice(1, 4); // the 3 table rows, prose already excluded
    const grid = buildGridFromAlignedRows(tableLines, proseAndTableColumns);
    expect(grid?.rowBoundaries).toHaveLength(4); // 3 rows ⇒ 4 boundaries
    expect(grid?.rowBoundaries[0]).toBeGreaterThan(grid!.rowBoundaries[1]!); // descending
    expect(grid?.colBoundaries).toHaveLength(3); // 2 columns ⇒ 3 boundaries
    expect(grid?.colBoundaries[0]).toBeLessThan(grid!.colBoundaries[1]!); // ascending
  });

  it("places every real fragment from the table lines inside the grid's own bounds, with no ambiguity, once assigned", () => {
    const tableLines = proseAndTableFixture.slice(1, 4);
    const grid = buildGridFromAlignedRows(tableLines, proseAndTableColumns)!;
    const { cells, ambiguous, outside } = assignFragmentsToCells(tableLines.flat(), grid);
    expect(ambiguous).toEqual([]);
    expect(outside).toEqual([]);
    expect(cells.map((row) => row.map((cell) => cell.map((f) => f.text)))).toEqual([
      [["Matière"], ["Note"]],
      [["Français"], ["14"]],
      [["Maths"], ["16"]],
    ]);
  });

  it("is undefined with fewer than 2 columns or no lines at all", () => {
    expect(buildGridFromAlignedRows(proseAndTableFixture.slice(1, 4), [50])).toBeUndefined();
    expect(buildGridFromAlignedRows([], proseAndTableColumns)).toBeUndefined();
  });
});

// The column discriminant, on synthetic coordinates.

/** A page in two bands: left column at x=60 (width `leftWidth`), right column at x=320. The vertical gaps are
 *  given one by one, to build a single or a double rhythm. */
const twoBandPage = (opts: {
  gaps: number[];
  leftText: string;
  rightText: string;
  leftWidth?: number;
}): Fragment[][] => {
  const lines: Fragment[][] = [];
  let y = 700;
  for (let i = 0; i <= opts.gaps.length; i++) {
    lines.push([
      { text: opts.leftText, x: 60, y, width: opts.leftWidth ?? 220, height: 9 },
      { text: opts.rightText, x: 320, y, width: 220, height: 9 },
    ]);
    y -= opts.gaps[i] ?? 0;
  }
  return lines;
};

const uniform = (count: number, gap: number): number[] => Array.from({ length: count }, () => gap);

describe("detectColumnGutter (point 13, étage 1 — la page est-elle en bandes ?)", () => {
  it("trouve la coupe entre deux bandes séparées par du vide", () => {
    const gutter = detectColumnGutter(
      twoBandPage({ gaps: uniform(11, 12), leftText: "prose de gauche", rightText: "prose de droite" }),
    );
    // The bands run 60 to 280 and 320 to 540: the gutter is [280, 320]. The profile works in one-point bins and
    // rounds the edges outwards, hence the point of play.
    expect(gutter!.start).toBeGreaterThanOrEqual(279);
    expect(gutter!.start).toBeLessThanOrEqual(282);
    expect(gutter!.end).toBeGreaterThanOrEqual(318);
    expect(gutter!.end).toBeLessThanOrEqual(321);
    expect(Math.abs(gutter!.cut - 300)).toBeLessThanOrEqual(2);
  });

  it("ne voit aucune gouttière sur une page d'une seule bande", () => {
    const lines = Array.from({ length: 12 }, (_, i) => [
      { text: "une ligne de prose ordinaire", x: 60, y: 700 - i * 12, width: 460, height: 9 },
    ]);
    expect(detectColumnGutter(lines)).toBeUndefined();
  });

  it("survit à quelques lignes pleine largeur — un titre n'efface pas la gouttière", () => {
    // Why the profile is a fraction of the lines: as presence or absence, one full-width line would erase it all.
    const lines = twoBandPage({ gaps: uniform(19, 12), leftText: "prose de gauche", rightText: "prose de droite" });
    lines.unshift([{ text: "un titre qui traverse toute la page", x: 60, y: 720, width: 480, height: 14 }]);
    expect(Math.abs(detectColumnGutter(lines)!.cut - 300)).toBeLessThanOrEqual(2);
  });

  it("ne prend pas une marge pour une gouttière", () => {
    // The white right of the text touches the edge of the box: a margin.
    const lines = Array.from({ length: 12 }, (_, i) => [
      { text: "texte", x: 60, y: 700 - i * 12, width: 100, height: 9 },
    ]);
    expect(detectColumnGutter(lines)).toBeUndefined();
  });
});

describe("verticalRhythm / hasRepeatedSecondRhythm (point 13, étage 2 — la preuve positive de tableau)", () => {
  it("de la prose a UN rythme : le second écart n'est pas répété", () => {
    const lines = twoBandPage({ gaps: uniform(20, 12), leftText: "prose de gauche", rightText: "prose de droite" });
    const rhythm = verticalRhythm(lines);
    expect(rhythm?.mode).toBe(12);
    expect(rhythm?.secondCount).toBe(0);
    expect(hasRepeatedSecondRhythm(lines)).toBe(false);
  });

  it("un tableau en a DEUX : l'interligne dans la cellule, la séparation entre rangées", () => {
    // Four rows of three lines, 20 pt apart.
    const gaps = [12, 12, 20, 12, 12, 20, 12, 12, 20, 12, 12];
    const lines = twoBandPage({ gaps, leftText: "cellule de gauche", rightText: "cellule de droite" });
    const rhythm = verticalRhythm(lines);
    expect(rhythm?.mode).toBe(12);
    expect(rhythm?.second).toBe(20);
    expect(rhythm?.secondCount).toBe(3);
    expect(hasRepeatedSecondRhythm(lines)).toBe(true);
  });

  it("un second écart vu deux fois seulement reste du bruit", () => {
    const lines = twoBandPage({
      gaps: [12, 12, 12, 20, 12, 12, 20, 12, 12, 12],
      leftText: "gauche",
      rightText: "droite",
    });
    expect(verticalRhythm(lines)?.secondCount).toBe(2);
    expect(hasRepeatedSecondRhythm(lines)).toBe(false);
  });
});

describe("looksLikeTextColumns (point 13, étage 3 — la preuve positive de colonnes)", () => {
  const PROSE = "une ligne de prose qui remplit sa colonne";

  it("reconnaît deux bandes denses de prose", () => {
    expect(looksLikeTextColumns(twoBandPage({ gaps: uniform(20, 12), leftText: PROSE, rightText: PROSE }), 300)).toBe(
      true,
    );
  });

  it("refuse une page trop courte, même parfaitement en bandes", () => {
    // A case with no remedy: at this density, two columns of prose and a label/value block differ only by the
    // length of their fragments.
    expect(looksLikeTextColumns(twoBandPage({ gaps: uniform(5, 12), leftText: PROSE, rightText: PROSE }), 300)).toBe(
      false,
    );
  });

  it("refuse un bloc libellé / valeur, dont les fragments sont trop courts", () => {
    expect(
      looksLikeTextColumns(
        twoBandPage({ gaps: uniform(20, 16), leftText: "Date d'emission", rightText: "12 mars 2026" }),
        300,
      ),
    ).toBe(false);
  });

  it("refuse une page dont une seule bande porte de la prose", () => {
    const lines = Array.from({ length: 20 }, (_, i) => [
      { text: PROSE, x: 60, y: 700 - i * 12, width: 220, height: 9 },
    ]);
    expect(looksLikeTextColumns(lines, 300)).toBe(false);
  });

  /** The share of lines that start with a lowercase letter only refuses partitions, it allows none more. */
  describe("part de minuscules initiales", () => {
    it("refuse un formulaire long dont les libellés sont assez bavards pour passer le compte de mots", () => {
      // Each label has four words or more, so `MIN_WORDS_PER_FRAGMENT` is met, but no line starts in lowercase:
      // nothing is wrapped.
      const lines = twoBandPage({
        gaps: uniform(20, 16),
        leftText: "Date de derniere mise a jour",
        rightText: "Douze mars deux mille vingt six",
      });
      expect(looksLikeTextColumns(lines, 300)).toBe(false);
    });

    it("accepte le même formulaire si ses bandes sont de la prose repliée", () => {
      // Same geometry, same fragment length: only the initial case changes.
      const lines = twoBandPage({
        gaps: uniform(20, 16),
        leftText: "date de derniere mise a jour",
        rightText: "douze mars deux mille vingt six",
      });
      expect(looksLikeTextColumns(lines, 300)).toBe(true);
    });

    /**
     * The guard by the share of cased characters. In a script with no case the share of initial lowercase is zero,
     * which is silence, not information: without the guard the signal would refuse every Japanese, Chinese or
     * Korean document.
     *
     * The first case below gives the band fragments separated by spaces, artificial for Japanese: otherwise the
     * refusal would also come from `MIN_WORDS_PER_FRAGMENT`, since `wordCount` splits on spaces.
     */
    it("ne consulte pas le signal sur une écriture sans casse", () => {
      const lines = twoBandPage({
        gaps: uniform(20, 12),
        leftText: "デジタル 技術 の 活用 は 進んで いる",
        rightText: "情報 通信 白書 の 記述 に よれば",
      });
      // No lowercase anywhere, and accepted all the same.
      expect(looksLikeTextColumns(lines, 300)).toBe(true);
    });

    it("consulte le signal dès que le texte est majoritairement à casse", () => {
      const lines = twoBandPage({
        gaps: uniform(20, 12),
        leftText: "Une Ligne De Prose Qui Remplit",
        rightText: "Une Autre Ligne De Prose Ici",
      });
      expect(looksLikeTextColumns(lines, 300)).toBe(false);
    });
  });
});

describe("buildGridsFromVectorLines — plusieurs tableaux sur une page", () => {
  /** Two stacked tables, a left edge that runs through both, and a page frame across the whole sheet. The two
   *  shared edges belong to the group of neither vote, so the first pass must not consume them. */
  const HAUT = { top: 780, bottom: 710 };
  const BAS = { top: 660, bottom: 570 };
  const shared: ClassifiedLine[] = [
    { orientation: "vertical", x: 28, yMin: BAS.bottom, yMax: HAUT.top },
    { orientation: "vertical", x: 567, yMin: 28, yMax: 811 },
  ];
  const table = (band: { top: number; bottom: number }, xs: readonly number[]): ClassifiedLine[] => [
    ...xs.map((x): ClassifiedLine => ({ orientation: "vertical", x, yMin: band.bottom, yMax: band.top })),
    { orientation: "horizontal", y: band.top, xMin: 28, xMax: 567 },
    { orientation: "horizontal", y: (band.top + band.bottom) / 2, xMin: 28, xMax: 567 },
    { orientation: "horizontal", y: band.bottom, xMin: 28, xMax: 567 },
  ];

  it("rend UNE région par tableau, et le bord partagé borne les deux", () => {
    const grids = buildGridsFromVectorLines([
      ...shared,
      ...table(HAUT, [123, 141, 202]),
      ...table(BAS, [244, 350, 459]),
    ]);
    expect(grids).toHaveLength(2);
    // The page frame is the right boundary of both.
    for (const g of grids) {
      expect(g.colBoundaries[0]).toBe(28);
      expect(g.colBoundaries[g.colBoundaries.length - 1]).toBe(567);
      expect(g.colBoundaries).toHaveLength(5);
      expect(g.rowBoundaries).toHaveLength(3);
    }
    // The order is the vote's, not the page's: the rendering sorts top to bottom (`renderPageTables`).
    expect([...grids.map((g) => g.rowBoundaries[0])].sort((a, b) => b! - a!)).toEqual([HAUT.top, BAS.top]);
  });

  it("n'invente PAS de région à partir de traits INTÉRIEURS à un tableau déjà retenu", () => {
    // The vertical edges of coloured bars: two strokes that agree on a short extent, inside the table.
    const barres: ClassifiedLine[] = [
      { orientation: "vertical", x: 271, yMin: 590, yMax: 614 },
      { orientation: "vertical", x: 284, yMin: 590, yMax: 614 },
    ];
    const grids = buildGridsFromVectorLines([
      ...shared,
      ...table(HAUT, [123, 141, 202]),
      ...table(BAS, [244, 350, 459]),
      ...barres,
    ]);
    expect(grids).toHaveLength(2);
  });

  it("une page à un seul tableau rend exactement ce qu'elle rendait", () => {
    const lines = [...shared, ...table(HAUT, [123, 141, 202])];
    expect(buildGridsFromVectorLines(lines)).toEqual([buildGridFromVectorLines(lines)]);
  });
});

describe("assignFragmentsToCells — la garde d'ambiguïté est SYMÉTRIQUE", () => {
  /** A header on two levels: three columns, two rows, the first column merged vertically. */
  const grid: TableGrid = { rowBoundaries: [706, 698, 690], colBoundaries: [28, 123, 202] };
  const merge = {
    cells: [
      { row: 0, col: 0, colspan: 1, rowspan: 2 },
      { row: 0, col: 1, colspan: 1, rowspan: 1 },
      { row: 1, col: 1, colspan: 1, rowspan: 1 },
    ],
    ownerAt: [
      [0, 1],
      [0, 2],
    ],
  };

  /** The label of the merged cell, centred on the inner boundary: its box crosses it. */
  const libelle: Fragment = { text: "Matières", x: 62, y: 696.3, width: 26, height: 6.5 };

  it("un fragment qui TRAVERSE la frontière d'une cellule fusionnée n'est PAS ambigu", () => {
    const { ambiguous } = assignFragmentsToCells([libelle], grid, merge);
    expect(ambiguous).toEqual([]);
  });

  it("le MÊME fragment, sans la carte de fusion, EST ambigu — c'est ce qui faisait retomber la page en texte plat", () => {
    expect(assignFragmentsToCells([libelle], grid).ambiguous).toHaveLength(1);
  });
});

describe("buildGridsFromVectorLines — une horizontale PARTIELLE, et ses deux discriminants", () => {
  const COLS = [28, 123, 202, 567];
  const cadre: ClassifiedLine[] = [
    ...COLS.map((x): ClassifiedLine => ({ orientation: "vertical", x, yMin: 690, yMax: 706, thickness: 0.1 })),
    { orientation: "horizontal", y: 706, xMin: 28, xMax: 567, thickness: 0.1 },
    { orientation: "horizontal", y: 690, xMin: 28, xMax: 567, thickness: 0.1 },
  ];
  const lignes = (partielle: ClassifiedLine): number =>
    buildGridsFromVectorLines([...cadre, partielle])[0]!.rowBoundaries.length;

  it("FINE et accrochée aux deux bouts : admise, la grille gagne une frontière", () => {
    expect(lignes({ orientation: "horizontal", y: 698, xMin: 123, xMax: 202, thickness: 0.1 })).toBe(3);
  });

  it("ÉPAISSE : rejetée — c'est un fond de cellule ou une barre, pas un filet", () => {
    // A bar at its maximum value hooks onto the boundaries exactly as a real separator does.
    expect(lignes({ orientation: "horizontal", y: 698, xMin: 123, xMax: 202, thickness: 8 })).toBe(2);
  });

  it("fine mais NON accrochée : rejetée — une extrémité qui ne tombe sur aucune colonne", () => {
    expect(lignes({ orientation: "horizontal", y: 698, xMin: 123, xMax: 170, thickness: 0.1 })).toBe(2);
  });
});

describe("findCellsByIntersection — le chemin qui n'élit aucune emprise", () => {
  // The geometry that defeats `mergeCollinear`: a page frame, a box and a table whose left edges all share one
  // abscissa.
  const v = (x: number, yMin: number, yMax: number): ClassifiedLine => ({
    orientation: "vertical",
    x,
    yMin,
    yMax,
    thickness: 0.5,
  });
  const h = (y: number, xMin: number, xMax: number): ClassifiedLine => ({
    orientation: "horizontal",
    y,
    xMin,
    xMax,
    thickness: 0.5,
  });

  const page: ClassifiedLine[] = [
    // The page frame: it holds everything else, and erases the others once the abscissa is reduced to one extent.
    v(28.3, 42.1, 810.9),
    v(568.2, 42.1, 810.9),
    h(810.9, 28.3, 568.2),
    h(42.1, 28.3, 568.2),
    // A header box, left edge at the same abscissa as the frame.
    v(28.3, 740.0, 810.9),
    v(240.8, 740.0, 810.9),
    h(810.9, 28.3, 240.8),
    h(740.0, 28.3, 240.8),
    // A two-column table lower down, same left margin again.
    v(28.3, 305.4, 706.5),
    v(300.0, 305.4, 706.5),
    v(567.0, 305.4, 706.5),
    h(706.5, 28.3, 567.0),
    h(305.4, 28.3, 567.0),
  ];

  it("trouve l'encadré d'en-tête que `buildGridsFromVectorLines` perd", () => {
    const cells = findCellsByIntersection(page);
    const box = cells.find((c) => Math.abs(c.yTop - 810.9) < 1 && Math.abs(c.yBottom - 740.0) < 1);
    expect(box).toBeDefined();
    expect(box?.xLeft).toBeCloseTo(28.3, 1);
    expect(box?.xRight).toBeCloseTo(240.8, 1);

    // The contrast: the vector-grid path does not see it.
    const regions = buildGridsFromVectorLines(page);
    const seenByOldPath = regions.some((g) => g.rowBoundaries.some((y) => Math.abs(y - 740.0) < 1));
    expect(seenByOldPath).toBe(false);
  });

  it("retient la PLUS PETITE cellule : le cadre de page n'avale personne", () => {
    const cells = findCellsByIntersection(page);
    expect(cells.some((c) => c.yTop > 800 && c.yBottom < 100)).toBe(false);
    // The right edge comes out at 567.6, not 567.0: the page frame's is 1.2 pt away, so `clusterPositions` joins
    // them on their mean.
    const row = cells.filter((c) => Math.abs(c.yTop - 706.5) < 1 && Math.abs(c.yBottom - 305.4) < 1);
    expect(row.map((c) => [c.xLeft, c.xRight])).toEqual([
      [28.3, 300],
      [300, 567.6],
    ]);
  });

  it("un bord peint en deux morceaux distants de 2,4 pt reste UN bord", () => {
    const split: ClassifiedLine[] = [
      v(50, 500, 700),
      v(550, 500, 700),
      v(300, 500, 597.6),
      v(300, 600, 700),
      h(700, 50, 550),
      h(500, 50, 550),
    ];
    const cells = findCellsByIntersection(split);
    expect(cells.map((c) => [c.xLeft, c.xRight])).toEqual([
      [50, 300],
      [300, 550],
    ]);
  });
});
