/** Where a workbook chart's values are read when the file wrote none (docs/CONCEPTION-GRAPHIQUE-SANS-CACHE.md).
 *  A chart part names its data by address (`c:f`) and, optionally, caches the values (ECMA-376 Part 1 §21.2.2.120 `numRef`, §21.2.2.123
 *  `numCache`, §21.2.2.199 `strRef`); Google Sheets writes the address and no cache. Decides: the closed grammar of an address we read
 *  (`parseChartReference`: a sheet name, then one cell or a range of ONE row or ONE column; everything else is refused) and the points a
 *  readable address gives (`sheetChartResolver`): only the sheet that HOLDS the chart is read, an empty cell gives no point, and a cell in a
 *  hidden or filtered row or column gives none whatever `c:plotVisOnly` says (what the published sheet does not show is not exposed here
 *  either).
 *  NOT here: when the sheet replaces the cache, the table and the drawing built from the points (`pptx-reader/chart.ts`), the cell text
 *  itself (`xlsx.ts#keptGridOf`, which hands its grid over), the structure control's own reading of the same addresses
 *  (`pipeline/source-reading-chart.ts`, written separately on purpose so the two readings stay independent).
 *  Called by: `extractor/xlsx.ts` (builds the resolver, passes it to the chart reader), `pptx-reader/chart.ts` (type only). */

import { EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS } from "./xlsx-parts";

/** One point of a reference, from one cell: `index` is the cell's place in the range (the cache's `idx`), `text` what the grid shows,
 *  `stored` the number the cell holds (numeric cells only), `formatCode` the cell's format. */
export interface ChartCellPoint {
  index: number;
  text: string;
  stored?: string;
  formatCode?: string | undefined;
}

/** The points of an address, in index order, produced as asked. `extent`, when given, is how many cells the reference can yield, known
 *  without reading one: its length up to its last cell that gives a point (the length of the cache Excel would write; 0 when none does). */
export interface ChartPoints extends Iterable<ChartCellPoint> {
  extent?: number;
}

/** The points of an address, or `undefined` for an address outside the grammar or on another sheet, which the chart reader answers by keeping
 *  the file's own cache. */
export type ChartResolver = (reference: string) => ChartPoints | undefined;

/** Zero-based, inclusive; one of the two dimensions is a single line. */
export interface ChartRange {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

// A bare sheet name stops at everything that makes the address something else: a quote, a colon (3-D), a space or a function-like
// character. An external book (`[1]Sheet!A1`) is refused by the comparison with the holding sheet (pinned by the grammar test).
const BARE_SHEET = /^([^'!\s:\\/?*(),;]+)!(.+)$/u;
const QUOTED_SHEET = /^'((?:[^']|'')+)'!(.+)$/u;
const CELL = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/u;

const cellOf = (text: string): { row: number; column: number } | undefined => {
  const match = CELL.exec(text);
  if (match === null) return undefined;
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + (letter.charCodeAt(0) - 64);
  const row = Number(match[2]);
  return row <= EXCEL_MAX_ROWS && column <= EXCEL_MAX_COLUMNS ? { row: row - 1, column: column - 1 } : undefined;
};

/** The range an address names on `holdingSheet`, `undefined` for anything else: no sheet name, another sheet (names compare ignoring case, as
 *  Excel does), an external book, a defined name, several areas, a whole column or row, a 3-D range, a table reference, a two-dimensional range,
 *  a range written from its bottom-right corner. */
export const parseChartReference = (reference: string, holdingSheet: string): ChartRange | undefined => {
  const quoted = QUOTED_SHEET.exec(reference);
  const match = quoted ?? BARE_SHEET.exec(reference);
  if (match === null) return undefined;
  const sheet = quoted === null ? match[1]! : match[1]!.replaceAll("''", "'");
  if (sheet.toLowerCase() !== holdingSheet.toLowerCase()) return undefined;
  const [startText, endText = startText, ...rest] = match[2]!.split(":");
  if (rest.length > 0 || startText === undefined) return undefined;
  const start = cellOf(startText);
  const end = cellOf(endText ?? "");
  if (start === undefined || end === undefined) return undefined;
  if (start.row > end.row || start.column > end.column) return undefined;
  if (start.row !== end.row && start.column !== end.column) return undefined;
  return { firstRow: start.row, lastRow: end.row, firstColumn: start.column, lastColumn: end.column };
};

/** What the resolver needs of a sheet's published grid, zero-based like the sheet reader. */
export interface ChartGrid {
  /** The cells that show something (row, column), hidden rows and columns out, any order. */
  readonly filledCells: readonly (readonly [rowIndex: number, columnIndex: number])[];
  /** What the cell shows, `""` for a cell that is hidden, empty or shows nothing. */
  textAt: (rowIndex: number, columnIndex: number) => string;
  /** The number the cell holds and its format code; `undefined` for a cell that is not a number. */
  numberAt: (rowIndex: number, columnIndex: number) => { value: number; formatCode: string | undefined } | undefined;
}

/** The first index of `places` (ascending) that is at least `target`. */
const lowerBound = (places: readonly number[], target: number): number => {
  let low = 0;
  let high = places.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (places[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** The cells that give a point, line by line: for each column the rows, for each row the columns, ascending. */
interface PointLines {
  byColumn: Map<number, number[]>;
  byRow: Map<number, number[]>;
}

const pointLinesOf = (grid: ChartGrid): PointLines => {
  const lines: PointLines = { byColumn: new Map(), byRow: new Map() };
  const add = (line: Map<number, number[]>, key: number, place: number): void => {
    const places = line.get(key);
    if (places === undefined) line.set(key, [place]);
    else places.push(place);
  };
  for (const [row, column] of grid.filledCells) {
    // A blank text gives no point: left out here, so a walk never examines it.
    if (grid.textAt(row, column).trim() === "") continue;
    add(lines.byColumn, column, row);
    add(lines.byRow, row, column);
  }
  for (const places of [...lines.byColumn.values(), ...lines.byRow.values()]) places.sort((earlier, later) => earlier - later);
  return lines;
};

/** The resolver of the sheet named `sheetName` whose published grid is `grid`. A range walks only the cells of its line that give a point, never
 *  the span nor the other kept cells: the lines are built once per sheet, when the first chart asks (one lookup per filled cell). Each cell a
 *  walk examines is a point (two lookups), so a reference read up to the point bound (`pptx-reader/chart.ts#upToBound`) examines at most that
 *  bound plus one cells, whatever its span and the sheet's height. */
export const sheetChartResolver = (sheetName: string, grid: ChartGrid): ChartResolver => {
  let lines: PointLines | undefined;
  const pointAt = (row: number, column: number, index: number): ChartCellPoint => {
    const number = grid.numberAt(row, column);
    return { index, text: grid.textAt(row, column), ...(number === undefined ? {} : { stored: String(number.value), formatCode: number.formatCode }) };
  };
  /** The places along the range's line that give a point, and the range's two ends on that line. */
  const lineOf = (range: ChartRange): { across: boolean; places: readonly number[]; first: number; last: number } => {
    lines ??= pointLinesOf(grid);
    const across = range.firstRow === range.lastRow;
    const places = (across ? lines.byRow.get(range.firstRow) : lines.byColumn.get(range.firstColumn)) ?? [];
    return across ? { across, places, first: range.firstColumn, last: range.lastColumn } : { across, places, first: range.firstRow, last: range.lastRow };
  };
  function* pointsOf(range: ChartRange): Generator<ChartCellPoint> {
    const { across, places, first, last } = lineOf(range);
    for (let at = lowerBound(places, first); at < places.length && places[at]! <= last; at++) {
      const place = places[at]!;
      yield across ? pointAt(range.firstRow, place, place - first) : pointAt(place, range.firstColumn, place - first);
    }
  }
  /** The range's length up to its last cell that gives a point (0: none), from the lines alone: the length of the cache Excel would write. */
  const extentOf = (range: ChartRange): number => {
    const { places, first, last } = lineOf(range);
    const end = lowerBound(places, last + 1);
    return end > lowerBound(places, first) ? places[end - 1]! - first + 1 : 0;
  };
  return (reference) => {
    const range = parseChartReference(reference, sheetName);
    if (range === undefined) return undefined;
    const points: ChartPoints = { [Symbol.iterator]: () => pointsOf(range), extent: extentOf(range) };
    return points;
  };
};
