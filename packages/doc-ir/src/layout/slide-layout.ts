/** The form of one slide's body, decided from the boxes alone: a FLOW (one
 *  column, or abstention), a TABLE (several columns: rows and cells by the
 *  centre of each element, `rowspan`/`colspan` for what overflows), or a
 *  DIAGRAM (at least one connector or block arrow: the items in flow order,
 *  the drawing is made elsewhere). A group is one element; an element posed
 *  on a picture follows that picture, in its cell. Every element given comes
 *  out exactly once. Integer EMU throughout, y downwards; the order never
 *  depends on the order the elements are given in
 *  (MIKSUDOC « Spécification fonctionnelle » §9.3.2).
 *  NOT here: which shape is a title or has content, where a box comes from
 *  (`extractor/pptx-reader/`), the background and posed-on facts
 *  (`layout/slide-elements.ts`), the empty slots and reading order of the
 *  cells (`layout/merged-cells.ts#buildMergeMap`), the IR the form becomes
 *  (`extractor/pptx.ts`), nor the drawing of a diagram
 *  (`extractor/slide-svg.ts`).
 *  Called by: `extractor/pptx.ts`. */

import type { TableGrid } from "doc-ir/layout/geometry-types";
import { buildMergeMap } from "doc-ir/layout/merged-cells";
import { type Box, centreInside, type Size, slideItemFlags } from "./slide-elements";

/** 10 pt in EMU (12 700 per point): left edges this close make one column,
 *  top edges this close one row, and a box must reach this far past a
 *  boundary to overflow into the next row or column. VALEUR DE DÉPART À
 *  CALIBRER. Populations of left-edge gaps (FORMAT-PPTX [purged 27/09/2026, git history] §3 quater, USA and
 *  IT): same column 0.1 to 8.9 pt, distinct columns 22.7 pt and more, the two
 *  overlapping between 17.5 and 35.5 pt on USA 20 and 24 (both diagrams). No
 *  second population exists yet for the row and overflow uses. */
const SLIDE_TOLERANCE_EMU = 127_000;

/** An element of a slide: something PUBLISHED (text, picture, table, chart…).
 *  `item` is returned as given. */
export interface SlideElement<T> {
  item: T;
  /** Integer EMU; absent when unknown. */
  box?: Box;
  picture: boolean;
  /** Rank in the shape tree: the last tie-break. */
  spTreeIndex: number;
  /** The top-level group the element belongs to (that group's rank): a group
   *  is ONE element of the slide. */
  group?: number;
  /** `a:prstGeom prst`, for the arrow test. */
  geometry?: string;
}

export interface SlideLayoutInput<T> {
  slide: Size;
  /** Everything published, the title excepted. */
  elements: readonly SlideElement<T>[];
  /** The preset geometry of each shape that publishes nothing (no text, no
   *  image): it never becomes an element, but it can be an arrow. */
  drawnGeometries: readonly (string | undefined)[];
  /** Visible connectors (`p:cxnSp`), glued or not. */
  connectors: number;
}

interface SlideCell<T> {
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  /** Empty for a slot no element occupies. */
  items: T[];
}

/** Why a slide without arrows is a flow: one column; a group of left edges
 *  wider than the tolerance (edges chaining, no column can be trusted); an
 *  element without a box (no position to place it by). */
type FlowReason = "one-column" | "chained-edges" | "no-box";

export type SlideLayout<T> =
  | { form: "flow"; reason: FlowReason; items: T[] }
  | { form: "table"; columns: number; rows: SlideCell<T>[][] }
  | { form: "diagram"; items: T[] };

/** The block arrows of ECMA-376 `ST_ShapeType`: a shape drawn to point from
 *  one element to another. NOT arrows: the `*ArrowCallout` family (a text box
 *  with a pointer, USA 13 and 14 put them on a screenshot), `homePlate` and
 *  `chevron` (step headers of a process row), and the line presets on a
 *  `p:sp` (`line`, `straightConnector1`, `bentConnector*`…: none observed,
 *  every line of USA and IT is a `p:cxnSp`). */
export const ARROW_GEOMETRIES: ReadonlySet<string> = new Set([
  "rightArrow",
  "leftArrow",
  "upArrow",
  "downArrow",
  "leftRightArrow",
  "upDownArrow",
  "quadArrow",
  "leftRightUpArrow",
  "bentArrow",
  "uturnArrow",
  "leftUpArrow",
  "bentUpArrow",
  "curvedRightArrow",
  "curvedLeftArrow",
  "curvedUpArrow",
  "curvedDownArrow",
  "stripedRightArrow",
  "notchedRightArrow",
  "circularArrow",
  "leftCircularArrow",
  "leftRightCircularArrow",
  "swooshArrow",
]);

/** One element of the slide as the layout sees it: a lone element, or a whole
 *  group (its members in geometric order, its box their union). */
interface Unit<T> {
  members: SlideElement<T>[];
  box?: Box;
  picture: boolean;
  /** Group rank, or the lone element's rank. */
  key: number;
}

// A loop, never `Math.min(...boxes)`: a group can hold more members than a
// call takes arguments (a RangeError past ~124k of them).
const union = (boxes: readonly Box[]): Box | undefined => {
  if (boxes.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    if (b.x < left) left = b.x;
    if (b.y < top) top = b.y;
    if (b.x + b.cx > right) right = b.x + b.cx;
    if (b.y + b.cy > bottom) bottom = b.y + b.cy;
  }
  return { x: left, y: top, cx: right - left, cy: bottom - top };
};

/** Strict order: top, left, then rank. */
const byTopLeft = (a: { box: Box; key: number }, b: { box: Box; key: number }): number =>
  a.box.y - b.box.y || a.box.x - b.box.x || a.key - b.key;

/** Reading order of positioned things, the `extractor/pdf-lines.ts`
 *  discipline: a strict sort (top, left, rank), then lines — a thing whose top
 *  is within the tolerance of its line's FIRST top joins it (anchored, so a
 *  line never chains down a slide) —, then a strict sort inside each line
 *  (left, top, rank). Things without a box come last, by rank. */
const readingOrder = <U>(things: readonly U[], boxOf: (u: U) => Box | undefined, keyOf: (u: U) => number): U[] => {
  const placed = things
    .filter((t) => boxOf(t) !== undefined)
    .map((t) => ({ t, box: boxOf(t)!, key: keyOf(t) }))
    .sort(byTopLeft);
  const lines: (typeof placed)[] = [];
  for (const p of placed) {
    const line = lines.at(-1);
    if (line && p.box.y - line[0]!.box.y <= SLIDE_TOLERANCE_EMU) line.push(p);
    else lines.push([p]);
  }
  const ordered = lines.flatMap((line) => [...line].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y || a.key - b.key));
  const unplaced = things.filter((t) => boxOf(t) === undefined).sort((a, b) => keyOf(a) - keyOf(b));
  return [...ordered.map((p) => p.t), ...unplaced];
};

const unitsOf = <T>(elements: readonly SlideElement<T>[]): Unit<T>[] => {
  const groups = new Map<number, SlideElement<T>[]>();
  const units: Unit<T>[] = [];
  for (const e of elements) {
    if (e.group === undefined) {
      units.push({ members: [e], ...(e.box ? { box: e.box } : {}), picture: e.picture, key: e.spTreeIndex });
    } else {
      const members = groups.get(e.group) ?? [];
      members.push(e);
      groups.set(e.group, members);
    }
  }
  for (const [key, members] of groups) {
    const box = union(members.flatMap((m) => (m.box ? [m.box] : [])));
    units.push({
      members: readingOrder(members, (m) => m.box, (m) => m.spTreeIndex),
      ...(box ? { box } : {}),
      picture: false,
      key,
    });
  }
  return units;
};

const itemsOf = <T>(units: readonly Unit<T>[]): T[] => units.flatMap((u) => u.members.map((m) => m.item));

/** For each unit, the picture unit it is posed on (its centre lies in that
 *  picture, which is no background: `slide-elements.ts#slideItemFlags`),
 *  followed to a picture posed on nothing; undefined for a unit posed on
 *  nothing. Among several pictures under a centre, the lowest rank. Two
 *  pictures each posed on the other: the lower rank stays in place. */
const hostsOf = <T>(units: readonly Unit<T>[], slide: Size): (number | undefined)[] => {
  const flags = slideItemFlags(units, slide);
  const direct = units.map((u, i) => {
    if (!flags[i]!.posedOnPicture) return undefined;
    let host: number | undefined;
    units.forEach((p, j) => {
      if (j === i || !p.picture || flags[j]!.background || !p.box || !centreInside(u.box!, p.box)) return;
      if (host === undefined || p.key < units[host]!.key) host = j;
    });
    return host;
  });
  const anchored = new Set(units.flatMap((_, i) => (direct[i] === undefined ? [i] : [])));
  units.forEach((_, start) => {
    const path: number[] = [];
    let at = start;
    while (!anchored.has(at) && !path.includes(at)) {
      path.push(at);
      at = direct[at]!;
    }
    if (!anchored.has(at)) {
      const cycle = path.slice(path.indexOf(at));
      anchored.add(cycle.reduce((a, b) => (units[a]!.key <= units[b]!.key ? a : b)));
    }
  });
  return units.map((_, i) => {
    if (anchored.has(i)) return undefined;
    let at = direct[i]!;
    while (!anchored.has(at)) at = direct[at]!;
    return at;
  });
};

/** Left edges grouped as `layout/position-clusters.ts#clusterPositions` does
 *  (sorted, a gap within the tolerance joins the group, so groups CHAIN), on
 *  integers, keeping each group's first and last edge. `clusterPositions` is
 *  not called: it returns each group's mean as a float, and the guard needs
 *  the group's extent, the boundaries its first edge. */
const chainedGroups = (values: readonly number[]): { first: number; last: number }[] => {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: { first: number; last: number }[] = [];
  for (const v of sorted) {
    const g = groups.at(-1);
    if (g && v - g.last <= SLIDE_TOLERANCE_EMU) g.last = v;
    else groups.push({ first: v, last: v });
  }
  return groups;
};

/** Row starts: top edges sorted, a new row when a top is more than the
 *  tolerance below its row's FIRST top (anchored, as `readingOrder`). */
const rowStarts = (tops: readonly number[]): number[] => {
  const starts: number[] = [];
  for (const t of [...tops].sort((a, b) => a - b)) {
    if (starts.length === 0 || t - starts.at(-1)! > SLIDE_TOLERANCE_EMU) starts.push(t);
  }
  return starts;
};

/** The band whose start is the last one at or before the doubled centre
 *  (centres compared at twice the scale, integers). */
const bandOf = (starts: readonly number[], centre2: number): number => {
  let band = 0;
  starts.forEach((s, i) => {
    if (2 * s <= centre2) band = i;
  });
  return band;
};

interface Rect<T> {
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  items: T[];
}

export const layoutSlide = <T>(input: SlideLayoutInput<T>): SlideLayout<T> => {
  const units = unitsOf(input.elements);
  const hosts = hostsOf(units, input.slide);

  const ordered = (indices: readonly number[]): number[] => readingOrder(indices, (i) => units[i]!.box, (i) => units[i]!.key);
  /** A unit's items followed by the items of the units posed on it. */
  const withPosed = (i: number): T[] => {
    const posed = units.flatMap((_, j) => (hosts[j] === i ? [j] : []));
    return [...itemsOf([units[i]!]), ...itemsOf(ordered(posed).map((j) => units[j]!))];
  };
  const inFlow = (indices: readonly number[]): T[] => ordered(indices).flatMap(withPosed);
  const free = units.flatMap((_, i) => (hosts[i] === undefined ? [i] : []));

  const arrows = [...input.elements.map((e) => e.geometry), ...input.drawnGeometries].some(
    (g) => g !== undefined && ARROW_GEOMETRIES.has(g),
  );
  if (input.connectors > 0 || arrows) return { form: "diagram", items: inFlow(free) };
  if (units.some((u) => u.box === undefined)) return { form: "flow", reason: "no-box", items: inFlow(free) };

  const flags = slideItemFlags(units, input.slide);
  const backgrounds = free.filter((i) => flags[i]!.background).sort((a, b) => units[a]!.key - units[b]!.key);
  const grid = free.filter((i) => !flags[i]!.background);

  const columnGroups = chainedGroups(grid.map((i) => units[i]!.box!.x));
  if (columnGroups.some((g) => g.last - g.first > SLIDE_TOLERANCE_EMU)) {
    return { form: "flow", reason: "chained-edges", items: inFlow(free) };
  }

  // A band no element's centre falls in is no row or column: it goes to the
  // band before it (the first band to the one after). An element's edge only
  // proposes a band; the centres decide which ones exist. This is what makes
  // USA 1, 7 and 27 flows: a wide text starting left of the others has its
  // centre in their column (`slide-layout.test.ts`).
  const centresX = grid.map((i) => 2 * units[i]!.box!.x + units[i]!.box!.cx);
  const centresY = grid.map((i) => 2 * units[i]!.box!.y + units[i]!.box!.cy);
  const inhabited = (starts: readonly number[], centres2: readonly number[]): number[] => {
    const used = new Set(centres2.map((c) => bandOf(starts, c)));
    return starts.filter((_, i) => used.has(i));
  };
  const cols = inhabited(columnGroups.map((g) => g.first), centresX);
  if (cols.length < 2) return { form: "flow", reason: "one-column", items: inFlow(free) };
  const rows = inhabited(rowStarts(grid.map((i) => units[i]!.box!.y)), centresY);
  const colCount = cols.length;
  const rowCount = rows.length;

  // Cells: the units whose centre falls in the same row band and column band.
  const cellOf = new Map<number, number[]>();
  for (const i of grid) {
    const b = units[i]!.box!;
    const slot = bandOf(rows, 2 * b.y + b.cy) * colCount + bandOf(cols, 2 * b.x + b.cx);
    cellOf.set(slot, [...(cellOf.get(slot) ?? []), i]);
  }

  // Spans, cell by cell in (row, column) order: the cell's box (the union of
  // its units, posed items left out) overflows into a neighbouring band when
  // it reaches more than the tolerance past the boundary. A span stops at the
  // first slot another cell owns or has claimed, so spans are disjoint by
  // construction: `buildMergeMap` would drop an overlapping one in silence.
  // Columns first, in the home row; then rows, each taken only if every
  // column of the span is free in it (a cell stays a rectangle).
  const owner: (number | undefined)[][] = Array.from({ length: rowCount }, () => Array<number | undefined>(colCount));
  const homes = [...cellOf.keys()].sort((a, b) => a - b);
  homes.forEach((slot, id) => {
    owner[Math.floor(slot / colCount)]![slot % colCount] = id;
  });
  const rects: Rect<T>[] = homes.map((slot, id) => {
    const members = cellOf.get(slot)!;
    const box = union(members.map((i) => units[i]!.box!))!;
    const row = Math.floor(slot / colCount);
    const col = slot % colCount;
    const isFree = (r: number, c: number): boolean => owner[r]![c] === undefined;
    let c0 = col;
    let c1 = col;
    while (c0 > 0 && isFree(row, c0 - 1) && box.x < cols[c0]! - SLIDE_TOLERANCE_EMU) c0--;
    while (c1 < colCount - 1 && isFree(row, c1 + 1) && box.x + box.cx > cols[c1 + 1]! + SLIDE_TOLERANCE_EMU) c1++;
    const rowFree = (r: number): boolean => {
      for (let c = c0; c <= c1; c++) if (!isFree(r, c)) return false;
      return true;
    };
    let r0 = row;
    let r1 = row;
    while (r0 > 0 && rowFree(r0 - 1) && box.y < rows[r0]! - SLIDE_TOLERANCE_EMU) r0--;
    while (r1 < rowCount - 1 && rowFree(r1 + 1) && box.y + box.cy > rows[r1 + 1]! + SLIDE_TOLERANCE_EMU) r1++;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) owner[r]![c] = id;
    return { row: r0, col: c0, rowspan: r1 - r0 + 1, colspan: c1 - c0 + 1, items: inFlow(members) };
  });

  // A background picture: a first row of its own, across every column.
  const offset = backgrounds.length > 0 ? 1 : 0;
  const all: Rect<T>[] = [
    ...(offset ? [{ row: 0, col: 0, rowspan: 1, colspan: colCount, items: backgrounds.flatMap(withPosed) }] : []),
    ...rects.map((r) => ({ ...r, row: r.row + offset })),
  ];
  const height = rowCount + offset;
  const at: (Rect<T> | undefined)[][] = Array.from({ length: height }, () => Array<Rect<T> | undefined>(colCount));
  for (const r of all) for (let y = r.row; y < r.row + r.rowspan; y++) for (let x = r.col; x < r.col + r.colspan; x++) at[y]![x] = r;

  // `buildMergeMap` lays the empty slots out and gives the cells in reading
  // order: per row, the spans of every slot left to right (a slot covered
  // from above keeps its rectangle's width), and "merged down" where one
  // rectangle covers both slots.
  const columnSpans = at.map((line) => {
    const spans: number[] = [];
    for (let x = 0; x < colCount; ) {
      const span = line[x]?.colspan ?? 1;
      spans.push(span);
      x += span;
    }
    return spans;
  });
  const rowMerges = at.slice(0, -1).map((line, y) => line.map((r, x) => r !== undefined && r === at[y + 1]![x]));
  const tableGrid: TableGrid = {
    rowBoundaries: Array.from({ length: height + 1 }, (_, i) => height - i),
    colBoundaries: Array.from({ length: colCount + 1 }, (_, i) => i),
  };
  const merge = buildMergeMap(tableGrid, columnSpans, rowMerges);
  const out: SlideCell<T>[][] = Array.from({ length: height }, () => []);
  for (const cell of merge.cells) {
    const rect = at[cell.row]![cell.col];
    out[cell.row]!.push({ ...cell, items: rect && rect.row === cell.row && rect.col === cell.col ? rect.items : [] });
  }
  return { form: "table", columns: colCount, rows: out };
};
