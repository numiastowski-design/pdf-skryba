import { describe, expect, it } from "vitest";

import type { ClassifiedLine, TableGrid } from "doc-ir/internal";
import { buildMergeMap } from "doc-ir/internal";
import { detectColumnSpans, detectMergedCells, headerRowCount } from "./merged-cells";

/**
 * The shape of a real seven-column table: the header row alone lacks three inner separators (166.6, 185.2, 203.8),
 * at the four sub-columns one header cell spans. Every other row has its six separators.
 */
const COLS = [28.3, 123.3, 141.9, 166.6, 185.2, 203.8, 222.4, 567.1];
const ROWS = [707, 689, 632, 575];

const grid: TableGrid = { rowBoundaries: ROWS, colBoundaries: COLS };

/** A separator drawn over the whole height of a band. */
const separator = (x: number, top: number, bottom: number): ClassifiedLine => ({
  orientation: "vertical",
  x,
  yMin: bottom,
  yMax: top,
});

/** The separators of a band, except those whose abscissa is in `missing`. */
const bandSeparators = (top: number, bottom: number, missing: readonly number[] = []): ClassifiedLine[] =>
  COLS.slice(1, -1)
    .filter((x) => !missing.some((m) => Math.abs(m - x) < 0.5))
    .map((x) => separator(x, top, bottom));

describe("detectRowSpans", () => {
  it("rend une colspan de 1 partout quand tous les séparateurs sont tracés", () => {
    const lines = ROWS.slice(0, -1).flatMap((top, i) => bandSeparators(top, ROWS[i + 1]!));
    expect(detectColumnSpans(lines, grid)).toEqual([
      [1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
    ]);
  });

  it("fusionne les colonnes dont le séparateur manque — le cas « Moyennes » mesuré", () => {
    const lines = [
      ...bandSeparators(707, 689, [166.6, 185.2, 203.8]),
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    const spans = detectColumnSpans(lines, grid);
    expect(spans[0]).toEqual([1, 1, 4, 1]);
    expect(spans[1]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("la somme des colspans d'une ligne vaut toujours le nombre de colonnes", () => {
    const lines = [
      ...bandSeparators(707, 689, [166.6, 185.2, 203.8]),
      ...bandSeparators(689, 632, [123.3]),
      ...bandSeparators(632, 575, []),
    ];
    for (const row of detectColumnSpans(lines, grid)) {
      expect(row.reduce((a, b) => a + b, 0)).toBe(COLS.length - 1);
    }
  });

  it("fusionne aussi en début et en fin de ligne, pas seulement au milieu", () => {
    const lines = [
      ...bandSeparators(707, 689, [123.3]),
      ...bandSeparators(689, 632, [222.4]),
      ...bandSeparators(632, 575),
    ];
    const spans = detectColumnSpans(lines, grid);
    expect(spans[0]).toEqual([2, 1, 1, 1, 1, 1]);
    expect(spans[1]).toEqual([1, 1, 1, 1, 1, 2]);
  });

  it("une ligne entièrement fusionnée rend une seule cellule", () => {
    const lines = [
      ...bandSeparators(707, 689, COLS.slice(1, -1)),
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    expect(detectColumnSpans(lines, grid)[0]).toEqual([COLS.length - 1]);
  });

  it("un séparateur qui ne couvre qu'un bout de la bande ne compte pas — il ne sépare rien", () => {
    const partial: ClassifiedLine = { orientation: "vertical", x: 166.6, yMin: 700, yMax: 704 };
    const lines = [
      ...bandSeparators(707, 689, [166.6]),
      partial,
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    expect(detectColumnSpans(lines, grid)[0]).toEqual([1, 1, 2, 1, 1, 1]);
  });

  it("un séparateur fait de plusieurs segments bout à bout compte comme tracé", () => {
    // The common case: each cell draws its share of the stroke.
    const halves: ClassifiedLine[] = [
      { orientation: "vertical", x: 166.6, yMin: 698, yMax: 707 },
      { orientation: "vertical", x: 166.6, yMin: 689, yMax: 698 },
    ];
    const lines = [
      ...bandSeparators(707, 689, [166.6]),
      ...halves,
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    expect(detectColumnSpans(lines, grid)[0]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("rend un tableau vide pour une grille sans ligne", () => {
    expect(detectColumnSpans([], { rowBoundaries: [100], colBoundaries: COLS })).toEqual([]);
  });
});

describe("detectRowSpans — l'union, jamais la somme", () => {
  it("deux segments SUPERPOSÉS ne couvrent pas plus que l'un d'eux", () => {
    // A document repaints its strokes: summing the overlaps would count double, a separator covering half a band
    // would pass the coverage threshold, and no merge would ever be detected.
    const halfBand = { orientation: "vertical" as const, x: 166.6, yMin: 698, yMax: 707 };
    const lines = [
      ...bandSeparators(707, 689, [166.6]),
      halfBand,
      { ...halfBand },
      { ...halfBand },
      { ...halfBand },
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    // 9 pt on a band of 18: the separator is absent, however many times it was painted.
    expect(detectColumnSpans(lines, grid)[0]).toEqual([1, 1, 2, 1, 1, 1]);
  });

  it("deux segments BOUT À BOUT couvrent bien leur somme", () => {
    const lines = [
      ...bandSeparators(707, 689, [166.6]),
      { orientation: "vertical" as const, x: 166.6, yMin: 698, yMax: 707 },
      { orientation: "vertical" as const, x: 166.6, yMin: 689, yMax: 698 },
      ...bandSeparators(689, 632),
      ...bandSeparators(632, 575),
    ];
    expect(detectColumnSpans(lines, grid)[0]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("detectMergedCells — la fusion verticale se lit dans les traits", () => {
  const COLUMNS = 7;

  it("une frontière SANS AUCUN TRAIT ne fusionne rien — absence de preuve n'est pas preuve de fusion", () => {
    // A grid built by alignment has no horizontal stroke: concluding "everything is merged" would make one giant cell.
    const lines = ROWS.slice(0, -1).flatMap((top, i) => bandSeparators(top, ROWS[i + 1]!));
    const map = detectMergedCells(lines, grid);
    expect(map.cells.every((c) => c.rowspan === 1)).toBe(true);
    expect(map.cells).toHaveLength((ROWS.length - 1) * COLUMNS);
  });

  it("un séparateur PARTIEL fusionne verticalement les colonnes qu'il ne traverse pas", () => {
    // The separator between the two header levels runs under the sub-columns alone, so the three other cells span
    // both rows.
    const full = (top: number): ClassifiedLine => ({
      orientation: "horizontal",
      y: top,
      xMin: COLS[0]!,
      xMax: COLS[COLS.length - 1]!,
      thickness: 0.1,
    });
    const partial: ClassifiedLine = {
      orientation: "horizontal",
      y: ROWS[1]!,
      xMin: COLS[2]!,
      xMax: COLS[6]!,
      thickness: 0.1,
    };
    const lines: ClassifiedLine[] = [
      full(ROWS[0]!),
      partial,
      full(ROWS[2]!),
      full(ROWS[3]!),
      ...ROWS.slice(0, -1).flatMap((top, i) => bandSeparators(top, ROWS[i + 1]!)),
    ];
    const map = detectMergedCells(lines, grid);
    const opening = map.cells.filter((c) => c.row === 0);
    expect(opening.map((c) => [c.col, c.colspan, c.rowspan])).toEqual([
      [0, 1, 2],
      [1, 1, 2],
      [2, 1, 1],
      [3, 1, 1],
      [4, 1, 1],
      [5, 1, 1],
      [6, 1, 2],
    ]);
    // The covered row emits the second-level cells only.
    expect(map.cells.filter((c) => c.row === 1).map((c) => c.col)).toEqual([2, 3, 4, 5]);
  });
});

describe("headerRowCount — la hauteur de l'en-tête se LIT dans la fusion", () => {
  it("une cellule de la première ligne qui enjambe la suivante décrit un en-tête à DEUX niveaux", () => {
    const map = buildMergeMap(
      grid,
      [
        [1, 1, 4, 1],
        [1, 1, 1, 1, 1, 1, 1],
      ],
      [[true, true, false, false, false, false, true]],
    );
    expect(headerRowCount(map)).toBe(2);
  });

  it("sans fusion verticale, la valeur vaut 1 — la règle d'avant, inchangée", () => {
    expect(headerRowCount(buildMergeMap(grid, [[1, 1, 4, 1]]))).toBe(1);
  });

  it("sans carte du tout, la valeur vaut 1 — jamais 0, jamais une exception", () => {
    expect(headerRowCount(undefined)).toBe(1);
  });

  it("une fusion qui commence PLUS BAS ne compte pas — seule la première ligne définit l'en-tête", () => {
    const map = buildMergeMap(
      grid,
      [],
      [
        [false, false, false, false, false, false, false],
        [true, true, true, true, true, true, true],
      ],
    );
    expect(headerRowCount(map)).toBe(1);
  });
});
