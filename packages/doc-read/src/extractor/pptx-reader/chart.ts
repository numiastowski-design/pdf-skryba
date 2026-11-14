/** The data of one chart part (`c:chartSpace`), for a bar-, column- or
 *  line-shaped chart: a `c:cat` category axis and `c:ser` series whose
 *  `c:val` is a number reference. The table has one row per category, one
 *  column per series, preceded by one column per category level when the
 *  categories have several (outermost first); its title is the `c:title` of `c:chart`; the titles of the axes it shows (`c:catAx`, `c:valAx`, `c:dateAx`, `c:serAx`; not a `c:delete`d one): the first `c:catAx`/`c:dateAx` title heads the table's top-left cell when the categories take one column, the others ride along as `axisTitles` (lines under the table). `x` is the category axis, not the screen's horizontal (horizontal bars lay it vertically); `y` a value axis, `z` a `c:serAx` (3D depth); the value axes of a chart with a scatter or bubble group, or with no category or date axis, are told apart by `c:axPos` (`b`/`t` x, `l`/`r` y); its picture
 *  is the image the chart part's relationships name, when the file carries
 *  one (MIKSUDOC « Spécification technique » §5.4: the full data table always, the picture only
 *  when the archive holds a rendering). Values are the numbers AS THE CHART DISPLAYS them (`displayFormatCode`:
 *  `0.8086…` under « 0% » is "81%"; `<c:v>1840</c:v>` stays "1840"), not the stored doubles; category and name caches stay as written.
 *  A scatter or bubble series (`c:xVal`, `c:yVal`, `c:bubbleSize`) is read too: the X values take the left column when no series writes
 *  categories (the title of the horizontal value axis heads it), else a column of their own; series of the same X share one, series of other X
 *  each get their own (X, Y) pair; a bubble's sizes are one more column. A part with no series gives
 *  no data: the slide gets nothing, a `DocumentNotice` in `extractor/pptx.ts`
 *  says so on the dashboard, never on the page.
 *  Also turns that table into an IR block (`chartToIr`).
 *  NOT here: the graphic frame that points at the part
 *  (`pptx-reader/shapes.ts`).
 *  Ported from the former `extractor/pptx.ts#parseChartTable`/`chartTitle`
 *  (the own pptx reader replacing the old analyzer, 25/09/2026), onto the canonical tree.
 *  Called by: `pptx-reader/index.ts`, `extractor/xlsx.ts`, `docx-reader/drawing-objects.ts`
 *  (the read), and `extractor/pptx.ts` (`chartToIr`). */

import { MAX_CHART_CELLS, MAX_CHART_LEVELS, MAX_CHART_POINTS, MAX_CHART_SERIES, type ReaderLimits } from "doc-ir/lib/reader-limits";
import type { ChartAxis, ChartDrawing, ChartDrawingType, ImageRef, IRBlock, TableData } from "doc-ir/lib/ir";
import { orDamaged, type DocxPackage } from "../ooxml/package";
import { attr, child, children, descendants, kids as kidsOf, tagOf, textOf, type XNode } from "../ooxml/xml";
import { formatNumberCell } from "../xlsx-number-format";

export interface PptxChart {
  data: TableData;
  title?: string;
  /** The titles of the axes the chart shows (not the deleted ones) that the table's top-left cell does not carry, in document order. */
  axisTitles?: { axis: ChartAxis; text: string }[];
  /** What the chart macro needs to DRAW this chart (type and numbers), when a Forge component draws it faithfully; absent otherwise. */
  drawing?: ChartDrawing;
  /** The chart part's own rendering, when its relationships name an image
   *  inside the package. */
  image?: { bytes: Uint8Array; contentType: string };
}

/** The format code a series' values are DISPLAYED with: the series' data labels' `c:numFmt` when it is not source-linked
 *  (ECMA-376 Part 1 §21.2.2.121 `numFmt`, `sourceLinked="0"`; `c:dLbls` §21.2.2.49), else the `c:formatCode` of its `c:numCache`
 *  (§21.2.2.71). An axis `c:numFmt` formats ticks and is never read here. `undefined`: General. */
const displayFormatCode = (ser: XNode, numCache: XNode | undefined): string | undefined => {
  const label = child(child(ser, "c:dLbls") ?? {}, "c:numFmt");
  const labelCode = label === undefined ? undefined : attr(label, "formatCode");
  const linked = label === undefined ? undefined : attr(label, "sourceLinked");
  if (labelCode !== undefined && labelCode !== "" && linked !== "1" && linked !== "true") return labelCode;
  return cacheFormatCode(numCache);
};

/** The `c:formatCode` of a number cache (§21.2.2.71): what an X value or a bubble size is shown with (data labels format the Y). `undefined`: General. */
const cacheFormatCode = (numCache: XNode | undefined): string | undefined => {
  const cached = textOf(child(numCache ?? {}, "c:formatCode") ?? {});
  return cached === "" ? undefined : cached;
};

/** A stored number as the chart shows it (Excel's engine); a cell that is not a plain number, or a code outside what the
 *  engine writes, stays as stored (a value is never lost for lack of a format). */
const displayed = (stored: string, code: string | undefined): string => {
  const trimmed = stored.trim();
  if (trimmed === "") return stored;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return stored;
  return formatNumberCell(n, code, false) ?? stored;
};

/** The bounds of a chart: points, category levels, series and cells: the limits given, else the product's. */
const boundsOf = (limits: ReaderLimits | undefined): { series: number; cells: number; points: number; levels: number } => ({
  series: limits?.chartSeries ?? MAX_CHART_SERIES,
  cells: limits?.chartCells ?? MAX_CHART_CELLS,
  points: limits?.chartPoints ?? MAX_CHART_POINTS,
  levels: limits?.chartLevels ?? MAX_CHART_LEVELS,
});

/** A cache's points by `idx`, `countNode` holding `c:ptCount` and `ptsNode`
 *  the `c:pt` entries: the same node for a plain cache, not for a
 *  `c:multiLvlStrCache`, whose points sit one level down in `c:lvl`.
 *  Sized from the points actually PRESENT, never from the declared count
 *  (`new Array(2e9)` was an OOM); an `idx` at or past the declared count is
 *  dropped as before. Chosen bias, written: a trailing point NO cache of
 *  the series writes no longer pads the table with an empty row — `tableOf`
 *  sizes the rows on the LONGEST cache, so a value whose category cell is
 *  blank keeps its row (recensement 28/09, constat 1: Excel omits `c:pt`
 *  for a blank cell, and rows driven by the categories alone dropped
 *  written numbers).
 *  `undefined`: a point really PRESENT (and under the declared count) sits
 *  at or past `MAX_CHART_POINTS` — the whole chart is then withheld to its
 *  marker (décision B of the arbitrage of 28/09/2026: those points used to
 *  be dropped in silence, a table that looked complete with rows missing).
 *  A LYING `c:ptCount` with no such point withholds nothing: refusing it
 *  would lose readable points over a broken attribute. */
const pointsFrom = (countNode: XNode | undefined, ptsNode: XNode | undefined, limits: ReaderLimits | undefined): string[] | undefined => {
  // `c:ptCount` is OPTIONAL in ECMA-376 (CT_NumData/CT_StrData, 0..1) and
  // the reference readers treat it as a HINT: absent (or unreadable), the
  // points PRESENT stand, under `MAX_CHART_POINTS` alone — the old
  // « declared = 0 » reading threw a conforming cache away whole, in
  // silence (Mikolaj, 28/09/2026, after the norm and the practices). A
  // WRITTEN count — an explicit 0 included — is a declaration, read as
  // before: a point at or past it stays out (anti-padding).
  const raw = attr(child(countNode ?? {}, "c:ptCount") ?? {}, "val");
  const count = raw === undefined ? undefined : Number.parseInt(raw, 10);
  const declared = count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined;
  const kept: { idx: number; value: string }[] = [];
  const pointCap = boundsOf(limits).points;
  let length = 0;
  for (const pt of children(ptsNode ?? {}, "c:pt")) {
    const idx = Number.parseInt(attr(pt, "idx") ?? "-1", 10);
    if (Number.isNaN(idx)) continue; // an unreadable idx (« abc ») is no point; the control reading ignores it too; Infinity (400 digits) is past the bound below
    // The withhold looks at the points PRESENT before any declared-count
    // filter (revue HIGH du 28/09, constat 1): a ptCount lying LOW used to
    // drop a real point past the bound in silence — the very loss décision
    // B ends.
    if (idx >= pointCap) return undefined;
    if (idx < 0 || (declared !== undefined && idx >= declared)) continue;
    kept.push({ idx, value: textOf(child(pt, "c:v") ?? {}) });
    if (idx + 1 > length) length = idx + 1;
  }
  const values = new Array<string>(length).fill("");
  for (const { idx, value } of kept) values[idx] = value;
  return values;
};
const points = (cache: XNode | undefined, limits: ReaderLimits | undefined): string[] | undefined => pointsFrom(cache, cache, limits);

/** The categories of a series, as LEVELS, the leaf level first
 *  (`c:multiLvlStrRef`, ECMA-376 Part 1 §21.2.2.115: each `c:lvl` is one
 *  level, the first the innermost; an outer level writes a point only where
 *  its group starts, `idx` being the first leaf of the group). A plain
 *  `c:strRef`/`c:numRef` is one level. Every level is kept: an outer label
 *  is the document's own word, and dropping it was a lost word.
 *  `undefined` propagates a cache past the bound (décision B). */
const referencedLevels = (parent: XNode | undefined, limits: ReaderLimits | undefined): string[][] | undefined => {
  const multi = child(parent ?? {}, "c:multiLvlStrRef");
  if (multi) {
    const cache = child(multi, "c:multiLvlStrCache");
    const levels: string[][] = [];
    const levelCap = boundsOf(limits).levels;
    for (const lvl of children(cache ?? {}, "c:lvl")) {
      if (levels.length >= levelCap) return undefined; // a ninth level: the whole chart is withheld (décision B)
      const pts = pointsFrom(cache, lvl, limits);
      if (pts === undefined) return undefined;
      levels.push(pts);
    }
    if (levels.length > 0) return levels;
  }
  const str = child(parent ?? {}, "c:strRef");
  if (str) {
    const pts = points(child(str, "c:strCache"), limits);
    return pts === undefined ? undefined : [pts];
  }
  const num = child(parent ?? {}, "c:numRef");
  if (num) {
    const pts = points(child(num, "c:numCache"), limits);
    return pts === undefined ? undefined : [pts];
  }
  return [[]];
};

/** Chosen bias, written: a series NAME cache past the bound only loses the
 *  name (an EMPTY header stands in — A4 of docs/CONCEPTION-CARTE-ET-REMARQUES.md,
 *  Mikolaj 29/09/2026: no invented « Series N », the series existed and had
 *  no name) — the table shows one cell of it, nothing is amputated. */
const seriesName = (ser: XNode, limits: ReaderLimits | undefined): string | undefined => {
  const tx = child(ser, "c:tx") ?? {};
  const ref = child(tx, "c:strRef");
  // A name typed in the chart (`c:tx/c:v`, no cell behind it) is the series' name as well.
  if (!ref) return child(tx, "c:v") === undefined ? undefined : textOf(child(tx, "c:v")!);
  return points(child(ref, "c:strCache"), limits)?.[0];
};

interface TableColumn { name: string | undefined; values: string[]; /** The numbers the values stand for, one per value (`null`: not a number). Series of categories only. */ nums?: (number | null)[] }

const GROUPED_NUMBER = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
// One currency sign, before the number (after its minus) or after it, a space allowed between: « $5 », « -$5 », « 5 € ».
const LEADING_CURRENCY = /^(-?)\p{Sc}[   ]?(?!\p{Sc})(.*)$/u;
const TRAILING_CURRENCY = /^([^\p{Sc}]*?)[   ]?\p{Sc}$/u;

const withoutCurrency = (cell: string): string => {
  const leading = LEADING_CURRENCY.exec(cell);
  if (leading !== null) return leading[1]! + leading[2]!;
  return TRAILING_CURRENCY.exec(cell)?.[1] ?? cell;
};

/** The number a displayed cell stands for: the cell itself when it is a plain number, percentage or amount with one currency sign
 *  (« 81% » is 81, « 1,234 » is 1234, « $5 » is 5, accounting
 *  « (5) » is -5), else `null`: a gap in the drawing, as the table shows it. NEVER the stored value of a cell the chart displays as nothing
 *  (format `;;;`), as a word (`[<5]"faible";0`) or with a unit. */
export const numberShown = (cell: string): number | null => {
  const accounting = /^\((.*)\)$/.exec(cell);
  const inner = withoutCurrency(accounting === null ? cell : accounting[1]!);
  // Commas only as thousands separators, three digits at a time; anything else (units, words, a hidden or conditional display) is a gap.
  const body = inner.endsWith("%") ? inner.slice(0, -1) : inner;
  if (!GROUPED_NUMBER.test(body) && !PLAIN_NUMBER.test(body)) return null;
  const n = Number(body.replaceAll(",", ""));
  return accounting === null ? n : -Math.abs(n);
};

const BAR_GROUPS: ReadonlySet<string> = new Set(["c:barChart", "c:bar3DChart"]);
const LINE_GROUPS: ReadonlySet<string> = new Set(["c:lineChart", "c:line3DChart"]);
const PIE_GROUPS: ReadonlySet<string> = new Set(["c:pieChart", "c:pie3DChart"]);

const barType = (group: XNode, grouping: string | undefined): ChartDrawingType | undefined => {
  if (grouping === "percentStacked") return undefined;
  const stacked = grouping === "stacked";
  if (attr(child(group, "c:barDir") ?? {}, "val") === "bar") return stacked ? "hStackBar" : "hBar";
  return stacked ? "stackBar" : "bar";
};

/** The component a chart is drawn with, from its ONE plot group: `c:barChart` / `c:bar3DChart` by `c:barDir`
 *  (ECMA-376 Part 1 §21.2.2.17) and `c:grouping` (§21.2.2.76: `stacked` stacks, `percentStacked` has no component), `c:lineChart` / `c:line3DChart` when
 *  `standard`, `c:pieChart` / `c:pie3DChart` (not `c:ofPieChart`: a pie of pie is not a pie), `c:doughnutChart`. 3D groups are drawn flat (a stated limit). Several groups (a combined chart), or any other group (scatter,
 *  bubble, area, radar, stock, surface): `undefined`, the table stands alone. */
const drawingTypeOf = (root: XNode): ChartDrawingType | undefined => {
  const groups = kidsOf(child(child(root, "c:chart") ?? {}, "c:plotArea") ?? {}).filter((k) => /^c:\w+Chart$/.test(tagOf(k) ?? ""));
  if (groups.length !== 1) return undefined;
  const group = groups[0]!;
  const tag = tagOf(group) ?? "";
  const grouping = attr(child(group, "c:grouping") ?? {}, "val");
  if (BAR_GROUPS.has(tag)) return barType(group, grouping);
  if (LINE_GROUPS.has(tag)) return grouping === undefined || grouping === "standard" ? "line" : undefined;
  if (PIE_GROUPS.has(tag)) return "pie";
  return tag === "c:doughnutChart" ? "donut" : undefined;
};


/** A scatter or bubble series: it writes `c:xVal`, `c:yVal` or `c:bubbleSize` where the others write `c:cat` and `c:val`. */
const isXySeries = (ser: XNode): boolean => ["c:xVal", "c:yVal", "c:bubbleSize"].some((tag) => child(ser, tag) !== undefined);

/** The values of one `c:xVal`, `c:yVal` or `c:bubbleSize`: a number reference shown with `codeOf` (the format of its cache, ECMA-376 Part 1 §21.2.2.71),
 *  or a string reference as written. Literal data (`c:numLit`, `c:strLit`) is not read (written limit, as for `c:val`). `undefined`: a cache past the bound. */
const xyValues = (parent: XNode | undefined, codeOf: (numCache: XNode | undefined) => string | undefined, limits: ReaderLimits | undefined): string[] | undefined => {
  const str = child(parent ?? {}, "c:strRef");
  if (str) return points(child(str, "c:strCache"), limits);
  const numCache = child(child(parent ?? {}, "c:numRef") ?? {}, "c:numCache");
  const stored = points(numCache, limits);
  if (stored === undefined) return undefined;
  const code = codeOf(numCache);
  return stored.map((v) => displayed(v, code));
};

/** The same cells, as displayed, row by row (a missing tail is blank). */
const sameValues = (a: readonly string[], b: readonly string[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? "") !== (b[i] ?? "")) return false;
  return true;
};
const isBlank = (values: readonly string[]): boolean => values.every((v) => v === "");

/** The drawing of a chart whose rows are the indices `kept` of its columns: one category column, series of categories only (no scatter column),
 *  and ONE series for a pie or a donut. `undefined`: the table stands alone. */
const drawingOf = (type: ChartDrawingType | undefined, labelColumnCount: number, columns: readonly TableColumn[], kept: readonly number[]): ChartDrawing | undefined => {
  if (type === undefined || labelColumnCount !== 1 || columns.length === 0) return undefined;
  if ((type === "pie" || type === "donut") && columns.length !== 1) return undefined;
  const numbers = columns.map((c) => c.nums);
  if (numbers.some((n) => n === undefined)) return undefined;
  return { type, values: numbers.map((n) => kept.map((i) => n![i] ?? null)) };
};

/** `"withheld"`: the chart HAS series but a bound keeps it out whole (décision B); `undefined`: it has none.
 *  `labelFromX`: the left column holds the X values of a scatter (no series writes categories), so the title of the X axis heads it. */
const tableOf = (root: XNode, limits: ReaderLimits | undefined): { data: TableData; labelColumns: number; labelFromX: boolean; drawing?: ChartDrawing } | "withheld" | undefined => {
  const series = descendants(root, "c:ser");
  if (series.length === 0) return undefined;
  // Category levels, the leaf level first (a plain chart has one).
  let levels: string[][] = [[]];
  let labelFromX = false;
  // The categories win the left column over a scatter's X values, wherever the series stand: decided from the points written.
  const categorised = series.some((ser) => !isXySeries(ser) && descendants(child(ser, "c:cat") ?? {}, "c:pt").length > 0);
  const columns: TableColumn[] = [];
  // The X columns already published beside the left column: a scatter series whose X (as displayed) is one of them shares it. Chosen
  // rule, written: sharing keeps one row per point; series of other X each get their own (X, Y) pair, so no point shares a row with a
  // point of another X and no number is lost. An X column that is entirely blank (a cache the file never filled) is not published.
  const publishedX: string[][] = [];
  const bounds = boundsOf(limits);
  let longest = 0;
  let seen = 0;
  for (const ser of series) {
    // Checked before any array of this series is built (décision B).
    if (seen >= bounds.series) return "withheld";
    seen++;
    const added: TableColumn[] = [];
    if (isXySeries(ser)) {
      const xs = xyValues(child(ser, "c:xVal"), cacheFormatCode, limits);
      const ys = xyValues(child(ser, "c:yVal"), (cache) => displayFormatCode(ser, cache), limits);
      const sizes = xyValues(child(ser, "c:bubbleSize"), cacheFormatCode, limits);
      if (xs === undefined || ys === undefined || sizes === undefined) return "withheld";
      if (!isBlank(xs)) {
        if (!categorised && levels.every((l) => l.length === 0)) {
          levels = [xs];
          labelFromX = true;
        } else if (!(levels.length === 1 && sameValues(xs, levels[0]!)) && !publishedX.some((p) => sameValues(xs, p))) {
          added.push({ name: undefined, values: xs });
          publishedX.push(xs);
        }
      }
      added.push({ name: seriesName(ser, limits), values: ys });
      if (!isBlank(sizes)) added.push({ name: undefined, values: sizes });
      for (const column of [...levels, ...added.map((c) => c.values)]) longest = Math.max(longest, column.length);
    } else {
      if (levels.every((l) => l.length === 0)) {
        const cats = referencedLevels(child(ser, "c:cat"), limits);
        if (cats === undefined) return "withheld"; // a cache past the bound: the whole chart is withheld (décision B)
        levels = cats;
        for (const l of levels) longest = Math.max(longest, l.length);
      }
      const numCache = child(child(child(ser, "c:val") ?? {}, "c:numRef") ?? {}, "c:numCache");
      const stored = points(numCache, limits);
      if (stored === undefined) return "withheld";
      const code = displayFormatCode(ser, numCache);
      const values = stored.map((v) => displayed(v, code));
      longest = Math.max(longest, values.length);
      added.push({ name: seriesName(ser, limits), values, nums: values.map(numberShown) });
    }
    // Running bound (chosen bias, written): the dense arrays are sized by
    // their last idx, so (levels + columns incl. this series') × the longest
    // array is checked before each push — a sparse many-series chart is
    // withheld on array length, which keeps the build itself bounded.
    if ((levels.length + columns.length + added.length) * longest > bounds.cells) return "withheld";
    columns.push(...added);
  }
  // Only OCCUPIED rows come out (revue HIGH du 28/09, constat N3): the
  // 0..maxIdx span let ONE point at idx 9 999 fabricate 10 000 near-empty
  // rows. A written value past the last written category still keeps its
  // row, label cell empty (recensement 28/09, constat 1 — never a number
  // lost); a row whose label and every value are blank carries nothing
  // and is not fabricated (chosen bias, written).
  // One leading column per category level, the OUTERMOST first: an outer
  // label stands on the row where its group starts, blank after (never
  // repeated, never joined to the leaf: no word is invented).
  const labelColumns = [...levels].reverse();
  // Withheld before any row is built: the bound is on what the table WOULD
  // hold — OCCUPIED rows × columns, so a sparse cache is not penalised.
  const occupied = new Set<number>();
  for (const column of [...labelColumns, ...columns.map((c) => c.values)]) {
    for (let i = 0; i < column.length; i++) if (column[i] !== "") occupied.add(i);
  }
  if (occupied.size * (labelColumns.length + columns.length) > bounds.cells) return "withheld";
  const rows: string[][] = [];
  const keptIndices: number[] = [];
  // Rows come from the SORTED occupied indices only, never 0..rowCount.
  for (const i of [...occupied].sort((a, b) => a - b)) {
    const row = [...labelColumns.map((l) => l[i] ?? ""), ...columns.map((c) => c.values[i] ?? "")];
    if (row.some((cell) => cell !== "")) {
      rows.push(row);
      keptIndices.push(i);
    }
  }
  const drawing = drawingOf(drawingTypeOf(root), labelColumns.length, columns, keptIndices);
  return {
    data: { headers: [...labelColumns.map(() => ""), ...columns.map((c) => c.name ?? "")], rows },
    labelColumns: labelColumns.length,
    labelFromX,
    ...(drawing === undefined ? {} : { drawing }),
  };
};

/** The lines of a rich title: one per paragraph (`a:p`) and per line break (`a:br`); the runs of one line are joined as written. */
const richLines = (title: XNode): string[] => {
  const lines: string[] = [];
  for (const paragraph of descendants(title, "a:p")) {
    let line = "";
    for (const piece of kidsOf(paragraph)) {
      if (tagOf(piece) === "a:br") {
        lines.push(line);
        line = "";
      } else line += descendants(piece, "a:t").map((t) => textOf(t)).join("");
    }
    lines.push(line);
  }
  return lines;
};

/** The text a `c:title` shows: its rich text, lines separated by one space (never welded: « Total » over « revenue » is « Total revenue »), or,
 *  for a title linked to a cell (`c:tx/c:strRef`, Excel's), the first point of its `c:strCache` (ECMA-376 Part 1 §21.2.2.178, §21.2.2.176). */
const titleText = (title: XNode | undefined, limits: ReaderLimits | undefined): string | undefined => {
  if (title === undefined) return undefined;
  const rich = richLines(title).map((l) => l.trim()).filter((l) => l !== "").join(" ");
  const linked = rich === "" ? points(child(child(child(title, "c:tx") ?? {}, "c:strRef") ?? {}, "c:strCache"), limits)?.[0] : undefined;
  const text = rich !== "" ? rich : (linked ?? "").trim();
  return text === "" ? undefined : text;
};

/** The chart's OWN title: the `c:title` child of `c:chart` (an axis title is never taken for it). */
const titleOf = (root: XNode, limits: ReaderLimits | undefined): string | undefined => titleText(child(child(root, "c:chart") ?? {}, "c:title"), limits);

/** An axis the chart deletes (`c:delete`, an optional CT_Boolean: no `val` means true) shows no title. */
const axisIsDeleted = (axis: XNode): boolean => {
  const del = child(axis, "c:delete");
  if (del === undefined) return false;
  const val = attr(del, "val");
  return val === undefined || val === "1" || val === "true";
};

interface AxisTitle {
  axis: ChartAxis;
  text: string;
  /** A category or date axis: it may head the table's top-left cell when the categories take it. */
  corner: boolean;
  /** A value axis (`c:valAx`). */
  valued: boolean;
}

const axisRole = (tag: string | undefined, position: string | undefined, byPosition: boolean): ChartAxis => {
  if (tag === "c:serAx") return "z";
  if (tag !== "c:valAx") return "x";
  if (byPosition) return position === "b" || position === "t" ? "x" : "y";
  return "y";
};

/** `x`/`y` are the roles of the chart's DATA, not screen directions: `x` is the category axis even when horizontal bars lay it vertically. */
const axisTitlesOf = (root: XNode, limits: ReaderLimits | undefined): AxisTitle[] => {
  const areas = descendants(root, "c:plotArea");
  const axes = areas.flatMap((area) => kidsOf(area).filter((k) => ["c:catAx", "c:dateAx", "c:serAx", "c:valAx"].includes(tagOf(k) ?? "")));
  // A value axis is classed by its position (`c:axPos`: bottom or top is x, left or right is y) when the chart has no category or date axis
  // (a scatter or bubble alone) AND when it has a scatter or bubble group, whose value axes may be horizontal beside a category axis (a
  // combined chart). Otherwise (bars, lines) a value axis is y whatever its position: horizontal bars lay their value axis at the bottom.
  const categorical = axes.some((k) => tagOf(k) === "c:catAx" || tagOf(k) === "c:dateAx");
  const xy = areas.some((area) => kidsOf(area).some((k) => tagOf(k) === "c:scatterChart" || tagOf(k) === "c:bubbleChart"));
  const byPosition = !categorical || xy;
  const out: AxisTitle[] = [];
  for (const k of axes) {
    if (axisIsDeleted(k)) continue;
    const text = titleText(child(k, "c:title"), limits);
    if (text === undefined) continue;
    const tag = tagOf(k);
    out.push({ axis: axisRole(tag, attr(child(k, "c:axPos") ?? {}, "val"), byPosition), text, corner: tag === "c:catAx" || tag === "c:dateAx", valued: tag === "c:valAx" });
  }
  return out;
};

/** The table and the title fields of a chart read. The first category-axis title heads the table's top-left cell when the categories take
 *  ONE column, and the first horizontal value-axis title when that column holds a scatter's X values; every other axis title is a line under the table. */
const withTitles = (root: XNode, table: { data: TableData; labelColumns: number; labelFromX: boolean; drawing?: ChartDrawing }, limits: ReaderLimits | undefined): { data: TableData; titles: Pick<PptxChart, "title" | "axisTitles"> } => {
  const title = titleOf(root, limits);
  const all = axisTitlesOf(root, limits);
  const heading = table.labelFromX ? all.find((t) => t.valued && t.axis === "x") : all.find((t) => t.corner);
  const headed = heading !== undefined && table.labelColumns === 1 && table.data.headers !== undefined;
  const data = headed ? { ...table.data, headers: [heading.text, ...table.data.headers!.slice(1)] } : table.data;
  const lines = all.filter((t) => !headed || t !== heading).map(({ axis, text }) => ({ axis, text }));
  return { data, titles: { ...(title === undefined ? {} : { title }), ...(lines.length === 0 ? {} : { axisTitles: lines }) } };
};

/** The chart at `part`, `undefined` when it has no series (nothing to say), `"withheld"` when the part is MISSING (Mikolaj, 07/10/2026: said like a damaged
 *  part, the same notice in every format) or when the chart has series and a bound (points, levels, cells, series) keeps it out whole: its title and
 *  labels are then not on the page, which the caller reports (docx, review of 01/10/2026). */
export const readChartOutcome = async (
  pkg: DocxPackage,
  part: string,
  options: { picture?: boolean; limits?: ReaderLimits | undefined } = {},
): Promise<PptxChart | "withheld" | undefined> => {
  const root = await pkg.readXml(part);
  if (!root) return "withheld";
  const table = tableOf(root, options.limits);
  if (table === undefined || table === "withheld") return table;
  const { data, titles } = withTitles(root, table, options.limits);
  // A caller that publishes no picture (docx, xlsx) never reads its bytes.
  const drawing = table.drawing === undefined ? {} : { drawing: table.drawing };
  if (options.picture === false) return { data, ...titles, ...drawing };
  // The first image relation whose part EXISTS: the header promises « the
  // picture only when the archive holds a rendering », and a relation whose
  // part is absent used to end the search with no picture at all.
  let image: PptxChart["image"];
  for (const rel of (await pkg.relationships(part)).values()) {
    if (rel.kind !== "image" || rel.external) continue;
    // The picture is only a fallback: a damaged image part costs that picture, never the chart's data.
    const bytes = await orDamaged(() => pkg.readBytes(rel.target));
    if (bytes) {
      image = { bytes, contentType: pkg.contentType(rel.target) ?? "application/octet-stream" };
      break;
    }
  }
  return { data, ...titles, ...drawing, ...(image === undefined ? {} : { image }) };
};

/** `readChartOutcome`, with a chart part that is DAMAGED (a corrupt stream, an XML that does not parse) read as `"withheld"`, like a missing one:
 *  the chart is kept out whole and the rest of the document stands. Any other failure still throws. */
export const readChartOrWithheld = async (
  pkg: DocxPackage,
  part: string,
  options: { picture?: boolean; limits?: ReaderLimits | undefined } = {},
): Promise<PptxChart | "withheld" | undefined> => {
  // The wrapper makes `undefined` mean "damaged"; the outcome's own `undefined` (no series) says nothing.
  const read = await orDamaged(async () => ({ outcome: await readChartOutcome(pkg, part, options) }));
  return read === undefined ? "withheld" : read.outcome;
};

/** The IR block of a chart read, and whether a bound kept it out whole (`withheld`: its title and labels are not on the
 *  page, which the caller reports in its own notice). `collectImage` stores the chart's picture, when the caller keeps
 *  it as a fallback (pptx); without it the block carries no picture. */
export const chartToIr = (
  read: PptxChart | "withheld" | undefined,
  options: { collectImage?: (image: NonNullable<PptxChart["image"]>) => ImageRef } = {},
): { block?: IRBlock; withheld: boolean } => {
  if (read === "withheld") return { withheld: true };
  if (read === undefined) return { withheld: false };
  const image = read.image && options.collectImage ? options.collectImage(read.image) : undefined;
  return {
    withheld: false,
    block: { kind: "chart", data: read.data, ...(read.drawing === undefined ? {} : { drawing: read.drawing }), ...(read.title === undefined ? {} : { title: read.title }), ...(read.axisTitles === undefined ? {} : { axisTitles: read.axisTitles }), ...(image === undefined ? {} : { image }) },
  };
};
