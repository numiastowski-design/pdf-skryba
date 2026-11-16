/** Where each large image outside a table sits in the reading order (`readPageWithImages`, banded reading in the
 *  declared order), and the WHOLE-PAGE reading of a tagged page whose chunks break its declared order (`readTaggedPage`, guarded:
 *  a page that reads as one segment keeps its chunked reading). Le test d'étiquette sur figure est retiré depuis le
 *  05/11/2026 — la taille seule fait un titre.
 *  Also decides what the bands of a page BECOME (`rowBlocks`, 06/11/2026): a band of N >= 2 columns is one table of one
 *  row x N cells, a band of one column stays prose; the boxed blocks of a cell follow the `framed` option (`BandRendering`).
 *  Since 13/11/2026 it asks the PAGE PLAN for every reading (`extractor/pdf-page-plan.ts`) instead of calling the
 *  band reader itself: the plan holds the cuts and records the slices the page is read in.
 *  NOT here: the reading of the bytes themselves
 *  (`extractor/pdf-embedded-images.ts`, `extractor/pdf-source.ts`), nor the
 *  ordering rule, which is `extractor/pdf-region-order.ts`, nor the band reading, which the plan delegates to
 *  `extractor/pdf-bands.ts`, nor frame membership (`extractor/pdf-framed-blocks.ts`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-page-tables.ts`. */

import type { IRBlock, IRTable } from "doc-ir/lib/ir";
import { maxOf, minOf } from "doc-ir/lib/extent";
import { bodySizeOf } from "doc-ir/layout/heading-sizes";
import { imageFrontier as sharedImageFrontier } from "doc-ir/layout/image-frontier";
import { asideFigures } from "./pdf-aside-figures";
import type { ReadSegment } from "./pdf-bands";
import { DEFAULT_FRAMED_BLOCKS, splitFramed, type FramedBlocks } from "./pdf-framed-blocks";
import type { ContainerBox } from "./pdf-line-breaks";
import { groupItemsIntoLines } from "./pdf-lines";
import type { ImageAnchor, ImageCandidate, PageRegion } from "./pdf-model";
import type { PagePlanReader } from "./pdf-page-plan";
import { interleaveRegions, readingOrder } from "./pdf-region-order";
import type { PdfTextRun } from "./pdf-source";

/**
 * READS THE LARGE IMAGES THAT SIT IN THE PAGE'S FLOW, and
 * turns each readable one into an anchor; an unreadable one leaves nothing.
 *
 * The images of a rendered table are NOT given here: `renderPageTables` puts
 * them in their cell, unscanned (`pdf-table-render.ts#renderTableRegion`).
 */
export function placeImages(candidates: readonly ImageCandidate[]): ImageAnchor[] {
  return candidates.flatMap((c) => {
    const blocks = c.read();
    return blocks === undefined ? [] : [{ top: c.top, bottom: c.bottom, xMin: c.xMin, xMax: c.xMax, blocks }];
  });
}

/** Une image en région d'ordre : bande nulle, frontière à la médiane. Une
 *  ancre sans `bottom` connu garde l'ancien comportement — sa frontière est son
 *  bord haut, et on ne suppose pas une hauteur qu'on n'a pas mesurée. */
export const imageRegion = (a: ImageAnchor): PageRegion => ({
  top: a.top,
  bottom: a.top,
  xMin: a.xMin,
  blocks: a.blocks,
  consumesBand: false,
  orderAt: a.bottom === undefined ? a.top : (a.top + a.bottom) / 2,
  ...(a.bottom !== undefined && a.xMax !== undefined
    ? { box: { top: a.top, bottom: a.bottom, xMin: a.xMin, xMax: a.xMax } }
    : {}),
});

/**
 * INSÈRE LES IMAGES DANS L'ORDRE VERTICAL D'UNE PAGE SANS TABLEAU (15/09/2026) —
 * le cas particulier d'`interleaveRegions`. Aucune ligne n'est jetée ; l'ordre se
 * décide à la MÉDIANE de l'image (voir `interleaveRegions`).
 *
 * ⚠️ `bottom` reste égal à `top` : une image ne consomme AUCUNE bande, sans quoi
 * les lignes posées dessus seraient jetées. C'est `orderAt` qui porte la
 * médiane, et lui seul.
 */
export function interleaveImages(
  items: readonly PdfTextRun[],
  anchors: readonly ImageAnchor[],
  prose: (items: PdfTextRun[]) => IRBlock[],
  /** Regions the caller already built — the side-by-side tables of `pdf-aside-figures.ts`. They are ordered with
   *  the images, by the same rule, so a page carrying both keeps one reading order. */
  extra: readonly PageRegion[] = [],
): IRBlock[] {
  return interleaveRegions(items, [...anchors.map(imageRegion), ...extra], prose);
}

/** A text line of a rendered segment, with its geometry (non-blank items only: a blank has height 0, lesson of 21/09/2026). */
interface PlacedLine {
  /** Index of the rendered segment that holds the line, and of the line inside it. */
  segment: number;
  line: number;
  middle: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A place between two lines: `at` lines of segment `segment` come before it (`at` = 0 is the start of the segment). */
interface Cut {
  segment: number;
  at: number;
}

/** The lines of the rendered segments in reading order. A line of blanks only is left out. */
const placedLines = (read: readonly PdfTextRun[][][]): PlacedLine[] =>
  read.flatMap((segment, index) =>
    segment.flatMap((line, lineIndex) => {
      const ink = line.filter((it) => it.text.trim() !== "");
      if (ink.length === 0) return [];
      return [
        {
          segment: index,
          line: lineIndex,
          ...extentOf(ink),
        },
      ];
    }),
  );

/** The nearest line (by middle) at or above `median`, the first in reading order on a tie; `undefined` when none. */
const nearestAbove = (lines: readonly PlacedLine[], median: number): PlacedLine | undefined =>
  lines.reduce<PlacedLine | undefined>(
    (best, l) => (l.middle >= median && (best === undefined || l.middle - median < best.middle - median) ? l : best),
    undefined,
  );

/**
 * WHERE AN IMAGE WANTS TO STAND ON A TAGGED PAGE, as a place between two lines (the rule 2 of the design):
 *  - lines the image COVERS on both sides of its median (a background, a banner): before the first covered line
 *    (`sharedImageFrontier`, the 23/09/2026 rule); `retreat` is true;
 *  - else after its reference line: the nearest line above its median that overlaps it in width (its own column), else the nearest
 *    above in any column; an anchor without a box takes the all-columns rule;
 *  - no line above at all: before all the text.
 * `retreat` says which way to go when the wanted place would cut a paragraph, a list or a heading: before the segment (true) or after it.
 */
const wantedCut = (anchor: ImageAnchor, lines: readonly PlacedLine[]): { cut: Cut; retreat: boolean } => {
  const median = anchor.bottom === undefined ? anchor.top : (anchor.top + anchor.bottom) / 2;
  const { bottom, xMax } = anchor;
  const after = (l: PlacedLine): { cut: Cut; retreat: boolean } => ({ cut: { segment: l.segment, at: l.line + 1 }, retreat: false });
  if (bottom !== undefined && xMax !== undefined) {
    const covered = lines.filter((l) => l.bottom >= bottom && l.top <= anchor.top);
    if (sharedImageFrontier(median, anchor.top, covered) !== median) {
      return { cut: { segment: covered[0]!.segment, at: covered[0]!.line }, retreat: true };
    }
    const sameColumn = nearestAbove(
      lines.filter((l) => Math.min(l.right, xMax) - Math.max(l.left, anchor.xMin) > 0),
      median,
    );
    if (sameColumn !== undefined) return after(sameColumn);
  }
  const reference = nearestAbove(lines, median);
  return reference === undefined ? { cut: { segment: 0, at: 0 }, retreat: true } : after(reference);
};

/** What `settle` remembers across the anchors of one page: the blocks of each whole segment, the segments that read as ONE
 *  block (no interior boundary to look for), and the boundary answers already computed. */
interface SettleCache {
  whole: Map<number, string>;
  single: Set<number>;
  boundaries: Map<string, boolean>;
}
/**
 * A place INSIDE a segment is kept only when it falls on a block boundary: reading the two halves apart gives exactly the blocks of
 * the whole (`toBlocks`), so no paragraph, list or heading is cut. WRITTEN LIMIT (revue 27/10/2026): each cut is verified as a
 * PAIRWISE split of the whole segment; with TWO cuts in one segment the rendering composes three slices, which is only proven for a
 * SLICE-LOCAL block builder (ours groups by the gaps inside the slice, so it is one); a context-sensitive builder would need a
 * composed check across all cuts of the segment — not written, STATUS carries it. Otherwise the image goes to the NEAREST such boundary in the
 * direction its rule names (forward after its reference line, back before its first covered line), else to the end of the segment
 * (or its start). Without the boundary test, a tagged page read as ONE segment pushed all its images to the end of the page
 * (fixture 24 p1, p7); without the nearest boundary, an image whose reference line sits inside a paragraph went to the end of the
 * segment, behind the labels of its own column (fixture 24 p7, the phone screenshot under "Pas 6").
 */
const settle = (
  read: readonly PdfTextRun[][][],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
  cache: SettleCache,
  { cut, retreat }: { cut: Cut; retreat: boolean },
): Cut => {
  const lines = read[cut.segment];
  if (lines === undefined || cut.at <= 0) return cut;
  if (cut.at >= lines.length) return { segment: cut.segment + 1, at: 0 };
  const { whole, single, boundaries } = cache;
  if (!whole.has(cut.segment)) {
    const blocks = toBlocks(lines);
    whole.set(cut.segment, JSON.stringify(blocks));
    // A segment that reads as ONE block has no interior boundary at all (any split gives two blocks or more): the scan below
    // would walk every line for nothing, two `toBlocks` runs a step (revue 27/10/2026, tour 9).
    if (blocks.length <= 1) single.add(cut.segment);
  }
  if (single.has(cut.segment)) return retreat ? { segment: cut.segment, at: 0 } : { segment: cut.segment + 1, at: 0 };
  // Boundary answers are MEMOIZED across anchors (revue 27/10/2026): each test costs two toBlocks runs of the segment,
  // and several anchors walk the same indexes — without the cache a long segment costs O(anchors x lines^2) toBlocks runs.
  const isBoundary = (at: number): boolean => {
    const key = `${cut.segment}:${at}`;
    const cached = boundaries.get(key);
    if (cached !== undefined) return cached;
    const answer = JSON.stringify([...toBlocks(lines.slice(0, at)), ...toBlocks(lines.slice(at))]) === whole.get(cut.segment);
    boundaries.set(key, answer);
    return answer;
  };
  const step = retreat ? -1 : 1;
  for (let at = cut.at; at > 0 && at < lines.length; at += step) if (isBoundary(at)) return { segment: cut.segment, at };
  return retreat ? { segment: cut.segment, at: 0 } : { segment: cut.segment + 1, at: 0 };
};

/** A TAGGED page: the text of the WHOLE page is read in the declared order once, the images are then slid between its blocks. */
const readTaggedPage = (
  read: readonly PdfTextRun[][][],
  anchors: readonly ImageAnchor[],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
): IRBlock[] => {
  const lines = placedLines(read);
  const cache: SettleCache = { whole: new Map(), single: new Set(), boundaries: new Map() };
  // Several images in one place: bands from top to bottom, each band from left to right (`readingOrder`, as for an untagged page).
  const byPlace = new Map<string, PageRegion[]>();
  const key = (c: Cut): string => `${c.segment}:${c.at}`;
  for (const anchor of anchors) {
    const place = settle(read, toBlocks, cache, wantedCut(anchor, lines));
    byPlace.set(key(place), [...(byPlace.get(key(place)) ?? []), imageRegion(anchor)]);
  }
  const imagesAt = (segment: number, at: number): IRBlock[] =>
    readingOrder(byPlace.get(key({ segment, at })) ?? []).flat().flatMap((region) => region.blocks);
  const out: IRBlock[] = [];
  read.forEach((linesOfSegment, segment) => {
    const ats = [...new Set([0, ...[...byPlace.keys()].flatMap((k) => (k.startsWith(`${segment}:`) ? [Number(k.split(":")[1])] : []))])].sort(
      (x, y) => x - y,
    );
    ats.forEach((at, i) => {
      out.push(...imagesAt(segment, at));
      out.push(...toBlocks(linesOfSegment.slice(at, ats[i + 1] ?? linesOfSegment.length)));
    });
  });
  out.push(...imagesAt(read.length, 0));
  return out;
};

/**
 * Does the chunked reading put a ranked line BEFORE a line of a later chunk that the document declares earlier? `chunks` holds, per
 * chunk in reading order, the declared rank of each of its lines (the lowest rank of its items; lines with no rank are left out).
 */
const chunksBreakDeclaredOrder = (chunks: readonly (readonly number[])[]): boolean => {
  let highestBefore = Number.NEGATIVE_INFINITY;
  for (const ranks of chunks) {
    if (ranks.length === 0) continue;
    // Loops, never `Math.min(...ranks)` (revue 27/10/2026, tour 8): one entry per ranked LINE, so a hostile page with
    // ~100k lines would spread past the argument limit and throw « Maximum call stack size exceeded » in the product path.
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (const rank of ranks) {
      if (rank < lowest) lowest = rank;
      if (rank > highest) highest = rank;
    }
    if (lowest < highestBefore) return true;
    if (highest > highestBefore) highestBefore = highest;
  }
  return false;
};

/**
 * A PAGE WITHOUT A TABLE: the images and the reading in bands, inside each vertical chunk the images cut. Exported to pin the
 * reading order without a fixture.
 *
 * ON A TAGGED PAGE (`declaredRank` defined) whose chunked reading BREAKS the declared order across chunks (an icon in the middle of a
 * table row: 014 p35, 141 p70), the page is read whole in the declared order and each image stands between two blocks
 * (`readTaggedPage`). A tagged page whose chunked reading already follows the declared order keeps its output unchanged (24/10/2026).
 * KNOWN LIMIT, ugly but written, for every page that keeps the chunked reading (15/09/2026): the images cut the page by height BEFORE
 * the column cut. An image in the left column also cuts the right column, and the reading order gets mixed up
 * (`pdf-block-images.test.ts`).
 */
/** What the bands of a page become. `rows` is the PRODUCT since 06/11/2026: a band of N >= 2 columns is one table of one
 *  row x N cells (`rowBlocks`). `flow` is the older rendering, used by the scanned page and the tests that pin it: one
 *  column, then the next below. Tried and dropped on 04/11/2026: a page of columns rendered by `ac:layout` (Confluence degrades
 *  an `ac:layout` inside a tab to `legacy-content`, `docs/PLATFORM-STATUS.md` §85) and a whole-page grid (« on vire l'essai
 *  table »). The product publishes a band of columns as a table of one row (option C).
 *  `items` and `item-cells` (10/11/2026, tried on the word, « essaye 1, 2 et 3 sur 3 pages différentes ») publish
 *  columns of NUMBERED ITEMS as one table row per rank of item (`itemRows`); any other band keeps the one-row table. */
export type BandLayout = "rows" | "flow" | "items" | "item-cells";

/** 🔴 WHAT THE PRODUCT MAKES OF A BAND OF N >= 2 COLUMNS — `item-cells` since 11/11/2026 (« oui » to the
 *  four-column catalogue page 115408897): columns of NUMBERED ITEMS become one table row per rank of item, number and
 *  text in their own cells; EVERY OTHER band stays one table of one row x N cells, the `rows` rendering (option C,
 *  decided 06/11/2026), which is what the Alouette bulletin (FIDREVIEW 114425870, its golden) publishes.
 *  How option C was lost once, written so nobody falls into it again: on 10/11 I removed it, wrongly believing it caused
 *  the regression the maintainer saw, and put it back the same evening. I had taken as reference a published page of unknown
 *  provenance; the recap mail of 06/11 11:22 is what dated the product's rendering. RECAP MAILS DATE WHAT THE PRODUCT
 *  RENDERED; a published page does not. `flow` (prose in reading order) stays reachable by `extractPdf`'s `bands`. */
export const DEFAULT_BAND_LAYOUT: BandLayout = "item-cells";

/** What the bands of a page become, and how the boxed blocks of a cell are published (06/11/2026). */
export interface BandRendering {
  layout: BandLayout;
  /** The boxed blocks of a column (`pdf-framed-blocks.ts#FramedBlocks`). Absent: the product's default. */
  framed?: FramedBlocks;
  /** The closed rectangles drawn on the page — the candidate frames. Absent or empty: nothing is framed. */
  frames?: readonly ContainerBox[];
}

/** What `rowBlocks` needs beyond the bands: the frames of the page and the option that says what to do with them, and the
 *  figures that follow a row of bands (`figuresUnder`). */
interface RowExtras {
  framed: FramedBlocks;
  frames: readonly ContainerBox[];
  figuresUnder: (bands: readonly PdfTextRun[][][]) => IRBlock[];
}

/** What the figures of a column table need: the cuts and the band centres of the page, the overflowing images still to
 *  place, and the figure of an anchor (image and caption in their one-cell table; marks the anchor placed). */
interface FigureContext {
  cuts: readonly number[];
  centres: readonly number[];
  pending: () => ImageAnchor[];
  figure: (a: ImageAnchor) => IRBlock[];
}

/** The centre of each band of the page, between its edges and its cuts. */
const centresOf = (cuts: readonly number[], left: number, right: number): number[] => {
  const edges = [left, ...cuts, right];
  return edges.slice(0, -1).map((edge, i) => (edge + edges[i + 1]!) / 2);
};

/**
 * THE FIGURE UNDER THE TABLE OF ITS OWN ZONE (06/11/2026, on the published page: « on avait dit EN DESSOUS du
 * tableau, pas au-dessus »). The photo of the APF article (Alouette bulletin p3, fixture 58 p1) covers two of the four
 * columns right under the article's title and by-line. The 05/11 rule (« la figure sort SOUS le bloc de colonnes ») put it
 * at the BOTTOM of the page, after every column block of the chunk, where it lost its article. A first reading of his
 * decision put it INSIDE the article's table, a `colspan` row above the prose — refused on the published page the same
 * day: the photo topped the prose and the empty cells of the row left visible borders. The rule: in `rows`, an image that
 * OVERFLOWS its column follows the column table of the zone it belongs to, OUTSIDE it, in the one-cell table as wide as
 * the image of 05/11 (image and caption, `figure`), before the next block of the page. It belongs to a row of bands when
 * it overlaps it in height and covers the CENTRE of a column one of its cells holds (the test `placementOf` already makes;
 * a cell covers the grid columns from its band's left column to the next band's). An image that belongs to no row keeps
 * the 05/11 form: after the column block of its chunk (`liftedIn`). Several images under one table: highest first.
 */
const figuresUnder = (bands: readonly PdfTextRun[][][], { cuts, centres, pending, figure }: FigureContext): IRBlock[] => {
  const inks = bands.map(inkOf);
  if (inks.some((ink) => ink.length === 0)) return [];
  const extent = extentOf(inks.flat());
  const columnOf = (x: number): number => cuts.filter((cut) => cut <= x).length;
  const starts = inks.map((ink) => columnOf(extentOf(ink).left));
  const spans = starts.map((start, i) => ({ from: start, to: (starts[i + 1] ?? cuts.length + 1) - 1 }));
  return pending()
    .filter((a) => a.bottom !== undefined && a.top >= extent.bottom && a.bottom <= extent.top)
    .sort((p, q) => q.top - p.top)
    .flatMap((a) => {
      const covered = centres.flatMap((centre, i) => (a.xMin <= centre && (a.xMax ?? a.xMin) >= centre ? [i] : []));
      const belongs = spans.some((span) => covered.some((c) => c >= span.from && c <= span.to));
      return belongs ? figure(a) : [];
    });
};

/** The blocks of the bands of a page, as `bandLayout` says: one table per run of columns (`rows`) or the bands one after the other (`flow`).
 *  Tried on 04/11/2026 and dropped: a page of columns rendered by `ac:layout`, because Confluence degrades an `ac:layout`
 *  inside a tab to `legacy-content` (`docs/PLATFORM-STATUS.md` §85). The product publishes a band of columns as a table of one row (option C). */
function blocksOfBands(
  segments: readonly ReadSegment<PdfTextRun>[],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
  bandLayout: BandLayout,
  cuts: readonly number[],
  extras: RowExtras,
): IRBlock[] {
  const runs = bandRuns(segments);
  return bandLayout === "flow" ? runs.flatMap((run) => runBlocks(run, toBlocks)) : runs.flatMap((run) => rowBlocks(run, toBlocks, cuts, extras, bandLayout));
}

/** The segments grouped: a run of neighbouring bands, or one full-width block. */
interface BandRun<T> {
  column: boolean;
  bands: T[][][];
}

const bandRuns = <T>(segments: readonly ReadSegment<T>[]): BandRun<T>[] => {
  const runs: BandRun<T>[] = [];
  for (const segment of segments) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.column && segment.column) last.bands.push(segment.lines);
    else runs.push({ column: segment.column, bands: [segment.lines] });
  }
  return runs;
};

/** The blocks of a run that is not a column. */
const runBlocks = (run: BandRun<PdfTextRun>, toBlocks: (segment: PdfTextRun[][]) => IRBlock[]): IRBlock[] => run.bands.flatMap(toBlocks);

/**
 * A BAND OF N >= 2 COLUMNS IS ONE TABLE OF ONE ROW x N CELLS, one column per cell, blocks in the order the bands are read
 * (06/11/2026, option C of the columns arbitration: layouts cannot live in tabs, so the columns go in a table).
 * A change of RENDERING only: the bands, their cuts and their order come from `pdf-bands.ts` untouched. What crosses the cut
 * is not a column run and stays outside; a run of ONE band stays flat prose (the 26/10 rule).
 *
 * Two zones that touch with no full-width line between them arrive as one run: a band whose column does not rise above the
 * previous one's opens the next table, so a table never holds two bands of the same column.
 */
/**
 * THE BLOCKS OF ONE CELL, AND THE BOXED BLOCKS THAT LEAVE IT. The lines a drawn frame holds (`splitFramed`) become a
 * one-cell table marked `framed` (`lib/ir.ts`): at their place in the cell (`nested`), or handed back in `below` for the
 * caller to publish after the column table. The lines between two frames are read as their own segment: a frame is a
 * block boundary by nature, so the paragraphs around it never cross it. `flat`, the product's default, reads the band
 * whole, as before the option existed.
 */
const framedCell = (band: PdfTextRun[][], toBlocks: (segment: PdfTextRun[][]) => IRBlock[], { framed, frames }: RowExtras): { blocks: IRBlock[]; below: IRBlock[] } => {
  if (framed === "flat" || frames.length === 0) return { blocks: toBlocks(band), below: [] };
  const { rest, groups } = splitFramed(band, frames);
  if (groups.length === 0) return { blocks: toBlocks(band), below: [] };
  const starts = new Map(groups.map((g) => [g.at, g]));
  const restAt = new Map(rest.map((r) => [r.at, r.line]));
  const blocks: IRBlock[] = [];
  const below: IRBlock[] = [];
  let run: PdfTextRun[][] = [];
  const flush = (): void => {
    if (run.length > 0) blocks.push(...toBlocks(run));
    run = [];
  };
  band.forEach((_, at) => {
    const group = starts.get(at);
    if (group !== undefined) {
      flush();
      const table: IRTable = { kind: "table", framed: true, rows: [{ cells: [{ blocks: toBlocks(group.lines) }] }] };
      (framed === "nested" ? blocks : below).push(table);
    }
    const line = restAt.get(at);
    if (line !== undefined) run.push(line);
  });
  flush();
  return { blocks, below };
};

/** A short marker that can open an item: a number of up to four digits, with an optional `.` or `)`, or a bullet. */
const ITEM_MARKER = /^(?:\(?\d{1,4}[.)]?|[•·▪◦‣–-])$/u;

/** The marker that opens an item on this line: its first inked fragment is a marker, and the next inked fragment stands
 *  at least one em (the marker's font size) to its right — a blank, not a space (« un ou plusieurs espaces,
 *  selon ce que dit le pdf »). Starting value to calibrate: the catalogue's lot numbers stand 29 pt from their text at
 *  10 pt; a word space is a quarter to a third of an em. */
const itemMarkerOf = (line: readonly PdfTextRun[]): PdfTextRun | undefined => {
  const inked = line.filter((it) => it.text.trim().length > 0);
  const [first, next] = inked;
  if (first === undefined || next === undefined || !ITEM_MARKER.test(first.text.trim())) return undefined;
  return next.x - (first.x + first.width) >= first.fontSize ? first : undefined;
};

/** The lines of a column cut into items at each marker line. Undefined when the column holds inked text before its first
 *  marker, or fewer than two items: it is not a column of items, and the band keeps the one-row table. */
const itemsOf = (band: readonly PdfTextRun[][]): PdfTextRun[][][] | undefined => {
  const items: PdfTextRun[][][] = [];
  for (const line of band) {
    if (itemMarkerOf(line) !== undefined) items.push([line]);
    else if (items.length > 0) items[items.length - 1]!.push(line);
    else if (line.some((it) => it.text.trim().length > 0)) return undefined;
  }
  return items.length >= 2 ? items : undefined;
};

/**
 * COLUMNS OF NUMBERED ITEMS, ONE TABLE ROW PER RANK OF ITEM (10/11/2026, auction catalogue `sd-1026348`). The k-th item
 * of each column goes in row k, whole: `items` puts it in one cell (its number at the head, then a space), `item-cells`
 * gives the number a cell of its own (number | text). Items pair by RANK, not by height: the catalogue's lots 2 and 6
 * start 11 pt apart. A column with fewer items leaves its cells empty. Undefined when one column is not a column of
 * items (`itemsOf`).
 */
const itemRows = (bands: readonly PdfTextRun[][][], toBlocks: (segment: PdfTextRun[][]) => IRBlock[], ownCell: boolean): IRTable | undefined => {
  const columns: PdfTextRun[][][][] = [];
  for (const band of bands) {
    const items = itemsOf(band);
    if (items === undefined) return undefined;
    columns.push(items);
  }
  const ranks = Math.max(...columns.map((items) => items.length));
  const rows = Array.from({ length: ranks }, (_, k) => ({
    cells: columns.flatMap((items) => {
      const item = items[k];
      if (item === undefined) return ownCell ? [{ blocks: [] }, { blocks: [] }] : [{ blocks: [] }];
      if (!ownCell) return [{ blocks: toBlocks(item) }];
      const marker = itemMarkerOf(item[0]!)!;
      const firstLine = item[0]!.filter((it) => it !== marker);
      return [{ blocks: toBlocks([[marker]]) }, { blocks: toBlocks([firstLine, ...item.slice(1)]) }];
    }),
  }));
  return ownCell ? { kind: "table", rows, columnWidths: columns.flatMap(itemColumnWidths) } : { kind: "table", rows };
};

/** The widths the PDF gives a column of items, number then text (« on peut réduire largeur des cols de numéros ? »):
 *  from the leftmost marker to the leftmost text, then from there to the rightmost ink. Proportions only: Confluence
 *  shares the table's width by them (`renderer/storage.ts#columnGroup`). Measured on the catalogue, page 1: 35 pt then
 *  about 215 pt. */
const itemColumnWidths = (items: readonly PdfTextRun[][][]): number[] => {
  let markerLeft = Number.POSITIVE_INFINITY;
  let textLeft = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const marker = itemMarkerOf(item[0]!)!;
    markerLeft = Math.min(markerLeft, marker.x);
    for (const it of item.flat()) {
      if (it === marker || it.text.trim().length === 0) continue;
      textLeft = Math.min(textLeft, it.x);
      right = Math.max(right, it.x + it.width);
    }
  }
  return [Math.max(1, textLeft - markerLeft), Math.max(1, right - textLeft)];
};

const rowBlocks = (
  run: BandRun<PdfTextRun>,
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
  cuts: readonly number[],
  extras: RowExtras,
  bandLayout: BandLayout = DEFAULT_BAND_LAYOUT,
): IRBlock[] => {
  if (!run.column || run.bands.length < 2) return runBlocks(run, toBlocks);
  const columnOf = (lines: PdfTextRun[][]): number => {
    let left = Number.POSITIVE_INFINITY;
    for (const it of lines.flat()) if (it.text.trim().length > 0 && it.x < left) left = it.x;
    return cuts.filter((cut) => cut <= left).length;
  };
  const rows: PdfTextRun[][][][] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (const band of run.bands) {
    const column = columnOf(band);
    if (column > previous) rows[rows.length - 1]!.push(band);
    else rows.push([band]);
    previous = column;
  }
  return rows.flatMap((bands) => {
    if (bands.length < 2) return bands.flatMap(toBlocks);
    const items = bandLayout === "items" || bandLayout === "item-cells" ? itemRows(bands, toBlocks, bandLayout === "item-cells") : undefined;
    if (items !== undefined) return [items, ...extras.figuresUnder(bands)];
    const read = bands.map((band) => framedCell(band, toBlocks, extras));
    const cells = read.map(({ blocks }) => ({ blocks }));
    // THE TITLE THAT OPENS THE FIRST COLUMN STANDS ABOVE THE TABLE WHEN IT CAPS THE WHOLE ZONE (06/11/2026, finding 9
    // of the review). « Programme » of the Alouette bulletin sits on the first baseline of the right column, so the band
    // reading takes it for column 1's first line; taken out in front of its table, the reading order is the same word for
    // word. But a rule for EVERY document would lift « Introduction » above a page whose columns each open with their own
    // title (« Introduction » left, « Results » right) and break the hierarchy. The discriminant is a fact the code already
    // holds, no threshold: the FIRST block of the neighbouring cell, which shares the title's line. Running text there
    // (« Performances de slam… ») — the title caps the zone and goes above; another HEADING there — each column has its
    // title, and it stays in its cell. ONE block only, never the whole cell.
    const first = cells[0]!.blocks[0];
    const neighbourFirst = cells[1]?.blocks[0];
    const caps = first?.kind === "heading" && cells[0]!.blocks.length > 1 && neighbourFirst !== undefined && neighbourFirst.kind !== "heading";
    const title = caps ? cells[0]!.blocks.shift() : undefined;
    // The figures that overflow a column of this row FOLLOW its table (`figuresUnder`), then the boxed blocks that left
    // their cell (`below`), cell after cell, each in its reading order.
    const table: IRTable = { kind: "table", rows: [{ cells }] };
    return [...(title === undefined ? [] : [title]), table, ...extras.figuresUnder(bands), ...read.flatMap(({ below }) => below)];
  });
};

/**
 * WHERE AN IMAGE STANDS AGAINST THE COLUMNS (05/11/2026, front page of the newspaper `sd-2479793`). Until then
 * every image cut the page at its height before the columns were read, and the front page's sidebar — one column
 * running from top to bottom — came out in four slices around a logo and a photo. Three cases, by what the image
 * covers:
 *   within ONE column (crosses no cut)        → in the flow of its column, at its height (`interleaveImages` on the band);
 *   OVERFLOWING its column (crosses a cut,
 *     but not every column)                   → image and caption in a one-cell table as wide as the image (
 *                                               05/11/2026, forme A), placed in `rows` right UNDER the column table of the
 *                                               zone it belongs to (`figuresUnder`, 06/11/2026), otherwise below
 *                                               the column block of its chunk (`liftedIn`);
 *   SPANNING every column (covers the centre
 *     of each band)                           → cuts the page at its height, as before (the median rule of 16/09).
 * An anchor without a known box keeps the old behaviour. The caption of a lifted image: the lines right under it, within
 * its width, smaller than the body size, up to the first line that is not. No image is lost: one that found no chunk
 * nor band is published at the end of the page.
 */
type ImagePlacement = "within" | "overflowing" | "spanning";

const placementOf = (a: ImageAnchor, cuts: readonly number[], left: number, right: number, ink: readonly PdfTextRun[]): ImagePlacement => {
  if (a.xMax === undefined || a.bottom === undefined || cuts.length === 0) return "spanning";
  // 🔴 NO TEXT AT ITS HEIGHT, NO COLUMN TO BELONG TO (10/11/2026, auction catalogue `sd-1026348`: its logo, across the cut
  // and above every line, was published last on the page). An image that no line of text meets in height stands where no
  // column runs: it cuts the page at its height, as a spanning one does.
  const bottom = a.bottom;
  if (!ink.some((it) => it.y + it.height > bottom && it.y < a.top)) return "spanning";
  const [xMin, xMax] = [a.xMin, a.xMax];
  if (!cuts.some((cut) => xMin < cut && xMax > cut)) return "within";
  return centresOf(cuts, left, right).every((centre) => xMin <= centre && xMax >= centre) ? "spanning" : "overflowing";
};

const inkOf = (lines: readonly (readonly PdfTextRun[])[]): PdfTextRun[] => lines.flat().filter((it) => it.text.trim() !== "");

/** HOW FAR A CAPTION MAY STEP OUT OF ITS IMAGE'S WIDTH, on either side, as a share of that width (05/11/2026 :
 *  « mets genre 2 % de tolérance »). The caption of the newspaper's photo spans 317..550 under a photo 317..551 (0 and
 *  0.4 %) ; the column beside it starts 4 pt past the photo's right edge (1.7 %) but runs to 660 (47 %), and the
 *  column before it starts 110 pt before the left edge. */
export const MAX_CAPTION_OVERHANG_RATIO = 0.02;

/** The caption of a lifted image: the FRAGMENTS under its bottom edge and within its width (`MAX_CAPTION_OVERHANG_RATIO`)
 *  — not the page's lines, which would weld the caption to the neighbouring column at the same height — grouped into
 *  lines, nearest first, smaller than the body, up to the first line that is not. A fragment stands no lower than `floor`:
 *  the top of the next image under this one (review 06/11/2026: two stacked images, no body line between them, the
 *  upper one swallowed the lower one's caption and the words came out twice). */
const captionOf = (a: ImageAnchor, items: readonly PdfTextRun[], bodySize: number, floor: number): PdfTextRun[][] => {
  if (a.bottom === undefined || a.xMax === undefined) return [];
  const [bottom, xMin, xMax] = [a.bottom, a.xMin, a.xMax];
  const overhang = (xMax - xMin) * MAX_CAPTION_OVERHANG_RATIO;
  const fragments = items.filter((it) => it.text.trim() !== "" && it.y >= floor && it.y + it.height <= bottom + it.fontSize && it.x >= xMin - overhang && it.x + it.width <= xMax + overhang);
  const under = groupItemsIntoLines(fragments)
    .map((line) => ({ line, ink: inkOf([line]) }))
    .filter(({ ink }) => ink.length > 0)
    .sort((p, q) => q.ink[0]!.y - p.ink[0]!.y);
  const caption: PdfTextRun[][] = [];
  for (const { line, ink } of under) {
    if (ink.some((it) => it.fontSize >= bodySize)) break;
    caption.push(line);
  }
  return caption;
};

/** The top edge of the nearest image UNDER `a` that shares part of its width — where `a`'s caption must stop; `-Infinity`
 *  when there is none. */
const nextImageTop = (a: ImageAnchor, anchors: readonly ImageAnchor[]): number => {
  if (a.bottom === undefined || a.xMax === undefined) return Number.NEGATIVE_INFINITY;
  let floor = Number.NEGATIVE_INFINITY;
  for (const other of anchors) {
    if (other === a || other.xMax === undefined || other.top > a.bottom) continue;
    if (other.xMin < a.xMax && other.xMax > a.xMin && other.top > floor) floor = other.top;
  }
  return floor;
};

/** What a column page is read with: ITS PLAN — which holds the cuts and the bound of a painted cell, and which is
 *  asked for every reading — the rendering of its bands, and its paragraph builder. */
interface ColumnReading {
  plan: PagePlanReader;
  rendering: BandRendering;
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[];
  /** The side-by-side tables already built for this page (`pdf-aside-figures.ts`), to order with the images. */
  figures: readonly PageRegion[];
}

/** THE CAPTION IS ONE PARAGRAPH (05/11/2026 : « la largeur décide »). Its lines were kept because they fit the
 *  image's width, like the caption of the newspaper's photo (x 317..550 under a photo 317..551) ; a size change inside
 *  them — a book title in italics at 8.15 pt in a caption set in 8 pt — splits nothing. Paragraphs only : a caption the
 *  builder read otherwise (a heading, a list) is left as it came. */
const oneCaption = (blocks: readonly IRBlock[]): IRBlock[] => {
  const paragraphs = blocks.filter((b): b is Extract<IRBlock, { kind: "paragraph" }> => b.kind === "paragraph");
  if (paragraphs.length < 2 || paragraphs.length !== blocks.length) return [...blocks];
  // The joining space goes on the piece before, as the paragraph builder does between two lines: a sentence read
  // across the join stays one string (fixture 24 p7, « Note : si vous avez un code »).
  const inlines = paragraphs[0]!.inlines.map((i) => ({ ...i }));
  for (const p of paragraphs.slice(1)) {
    const last = inlines[inlines.length - 1];
    if (last !== undefined && last.image === undefined && last.marks === undefined) last.text += " ";
    else inlines.push({ text: " " });
    inlines.push(...p.inlines);
  }
  return [{ ...paragraphs[0]!, inlines }];
};

function readColumnsWithImages(items: readonly PdfTextRun[], anchors: readonly ImageAnchor[], { plan, rendering, toBlocks, figures }: ColumnReading): IRBlock[] {
  const { cuts } = plan;
  const ink = inkOf([items]);
  const left = minOf(ink, (it) => it.x);
  const right = maxOf(ink, (it) => it.x + it.width);
  const placed = anchors.map((a) => ({ a, placement: placementOf(a, cuts, left, right, ink) }));
  const spanning = placed.filter((p) => p.placement === "spanning").map((p) => p.a);
  const overflowing = placed.filter((p) => p.placement === "overflowing").map((p) => p.a);
  const within = placed.filter((p) => p.placement === "within").map((p) => p.a);

  const charsBySize = new Map<number, number>();
  for (const it of ink) charsBySize.set(it.fontSize, (charsBySize.get(it.fontSize) ?? 0) + it.text.trim().length);
  const bodySize = bodySizeOf(charsBySize) ?? 0;
  // Highest image first, so that a fragment claimed by one caption is not offered to the next: it belongs to ONE caption.
  const claimed = new Set<PdfTextRun>();
  const captions = new Map<ImageAnchor, PdfTextRun[][]>();
  for (const a of [...overflowing].sort((p, q) => q.top - p.top)) {
    const own = captionOf(a, items.filter((it) => !claimed.has(it)), bodySize, nextImageTop(a, anchors));
    for (const it of own.flat()) claimed.add(it);
    captions.set(a, own);
  }
  const captioned = claimed;
  const rest = items.filter((it) => !captioned.has(it));

  const emitted = new Set<ImageAnchor>();
  /** The image and its caption, and the anchor is placed. */
  const figureBlocks = (a: ImageAnchor): IRBlock[] => {
    emitted.add(a);
    const caption = captions.get(a) ?? [];
    return [...a.blocks, ...(caption.length > 0 ? oneCaption(toBlocks(caption)) : [])];
  };
  // THE FIGURE, OUT OF ITS COLUMNS: image and caption in a one-cell table that takes the image's width at publication
  // (`lib/ir.ts` `width: "image"`), so the caption wraps exactly under the photo (05/11/2026).
  const figure = (a: ImageAnchor): IRBlock[] => {
    const blocks = figureBlocks(a);
    return blocks.some((b) => b.kind === "image") ? [{ kind: "table", width: "image", rows: [{ cells: [{ blocks }] }] }] : blocks;
  };
  const extras: RowExtras = {
    framed: rendering.framed ?? DEFAULT_FRAMED_BLOCKS,
    frames: rendering.frames ?? [],
    figuresUnder: (bands) => figuresUnder(bands, { cuts, centres: centresOf(cuts, left, right), pending: () => overflowing.filter((a) => !emitted.has(a)), figure }),
  };
  const bandOf = (x: number): number => cuts.filter((cut) => cut <= x).length;
  const overlaps = (a: ImageAnchor, lines: readonly (readonly PdfTextRun[])[]): boolean => {
    const bandInk = inkOf(lines);
    if (bandInk.length === 0 || a.bottom === undefined) return false;
    const top = maxOf(bandInk, (it) => it.y + it.height);
    const bottom = minOf(bandInk, (it) => it.y);
    return a.top >= bottom && a.bottom <= top;
  };
  // A lifted image goes BELOW the column block of the chunk its height falls in, highest first (05/11/2026 :
  // « la photo et sa légende, par défaut, en dessous du tableau dont elles sont extraites »).
  const liftedIn = (chunk: readonly PdfTextRun[]): IRBlock[] =>
    overflowing
      .filter((a) => !emitted.has(a) && overlaps(a, [chunk]))
      .sort((p, q) => q.top - p.top)
      .flatMap(figure);
  // An image within one column joins the flow of the band of that column it overlaps.
  const toBlocksWithImages = (lines: PdfTextRun[][]): IRBlock[] => {
    const bandInk = inkOf(lines);
    const mine = bandInk.length === 0 ? [] : within.filter((a) => !emitted.has(a) && bandOf(a.xMin) === bandOf(minOf(bandInk, (it) => it.x)) && overlaps(a, lines));
    if (mine.length === 0) return toBlocks(lines);
    for (const a of mine) emitted.add(a);
    return interleaveImages(lines.flat(), mine, (its) => toBlocks(groupItemsIntoLines(its)));
  };
  const readChunk = (chunk: readonly PdfTextRun[]): IRBlock[] => {
    // The columns are read first: `within` images are emitted there, and `liftedIn` then takes what is left.
    const columns = blocksOfBands(plan.bands(chunk), toBlocksWithImages, rendering.layout, cuts, extras);
    return [...columns, ...liftedIn(chunk)];
  };
  const out = interleaveImages(rest, spanning, readChunk, figures);
  const forgotten = [...overflowing, ...within].filter((a) => !emitted.has(a)).flatMap(figure);
  return [...out, ...forgotten];
}

export function readPageWithImages(
  items: readonly PdfTextRun[],
  anchors: readonly ImageAnchor[],
  /** 🔴 THE PAGE'S PLAN (`extractor/pdf-page-plan.ts`), built once per page. Every reading of this page goes
   *  through it — it holds the column cuts and the bound of a painted cell, and it records each slice the page is
   *  read in. Nothing here asks `pdf-bands.ts` any more (13/11/2026). */
  plan: PagePlanReader,
  /** 🔴 WHAT THE PAGE'S BANDS BECOME (`BandLayout`) and their framed blocks (06/11/2026).
   *  ⚠️ WRITTEN LIMIT: no effect on a TAGGED page, which keeps its reading in the declared order. */
  rendering: BandRendering,
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
  /** The rank the document's own structure tree gives a cycle, when the page
   *  is tagged and its tree accounts for all of its text — see
   *  `./pdf-reading-order`. Absent on every untagged page, which is most of
   *  them, and the reading is then purely geometric. */
  declaredRank?: (item: PdfTextRun) => number | undefined,
): IRBlock[] {
  // 🔴 UNE IMAGE AVEC DU TEXTE À CÔTÉ EST UNE CELLULE, PAS UN POINT D'INSERTION (13/11/2026). Tant
  // qu'elle s'insère ENTRE deux lignes, une phrase qui court sur toute sa hauteur est coupée, et aucune valeur de
  // frontière n'y change rien — mesuré sur la page 5 du livret 26. Elle devient donc une rangée de deux cellules
  // avec le texte qu'elle longe. Les deux chemins passent ici, donc une page balisée est traitée comme une autre.
  const aside = asideFigures(items, anchors, toBlocks);
  const flow = aside.taken.size === 0 ? items : items.filter((it) => !aside.taken.has(it));
  const free = aside.figures.length === 0 ? anchors : anchors.filter((a) => !aside.figures.some((f) => f.anchor === a));
  const figures = aside.figures.map((f) => f.region);
  if (declaredRank === undefined) return readColumnsWithImages(flow, free, { plan, rendering, toBlocks, figures });
  // ONE pass on a tagged page, blocks built as we go (revue 27/10/2026, tour 9, REVERSING the two-pass of tour 6): deciding the
  // rewrite needs only the ranks, but `interleaveImages` redoes the whole page geometry (visual lines, gutters, frontiers) on a
  // second call, and the page that KEEPS its chunked reading — the common case — paid that twice for a byte-identical output.
  // The rewrite is the rare case, so it is the one that pays: its chunked blocks are built, then dropped.
  const chunkRanks: number[][] = [];
  const chunked = interleaveImages(flow, free, (chunk) => {
    const read = plan.declared(chunk, declaredRank);
    chunkRanks.push(linesRanks(read, declaredRank));
    return read.flatMap(toBlocks);
  }, figures);
  if (!chunksBreakDeclaredOrder(chunkRanks)) {
    return chunked;
  }
  const whole = plan.declaredWholePage(flow, declaredRank);
  // ONE-SEGMENT GUARD (27/10/2026, measured on the port of lot F): when the page read WHOLE is a single segment, the chunked
  // text is the same text in the same order — the rank inversion that triggered us is an artifact of the image cuts themselves —
  // so the declared-order rewrite can only LOSE the image interleaving (fixture 24 p7: two labels merged into one paragraph, the
  // two screenshots swapped). Measured populations: the one damaged page reads as 1 segment; every repaired page of 014
  // (p5/35/36/106/111) reads as 4 to 255 segments. The chunked reading stays.
  if (whole.length < 2) {
    return chunked;
  }
  // ⚠️ The side-by-side tables are already built: the whole-page rewrite publishes them after the text, as it does
  // for any region it was not given. Their lines are out of `flow`, so nothing is published twice.
  return [...readTaggedPage(whole, free, toBlocks), ...figures.flatMap((region) => region.blocks)];
}

/** The extent of a line's inked items, by LOOP: a spread (`Math.max(...items)`) throws « Maximum call stack size exceeded »
 *  past ~100k arguments, and a hostile page may draw one line of that many items (revue 28/10/2026, tour 10). */
const extentOf = (ink: readonly PdfTextRun[]): { middle: number; top: number; bottom: number; left: number; right: number } => {
  let middle = Number.NEGATIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const it of ink) {
    if (it.y + it.height / 2 > middle) middle = it.y + it.height / 2;
    if (it.y + it.height > top) top = it.y + it.height;
    if (it.y < bottom) bottom = it.y;
    if (it.x < left) left = it.x;
    if (it.x + it.width > right) right = it.x + it.width;
  }
  return { middle, top, bottom, left, right };
};
/** The declared rank of each ranked line of the segments, in reading order (the lowest rank among its items). */
const linesRanks = (read: readonly PdfTextRun[][][], rankOf: (item: PdfTextRun) => number | undefined): number[] =>
  read.flat().flatMap((line) => {
    // By LOOP, never `Math.min(...ranks)`: one argument per ITEM of the line (same crash as `chunksBreakDeclaredOrder`, tour 10).
    let lowest = Number.POSITIVE_INFINITY;
    for (const item of line) {
      const rank = rankOf(item);
      if (rank !== undefined && rank < lowest) lowest = rank;
    }
    return lowest === Number.POSITIVE_INFINITY ? [] : [lowest];
  });
