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
 *  NOT here: walking the document to its charts (`source-reading-docx.ts`, `source-reading-pptx.ts`), the page's own chart table
 *  (`extractor/pptx-reader/chart.ts`).
 *  Called by: `source-reading-docx.ts` (Word charts) and `source-reading-pptx.ts` (slide charts). */

import { MAX_CHART_CELLS, MAX_CHART_LEVELS, MAX_CHART_POINTS, MAX_CHART_SERIES, type ReaderLimits } from "doc-ir/lib/reader-limits";
import { formatNumberCell } from "../extractor/xlsx-number-format";
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
  const cache: Cache = { length: 0, cells: new Map() };
  const pointCap = boundsOf(limits).points;
  for (const pt of ptsNode ? kidsOf(ptsNode).filter((c) => tagOf(c) === "c:pt") : []) {
    const idx = Number.parseInt(attrOf(pt, "idx") ?? "-1", 10);
    if (Number.isNaN(idx)) continue; // an unreadable idx (« abc ») is no cell: the extractor drops it too; Infinity (400 digits) is past the bound below
    if (idx >= pointCap) return "over";
    if (idx < 0 || (declared !== undefined && idx >= declared)) continue;
    cache.cells.set(idx, display(textOf(first(pt, "c:v") ?? {})));
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
const levelsOf = (cat: N | undefined, limits: ReaderLimits | undefined): Cache[] | "over" => {
  const multi = first(first(cat, "c:multiLvlStrRef"), "c:multiLvlStrCache");
  const levels = multi ? multiLevels(multi, limits) : [];
  if (levels === "over" || levels.length > 0) return levels;
  const str = first(cat, "c:strRef");
  const num = first(cat, "c:numRef");
  if (!str && !num) return [emptyCache()];
  const cache = str ? first(str, "c:strCache") : first(num, "c:numCache");
  const one = readCache(cache, cache, verbatim, limits);
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
const xyCacheOf = (parent: N | undefined, codeOf: (numCache: N | undefined) => string | undefined, limits: ReaderLimits | undefined): Cache | "over" => {
  const str = first(first(parent, "c:strRef"), "c:strCache");
  if (str) return readCache(str, str, verbatim, limits);
  const num = first(first(parent, "c:numRef"), "c:numCache");
  if (!num) return emptyCache();
  const code = codeOf(num);
  return readCache(num, num, (v) => shown(v, code), limits);
};

const sameCells = (a: Cache, b: Cache): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a.cells.get(i) ?? "") !== (b.cells.get(i) ?? "")) return false;
  return true;
};
const isBlank = (cache: Cache): boolean => occupiedRows([cache]) === 0;

interface Building { levels: Cache[]; columns: Cache[]; publishedX: Cache[]; longest: number }

/** What a scatter series adds to the table: its X column (unless it is blank, or the same as displayed as the label column or an X column
 *  already added: the page shares it; the label column itself when no series writes categories), its Y column, and its bubble sizes column
 *  (unless blank). Updates the label columns, the X columns and the longest array of `state`. `"over"`: a cache past the point cap. */
const xySeries = (ser: N, state: Building, categorised: boolean, limits: ReaderLimits | undefined): Cache[] | "over" => {
  const xs = xyCacheOf(first(ser, "c:xVal"), cacheFormatOf, limits);
  const ys = xyCacheOf(first(ser, "c:yVal"), (cache) => shownFormatOf(ser, cache), limits);
  const sizes = xyCacheOf(first(ser, "c:bubbleSize"), cacheFormatOf, limits);
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
const valueSeries = (ser: N, state: Building, limits: ReaderLimits | undefined): Cache[] | "over" => {
  if (state.levels.every((l) => l.length === 0)) {
    const found = levelsOf(first(ser, "c:cat"), limits);
    if (found === "over") return "over";
    state.levels = found;
    for (const l of found) state.longest = Math.max(state.longest, l.length);
  }
  const numCache = first(first(first(ser, "c:val"), "c:numRef"), "c:numCache");
  const code = shownFormatOf(ser, numCache);
  const values = readCache(numCache, numCache, (v) => shown(v, code), limits);
  if (values === "over") return "over";
  state.longest = Math.max(state.longest, values.length);
  return [values];
};

/** The table the page holds for the series, as caches: its label columns (the categories of the first series that writes some; else the X
 *  values of the first scatter series that writes some) and its other columns, in order. `"withheld"`: a 256th series, a point at or past
 *  the point cap, a ninth category level, `(levels + columns so far + this series' columns) x longest array` over the cell cap while
 *  reading, or (occupied rows x (levels + columns)) over it at the end. */
const publishedTable = (series: readonly N[], limits: ReaderLimits | undefined): { levels: Cache[]; columns: Cache[] } | "withheld" => {
  const state: Building = { levels: [emptyCache()], columns: [], publishedX: [], longest: 0 };
  const categorised = series.some((ser) => {
    const cat = first(ser, "c:cat");
    return !isXy(ser) && cat !== undefined && allOf(cat, "c:pt").length > 0;
  });
  const bounds = boundsOf(limits);
  let seen = 0;
  for (const ser of series) {
    if (seen >= bounds.series) return "withheld";
    seen++;
    const added = isXy(ser) ? xySeries(ser, state, categorised, limits) : valueSeries(ser, state, limits);
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

export const chartReadOf = (chart: N, limits?: ReaderLimits): ChartRead => {
  const table = publishedTable(allOf(chart, "c:ser"), limits);
  if (table === "withheld") return { words: [], shape: undefined };
  return { words: shownTextOf(chart, table), shape: { rows: occupiedRows([...table.levels, ...table.columns]) + 1, columns: table.levels.length + table.columns.length } };
};

/** The words the page shows of a chart part: none when the extractor withholds the chart whole. */
export const chartTextOf = (chart: N, limits?: ReaderLimits): string[] => chartReadOf(chart, limits).words;
