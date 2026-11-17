/** The structure control's OWN reading of the addresses a workbook chart names (`c:f`), for a chart whose file cached no value
 *  (docs/CONCEPTION-GRAPHIQUE-SANS-CACHE.md). Written on its own, never through `extractor/xlsx-chart-reference.ts`: the page and the control
 *  must each decide which cell is a point, or a defect of one would pass the other (`pipeline/source-chart-reference.agreement.test.ts` holds
 *  the two grammars to the same table of addresses).
 *  Decides: which addresses are read (a sheet name that is the holding sheet's, then one cell or a range of ONE row or ONE column; anything
 *  else is refused with `undefined`) and which kept cell gives a point (a cell the published grid keeps and that shows something: hidden and
 *  empty cells give none).
 *  NOT here: when the sheet replaces the cache, and the table's shape (`source-reading-chart.ts`), the kept cells themselves
 *  (`source-reading-xlsx.ts#readKeptCells`).
 *  Also holds Excel's grid limits for the control (`MAX_COLUMN`, `EXCEL_MAX_ROWS`).
 *  Called by: `pipeline/source-reading-xlsx.ts` (builds it, and reads the limits), `pipeline/source-reading-chart.ts` and `pipeline/source-structure-sheet.ts` (type
 *  only). */

/** Excel's grid holds 16,384 columns (A..XFD) — Microsoft's « Excel specifications and limits ». A chart's address past it names nothing; the
 *  control's workbook reading (`source-reading-xlsx.ts`) clamps a hidden `col@max` span to it instead of expanding whatever a file declares
 *  (`max="2000000000"` is a valid xsd:unsignedInt). */
export const MAX_COLUMN = 16_384;

/** The last row Excel can hold (ECMA-376 Part 1 §18.3.1.66: 1,048,576). A chart's address past it names nothing; in the control's workbook
 *  reading (`source-reading-xlsx.ts`) a split or a table reaching past it declares nothing. */
export const EXCEL_MAX_ROWS = 1_048_576;

/** A cell the published grid keeps: its place (1-based row and column), what it shows (the raw text for a number: the control never writes a
 *  number's display) and whether it holds a number. */
export interface KeptChartCell {
  rowNum: number;
  colNum: number;
  text: string;
  numeric: boolean;
}

/** One point of a reference: the cell's place in the range (the cache's `idx`), its text, whether it is a number. */
export interface SheetCell {
  index: number;
  text: string;
  numeric: boolean;
}

/** The points of an address, in index order, produced as asked. `extent` is how many cells the reference can yield, known without producing
 *  one: its length up to its last cell that shows something (0 when none does). */
export interface SheetCells extends Iterable<SheetCell> {
  readonly extent: number;
}

/** The points of an address; `undefined`: an address the control does not read. */
export type SheetCellsResolver = (reference: string) => SheetCells | undefined;

interface Span {
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

const corner = (text: string): { row: number; col: number } | undefined => {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/u.exec(text);
  if (match === null) return undefined;
  let col = 0;
  for (const letter of match[1]!) col = col * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return row <= EXCEL_MAX_ROWS && col <= MAX_COLUMN ? { row, col } : undefined;
};

/** The sheet name and the cell part of an address: a name in single quotes (an apostrophe doubled inside), or a bare one. */
const split = (reference: string): { sheet: string; cells: string } | undefined => {
  const quoted = /^'((?:[^']|'')+)'!(.+)$/u.exec(reference);
  if (quoted !== null) return { sheet: quoted[1]!.replaceAll("''", "'"), cells: quoted[2]! };
  const bare = /^([^'!\s:\\/?*(),;]+)!(.+)$/u.exec(reference);
  return bare === null ? undefined : { sheet: bare[1]!, cells: bare[2]! };
};

/** The cells an address names on `holdingSheet`, or `undefined`. Names compare ignoring case. */
export const spanOf = (reference: string, holdingSheet: string): Span | undefined => {
  const parts = split(reference);
  if (parts === undefined || parts.sheet.toLowerCase() !== holdingSheet.toLowerCase()) return undefined;
  const ends = parts.cells.split(":");
  if (ends.length > 2) return undefined;
  const from = corner(ends[0]!);
  const to = corner(ends[ends.length - 1]!);
  if (from === undefined || to === undefined || from.row > to.row || from.col > to.col) return undefined;
  if (from.row !== to.row && from.col !== to.col) return undefined;
  return { firstRow: from.row, lastRow: to.row, firstCol: from.col, lastCol: to.col };
};

/** A kept cell that shows something, at its place along a line (its column for a row, its row for a column). */
interface Placed {
  at: number;
  cell: SheetCell;
}

/** The resolver of the sheet `sheetName` whose kept cells are `cells` (any order). The cells that show something are indexed once, by column and
 *  by row, when the first chart asks (one read of each kept cell's text); a range then visits only the indexed cells of its own line, never the
 *  span nor the sheet's other kept rows, so a reference read up to the point bound (`source-reading-chart.ts#sheetPointsOf`) visits at most
 *  that bound plus one cells. */
export const keptCellsResolver = (sheetName: string, cells: readonly KeptChartCell[]): SheetCellsResolver => {
  let lines: { byCol: Map<number, Placed[]>; byRow: Map<number, Placed[]> } | undefined;
  const index = (): { byCol: Map<number, Placed[]>; byRow: Map<number, Placed[]> } => {
    if (lines !== undefined) return lines;
    const byCol = new Map<number, Placed[]>();
    const byRow = new Map<number, Placed[]>();
    const place = (line: Map<number, Placed[]>, key: number, placed: Placed): void => {
      const known = line.get(key);
      if (known === undefined) line.set(key, [placed]);
      else known.push(placed);
    };
    // One cell per place, the last written winning (a file may repeat a cell reference).
    const byPlace = new Map<string, KeptChartCell>();
    for (const kept of cells) byPlace.set(`${kept.rowNum},${kept.colNum}`, kept);
    for (const kept of byPlace.values()) {
      const text = kept.text;
      if (text.trim() === "") continue;
      const cell = { index: 0, text, numeric: kept.numeric };
      place(byCol, kept.colNum, { at: kept.rowNum, cell });
      place(byRow, kept.rowNum, { at: kept.colNum, cell });
    }
    for (const line of [...byCol.values(), ...byRow.values()]) line.sort((earlier, later) => earlier.at - later.at);
    lines = { byCol, byRow };
    return lines;
  };
  /** The indexed cells of the span's line, and the span's two ends on it. */
  const lineOf = (span: Span): { line: readonly Placed[]; from: number; to: number } => {
    const { byCol, byRow } = index();
    const across = span.firstRow === span.lastRow;
    return {
      line: (across ? byRow.get(span.firstRow) : byCol.get(span.firstCol)) ?? [],
      from: across ? span.firstCol : span.firstRow,
      to: across ? span.lastCol : span.lastRow,
    };
  };
  /** The first position of `line` whose place is at least `target`. */
  const firstAtLeast = (line: readonly Placed[], target: number): number => {
    let low = 0;
    let high = line.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (line[middle]!.at < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  function* pointsOf(span: Span): Generator<SheetCell> {
    const { line, from, to } = lineOf(span);
    for (let position = firstAtLeast(line, from); position < line.length && line[position]!.at <= to; position++) {
      const { at, cell } = line[position]!;
      yield { ...cell, index: at - from };
    }
  }
  /** The span's length up to its last indexed cell (0: none), from the index alone. */
  const extentOf = (span: Span): number => {
    const { line, from, to } = lineOf(span);
    const end = firstAtLeast(line, to + 1);
    return end > firstAtLeast(line, from) ? line[end - 1]!.at - from + 1 : 0;
  };
  return (reference) => {
    const span = spanOf(reference, sheetName);
    if (span === undefined) return undefined;
    const found: SheetCells = { [Symbol.iterator]: () => pointsOf(span), extent: extentOf(span) };
    return found;
  };
};
