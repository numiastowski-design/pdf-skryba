/** The ordered list of stages a PDF page goes through, and the three stages
 *  themselves: the first one that claims the page decides it.
 *  NOT here: what holds for the WHOLE document — furniture, heading scale,
 *  gutter, signals (`extractor/pdf.ts`, `extractor/pdf-document-scale.ts`) —
 *  nor any geometry decision, which each have their own file
 *  (`extractor/pdf-*.ts`, `layout/*.ts`).
 *  Called by: `extractor/pdf.ts`. */

/**
 * THE PDF PIPELINE, WRITTEN DOWN (20/09/2026, refactoring lot 5d).
 *
 * The order the stages run in used to exist only as the shape of one long
 * loop in `pdf.ts`: three `continue`s and a fallthrough. Reading it meant
 * replaying it. It is a LIST here, and the rule it obeys is one sentence:
 *
 *   **the first stage that claims the page decides it, and the last one never
 *   abstains.**
 *
 * A stage answers what it sees (`PageOutcome`) or abstains (`undefined`) —
 * the same answer shape the single-answer detectors of `layout/` give
 * (MIKSUDOC « Spécification technique » §5.4.1, which also names the two shapes that deliberately
 * differ). Adding a rule later is adding a stage to `PAGE_STAGES`, at the
 * position where it should get its say; it is never a new branch inside
 * another stage.
 *
 * ⚠️ THE ORDER IS THE BEHAVIOUR, not a presentation choice. Two pairs cannot
 * be swapped:
 *  - `scannedPage` before everything: a page with no readable text has no
 *    geometry to lay out; it only reads its pictures (none on a scan: its
 *    operators are never named);
 *  - `tablePage` before `flowingPage`: the flowing stage is the FALLBACK a
 *    refused table lands on (§8, « violation → repli texte plat »), so it can
 *    only run once the table stage has given up.
 *
 * TWO ACCUMULATORS CROSS THE STAGES, and they are passed explicitly rather
 * than reached for: the cost counter and the image store, both built per
 * extraction in `pdf.ts` and both reachable only through `PageContext`. A
 * stage otherwise reads its context and returns its answer.
 */

import type { IRBlock } from "doc-ir/lib/ir";
import type { MergeMap, TableGrid } from "doc-ir/layout/geometry";
import type { HeadingLevel } from "doc-ir/layout/heading-sizes";
import type { GlyphFragment } from "./glyph-positions";
import type { ColumnCut } from "./pdf-column-cut";
import type { GridBand } from "./pdf-document-scale";
import type { FramedBlocks } from "./pdf-framed-blocks";
import { placeImages, readPageWithImages, type BandLayout } from "./pdf-image-anchors";
import type { ContainerBox } from "./pdf-line-breaks";
import type { ImageCandidate, Line, PositionedItem } from "./pdf-model";
import type { PagePlanReader } from "./pdf-page-plan";
import { renderPageTables } from "./pdf-page-tables";
import type { PageMarkers } from "./pdf-page-markers";
import { asidePictureReader, paragraphsFromSegment } from "./pdf-paragraphs";
import type { PdfTextRun } from "./pdf-source";

/** What the two LAST stages need and the first two never look at: the colour
 *  fills, the figures and the column cut of one page. Built on first use —
 *  see `PageContext.layout`. */
export interface PageLayout extends PageMarkers {
  /** Exact width of the first word at an ordinate — abstains with 0. */
  wordWidthAt: (y: number, left?: number) => number;
  /** The width of the container two lines share, for the centred-pair rule
   *  (`pdf-line-breaks.ts#centredContainerReader`). */
  centredContainer: (line: Line, next: Line, segment: readonly Line[]) => number | undefined;
  /** The page's large images, not read yet. */
  imageCandidates: readonly ImageCandidate[];
  /** Keeps for publication the images of the blocks that were KEPT. */
  placeDocumentImages: (blocks: readonly IRBlock[]) => void;
  /** Where this page's columns are cut, if anywhere. */
  cut: ColumnCut | undefined;
  /** 🔴 THE PAGE'S PLAN, built once here and asked for every reading of this page
   *  (`extractor/pdf-page-plan.ts`): it holds the cuts above, and records the slices the page is read in. */
  planner: PagePlanReader;
  /** The closed rectangles drawn on the page (`pdf-table-detector.ts#boxesByPage`): the candidate frames of the boxed
   *  blocks of a column (`pdf-framed-blocks.ts`, 06/11/2026). */
  frames: readonly ContainerBox[];
}

/** What every stage reads. Built once per page by `pdf.ts`. */
export interface PageContext {
  pageIndex: number;
  /** The items as the reader gives them, running headers and footers INCLUDED. */
  rawItems: readonly PdfTextRun[];
  /** ⚠️ THE SAME ITEMS AS `rawItems`, furniture INCLUDED — what a stage lays out (corrected 04/11/2026: this
   *  comment claimed the furniture was removed here, and `pdf.ts` passes `rawItems` unchanged). A running header or
   *  footer IS published; the furniture detection only keeps it out of the document-wide MEASURES (heading sizes,
   *  column cut, body text area), see `pdf-document-scale.ts`. The two fields are kept apart so that a stage that
   *  one day needs the furniture-free view can ask for it without changing every caller. */
  items: readonly PdfTextRun[];
  /**
   * Whether the page carries readable text, computed once by `readPdfSource` on the raw runs. Respacing and link marking
   * change neither a run's non-blank characters nor the line-grouping geometry, so it equals
   * `hasReadableText(linesFromItems(rawItems))`.
   */
  hasText: boolean;
  glyphs: readonly GlyphFragment[];
  isBold: (item: PositionedItem) => boolean;
  /** The vertical reach of the grids DETECTED on this page — rendered or not. */
  bands: readonly GridBand[];
  /** How the boxed blocks of a column come out (`pdf-framed-blocks.ts`): flat by default, the two variants in option (06/11/2026). */
  framed: FramedBlocks;
  /** What a band of N ≥ 2 columns becomes (`pdf-image-anchors.ts#DEFAULT_BAND_LAYOUT`): one table of one row × N
   *  cells, or one row per rank of numbered item (`item-cells`, the default). */
  bandLayout: BandLayout;
  /** The tabular regions detected on this page, if any. */
  regions: readonly { grid: TableGrid; merge?: MergeMap }[] | undefined;
  /** The heading level of a size, decided for this PAGE on its own sizes (`pdf-document-scale.ts#scaleOfPage`, 05/11/2026). */
  headingLevelOf: (size: number) => HeadingLevel | undefined;
  /** Smaller than the page's body: the paragraph is « Small text ». */
  isSmallSize: (size: number) => boolean;
        /** The rank the DOCUMENT ITSELF gives a text cycle in its reading order,
   *  when this page is tagged and its tree accounts for all of its text
   *  (`pdf-reading-order.ts`). Absent on every other page — which is most of
   *  them — and the order is then purely geometric. Only `flowingPage` reads
   *  it: a page the table stage claims keeps `renderPageTables`'s own region
   *  interleaving. */
  declaredRank?: ((item: PdfTextRun) => number | undefined) | undefined;
  /** ⚠️ MEMOISED BY THE CALLER, and that is not an optimisation: building it
   *  twice would open the page's images twice and count them twice. */
  layout: () => PageLayout;
}

/** What a stage saw. The two flags are the page's SIDE outputs — the caller
 *  collects them into the result's index lists. */
export interface PageOutcome {
  blocks: IRBlock[];
  /** Nothing readable was extracted: `pdf-scanned.ts` may OCR this page. */
  scanned?: boolean;
  /** The texts this page's rendered tables removed ON PURPOSE (collapsed
   *  paintings of one mark), for the text-conservation check. In memory only:
   *  it is the document's own text. */
  deliberateRemovals?: string[];
  /** Set by `tablePage` ONLY, when it answers: the top/bottom (y up) of the tables it RENDERED, the bands its interleaving consumes. The page's
   *  prose follows the geometry, so the letters control (`pipeline/letter-conservation.ts`) judges the order of the prose outside these bands
   *  only. Its presence marks a page laid out by the table stage. */
  tableBands?: { top: number; bottom: number }[];
}

/** A stage answers what it sees on the page, or abstains and lets the next
 *  one look. */
interface PageStage {
  name: string;
  run: (page: PageContext) => PageOutcome | undefined;
}

/** A page with no extractable text at all. Its index is reported, so `pdf-scanned.ts` can OCR it (a scan, or the AI on).
 *  Its PICTURES are published (07/10/2026, Mikolaj's rule of 05/10: a cover or a diagram in a document with text is no
 *  scan and is published as it is): the same figures as on a page with text, in reading order, with no prose between
 *  them. On a scan the page has no candidate at all (its operators are not named, `pdf-open.ts`), so this stays free. */
const scannedPage: PageStage = {
  name: "scanned-page",
  run: (page) => {
    if (page.hasText) return undefined;
    const laid = page.layout();
    const imageAnchors = placeImages(laid.imageCandidates);
    laid.placeDocumentImages(imageAnchors.flatMap((a) => a.blocks));
    return { blocks: readPageWithImages([], imageAnchors, laid.planner, { layout: "flow" }, () => []), scanned: true };
  },
};

// NO STAGE FOR AN INVISIBLE OCR LAYER, AND NO PUBLICATION OF IT EITHER (Mikolaj, 02/10/2026, then 05/10/2026). A page whose text
// is hidden under a full-page scan has no stage of its own here, and its hidden text is no longer a fallback. Since 05/10 one such
// page makes the WHOLE PDF a scan (`pdf.ts` `ocrLayerPageIndices`, `pdf-scanned.ts`): the layer is not published as it stands. The
// 02/10 version of this comment said the stale layer ("12 OOO" under a scan of "42 000") was published; that is no longer true.
// A page with no text at all is a scan too (`scannedPage`).

/**
 * A page carrying one or more grids, laid out in full — its tables, the prose
 * between them, and the images that fall outside them.
 *
 * ⚠️ IT ABSTAINS TWICE, and the second one matters: no region at all, and a
 * region whose conservation invariant does not hold (`renderPageTables`
 * returns nothing). Both land on `flowingPage`, which is the written fallback
 * — flat text, never a silent one.
 */
const tablePage: PageStage = {
  name: "table-page",
  run: (page) => {
    const { regions } = page;
    if (regions === undefined || regions.length === 0) return undefined;
    const laid = page.layout();
    // A BOUNDED cut only: a page with a grid is read on the cut that holds
    // ABOVE that grid, never on an unbounded one.
    const boundedCut = laid.cut?.above === undefined ? undefined : { cut: laid.cut.cut, above: laid.cut.above };
    const deliberateRemovals: string[] = [];
    let tableBands: { top: number; bottom: number }[] = [];
    const rendered = renderPageTables(
      page.items,
      regions,
      page.glyphs,
      page.isBold,
      laid.wordWidthAt,
      boundedCut,
      laid.markerBefore,
      page.headingLevelOf,
      laid.imageCandidates,
      laid.centredContainer,
      (text) => deliberateRemovals.push(text),
      page.bands,
      (bands) => {
        tableBands = bands;
      },
      page.declaredRank,
    );
    if (!rendered) return undefined;
    laid.placeDocumentImages(rendered);
    return { blocks: rendered, tableBands, ...(deliberateRemovals.length > 0 ? { deliberateRemovals } : {}) };
  },
};

/**
 * THE STAGE THAT CLOSES THE LIST: whatever no stage above claimed is read as
 * flowing text — images first, then the band reading inside each vertical
 * chunk, then paragraphs inside each band.
 *
 * A PAGE CAN BE A TABLE *AND* TWO BANDS, since 11/09/2026 — the comment this
 * one replaces claimed the opposite and was wrong. An UNBOUNDED cut only ever
 * comes out for pages no table stage kept; a BOUNDED one (`above`) also comes
 * out for a page with a grid, and holds only above that grid. With no cut,
 * `readingSegments` returns a single segment.
 *
 * Every anchor is kept here: there is no rendered table for an image to fall
 * into.
 */
const flowingPage: PageStage = {
  name: "flowing-page",
  run: (page) => {
    const laid = page.layout();
    const imageAnchors = placeImages(laid.imageCandidates);
    laid.placeDocumentImages(imageAnchors.flatMap((a) => a.blocks));
    return {
      blocks: readPageWithImages(
        page.items,
        imageAnchors,
        // LA PAGE SE LIT SUR TOUTES LES COUPES DU DOCUMENT, pas sur la seule dominante (04/11/2026) : une page à
        // quatre colonnes en porte trois, et `cut.cut` seule la laissait tressée deux colonnes par deux. Depuis le
        // 13/11 c'est le PLAN qui les porte, et qui rend chaque lecture de la page.
        laid.planner,
        { layout: page.bandLayout, framed: page.framed, frames: laid.frames },
        (segment) =>
          paragraphsFromSegment(segment, {
            isBold: page.isBold,
            wordWidthAt: laid.wordWidthAt,
            markerBefore: laid.markerBefore,
            headingLevelOf: page.headingLevelOf,
            isSmallSize: page.isSmallSize,
            centredContainer: laid.centredContainer,
            asidePicture: asidePictureReader(laid.imageCandidates),
          }),
        page.declaredRank,
      ),
    };
  },
};

/** THE ORDER, and it is what this file exists for. Adding a rule later is
 *  adding a stage here, at the place where it should get its say. */
export const PAGE_STAGES: readonly PageStage[] = [scannedPage, tablePage, flowingPage];

/**
 * Runs a page down the list and returns the first answer.
 *
 * The trailing call is NOT a second run of `flowingPage`: as long as it
 * closes `PAGE_STAGES` the loop returns before reaching it. It is there so
 * that taking it out of the list still lays the page out, instead of dropping
 * its content without a sound.
 */
export const layoutPage = (page: PageContext): PageOutcome => {
  for (const stage of PAGE_STAGES) {
    const outcome = stage.run(page);
    if (outcome !== undefined) return outcome;
  }
  return flowingPage.run(page) ?? { blocks: [] };
};
