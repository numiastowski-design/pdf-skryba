/** The words of one native chart part (`c:chartSpace`), read INDEPENDENTLY of the extractor (`extractor/pptx-reader/chart.ts`): the
 *  chart's titles, its series names, its category labels, a scatter or bubble's X values and sizes (`c:xVal`, `c:bubbleSize`: one X column is shared by the series of the same X as displayed, each series of another X has its own) and its values AS THE CHART DISPLAYS THEM (« 81% », never the stored
 *  `0.80861244019138756`). The display rule is written here on its own: a series' values take the `c:numFmt` of its data labels
 *  (`c:dLbls`) unless that is source-linked, else the `c:formatCode` of their `c:numCache` (ECMA-376 Part 1 §21.2.2.121, §21.2.2.49,
 *  §21.2.2.71); an axis format formats ticks, never values. Only the number-format ENGINE is shared with the page
 *  (`extractor/xlsx-number-format.ts`), as « 81% » must be the same string on both sides: a bug of that engine would be shared by both
 *  readings and is NOT caught here (written limit, `core/import-boundaries.test.ts`).
 *  A chart the extractor WITHHOLDS whole (series, cells, points or category levels over their caps) is not on the page, so it expects
 *  none of its words: everything is counted HERE, from this part's own XML; only the four cap constants are shared
 *  (`lib/reader-limits.ts`), never the extractor's logic.
 *  A workbook chart that carries NO value in any reference (Google Sheets writes the address and no cache) is read from the sheet that holds it,
 *  as the page does, through the control's own cells (`source-chart-reference.ts`): the same decision, written again here, so the two readings
 *  stay independent.
 *  NOT here: walking the document to its charts (`source-reading-docx.ts`, `source-reading-pptx.ts`, `source-structure-sheet.ts`), the page's own
 *  chart table (`extractor/pptx-reader/chart.ts`), the addresses and the cells (`source-chart-reference.ts`).
 *  Called by: `source-reading-docx.ts` (Word charts), `source-reading-pptx.ts` (slide charts) and `source-structure-sheet.ts` (workbook charts). */

import { MAX_CHART_CELLS, MAX_CHART_LEVELS, MAX_CHART_POINTS, MAX_CHART_SERIES, type ReaderLimits } from "doc-ir/lib/reader-limits";
import { formatNumberCell } from "../extractor/xlsx-number-format";
import type { SheetCell, SheetCells, SheetCellsResolver } from "./source-chart-reference";
import { attrOf, first, kidsOf, tagOf, textOf, type N } from "./source-reading-package";

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
const allOf = (n: N, tag: string, out: N[] = []): N[] => {
  for (const c of kidsOf(n)) {
    if (tagOf(c) === tag) out.push(c);
    else allOf(c, tag, out);
  }
  return out;
};

/** The format a series' values are shown with: not-linked data-label format, else the cache's, else General (`undefined`). */
const shownFormatOf = (ser: N, numCache: N | undefined): string | undefined => {
  const label = first(first(ser, "c:dLbls"), "c:numFmt");
  const labelCode = label ? attrOf(label, "formatCode") : undefined;
  const linked = label ? attrOf(label, "sourceLinked") : undefined;
  if (labelCode !== undefined && labelCode !== "" && linked !== "1" && linked !== "true") return labelCode;
  const cached = numCache ? textOf(first(numCache, "c:formatCode") ?? {}) : "";
  return cached === "" ? undefined : cached;
};

const shown = (stored: string, code: string | undefined): string => {
  const n = stored.trim() === "" ? Number.NaN : Number(stored);
  return Number.isFinite(n) ? (formatNumberCell(n, code, false) ?? stored) : stored;
};

/** The bounds of a chart: points, category levels, series and cells: the limits given, else the product's. */
const boundsOf = (limits: ReaderLimits | undefined): { series: number; cells: number; points: number; levels: number } => ({
  series: limits?.chartSeries ?? MAX_CHART_SERIES,
  cells: limits?.chartCells ?? MAX_CHART_CELLS,
  points: limits?.chartPoints ?? MAX_CHART_POINTS,
  levels: limits?.chartLevels ?? MAX_CHART_LEVELS,
});

/** One cache as the extractor's table would hold it: the cells written (index to text) and the array length they imply (last kept idx + 1).
 *  `"over"`: a point PRESENT at or past `MAX_CHART_POINTS`, checked before the declared count filters anything. A written `c:ptCount`
 *  (an explicit 0 included) drops the points at or past it; an absent or unreadable one drops nothing. */
interface Cache { length: number; cells: Map<number, string> }
const readCache = (countNode: N | undefined, ptsNode: N | undefined, display: (v: string) => string, limits: ReaderLimits | undefined): Cache | "over" => {
  const raw = attrOf(first(countNode, "c:ptCount") ?? {}, "val");
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const declared = Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  return cacheFrom(cachedPoints(ptsNode), declared, display, limits);
};

/** The `c:pt` of a cache as (index, text): an unreadable idx (« abc ») is no cell (the extractor drops it too); Infinity (400 digits) is past the bound in `cacheFrom`. */
function* cachedPoints(ptsNode: N | undefined): Generator<{ idx: number; value: string }> {
  for (const pt of ptsNode ? kidsOf(ptsNode).filter((c) => tagOf(c) === "c:pt") : []) {
    const idx = Number.parseInt(attrOf(pt, "idx") ?? "-1", 10);
    if (!Number.isNaN(idx)) yield { idx, value: textOf(first(pt, "c:v") ?? {}) };
  }
}

const cacheFrom = (points: Iterable<{ idx: number; value: string }>, declared: number | undefined, display: (v: string) => string, limits: ReaderLimits | undefined): Cache | "over" => {
  const cache: Cache = { length: 0, cells: new Map() };
  const pointCap = boundsOf(limits).points;
  for (const { idx, value } of points) {
    if (idx >= pointCap) return "over";
    if (idx < 0 || (declared !== undefined && idx >= declared)) continue;
    cache.cells.set(idx, display(value));
    cache.length = Math.max(cache.length, idx + 1);
  }
  return cache;
};

const verbatim = (v: string): string => v;
const emptyCache = (): Cache => ({ length: 0, cells: new Map() });
const multiLevels = (multi: N, limits: ReaderLimits | undefined): Cache[] | "over" => {
  const levels: Cache[] = [];
  const levelCap = boundsOf(limits).levels;
  for (const lvl of kidsOf(multi).filter((c) => tagOf(c) === "c:lvl")) {
    if (levels.length >= levelCap) return "over";
    const one = readCache(multi, lvl, verbatim, limits);
    if (one === "over") return "over";
    levels.push(one);
  }
  return levels;
};
/** The category levels of a series' `c:cat`, leaf first: a multi-level cache gives one per `c:lvl`, a plain reference one, none written gives
 *  one empty level. `"over"`: a cache past the point cap, or a ninth level. */
const levelsOf = (cat: N | undefined, limits: ReaderLimits | undefined, sheet: SheetPoints | undefined): Cache[] | "over" => {
  const multi = first(first(cat, "c:multiLvlStrRef"), "c:multiLvlStrCache");
  const levels = multi ? multiLevels(multi, limits) : [];
  if (levels === "over" || levels.length > 0) return levels;
  const str = first(cat, "c:strRef");
  const num = first(cat, "c:numRef");
  if (!str && !num) return [emptyCache()];
  const read = sheet?.get((str ?? num)!);
  const cache = str ? first(str, "c:strCache") : first(num, "c:numCache");
  const one = read === undefined ? readCache(cache, cache, verbatim, limits) : cacheFrom(read.map((cell) => ({ idx: cell.index, value: cell.text })), undefined, verbatim, limits);
  return one === "over" ? "over" : [one];
};

const occupiedRows = (columns: readonly Cache[]): number => {
  const occupied = new Set<number>();
  for (const column of columns) for (const [i, v] of column.cells) if (v !== "") occupied.add(i);
  return occupied.size;
};

/** A scatter or bubble series writes `c:xVal`, `c:yVal` or `c:bubbleSize` where the others write `c:cat` and `c:val`. */
const isXy = (ser: N): boolean => ["c:xVal", "c:yVal", "c:bubbleSize"].some((tag) => first(ser, tag) !== undefined);

/** The cache format of a number reference (§21.2.2.71): what an X value or a bubble size is shown with (data labels format the Y). */
const cacheFormatOf = (numCache: N | undefined): string | undefined => {
  const cached = numCache ? textOf(first(numCache, "c:formatCode") ?? {}) : "";
  return cached === "" ? undefined : cached;
};

/** The cache of a `c:xVal`, `c:yVal` or `c:bubbleSize`: a string reference as written, a number reference shown with `codeOf`'s format; none
 *  written (or literal data, not read: written limit) gives an empty cache. `"over"`: past the point cap. */
const xyCacheOf = (parent: N | undefined, codeOf: (numCache: N | undefined) => string | undefined, limits: ReaderLimits | undefined, sheet: SheetPoints | undefined, labelCode: string | undefined): Cache | "over" => {
  const strRef = first(parent, "c:strRef");
  const str = first(strRef, "c:strCache");
  const strRead = strRef === undefined ? undefined : sheet?.get(strRef);
  if (strRead !== undefined) return cacheFrom(strRead.map((cell) => ({ idx: cell.index, value: cell.text })), undefined, verbatim, limits);
  if (str) return readCache(str, str, verbatim, limits);
  const numRef = first(parent, "c:numRef");
  const numRead = numRef === undefined ? undefined : sheet?.get(numRef);
  if (numRead !== undefined) return numbersFromSheet(numRead, labelCode, limits);
  const num = first(numRef, "c:numCache");
  if (!num) return emptyCache();
  const code = codeOf(num);
  return readCache(num, num, (v) => shown(v, code), limits);
};

const sameCells = (a: Cache, b: Cache): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a.cells.get(i) ?? "") !== (b.cells.get(i) ?? "")) return false;
  return true;
};
const isBlank = (cache: Cache): boolean => occupiedRows([cache]) === 0;

/** The sheet's points by the reference node they stand for (the control's own reading, `source-chart-reference.ts`). */
type SheetPoints = ReadonlyMap<N, readonly SheetCell[]>;

const REFERENCES = ["c:strRef", "c:numRef", "c:multiLvlStrRef"] as const;
const SERIES_DATA = ["c:tx", "c:cat", "c:val", "c:xVal", "c:yVal", "c:bubbleSize"] as const;

/** Up to and including the first cell at or past the point bound: that one withholds the chart, and a range far past the bound is never read whole. */
const upToCap = (found: Iterable<SheetCell>, cap: number): SheetCell[] => {
  const kept: SheetCell[] = [];
  for (const cell of found) {
    kept.push(cell);
    if (cell.index >= cap) break;
  }
  return kept;
};

/** How many cells a reference can yield: its `extent`, or, from a resolver that cannot tell (a test's fixed cells), the cells read up to the
 *  bound, which are then kept. A series name counts one cell: only its first is read. */
const cellsOf = (found: SheetCells, name: boolean, cap: number): { cells: number; read?: SheetCell[] } => {
  if (name) return { cells: 1 };
  if (found.extent !== undefined) return { cells: found.extent };
  const read = upToCap(found, cap);
  return { cells: read.length === 0 ? 0 : read[read.length - 1]!.index + 1, read };
};

/** The sheet's points for the series references of a chart, or `undefined` when the chart keeps its cache: some reference of the chart carries a
 *  point, it holds literal data, there is no series reference, a reference is not read (another sheet, an address outside the grammar, a
 *  multi-level category), the chart has more series than the bound (its cache then withholds it in `publishedTable`), or its references can
 *  yield more cells than the bounds allow. That last decision is ARITHMETIC on the parsed addresses, before any cell is read, written here on
 *  its own and the same as the page's (`extractor/pptx-reader/chart.ts#sheetPointsOf`): one reference whose extent (the length of the cache
 *  Excel would write) is over MAX_CHART_POINTS, or all the references of the chart together over MAX_CHART_CELLS, a series name counting one
 *  cell. Points held for one chart: at most MAX_CHART_CELLS, decided before the first cell is read. */
const sheetPointsOf = (chart: N, series: readonly N[], resolver: SheetCellsResolver, limits: ReaderLimits | undefined): SheetPoints | undefined => {
  if (REFERENCES.some((tag) => allOf(chart, tag).some((ref) => allOf(ref, "c:pt").length > 0))) return undefined;
  // Literal data is values the file wrote and this reading does not read: the chart keeps its cache whole.
  if (["c:numLit", "c:strLit"].some((tag) => allOf(chart, tag).length > 0)) return undefined;
  if (series.length > boundsOf(limits).series) return undefined;
  const plan = planOf(series, resolver, limits);
  return plan === undefined ? undefined : cellsOfPlan(plan, limits);
};

interface Planned { ref: N; found: SheetCells; name: boolean; read?: SheetCell[] }

/** Every series reference parsed and its cells counted against the bounds, before any cell is read. `undefined`: a multi-level category, a
 *  refused address, or a bound passed. */
const planOf = (series: readonly N[], resolver: SheetCellsResolver, limits: ReaderLimits | undefined): Planned[] | undefined => {
  const bounds = boundsOf(limits);
  // A parse memo by address text: a repeated address is parsed and read once.
  const answers = new Map<string, SheetCells | undefined>();
  const plan: Planned[] = [];
  let total = 0;
  for (const { ref, name } of series.flatMap(seriesReferences)) {
    if (tagOf(ref) === "c:multiLvlStrRef") return undefined;
    const address = textOf(first(ref, "c:f") ?? {});
    if (!answers.has(address)) answers.set(address, resolver(address));
    const found = answers.get(address);
    if (found === undefined) return undefined;
    const { cells, read } = cellsOf(found, name, bounds.points);
    total += cells;
    if ((!name && cells > bounds.points) || total > bounds.cells) return undefined;
    plan.push({ ref, found, name, ...(read === undefined ? {} : { read }) });
  }
  return plan;
};

/** The cells of a plan within the bounds: a name its first cell, any other reference up to the bound, an address read once. */
const cellsOfPlan = (plan: readonly Planned[], limits: ReaderLimits | undefined): SheetPoints | undefined => {
  const bounds = boundsOf(limits);
  const readOnce = new Map<SheetCells, SheetCell[]>();
  const resolved = new Map<N, SheetCell[]>();
  for (const { ref, found, name, read } of plan) {
    if (name) {
      const firstCell = found[Symbol.iterator]().next();
      resolved.set(ref, firstCell.done === true ? [] : [firstCell.value]);
    } else {
      if (!readOnce.has(found)) readOnce.set(found, read ?? upToCap(found, bounds.points));
      resolved.set(ref, readOnce.get(found)!);
    }
  }
  return resolved.size === 0 ? undefined : resolved;
};

/** The reference nodes a series reads (name, categories, values, X, Y, sizes), in document order of the tags above, each with whether it is the
 *  series' name (`c:tx`). */
const seriesReferences = (ser: N): { ref: N; name: boolean }[] =>
  SERIES_DATA.flatMap((dataTag) => REFERENCES.flatMap((referenceTag): { ref: N; name: boolean }[] => {
    const ref = first(first(ser, dataTag), referenceTag);
    return ref === undefined ? [] : [{ ref, name: dataTag === "c:tx" }];
  }));

/** The data-label format of a series when it does not follow the source (§21.2.2.121), else `undefined`. */
const labelFormatOf = (ser: N): string | undefined => {
  const label = first(first(ser, "c:dLbls"), "c:numFmt");
  const code = label ? attrOf(label, "formatCode") : undefined;
  const linked = label ? attrOf(label, "sourceLinked") : undefined;
  return code !== undefined && code !== "" && linked !== "1" && linked !== "true" ? code : undefined;
};

/** The cache a number reference makes from the sheet: its numeric cells only, shown with the data labels' format when they decide it. */
const numbersFromSheet = (read: readonly SheetCell[], labelCode: string | undefined, limits: ReaderLimits | undefined): Cache | "over" =>
  cacheFrom(read.filter((cell) => cell.numeric).map((cell) => ({ idx: cell.index, value: cell.text })), undefined, (v) => shown(v, labelCode), limits);

interface Building { levels: Cache[]; columns: Cache[]; publishedX: Cache[]; longest: number }

/** What a scatter series adds to the table: its X column (unless it is blank, or the same as displayed as the label column or an X column
 *  already added: the page shares it; the label column itself when no series writes categories), its Y column, and its bubble sizes column
 *  (unless blank). Updates the label columns, the X columns and the longest array of `state`. `"over"`: a cache past the point cap. */
const xySeries = (ser: N, state: Building, categorised: boolean, limits: ReaderLimits | undefined, sheet: SheetPoints | undefined): Cache[] | "over" => {
  const xs = xyCacheOf(first(ser, "c:xVal"), cacheFormatOf, limits, sheet, undefined);
  const ys = xyCacheOf(first(ser, "c:yVal"), (cache) => shownFormatOf(ser, cache), limits, sheet, labelFormatOf(ser));
  const sizes = xyCacheOf(first(ser, "c:bubbleSize"), cacheFormatOf, limits, sheet, undefined);
  if (xs === "over" || ys === "over" || sizes === "over") return "over";
  const added: Cache[] = [];
  if (!isBlank(xs)) {
    if (!categorised && state.levels.every((l) => l.length === 0)) state.levels = [xs];
    else if (!(state.levels.length === 1 && sameCells(xs, state.levels[0]!)) && !state.publishedX.some((p) => sameCells(xs, p))) {
      added.push(xs);
      state.publishedX.push(xs);
    }
  }
  added.push(ys);
  if (!isBlank(sizes)) added.push(sizes);
  for (const column of [...state.levels, ...added]) state.longest = Math.max(state.longest, column.length);
  return added;
};

/** What a bar-, column- or line-shaped series adds: its categories when no earlier series gave some, then its values. */
const valueSeries = (ser: N, state: Building, limits: ReaderLimits | undefined, sheet: SheetPoints | undefined): Cache[] | "over" => {
  if (state.levels.every((l) => l.length === 0)) {
    const found = levelsOf(first(ser, "c:cat"), limits, sheet);
    if (found === "over") return "over";
    state.levels = found;
    for (const l of found) state.longest = Math.max(state.longest, l.length);
  }
  const numRef = first(first(ser, "c:val"), "c:numRef");
  const read = numRef === undefined ? undefined : sheet?.get(numRef);
  const numCache = first(numRef, "c:numCache");
  const code = shownFormatOf(ser, numCache);
  const values = read === undefined ? readCache(numCache, numCache, (v) => shown(v, code), limits) : numbersFromSheet(read, labelFormatOf(ser), limits);
  if (values === "over") return "over";
  state.longest = Math.max(state.longest, values.length);
  return [values];
};

/** The table the page holds for the series, as caches: its label columns (the categories of the first series that writes some; else the X
 *  values of the first scatter series that writes some) and its other columns, in order. `"withheld"`: a 256th series, a point at or past
 *  the point cap, a ninth category level, `(levels + columns so far + this series' columns) x longest array` over the cell cap while
 *  reading, or (occupied rows x (levels + columns)) over it at the end. */
const publishedTable = (series: readonly N[], limits: ReaderLimits | undefined, sheet: SheetPoints | undefined): { levels: Cache[]; columns: Cache[] } | "withheld" => {
  const state: Building = { levels: [emptyCache()], columns: [], publishedX: [], longest: 0 };
  const categorised = series.some((ser) => {
    const cat = first(ser, "c:cat");
    if (isXy(ser) || cat === undefined) return false;
    return sheet === undefined ? allOf(cat, "c:pt").length > 0 : [first(cat, "c:strRef"), first(cat, "c:numRef")].some((ref) => ref !== undefined && (sheet.get(ref)?.length ?? 0) > 0);
  });
  const bounds = boundsOf(limits);
  let seen = 0;
  for (const ser of series) {
    if (seen >= bounds.series) return "withheld";
    seen++;
    const added = isXy(ser) ? xySeries(ser, state, categorised, limits, sheet) : valueSeries(ser, state, limits, sheet);
    if (added === "over") return "withheld";
    if ((state.levels.length + state.columns.length + added.length) * state.longest > bounds.cells) return "withheld";
    state.columns.push(...added);
  }
  const { levels, columns } = state;
  return occupiedRows([...levels, ...columns]) * (levels.length + columns.length) > bounds.cells ? "withheld" : { levels, columns };
};

/** An axis the chart deletes (`c:delete`, CT_Boolean: no `val` is true). */
const isDeleted = (axis: N): boolean => {
  const del = first(axis, "c:delete");
  if (!del) return false;
  const val = attrOf(del, "val");
  return val === undefined || val === "1" || val === "true";
};

/** The `c:title` nodes of the deleted axes: they show nothing, so none of their words is expected. */
const hiddenTitlesOf = (chart: N): Set<N> =>
  new Set(["c:catAx", "c:valAx", "c:dateAx", "c:serAx"].flatMap((tag) => allOf(chart, tag).filter(isDeleted).flatMap((axis) => allOf(axis, "c:title"))));

/** What a `c:title` shows, read here on its own: the lines of its rich text (one per `a:p`, and a new one at each `a:br`, never welded), or,
 *  for a title linked to a cell (`c:tx/c:strRef`), the points of its `c:strCache`. Each piece is a text the bag of words splits. */
const titleWordsOf = (title: N): string[] => {
  const pieces: string[] = [];
  for (const paragraph of allOf(title, "a:p")) {
    let line = "";
    for (const piece of kidsOf(paragraph)) {
      if (tagOf(piece) === "a:br") {
        pieces.push(line);
        line = "";
      } else line += allOf(piece, "a:t").map(textOf).join("");
    }
    pieces.push(line);
  }
  const rich = pieces.filter((p) => p.trim() !== "");
  if (rich.length > 0) return rich;
  const cache = first(first(first(title, "c:tx"), "c:strRef"), "c:strCache");
  return cache ? allOf(cache, "c:v").map(textOf) : [];
};

/** The chart's text pieces, order free (the check compares bags of words). */
const shownTextOf = (chart: N, table: { levels: Cache[]; columns: Cache[] }): string[] => {
  const out: string[] = [];
  // Every title the chart shows: its own and its axes', except those of a deleted axis.
  const hidden = hiddenTitlesOf(chart);
  for (const title of allOf(chart, "c:title")) if (!hidden.has(title)) out.push(...titleWordsOf(title));
  // The series names, then the cells of the page's table: its label columns once (not one copy per series), its value columns.
  for (const ser of allOf(chart, "c:ser")) {
    const name = first(ser, "c:tx");
    if (name) for (const v of allOf(name, "c:v")) out.push(textOf(v));
  }
  for (const column of [...table.levels, ...table.columns]) out.push(...column.cells.values());
  return out;
};

/** The words and the table of a chart part the page publishes: none of either when the extractor withholds the chart whole. */
export interface ChartRead {
  words: string[];
  shape: ChartShape | undefined;
}

/** The size of the table the page publishes for a chart, header row included (always written, its cells empty when no name is): one row per OCCUPIED
 *  point plus the header, one column per category level and per column of values. */
export interface ChartShape {
  rows: number;
  columns: number;
}

export const chartReadOf = (chart: N, limits?: ReaderLimits, resolver?: SheetCellsResolver): ChartRead => {
  const series = allOf(chart, "c:ser");
  const table = publishedTable(series, limits, resolver === undefined ? undefined : sheetPointsOf(chart, series, resolver, limits));
  if (table === "withheld") return { words: [], shape: undefined };
  return { words: shownTextOf(chart, table), shape: { rows: occupiedRows([...table.levels, ...table.columns]) + 1, columns: table.levels.length + table.columns.length } };
};

/** The words the page shows of a chart part: none when the extractor withholds the chart whole. */
export const chartTextOf = (chart: N, limits?: ReaderLimits): string[] => chartReadOf(chart, limits).words;
