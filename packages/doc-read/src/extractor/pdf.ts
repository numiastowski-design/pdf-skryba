/** The one wiring of the PDF path: read the document, decide what holds for
 *  the WHOLE document, then send each page down the stage list and merge the
 *  result, with the text source the conservation check reads (runs,
 *  deliberate removals).
 *  The layout is one tab per page: nothing is removed or joined between pages (furniture and tables are published as read).
 *  The furniture DETECTION removes nothing from a page: `pdf-document-scale.ts` only keeps the repeated furniture out of its document-wide measures (heading sizes, column cut, body text area).
 *  Takes a few small document-level decisions itself (the top of each page's text, bold from stroked glyphs, withholding
 *  oversized tables). NOT here: the ORDER of the page stages and what each one decides
 *  (`extractor/pdf-page-stages.ts`), the other decisions on the geometry —
 *  they each have their file, `extractor/pdf-*.ts` — nor the reads of the file
 *  (`extractor/pdf-source.ts`), nor OCR (`extractor/pdf-scanned.ts`).
 *  Called by: `extractor/pdf-scanned.ts` (which `extractor/dispatch.ts` reaches), and the measurement tools in `tools/`. */

/**
 * PDF extractor (MIKSUDOC « Spécification technique » §5.4) — digital text layer only, via our own reader
 * (`pdf-source.ts`, `pdf-objects/`). Pure: no I/O beyond
 * the bytes it's given.
 *
 * A page with no extractable text at all (a scanned page, or a fully
 * scanned document) contributes its pictures only (none on a WHOLE scan, whose
 * operators are not named, `pdf-open.ts`; a page without text in a document that
 * has text publishes its images, `pdf-page-stages.ts`) — its index is also reported in
 * `scannedPageIndices`. This extractor never calls
 * vision itself and never fails on an all-scanned document; `pdf-scanned.ts`
 * is the integration point that OCRs flagged pages (via `VisionPort`) and
 * merges the result in page order, using `pages` (not a pre-flattened
 * `IRDoc`) so a mixed digital/scanned PDF's page order survives the merge.
 * An empty result on its own is not `EXTRACT_FAILED`, matching every other
 * extractor's "empty document -> empty page announced, not a failure" rule —
 * an *unreadable* scan is a vision-layer failure (confidence, not extraction).
 */

import { withoutLeadingBandsDeep } from "doc-ir/lib/table-empty-parts";
import type { DocumentNotice, PageLanguage } from "doc-ir/lib/reader-types";
import type { PdfTableDetection } from "doc-ir/layout/geometry";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { IRBlock } from "doc-ir/lib/ir";
import { MAX_NOTICE_IMAGE_PLACES, type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import type { PictureRefusal } from "doc-ir/lib/reader-types";
import type { LostPlace } from "./pdf-model";
import { withholdOversizedTables } from "doc-ir/lib/table-width-cap";
import { gridBandOf } from "doc-ir/layout/grid-band";
import { emptyExtractionCost, count, type ExtractionCost } from "./extraction-cost";
import { openEmbeddedImages, type EmbeddedImageReader } from "./pdf-embedded-images";
import { positionKey } from "doc-ir/layout/geometry";

import type { PdfExtractResult, PositionedItem } from "./pdf-model";
import { openPdfSource, glyphReader, readPageSignals } from "./pdf-open";
import { describePdf } from "./pdf-facts";
import { scaleOfPage, decideDocumentScale, type ColumnEvidence, type DocumentScale } from "./pdf-document-scale";
import { createImageStore, type ImageStore } from "./pdf-image-store";
import { linesFromItems } from "./pdf-lines";
import { gatherRotatedLines } from "./pdf-rotated-lines";
import { hyphenationLanguageOf, joinCutParagraphs, resolveCutHyphens } from "doc-ir/layout/cut-word";
import { respaceLetterSpacedRuns } from "./pdf-letter-spacing";
import { linkTieOfPage } from "./pdf-links";
import type { PdfSource, PdfTextRun } from "./pdf-source";
import type { GlyphFragment } from "./glyph-positions";
import type { BlockImage, PageTableGrid, PdfPageSignals } from "./pdf-table-detector";
import { centredContainerReader, firstWordWidthReader, valueColumnStarts } from "./pdf-line-breaks";
import { pageMarkers } from "./pdf-page-markers";
import { pageFigures } from "./pdf-page-figures";
import { pagePlanReader, type PagePlan } from "./pdf-page-plan";
import { pageColumnCut } from "./pdf-column-cut";
import { declaredRanks } from "./pdf-reading-order";
import { layoutPage, type PageLayout } from "./pdf-page-stages";

/** The PDF path is read from `./pdf`: tests and neighbours already import these
 *  names from it, and each now lives in the file of the stage that decides it. */
export type { ImageAnchor, ImageCandidate, Line, PageRegion, PdfExtractResult, TextRun } from "./pdf-model";
export { isCentredPair, isDeliberateBreak, hangsFromMarker, startsNewItem } from "./pdf-line-breaks";
export { interleaveImages, placeImages, readPageWithImages } from "./pdf-image-anchors";
import { DEFAULT_BAND_LAYOUT, type BandLayout } from "./pdf-image-anchors";
import { DEFAULT_FRAMED_BLOCKS, type FramedBlocks } from "./pdf-framed-blocks";
export { interleaveRegions } from "./pdf-region-order";
export { PAGE_STAGES, layoutPage } from "./pdf-page-stages";


type ImageLoss = { slow: number; unreadable: number; places: readonly LostPlace[] };

/** ONE `pdf-image-unread` notice for the images lost on the pages kept as digital, or none. `replaced`: the pages
 *  whose digital blocks the AI's text replaced (a scan read by the AI): their images were never to be published, so
 *  their losses are not losses (review of 06/10/2026). */
export function pdfImageUnreadNotices(lossByPage: ReadonlyMap<number, ImageLoss>, replaced: ReadonlySet<number>): DocumentNotice[] | undefined {
  let slow = 0;
  let unreadable = 0;
  const places: { page: number; id: string; why: PictureRefusal }[] = [];
  for (const [pageIndex, loss] of lossByPage) {
    if (replaced.has(pageIndex)) continue;
    slow += loss.slow;
    unreadable += loss.unreadable;
    for (const place of loss.places) places.push({ page: pageIndex + 1, id: place.id, why: place.why });
  }
  // Page order, always: the map is keyed by page but filled in the order the pages were read, and a notice that moves
  // from one run to the next would be a difference with no cause (determinism).
  places.sort((left, right) => left.page - right.page);
  if (slow + unreadable === 0) return undefined;
  return [
    {
      kind: "pdf-image-unread",
      slow,
      unreadable,
      places: places.slice(0, MAX_NOTICE_IMAGE_PLACES),
      more: Math.max(0, places.length - MAX_NOTICE_IMAGE_PLACES),
    },
  ];
}

/** The runs of every page after the two enrichments that need glyphs, and the way back to the reader's own runs. */
interface EnrichedRuns {
  items: PdfTextRun[][];
  /** Leads from a copy (a letter-spaced run, a run carrying link spans) to the original run: the bold keys and the
   *  conservation check both read that one. */
  originalOf: Map<PositionedItem, PdfTextRun>;
}

/**
 * Letter-spaced runs take the glyphs' text before anything reads the runs
 * (`pdf-letter-spacing.ts`). The glyphs are read once per page, by the caller. `originalOf` leads back to the reader's own run: the bold
 * keys and the conservation check both read that one.
 * Then each run a link covers becomes a copy carrying its link spans (`pdf-links.ts`), led back to the reader's run too;
 * and each glyph of a linked word a copy carrying its `href`, which a table cell reads (`pdf-table-render.ts`).
 * `glyphsByPage` is updated in place with the linked glyphs.
 */
const enrichRuns = (source: PdfSource, readItems: readonly (readonly PdfTextRun[])[], glyphsByPage: GlyphFragment[][]): EnrichedRuns => {
  const originalOf = new Map<PositionedItem, PdfTextRun>();
  const items = readItems.map((runs, pageIndex) => {
    const glyphs = glyphsByPage[pageIndex]!;
    const respaced = respaceLetterSpacedRuns(runs, glyphs, (copy, source) => originalOf.set(copy, source));
    const { spansByRun: spans, hrefByGlyph } = linkTieOfPage(respaced, glyphs, source.pages[pageIndex]?.links ?? []);
    if (hrefByGlyph.size > 0)
      glyphsByPage[pageIndex] = glyphs.map((g) => {
        const href = hrefByGlyph.get(g);
        return href === undefined ? g : { ...g, href };
      });
    const linked =
      spans.size === 0
        ? respaced
        : respaced.map((run) => {
            const links = spans.get(run);
            if (links === undefined) return run;
            const copy = { ...run, links };
            originalOf.set(copy, originalOf.get(run) ?? run);
            return copy;
          });
    // A rotated line of several runs is one run, read along its own axis (`pdf-rotated-lines.ts`), led back to its first run.
    return gatherRotatedLines(linked, (copy, source) => originalOf.set(copy, originalOf.get(source) ?? source)) as PdfTextRun[];
  });
  return { items, originalOf };
};

/** What the second reading of the document signals (grids, cuts, bold, boxes...), indexed by page. */
interface DocumentSignals {
  signals: PdfPageSignals;
  gridByPage: Map<number, PageTableGrid>;
  cutByPage: Map<number, PdfPageSignals["columnCuts"][number]>;
  tableDetections: PdfTableDetection[];
}

const readSignals = async (bytes: Uint8Array, source: PdfSource, cost: ExtractionCost): Promise<DocumentSignals> => {
  const signals = await readPageSignals(bytes, source, cost);
  const gridByPage = new Map(signals.grids.map((g) => [g.pageIndex, g]));
  const cutByPage = new Map(signals.columnCuts.map((c) => [c.pageIndex, c]));
  const tableDetections: PdfTableDetection[] = signals.grids.map(({ pageIndex, origin }) => ({ pageIndex, origin }));
  return { signals, gridByPage, cutByPage, tableDetections };
};

/** The pictures of the document: the large ones of each page, the furniture among them, the store the kept ones go
 *  into, and which pages placed each kept one. */
interface DocumentImages {
  blockImagesAll: BlockImage[][];
  readEmbedded: EmbeddedImageReader | undefined;
  store: ReturnType<typeof createImageStore>;
  /** The store of one page: what it keeps is also noted in `pagesOfImage`. */
  storeForPage: (pageIndex: number) => ImageStore;
  /** Which pages placed each kept image (by sha256): `extractPdfWithVision` leaves out the images placed only on pages
   *  the AI's text replaced (07/10/2026). The markers we make (`collect`) are not here: a page with no text makes none. */
  pagesOfImage: Map<string, Set<number>>;
}

const prepareImages = async (
  document: PdfObjectsDocument,
  readItems: readonly (readonly PdfTextRun[])[],
  signals: PdfPageSignals,
  cost: ExtractionCost,
): Promise<DocumentImages> => {
  // THE LARGE IMAGES (15/09/2026). `pdf-lib` is opened only if there is one.
  const blockImagesAll = readItems.map((_, p) => signals.blockImagesByPage.get(p) ?? []);
  // A new capability does not make a document that used to publish fatal: if `pdf-lib`
  // refuses to open it, it comes out without its large images, as before this lot.
  let readEmbedded: EmbeddedImageReader | undefined;
  if (blockImagesAll.some((b) => b.length > 0)) {
    try {
      readEmbedded = await openEmbeddedImages(document);
      count(cost, "pdfLibOpens");
    } catch {
      readEmbedded = undefined;
    }
  }
  const store = createImageStore();
  const pagesOfImage = new Map<string, Set<number>>();
  const storeForPage = (pageIndex: number): ImageStore => ({
    ...store,
    keep: (image) => {
      store.keep(image);
      const pages = pagesOfImage.get(image.sha256);
      if (pages === undefined) pagesOfImage.set(image.sha256, new Set([pageIndex]));
      else pages.add(pageIndex);
    },
  });
  return { blockImagesAll, readEmbedded, store, storeForPage, pagesOfImage };
};

/**
 * THE READING ORDER THAT THE DOCUMENT DECLARES, page by page (23/09/2026).
 * The ranks are set on the runs of the BOUNDARY, and found again through
 * `sourceRun`: a re-spaced run is a COPY, and its copy is not in the
 * table. Nothing here invents a fallback — a page without a usable tree has
 * no rank, and its reading stays geometric.
 */
const declaredRankFor = (source: PdfSource, originalOf: ReadonlyMap<PositionedItem, PdfTextRun>) =>
  source.pages.map((page) => {
    const ranks = declaredRanks(page);
    if (ranks === undefined) return undefined;
    const byRun = new Map<PdfTextRun, number>();
    page.runs.forEach((run, index) => {
      const rank = ranks[index];
      if (rank !== undefined) byRun.set(run, rank);
    });
    return (item: PdfTextRun): number | undefined => byRun.get(originalOf.get(item) ?? item);
  });

/** Everything the page loop reads of the document, decided before the first page is laid out. */
interface DocumentRead {
  source: PdfSource;
  cost: ExtractionCost;
  items: PdfTextRun[][];
  glyphsByPage: GlyphFragment[][];
  sourceRun: <R extends PositionedItem>(run: R) => R | PdfTextRun;
  detected: DocumentSignals;
  /** The vertical reach of the detected grids, per page. */
  bandsByPage: ReturnType<typeof gridBandOf>[][];
  scale: DocumentScale;
  images: DocumentImages;
  declaredRankByPage: ReturnType<typeof declaredRankFor>;
  /** The boxed blocks of a column: flat (the product) or one of the two variants in option (`pdf-framed-blocks.ts`, 06/11/2026). */
  framed: FramedBlocks;
  /** What a band of N ≥ 2 columns becomes: one table of one row × N cells, or one row per rank of numbered
   *  item under the default `item-cells` (`pdf-image-anchors.ts#DEFAULT_BAND_LAYOUT`). */
  bandLayout: BandLayout;
}

/**
 * THE SECOND BOLD SIGNAL: FAKE BOLD, the kind a word processor makes
 * by STROKING the glyph as well as filling it, when the font family
 * has no weight. The font's name does not say it, nor does the
 * descriptor.
 *
 * THE EMPHASIS COMES FROM A SECOND READING, matched by position. The two
 * paths return exactly the same coordinates — that is the property
 * `positionKey` already relies on for the rerouting of rotated items.
 *
 * The matching of fake bold is the same as for named bold, except that it is on
 * the POSITION ALONE: an item carries the text of a whole run, a
 * glyph a single character, so their keys would never coincide if the
 * text were part of them. Measured 10/09/2026: the position of the first
 * glyph of a run and that of the item are identical to 0.00 pt.
 */
const boldTestOf = (
  boldKeys: ReadonlySet<string> | undefined,
  glyphs: readonly GlyphFragment[],
  sourceRun: DocumentRead["sourceRun"],
): ((item: PositionedItem) => boolean) => {
  const strokedAt = new Set(glyphs.filter((g) => g.stroked).map((g) => positionKey(g.x, g.y, "")));
  return (item) =>
    (boldKeys !== undefined && boldKeys.has(positionKey(item.x, item.y, sourceRun(item).text))) || strokedAt.has(positionKey(item.x, item.y, ""));
};

/**
 * What the stages ask for, built on the FIRST read and once. A page with no text builds it too, for its pictures
 * alone (07/10/2026): a scan's page has no candidate (`pdf-open.ts` names no operator of it), so it opens and counts
 * nothing. `lostImageCounts` receives, per page, how many placed images no reader could obtain (`pageFigures`).
 */
const pageLayoutReader = (
  doc: DocumentRead,
  pageIndex: number,
  pageItems: readonly PdfTextRun[],
  lostImageCounts: Map<number, () => ImageLoss>,
  /** Where this page's plan is left for whoever asked for it (`onPagePlan`); a page no stage lays out leaves none. */
  pagePlans: Map<number, PagePlan>,
): (() => PageLayout) => {
  const { source, cost, glyphsByPage, detected, scale, images } = doc;
  const { signals, cutByPage } = detected;
  let laid: PageLayout | undefined;
  return () => {
    if (laid !== undefined) return laid;
    const markers = pageMarkers(images.store, {
      items: pageItems,
      inlineImages: signals.inlineImagesByPage.get(pageIndex) ?? [],
    });
    const { candidates, place, lost } = pageFigures(images.storeForPage(pageIndex), cost, {
      source: source.pages[pageIndex],
      blockImages: images.blockImagesAll[pageIndex]!,
      readEmbedded: images.readEmbedded,
    });
    lostImageCounts.set(pageIndex, lost);
    // ⚠️ SANS COUPE DOMINANTE, LES N COUPES SONT ABANDONNÉES — et c'est un choix mesuré, pas un oubli (04/11/2026).
    //
    // `documentColumnCut` s'abstient sur toute page à PLUSIEURS gouttières : un document dont AUCUNE page n'a une
    // gouttière unique n'a donc pas de dominante, et ses coupes se perdent ici. On a essayé de retomber sur la
    // première des N coupes. Gain sur le corpus : 48 voisinages cassés de moins (sonde `broken_neighbours`, 100
    // documents). Coût, mesuré le même jour sur les fixtures : la 24 — un guide Word d'UNE SEULE COLONNE — reçoit
    // PLUSIEURS coupes rapprochées — cinq le 04/11 (216, 236, 257, 307, 368), QUATRE remesurées le 13/11 (216,0 /
    // 256,6 / 307,4 / 371,0) : le compte exact dérive avec le lecteur, l'argument ne dérive pas — et le livret 26 en reçoit une qui
    // lui coupe deux phrases en deux et lui ajoute cinq paragraphes. Un seuil ne sépare pas ces deux populations :
    // chaque coupe passe la garde de prose SUR SA PAGE ; ce qui manque est de savoir si l'ENSEMBLE des coupes
    // décrit une seule grille de colonnes — largeurs égales, pas régulier — ou une collection d'accidents de page.
    // Tant que ce signal n'existe pas, l'abstention est le biais choisi : laid et visible plutôt que faux et
    // invisible.
    const gutter = scale.gutterCut === undefined ? undefined : { cut: scale.gutterCut, all: scale.gutterCuts };
    const cut = pageColumnCut(pageItems, cutByPage.get(pageIndex), gutter);
    const boxes = (signals.boxesByPage.get(pageIndex) ?? []).map((c) => ({ left: c.xLeft, right: c.xRight, bottom: c.yBottom, top: c.yTop }));
    const planner = pagePlanReader(cut);
    pagePlans.set(pageIndex, planner.plan);
    laid = {
      ...markers,
      wordWidthAt: firstWordWidthReader(glyphsByPage[pageIndex]!),
      centredContainer: centredContainerReader(boxes, cut, scale.bodyTextArea, valueColumnStarts(linesFromItems(pageItems))),
      imageCandidates: planner.watchPictures(candidates),
      placeDocumentImages: place,
      cut,
      planner,
      frames: boxes,
    };
    return laid;
  };
};

interface LaidOutPages {
  pages: IRBlock[][];
  scannedPageIndices: number[];
  deliberateRemovals: string[];
  /** The same removals, kept by the page whose rendering made them. */
  deliberateRemovalsByPage: string[][];
  lostImageCounts: Map<number, () => ImageLoss>;
  /** 0-based page -> the bands of the tables the table stage rendered on it. */
  tableBandsByPage: Map<number, { top: number; bottom: number }[]>;
  /** 0-based page -> its page plan, for the pages a stage laid out. */
  pagePlans: Map<number, PagePlan>;
}

/**
 * THE PLAN LEAVES THIS MODULE ONLY WHEN SOMEONE ASKED FOR IT (13/11/2026). A plan holds the page's items, so
 * keeping every plan in the result would retain the whole document's runs after the extraction — a memory cost
 * production must not pay for a development tool. `tools/analyse.ts` passes the hook; the product never does.
 */
const reportPagePlans = (
  plans: ReadonlyMap<number, PagePlan>,
  onPagePlan: ((pageIndex: number, plan: PagePlan) => void) | undefined,
): void => {
  if (onPagePlan === undefined) return;
  for (const [pageIndex, plan] of [...plans].sort((a, b) => a[0] - b[0])) onPagePlan(pageIndex, plan);
};

/** Each page down the stage list (`pdf-page-stages.ts`), in page order. */
const layoutPages = (doc: DocumentRead): LaidOutPages => {
  const { items, glyphsByPage, sourceRun, detected, bandsByPage, scale, source, declaredRankByPage } = doc;
  const pages: IRBlock[][] = [];
  const scannedPageIndices: number[] = [];
  const deliberateRemovals: string[] = [];
  const deliberateRemovalsByPage: string[][] = [];
  const lostImageCounts = new Map<number, () => ImageLoss>();
  const tableBandsByPage = new Map<number, { top: number; bottom: number }[]>();
  const pagePlans = new Map<number, PagePlan>();
  for (const [pageIndex, rawItems] of items.entries()) {
    const pageItems = rawItems;
    const keptGlyphs = glyphsByPage[pageIndex]!;
    // The page's own body is never a heading on that page (`scaleOfPage`, 05/11/2026).
    const { headingLevelOf, isSmallSize } = scaleOfPage(rawItems, scale);
    const outcome = layoutPage({
      pageIndex,
      rawItems,
      items: pageItems,
      framed: doc.framed,
      bandLayout: doc.bandLayout,
      hasText: source.pages[pageIndex]!.hasText,
      glyphs: keptGlyphs,
      isBold: boldTestOf(detected.signals.boldByPage.get(pageIndex), keptGlyphs, sourceRun),
      bands: bandsByPage[pageIndex] ?? [],
      regions: detected.gridByPage.get(pageIndex)?.regions,
      headingLevelOf,
      isSmallSize,
      declaredRank: declaredRankByPage[pageIndex],
      layout: pageLayoutReader(doc, pageIndex, pageItems, lostImageCounts, pagePlans),
    });
    if (outcome.scanned) scannedPageIndices.push(pageIndex);
    // A PAGE THAT PUBLISHED NO TABLE IS NOT A TABLE-STAGE PAGE for the letters control: it has no band to cut out, so its order
    // is judged on the WHOLE page like any prose page (`pipeline/letter-conservation.ts#checkPage`, `bands === undefined`).
    // Since 26/10/2026 the table stage can run and publish only flat regions, which is exactly that case (an empty array here
    // sent the page to `orderNotJudgedPages`, where a real move hides).
    if (outcome.tableBands !== undefined && outcome.tableBands.length > 0) tableBandsByPage.set(pageIndex, outcome.tableBands);
    deliberateRemovals.push(...(outcome.deliberateRemovals ?? []));
    deliberateRemovalsByPage.push([...(outcome.deliberateRemovals ?? [])]);
    pages.push(outcome.blocks);
  }
  return { pages, scannedPageIndices, deliberateRemovals, deliberateRemovalsByPage, lostImageCounts, tableBandsByPage, pagePlans };
};

/** Per page, the images lost by either path (dropped by the detector, or unreadable once placed). */
const imageLossOf = (signals: PdfPageSignals, lostImageCounts: ReadonlyMap<number, () => ImageLoss>): Map<number, ImageLoss> => {
  const imageLossByPage = new Map<number, ImageLoss>();
  for (const pageIndex of new Set([...signals.droppedImagesByPage.keys(), ...lostImageCounts.keys()])) {
    const dropped = signals.droppedImagesByPage.get(pageIndex) ?? { slow: 0, unreadable: 0, places: [] };
    const lost = lostImageCounts.get(pageIndex)?.() ?? { slow: 0, unreadable: 0, places: [] };
    imageLossByPage.set(pageIndex, {
      slow: dropped.slow + lost.slow,
      unreadable: dropped.unreadable + lost.unreadable,
      places: [...dropped.places, ...lost.places],
    });
  }
  return imageLossByPage;
};

/** The tab layout cuts at the page: a header cut into lines folds into ONE row (render 113, `lib/table-empty-parts.ts`). */
const withBandsFallen = (pages: readonly (readonly IRBlock[])[]): IRBlock[][] => pages.map((blocks) => withoutLeadingBandsDeep(blocks));

/** The text cycles of every page for the letters control, the structure-tree order of the pages published in it (`declaredRanks`: the tree
 *  accounts for all the page's content text), the pages that rest on the cycles alone, and the pages the table stage laid out, with the bands of
 *  their rendered tables. A page laid by the table stage keeps its own interleaving: the control judges the order of its prose outside the bands. */
const letterReference = (source: PdfSource, tableBandsByPage: ReadonlyMap<number, readonly { top: number; bottom: number }[]>): PdfExtractResult["textSource"]["reference"] => {
  const structureOrderByPage = new Map<number, string[]>();
  source.pages.forEach((page, index) => {
    if (page.declaredOrder !== undefined && declaredRanks(page) !== undefined) structureOrderByPage.set(index, [...page.declaredOrder]);
  });
  return {
    pages: source.pages.map((page) => page.reference ?? []),
    ...(structureOrderByPage.size > 0 ? { structureOrderByPage } : {}),
    ...(tableBandsByPage.size > 0 ? { tableBandsByPage: new Map([...tableBandsByPage].map(([page, bands]) => [page, bands.map((b) => ({ ...b }))])) } : {}),
  };
};

/** The result of the extraction: the pages merged and published, the notices, and the text source the conservation check reads. */
const assembleResult = (doc: DocumentRead, laid: LaidOutPages, readItems: readonly (readonly PdfTextRun[])[], limits: ReaderLimits | undefined, pageLanguage: PageLanguage): PdfExtractResult => {
  const { source, cost, detected, images } = doc;
  const { signals, tableDetections } = detected;
  const { pages, scannedPageIndices, deliberateRemovals } = laid;
  // The pages whose text is INVISIBLE (an OCR layer under a full-page scan): one of them makes the whole PDF a scan since
  // 05/10/2026 (`pdf-scanned.ts`). A page that turned out to hold no readable text is a scan first.
  const scannedSet = new Set(scannedPageIndices);
  const ocrLayerPageIndices = signals.ocrLayerPages.filter((pageIndex) => !scannedSet.has(pageIndex));

  const publishedImages = images.store.images();
  const textRuns = readItems.map((pageRuns) =>
    pageRuns.map((run) => {
      const kept = { text: run.text, x: run.x, y: run.y, width: run.width, fontSize: run.fontSize, hasEOL: run.hasEOL };
      return kept;
    }),
  );
  // Les passes de titraille hors-taille (séries, plan du PDF, profondeur de numérotation) sont retirées le
  // 05/11/2026: « on se base sur la taille des textes », quitte à inventer des titres.
  // Tabs cut a table at the page, as printed: nothing is joined, nothing is dropped between pages.
  // The hyphens of words the paper cut, resolved against the whole document's vocabulary and the hyphenation
  // table of the DOCUMENT's language (`layout/cut-word.ts`, 05/11/2026; the document's language since 10/11/2026).
  // A word cut between two published paragraphs joins them first (`layout/cut-word.ts#joinCutParagraphs`, 10/11/2026).
  const fallen = withBandsFallen(pages).map((page) => joinCutParagraphs(page));
  const merged = resolveCutHyphens(fallen, hyphenationLanguageOf(fallen, pageLanguage));
  // `deliberateRemovalsByPage` is indexed like `merged`: it relies on no pass above changing the page count (they keep the split by page).
  const deliberateRemovalsByPage = laid.deliberateRemovalsByPage.map((removed) => [...removed]);
  const imageLossByPage = imageLossOf(signals, laid.lostImageCounts);
  const imageNotices = pdfImageUnreadNotices(imageLossByPage, new Set());
  // A table wider than MAX_TABLE_COLS or longer than MAX_TABLE_ROWS is not published, and said (one notice for the document).
  let tablesWithheld = 0;
  const published = merged.map((page, pageIndex) => {
    const { blocks, withheld } = withholdOversizedTables(page, (text) => {
      deliberateRemovals.push(text);
      deliberateRemovalsByPage[pageIndex]?.push(text);
    }, limits);
    tablesWithheld += withheld;
    return blocks;
  });
  const notices = [...(imageNotices ?? []), ...unpublishedPartNotices({ chartsWithheld: 0, imagesMissing: 0, tablesWithheld })];
  return {
    pages: published,
    ...(notices.length > 0 ? { notices } : {}),
    imageLossByPage,
    ...(publishedImages.length > 0 ? { images: publishedImages, pagesOfImage: images.pagesOfImage } : {}),
    scannedPageIndices,
    docFacts: describePdf(source, { scanned: scannedPageIndices, invisibleText: ocrLayerPageIndices }),
    ...(ocrLayerPageIndices.length > 0 ? { ocrLayerPageIndices } : {}),
    ...(tableDetections.length > 0 ? { tableDetections } : {}),
    cost,
    // ALL THE FURNITURE IS DECLARED TO THE TEXT CHECK, since none of it is
    // published any more (23/09/2026 — see `pdf-document-scale.ts`). Without this
    // declaration the check would call lost lines that are removed on purpose.
    textSource: {
      runs: textRuns,
      deliberateRemovals,
      deliberateRemovalsByPage,
      reference: letterReference(source, laid.tableBandsByPage),
    },
  };
};

// `pageLanguage` picks the hyphenation table only when the document's own language cannot be told
// (`layout/cut-word.ts#hyphenationLanguageOf`, 10/11/2026);
// it once labelled the link of a decoded QR code, and QR codes are no longer decoded (06/10/2026).
export const extractPdf = async (
  bytes: Uint8Array,
  pageLanguage: PageLanguage = "en",
  opts?: {
    pageLimit?: number;
    firstPages?: number;
    limits?: ReaderLimits | undefined;
    columns?: ColumnEvidence;
    framed?: FramedBlocks;
    bands?: BandLayout;
    /** Development hook: the plan of each page a stage laid out, in page order, once the document is read. */
    onPagePlan?: (pageIndex: number, plan: PagePlan) => void;
  },
): Promise<PdfExtractResult> => {
  // THE WORK COUNTER, created here and returned in the result — never a global
  // state: two concurrent extractions must not add up, and a module-level
  // counter would leak from one document to the next in production. See
  // `extraction-cost.ts` for what it catches and above all what it does not see.
  const cost = emptyExtractionCost();
  const { source, items: readItems } = await openPdfSource(bytes, cost, opts?.pageLimit ?? opts?.limits?.pageLimit, opts?.firstPages);
  const glyphsOfPage = glyphReader(source);
  const glyphsByPage = readItems.map((_, pageIndex) => glyphsOfPage(pageIndex));
  const { items, originalOf } = enrichRuns(source, readItems, glyphsByPage);
  const sourceRun: DocumentRead["sourceRun"] = (run) => originalOf.get(run) ?? run;
  const detected = await readSignals(bytes, source, cost);

  // THE VERTICAL REACH OF THE DETECTED GRIDS, measured once: the furniture
  // detection uses it never to take a table header for a page footer, the
  // heading detection to exclude the sizes of a table, and the rendering of
  // a page to know what is not prose.
  const bandsByPage = items.map((_, pageIndex) =>
    (detected.gridByPage.get(pageIndex)?.regions ?? []).map((region) => gridBandOf(region.grid)),
  );
  const scale = decideDocumentScale(
    items,
    bandsByPage,
    source.pages.map((page) => page.height),
    source.pages.map((page) => page.bottom ?? 0),
    { fillsByPage: detected.signals.filledByPage, evidence: opts?.columns ?? "gutter" },
  );
  const images = await prepareImages(source.document, readItems, detected.signals, cost);
  const declaredRankByPage = declaredRankFor(source, originalOf);

  const doc: DocumentRead = {
    source,
    cost,
    items,
    glyphsByPage,
    sourceRun,
    detected,
    bandsByPage,
    scale,
    images,
    declaredRankByPage,
    framed: opts?.framed ?? DEFAULT_FRAMED_BLOCKS,
    bandLayout: opts?.bands ?? DEFAULT_BAND_LAYOUT,
  };
  const laid = layoutPages(doc);
  reportPagePlans(laid.pagePlans, opts?.onPagePlan);
  return assembleResult(doc, laid, readItems, opts?.limits, pageLanguage);
};
