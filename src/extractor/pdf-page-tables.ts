/** A page carrying grids, laid out in full: every table it renders, the prose
 *  between them, and the images — in the flow, or in the cell holding their centre.
 *  NOT here: the rendering of one grid (`extractor/pdf-table-render.ts`), the
 *  reading order of the regions (`extractor/pdf-region-order.ts`), nor the
 *  fallback when nothing renders — the caller's, in `extractor/pdf.ts`.
 *  Called by: `extractor/pdf.ts`. */

import type { ImageRef, IRBlock } from "doc-ir";
import type { MergeMap, TableGrid } from "../layout/geometry";
import { gridBandOf, type GridBand } from "../layout/grid-band";
import type { HeadingLevel } from "../layout/heading-sizes";
import { holdsPoint, RECT_RULES, rawFromEdges } from "doc-ir/internal";
import type { GlyphFragment } from "./glyph-positions";
import { bandedSplit } from "./pdf-bands";
import { imageRegion, placeImages } from "./pdf-image-anchors";
import { groupItemsIntoLines } from "./pdf-lines";
import type { ImageCandidate, Line, PositionedItem } from "./pdf-model";
import { paragraphsFromSegment } from "./pdf-paragraphs";
import { interleaveRegions } from "./pdf-region-order";
import { segmentsInDeclaredOrder } from "./pdf-reading-order";
import type { PdfTextRun } from "./pdf-source";
import { renderTableRegion } from "./pdf-table-render";

/** The top/bottom of the rendered regions that hold a table block (a region published flat carries no band). */
const tableBandsOf = (
  rendered: readonly { top: number; bottom: number; blocks: readonly IRBlock[] }[],
): { top: number; bottom: number }[] =>
  rendered.filter((r) => r.blocks.some((b) => b.kind === "table")).map((r) => ({ top: r.top, bottom: r.bottom }));

/**
 * A page may carry several tables: the prose is rebuilt between the regions, going down the page.
 * Each region is judged on its own: one that does not explain itself falls back to flat text without taking the
 * others with it.
 */
export function renderPageTables(
  pageItems: readonly PdfTextRun[],
  regions: readonly { grid: TableGrid; merge?: MergeMap }[],
  glyphs: readonly GlyphFragment[],
  isBold: (item: PositionedItem) => boolean,
  wordWidthAt: (y: number, left?: number) => number,
  cut?: { cut: number; above: number },
  /** The bitmap marker placed before an item — see `linesFromGroups`. A page with a grid carries prose too, and that is
   *  where a bulletin's legend lives. */
  markerBefore?: (item: PositionedItem) => ImageRef | undefined,
  /** The heading level of a size, decided on the whole document, hence passed by the caller. */
  headingLevelOf?: (size: number) => HeadingLevel | undefined,
  /** The page's large images, not read yet — see `placeImages`. */
  imageCandidates: readonly ImageCandidate[] = [],
  /** The container two lines share — see `pdf-line-breaks.ts#centredContainerReader`. */
  centredContainer?: (line: Line, next: Line, segment: readonly Line[]) => number | undefined,
  /** Receives what a rendered table removes on purpose — see `renderTableRegion`. */
  recordRemoval?: (text: string) => void,
  /** The vertical extent of each region's grid, when the caller already measured it (`PageContext.bands`). */
  gridBands: readonly GridBand[] = regions.map((region) => gridBandOf(region.grid)),
  /** Receives the top/bottom of each region published AS A TABLE, top to bottom (`tableBands` of the outcome): a region published
   *  flat is prose and carries no band — see where the array is built. */
  recordBands?: (bands: { top: number; bottom: number }[]) => void,
  /** The rank the document's structure tree gives a cycle (`./pdf-reading-order`), absent on an untagged page: the prose around the tables
   *  is read in that order too (a grid the table stage did not rebuild came out line by line across its cells: corpus doc 290, 22/10/2026; held
   *  by fixture 38 p. 7, `pipeline/letter-conservation.fixtures.test.ts`).
   *  Limit, written: a prose chunk the bounded cut splits into side-by-side blocks (`columns`) keeps its geometric order. */
  declaredRank?: (item: PdfTextRun) => number | undefined,
  /** Called once per region published FLAT by the one-column rule (26/10/2026, `renderTableRegion`): the page carries a
   *  DECIDED flattening, listed in `PdfExtractResult.flattenedGridPages` for the bench. */
  recordFlattened?: () => void,
): IRBlock[] | undefined {
  // AN IMAGE WHOSE CENTRE IS INSIDE A GRID'S BOX, ON BOTH AXES, goes into that
  // grid's cell if the grid renders (21/09/2026, O1 and O4). An image
  // beside a table — in its height, not its width — stays in the page flow: on
  // fixture 24 page 3, once glyph widths exist, a small grid (x 242.7-353.4)
  // would otherwise swallow the two QR code pictures beside it. The
  // first grid whose box holds the centre claims the image; if that grid does
  // not render, the image goes back to the flow — judged against RENDERED
  // tables, never DETECTED grids (on fixture 24, a never-rendered row once set
  // aside 43R and 45R on page 3 and 72R on page 8).
  const boxes = regions.map(({ grid }, i) => ({
    ...gridBands[i]!,
    xMin: grid.colBoundaries[0]!,
    xMax: grid.colBoundaries[grid.colBoundaries.length - 1]!,
  }));
  const boxRects = boxes.map((b) => rawFromEdges({ left: b.xMin, right: b.xMax, bottom: b.bottom, top: b.top }));
  const claimedBy = imageCandidates.map((c) => {
    const x = (c.xMin + c.xMax) / 2;
    const y = (c.top + c.bottom) / 2;
    return boxRects.findIndex((r) => holdsPoint(RECT_RULES["grid-claim"], r, x, y));
  });
  const rendered = regions
    .map((region, i) => ({
      ...boxes[i]!,
      // A table block, or — one content column — the cells' blocks flat (`renderTableRegion`): either way the region's band is consumed.
      blocks: renderTableRegion(
        region.grid,
        glyphs,
        region.merge,
        imageCandidates.flatMap((c, k) => (claimedBy[k] === i ? [c] : [])),
        { removal: recordRemoval, flattened: recordFlattened },
      ),
      index: i,
    }))
    .filter((r): r is typeof r & { blocks: IRBlock[] } => r.blocks !== undefined)
    .sort((a, b) => b.top - a.top);
  if (rendered.length === 0) return undefined;
  // ONLY THE BANDS OF THE REGIONS PUBLISHED AS A TABLE (26/10/2026). Its one consumer is the letters control, which CUTS these
  // bands out of the prose it judges (`pipeline/letter-conservation.ts#proseOrder`, which also reads the page `withoutTables`).
  // A region published flat is prose: its text stays in the page's reading, so cutting its band would drop the page out of the
  // order judgement — seen biting on fixtures 24, 33 and 44, and on the control that swaps two paragraphs of fixture 24 page 2
  // (it came back « ok », so the guard no longer bit).
  recordBands?.(tableBandsOf(rendered));

  // The prose around the tables is read in bands here: a page with a grid never reaches the band reading of the main
  // loop, so the bounded cut must act in this function. Every prose chunk goes through it: a chunk below the bound
  // holds no eligible line and comes back as one segment.
  const asBlocks = (segment: PdfTextRun[][], classe = true): IRBlock[] =>
    // Outside a TABLE: a DETECTED grid is enough to forbid, rendered or not — that is what tells prose from a cell's line.
    paragraphsFromSegment(segment, { isBold, wordWidthAt, markerBefore, headingLevelOf, centredContainer }, classe);
  const prose = (items: readonly PdfTextRun[]): IRBlock[] => {
    const split = bandedSplit(items, cut?.cut, cut?.above);
    if (split === undefined) {
      const lines = groupItemsIntoLines(items);
      return declaredRank === undefined
        ? asBlocks(lines)
        : segmentsInDeclaredOrder([lines], declaredRank).flatMap((segment) => asBlocks(segment));
    }
    // Two blocks side by side, not two runs of prose: stacked they lose that they are side by side, and as a table
    // they would lie about what they are (Matterhorn 15-004).
    // Size decides headings inside a side-by-side block too. Tried then dropped: no heading there, on the view that
    // two bands at the top of a page are a letterhead whose sizes mark fields.
    const side = [asBlocks(split.left), asBlocks(split.right)].filter((cell) => cell.length > 0);
    return [
      ...asBlocks(split.above),
      ...(side.length > 1 ? [{ kind: "columns" as const, cells: side }] : side.flat()),
      ...asBlocks(split.below),
    ];
  };

  const inRenderedTable = new Set(rendered.map((r) => r.index));
  const outsideTables = placeImages(imageCandidates.filter((_, k) => !inRenderedTable.has(claimedBy[k]!)));
  return interleaveRegions(
    pageItems,
    [
      ...rendered.map((r) => ({
        top: r.top,
        bottom: r.bottom,
        // A table is ordered by its real left edge, so that what shares its band reads left to right.
        xMin: r.xMin,
        blocks: r.blocks,
        consumesBand: true,
        // The box stays full width: without it the table would attract no line and a neighbouring image would take
        // them all. Where the table is ordered and which lines belong to it are two questions.
        // Limit, a chosen abstention: the order is right, the pairing is not. A frame of labels between two images
        // does not say which label goes with which image; pairing them would merge a 1×1 grid and two image regions
        // into one table, a new structure calibrated on one case.
        box: { top: r.top, bottom: r.bottom, xMin: Number.NEGATIVE_INFINITY, xMax: Number.POSITIVE_INFINITY },
      })),
      ...outsideTables.map(imageRegion),
    ],
    prose,
  );
}
