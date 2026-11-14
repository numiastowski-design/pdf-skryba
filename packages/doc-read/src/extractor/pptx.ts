/** A .pptx turned into an IR document: ONE tabs block, one tab per VISIBLE
 *  slide (Mikolaj 25/09/2026, a slide is a native Confluence tab). A tab is
 *  labelled "N. <declared title>", or "Slide N" when the slide declares none;
 *  it opens with the declared title as a heading, unless the previous slide
 *  had the same one, then the slide's body in the form its boxes give: a
 *  FLOW, a TABLE (several columns), or a DIAGRAM (arrows: our drawing of the
 *  slide; its text, in flow order, goes to the deck's ONE `diagramText` block
 *  after the tabs, under « Slide N », not published). Each tab and each such section carries the slide's `slideNumber`: the renderer writes the
 *  label in the page's language (the document's), `title`/`label` being the fallback text. No slide cap for presentations
 *  (decision (3) of 25/09/2026). A slide over the per-slide element cap
 *  carries no tab at all (A7). What the app itself would once have added TO
 *  a page — an unconverted element, a picture its own drawing leaves out, a
 *  withheld slide, the tab cap — is `PptxExtractResult.notices` instead,
 *  never a paragraph on the page (lot A, docs/CONCEPTION-CARTE-ET-REMARQUES.md,
 *  29/09/2026).
 *  Also orchestrates a Google Slides deck (exported as .pptx by the caller) and folds the notices into the result.
 *  NOT here: reading the file (`extractor/pptx-reader/`), the form of a slide
 *  (`layout/slide-layout.ts`), the drawing (`extractor/slide-svg.ts`), how
 *  the tabs are written (`renderer/storage.ts#renderTabs`), nor how a notice
 *  is shown (`lib/reader-types.ts#DocumentNotice`, `UnpublishedPartsDialog.tsx`).
 *  Called by: `extractor/dispatch.ts` — a Google Slides deck too, exported
 *  as .pptx by the caller. */


import { collapseBlanks } from "doc-ir/lib/blanks";
import { DIAGRAM_TEXT_SEPARATOR, diagramParagraphs, emptyTabBlocks, joinedInlines, type DiagramRelation, type DiagramTextSection, type Inline, type IRBlock, type IRDoc, type IRTab } from "doc-ir/lib/ir";
import { mapBlockChildren } from "doc-ir/lib/ir-walk";
import { withholdOversizedTables } from "doc-ir/lib/table-width-cap";
import type { DocumentNotice } from "doc-ir/lib/reader-types";
import { nestLists } from "../lib/nest-lists";
import type { Size } from "doc-ir/layout/slide-elements";
import { layoutSlide, type SlideElement, type SlideLayout, type SlideLayoutInput } from "doc-ir/layout/slide-layout";
import type { RawImage } from "doc-ir/extractor/raw-image";
import { NO_CAP, type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import type { PageLanguage } from "doc-ir/lib/reader-types";
import { type PageLabelOverride, resolveLabels } from "doc-ir/lib/page-labels";
import {
  type PptxGraphicShape,
  type PptxParagraph,
  type PptxReadResult,
  type PptxShape,
  type PptxSlide,
  type PptxTable,
  readPptx,
} from "./pptx-reader";
import { chartToIr } from "./pptx-reader/chart";
import { renderSlideSvg } from "./slide-svg";
import { undrawnWords } from "./smartart-drawing";
import { slideDiagramOrder } from "./pptx-diagram-order";
import { imagePixelWidth } from "doc-ir/extractor/image-pixel-width";
import { ImageCollector } from "./image-collector";
import type { Clock } from "../lib/clock";
import type { SlideImagePort, SlidePage } from "../lib/slide-image-port";
import { spanSingleFirstRows } from "./span-single-first";

export interface PptxExtractResult {
  doc: IRDoc;
  images: RawImage[];
  /** Class-1 remarks (docs/CONCEPTION-CARTE-ET-REMARQUES.md lot A,
   *  29/09/2026): every fact that used to be a marker line ON the page —
   *  now dashboard-only. See `lib/reader-types.ts#DocumentNotice`. */
  notices: DocumentNotice[];
  /** The tables the LAYOUT builds (a slide of form "table", `layout/slide-layout.ts`) and the page keeps, one number per published tab, in tab
   *  order. The one fact of the structure control that comes from the extractor and not from a second reading: an addition of the page, declared
   *  by the one who adds it (`pipeline/structure-conservation.ts`). */
  layoutTables: number[];
}

const SVG_MIME = "image/svg+xml";
const PNG_MIME = "image/png";

const visible = (p: PptxParagraph): boolean => p.runs.some((r) => r.text.trim() !== "");

/** The three reserved footer zones of a slide (footer, date, slide number). They take no part in the layout: a small
 *  box in a corner would turn a one-column slide into a table. Their text is published after everything else. */
const FOOTER_PLACEHOLDERS: ReadonlySet<string> = new Set(["ftr", "dt", "sldNum"]);
const isFooterShape = (shape: PptxShape): boolean =>
  shape.kind === "text" && shape.placeholder?.type !== undefined && FOOTER_PLACEHOLDERS.has(shape.placeholder.type);

/** What a slide gives the layout: every shape that publishes something is an
 *  element (a text shape with a visible character, a table, a chart or other
 *  frame, a picture); a text shape with none is only drawn; connectors are
 *  counted. The title shape is already out of `slide.shapes`. */
export const slideLayoutInput = (slide: PptxSlide, size: Size): SlideLayoutInput<PptxShape> => {
  const elements: SlideElement<PptxShape>[] = [];
  const drawnGeometries: (string | undefined)[] = [];
  let connectors = 0;
  for (const shape of slide.shapes.filter((s) => !isFooterShape(s))) {
    if (shape.kind === "connector") {
      connectors++;
      continue;
    }
    const geometry = shape.kind === "text" ? shape.geometry : undefined;
    if (shape.kind === "text" && !shape.paragraphs.some(visible)) {
      drawnGeometries.push(geometry);
      continue;
    }
    elements.push({
      item: shape,
      ...(shape.box ? { box: shape.box } : {}),
      picture: shape.kind === "picture",
      spTreeIndex: shape.spTreeIndex,
      ...(shape.group === undefined ? {} : { group: shape.group }),
      ...(geometry === undefined ? {} : { geometry }),
    });
  }
  return { slide: size, elements, drawnGeometries, connectors };
};

// A chart/SmartArt/embedded-object/other frame this app cannot convert, and
// a picture this app cannot publish, used to be a visible marker on the
// slide (04/09/2026 fidelity audit) — now a dashboard-only fact
// (`DocumentNotice` `unsupported-element`, lot A of
// docs/CONCEPTION-CARTE-ET-REMARQUES.md, 29/09/2026): the element
// contributes NOTHING to the page, the notice (pushed in `shapeBlocks` and
// `diagramPieces` below) says which slide and what kind — `shape.graphic`
// and `shape.notPublished` are already the technical codes the notice
// carries, so no wording lives here any more. Likewise a picture a
// diagram's own SVG drawing leaves out used to print a visible line
// (`notDrawnLine`) — now `DocumentNotice` `picture-not-drawn`, pushed where
// `renderSlideSvg`'s `picturesNotDrawn` is read, in `slideBody` below.

const inlinesOf = (p: PptxParagraph): Inline[] =>
  p.runs.map((r) => ({
    text: r.text,
    ...(r.marks === undefined ? {} : { marks: r.marks }),
    ...(r.href === undefined ? {} : { href: r.href }),
  }));

/** A shape's (or a cell's) paragraphs as blocks. A paragraph without a
 *  visible character is not published and does not end a list. Consecutive
 *  bulleted paragraphs become nested lists: a deeper level opens a list in
 *  the previous item, a shallower one returns to its level, a switch between
 *  numbered and bulleted at the same level starts a new list; a paragraph
 *  without a bullet ends them. `start` is the first item's `startAt`. */
const paragraphBlocks = (paragraphs: readonly PptxParagraph[]): IRBlock[] =>
  nestLists(
    paragraphs.map((p) => ({
      blocks: visible(p) ? [{ kind: "paragraph" as const, inlines: inlinesOf(p) }] : [],
      ...(p.list ? { list: { level: p.list.level, ordered: p.list.ordered, ...(p.list.start === undefined ? {} : { start: p.list.start }) } } : {}),
    })),
    // An empty paragraph is skipped and does not end a list (not verified against an official PowerPoint source).
    { emptyItem: "skip" },
  );

/** An `a:tbl` as an IR table, rows as read. A row whose every cell is
 *  absorbed by the spans above stays empty here: the renderer drops it and
 *  shrinks the rowspans crossing it (`renderer/storage.ts#withoutEmptyRows`). */
const tableBlock = (table: PptxTable): Extract<IRBlock, { kind: "table" }> => {
  const rows = table.rows.map((row) => ({
    cells: row.cells.map((cell) => ({
      blocks: paragraphBlocks(cell.paragraphs),
      ...(cell.colspan === undefined ? {} : { colspan: cell.colspan }),
      ...(cell.rowspan !== undefined && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
      ...(cell.header ? { header: true } : {}),
    })),
  }));
  const widths = table.columnWidths;
  // WRITTEN BIAS: unlike Excel, PowerPoint does NOT visually overflow a row whose only text is in its first cell; the full-width cell is a
  // chosen embellishment, not a fidelity (Mikolaj, 27/10/2026: « et quoi que ce soit »). Header cells are marked above.
  return spanSingleFirstRows({
    kind: "table",
    rows,
    ...(widths.length > 0 && widths.every((w) => w > 0) ? { columnWidths: widths } : {}),
  });
};

// `ImageCollector` lived here until the lot tableurs (step 0, 28/09/2026):
// the xlsx reader anchors images too, so it moved to `image-collector.ts`.

/** One element of a slide as blocks. A picture's width is the one it has on
 *  the slide (the page caps it: `renderer/storage.ts#publishedImageWidthPx`);
 *  it has no alt text, ever (decision (10) of 25/09/2026). */
const shapeBlocks = (shape: PptxShape, images: ImageCollector, slideNumber: number, notices: DocumentNotice[], deck?: PptxReadResult): IRBlock[] => {
  switch (shape.kind) {
    case "text":
      return paragraphBlocks(shape.paragraphs);
    case "table":
      return [tableBlock(shape.table)];
    case "picture": {
      if (!("image" in shape)) {
        notices.push({ kind: "unsupported-element", slide: slideNumber, what: shape.notPublished, outcome: "published", count: 1 });
        return [];
      }
      const ref = images.collect(shape.image.bytes, shape.image.contentType);
      // The reduced file's width when `collect` reduced it, else the file's own.
      const pixelWidth = ref.pixelWidth ?? shape.image.pixelWidth;
      return [
        {
          kind: "image",
          ref: {
            ...ref,
            ...(shape.widthPt === undefined ? {} : { widthPt: shape.widthPt }),
            ...(pixelWidth === undefined ? {} : { pixelWidth }),
          },
        },
      ];
    }
    case "graphic": {
      // The chart keeps its own picture as a fallback.
      const { block, withheld } = chartToIr(shape.chart, { collectImage: (image) => images.collect(image.bytes, image.contentType) });
      if (!block) {
        // A chart kept out says so (one `chart-withheld` notice, folded); one with no series says nothing, like docx and xlsx.
        if (shape.graphic === "chart") {
          if (withheld) notices.push({ kind: "chart-withheld", count: 1 });
          return [];
        }
        notices.push({ kind: "unsupported-element", slide: slideNumber, what: shape.graphic, outcome: "converted", count: 1 });
        return smartArtBlocks(shape, images, deck);
      }
      return [block];
    }
    case "connector":
      return [];
  }
};


/** The shapes of a slide with each SmartArt's saved drawing (`PptxGraphicShape#drawing`) added right after its frame, so the slide's
 *  ONE picture paints them where the frame stands. They are not in `slide.shapes`: they take no part in the layout and are no element of
 *  the slide (its element count, `spTreeIndex`, never move). */
const withDrawings = (shapes: readonly PptxShape[]): PptxShape[] =>
  shapes.flatMap((s) => (s.kind === "graphic" && typeof s.drawing === "object" ? [s, ...s.drawing.shapes] : [s]));

/** A SmartArt frame of a flow or table slide: its saved drawing as a picture of its own then its
 *  words in the diagram text the control reads (not published), with the ones the picture does not carry (`undrawn`). Without a
 *  drawing to draw, only the words (no picture is invented). */
const smartArtBlocks = (shape: PptxGraphicShape, images: ImageCollector, deck: PptxReadResult | undefined): IRBlock[] => {
  const drawn = typeof shape.drawing === "object" && deck?.slideSize !== undefined ? renderSlideSvg(shape.drawing.shapes, deck.slideSize, deck.defaultTextSizes ?? {}) : undefined;
  const picture: IRBlock[] = [];
  if (drawn !== undefined) {
    picture.push({ kind: "image", ref: images.collect(new TextEncoder().encode(drawn.svg), SVG_MIME, true) });
  }
  if (shape.words === undefined) return picture;
  const undrawn = undrawnWords(shape.words, drawn?.smartArtText ?? []);
  const inlines = joinedInlines(shape.words.map((w) => [{ text: w }]), DIAGRAM_TEXT_SEPARATOR);
  return [...picture, { kind: "diagramText", sections: [{ inlines, ...(undrawn.length > 0 ? { undrawn } : {}) }] }];
};

/** Paragraphs as one line: a line break, in a paragraph or between two, is a
 *  space. Marks and links kept. */
const oneLine = (paragraphs: readonly PptxParagraph[]): Inline[] =>
  joinedInlines(
    paragraphs.filter(visible).map((p) => inlinesOf(p).map((i) => ({ ...i, text: i.text.replace(/\n/g, " ") }))),
    " ",
  );

/** One element's text for a diagram's paragraph, as pieces: a text shape is
 *  one piece, a table one per cell, a chart its title then one per data
 *  label or value. A picture gives nothing: drawn, it is inside the drawing,
 *  never repeated below it (decision (5 ter)); left out, it is a
 *  `picture-not-drawn` notice pushed where `slideBody` reads
 *  `picturesNotDrawn`, never inside this collapsed text (Mikolaj,
 *  25/09/2026). A frame we cannot convert contributes nothing here either —
 *  an `unsupported-element` notice instead of its former marker (lot A of
 *  docs/CONCEPTION-CARTE-ET-REMARQUES.md, 29/09/2026). */
const diagramPieces = (shape: PptxShape, slideNumber: number, notices: DocumentNotice[]): Inline[][] => {
  switch (shape.kind) {
    case "text":
      return [oneLine(shape.paragraphs)];
    case "table":
      return shape.table.rows.flatMap((row) => row.cells.map((cell) => oneLine(cell.paragraphs)));
    case "picture":
      return [];
    case "graphic": {
      const chart = shape.chart === "withheld" ? undefined : shape.chart;
      if (!chart) {
        if (shape.graphic === "chart") {
          if (shape.chart === "withheld") notices.push({ kind: "chart-withheld", count: 1 });
          return [];
        }
        notices.push({ kind: "unsupported-element", slide: slideNumber, what: shape.graphic, outcome: "converted", count: 1 });
        return (shape.words ?? []).map((w) => [{ text: w }]);
      }
      const labels = [chart.title ?? "", ...(chart.data.headers ?? []), ...chart.data.rows.flat()];
      return labels.map((t) => (t.trim() === "" ? [] : [{ text: t.replace(/\n/g, " ") }]));
    }
    case "connector":
      return [];
  }
};

/** A diagram slide's text, or nothing when none has text (no empty
 *  paragraph). Its elements come in the layout's flow order, ONE paragraph —
 *  unless the slide's connectors say a sensible order
 *  (`layout/diagram-graph.ts`, milestone 1 of the diagram text): then one paragraph per chain of
 *  relations (source, label, target), the elements without a relation in a
 *  last paragraph, each element's text once and no character added. A slide
 *  with no relation found keeps the single paragraph.
 *
 *  The arrows of a component that is not a tree (hubs, merges, cycles: the
 *  layered landscapes of real decks) are published too, one line per target
 *  with its sources, by the shapes' NAMES (`relationName`): the order stays
 *  today's, every word is already in the paragraphs, only a name is repeated
 *  (Mikolaj, 02/10/2026). */
const diagramText = (slide: PptxSlide, items: readonly PptxShape[], slideNumber: number, notices: DocumentNotice[], undrawn: readonly string[] = []): IRBlock[] => {
  // Each element read ONCE, in today's order: a notice is pushed per frame it cannot convert.
  const pieces = items.map((s) => diagramPieces(s, slideNumber, notices));
  const order = slideDiagramOrder(slide.shapes, items);
  const paragraphs = order.paragraphs.length === 0 ? [items.map((_, i) => i)] : [...order.paragraphs, order.rest];
  const lines = paragraphs.map((p) => joinedInlines(p.flatMap((i) => pieces[i] ?? []), DIAGRAM_TEXT_SEPARATOR)).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const relations = order.links.flatMap((l): DiagramRelation[] => {
    const target = relationName(items[l.target]!);
    const sources = [...new Set(l.sources.map((i) => relationName(items[i]!)).filter((n) => n !== ""))];
    return target === "" || sources.length === 0 ? [] : [{ target, sources }];
  });
  return [{ kind: "diagramText", sections: [{ ...sectionOf(lines, relations), ...(undrawn.length > 0 ? { undrawn: [...undrawn] } : {}) }] }];
};

/** Starting value to calibrate: the longest name a relation line repeats, in
 *  characters. A shape's name is its first line; a first line longer than
 *  this is cut at a word, so a whole paragraph is never published twice. */
const RELATION_NAME_MAX = 60;

/** A shape's name for a relation line: its first non-blank paragraph as plain
 *  text, cut at a word past `RELATION_NAME_MAX` (then closed by « … »). */
const relationName = (shape: PptxShape): string => {
  if (shape.kind !== "text") return "";
  const first = shape.paragraphs.filter(visible).map((p) => collapseBlanks(inlinesOf(p).map((i) => i.text).join(""))).find((t) => t !== "");
  if (first === undefined || first.length <= RELATION_NAME_MAX) return first ?? "";
  // eslint-disable-next-line sonarjs/super-linear-regex -- judged safe 14/10/2026: the input is cut to RELATION_NAME_MAX + 1 (61) characters
  const cut = first.slice(0, RELATION_NAME_MAX + 1).replace(/\s+\S*$/, "");
  return `${cut === "" ? first.slice(0, RELATION_NAME_MAX) : cut}…`;
};

/** Paragraphs as one section: their inlines run on, a break where each next one starts. */
const sectionOf = (lines: readonly Inline[][], relations: readonly DiagramRelation[] = []): DiagramTextSection => {
  const breaks = lines.slice(0, -1).reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 0) + l.length], []);
  return { inlines: lines.flat(), ...(breaks.length > 0 ? { breaks } : {}), ...(relations.length > 0 ? { relations: [...relations] } : {}) };
};

/** The sections of one slide as ONE: the old single paragraph joined by the
 *  separator, unless one of them has paragraphs — then each part (and each
 *  of its paragraphs) is a paragraph of its own. */
const mergedSections = (parts: readonly DiagramTextSection[]): DiagramTextSection => {
  const relations = parts.flatMap((p) => p.relations ?? []);
  const undrawn = parts.flatMap((p) => p.undrawn ?? []);
  const notDrawn = undrawn.length > 0 ? { undrawn } : {};
  if (parts.every((p) => p.breaks === undefined)) return { inlines: joinedInlines(parts.map((p) => p.inlines), DIAGRAM_TEXT_SEPARATOR), ...(relations.length > 0 ? { relations } : {}), ...notDrawn };
  const lines = parts.flatMap(diagramParagraphs);
  return { ...sectionOf(lines.filter((l) => l.length > 0), relations), ...notDrawn };
};

/** A Google Slides deck: where Google's own image of a diagram slide comes
 *  from (MIKSUDOC « Spécification fonctionnelle » §9.3.4). Absent for a stored .pptx.
 *  `modifiedTime`: the Drive file's, from the listing the export was made
 *  after. `clock`: the deck's time budget. */
export interface GoogleSlidesSource {
  presentationId: string;
  port: SlideImagePort;
  clock: Clock;
  modifiedTime: string;
}

/** Starting value to calibrate: past this time spent on Google's images of
 *  one deck, the diagram slides not yet asked keep our SVG. Each call is
 *  also bounded by the adapter's own timeout. Nothing measured; what matters
 *  is a bound well inside the 900 s invocation. */
const DECK_BUDGET_MS = 120_000;

/** Each slide's Google page id, by its position in `p:sldIdLst`, or
 *  `undefined` when the two lists do not agree.
 *
 *  MAPPING RULE, a decision: we take the export and `presentations.get` to
 *  list the same slides in the same order (what is known of it, and when,
 *  is in MIKSUDOC « Spécification fonctionnelle » §9.3.4). When the API lists exactly as many
 *  pages as `p:sldIdLst` (hidden slides counted on both sides), position i
 *  is page i. When it lists more, and its pages NOT skipped are exactly as
 *  many, the export left the skipped slides out and position i is the i-th
 *  page not skipped. Any other count: no slide gets Google's image (two
 *  readings that disagree, we abstain). A deck edited between the export
 *  and the images is caught by `googleDiagramImages`. */
export const pageIdsByListIndex = (listedSlideCount: number, pages: readonly SlidePage[]): readonly string[] | undefined => {
  if (pages.length === listedSlideCount) return pages.map((p) => p.objectId);
  const shown = pages.filter((p) => !p.skipped);
  if (shown.length === listedSlideCount) return shown.map((p) => p.objectId);
  return undefined;
};

/** A port call that throws counts as a refusal: the real adapter never
 *  throws, a double might. */
const orNothing = async <T>(call: () => Promise<T | undefined>): Promise<T | undefined> => {
  try {
    return await call();
  } catch {
    return undefined;
  }
};

/** Google's image of one slide, and what the content hash knows of it. */
interface GoogleImage {
  bytes: Uint8Array;
  pixelWidth: number;
  /** "google-thumbnail:<page id>:<modifiedTime>": the image's identity in
   *  the IR, in place of its bytes, which Google may render differently
   *  for the same revision.
   *
   *  Chosen bias, written (revue du 25/09/2026, constat 3): the FILE's
   *  `modifiedTime` is deck-wide, so any edit renames EVERY Google PNG —
   *  a full re-upload on the republish that edit triggers anyway — and a
   *  re-extraction whose `DECK_BUDGET_MS` runs out can flip a slide
   *  PNG↔SVG and move the content hash. A finer key does not exist: the
   *  Slides API has no per-slide revision. The whole path is INACTIVE
   *  today (`presentations.get` 403, API not enabled, project frozen until
   *  Google's validation), so nothing of Google's real rendering can be
   *  measured — re-decide the key when the API can be exercised, not
   *  before. */
  identity: string;
}

/** Google's PNG for each DIAGRAM slide of a Google Slides deck, by slide
 *  number. One `presentations.get` for the deck, one thumbnail per diagram
 *  slide, one after the other, then one `unchangedSince`; no call at all for a
 *  stored .pptx or a deck without a diagram slide. A slide whose image is
 *  refused, is not a PNG with a readable width, or is not asked because
 *  `DECK_BUDGET_MS` is spent, is absent: it keeps our drawing. When the
 *  file's `modifiedTime` after the images is not the one the export was
 *  made after (or cannot be read), the deck may have been edited, slides
 *  reordered, in between: every image is dropped. */
const googleDiagramImages = async (
  deck: PptxReadResult,
  layouts: readonly (SlideLayout<PptxShape> | undefined)[],
  google: GoogleSlidesSource | undefined,
): Promise<Map<number, GoogleImage>> => {
  const found = new Map<number, GoogleImage>();
  const diagrams = deck.slides.filter((_, i) => layouts[i]?.form === "diagram");
  if (google === undefined || diagrams.length === 0) return found;
  const start = google.clock.now();
  const pages = await orNothing(() => google.port.slidePages(google.presentationId));
  const ids = pages === undefined ? undefined : pageIdsByListIndex(deck.listedSlideCount, pages);
  if (ids === undefined) return found;
  for (const slide of diagrams) {
    if (google.clock.now() - start > DECK_BUDGET_MS) break;
    const pageId = ids[slide.listIndex];
    if (pageId === undefined) continue;
    const image = await orNothing(() => google.port.slideImage(google.presentationId, pageId));
    const pixelWidth = image === undefined ? undefined : imagePixelWidth(image.bytes);
    if (image !== undefined && pixelWidth !== undefined) {
      found.set(slide.number, { bytes: image.bytes, pixelWidth, identity: `google-thumbnail:${pageId}:${google.modifiedTime}` });
    }
  }
  if (found.size === 0) return found;
  const unchanged = await orNothing(() => google.port.unchangedSince(google.presentationId, google.modifiedTime));
  return unchanged === true ? found : new Map();
};

/** The body of a slide in the form its layout gives. Without a slide size
 *  (`p:sldSz` unreadable) nothing can be placed: the shapes in document
 *  order. `google`: Google's own image of this slide, when it is a diagram
 *  of a Google Slides deck and Google gave one. */
const slideBody = (
  slide: PptxSlide,
  deck: PptxReadResult,
  layout: SlideLayout<PptxShape> | undefined,
  images: ImageCollector,
  google: GoogleImage | undefined,
  notices: DocumentNotice[],
): IRBlock[] => {
  const blocksOf = (items: readonly PptxShape[]): IRBlock[] => items.flatMap((s) => shapeBlocks(s, images, slide.number, notices, deck));
  if (deck.slideSize === undefined || layout === undefined) return blocksOf(slide.shapes.filter((s) => !isFooterShape(s)));
  switch (layout.form) {
    case "flow":
      return blocksOf(layout.items);
    case "diagram": {
      // A declared table stays a table (02/10/2026): its cells are not
      // flattened into the diagram's collapsed text but follow the drawing as
      // a table block (the drawing still shows them). The rest is unchanged.
      const tables = layout.items.filter((s) => s.kind === "table");
      const rest = layout.items.filter((s) => s.kind !== "table");
      const tableBlocks = blocksOf(tables);
      // Google's image is the slide exactly as its author sees it: it
      // replaces our drawing, and draws every picture, so no "not drawn"
      // notice. The collapsed text is the same (§4 bis). Not self-described:
      // it is a picture of the author's slide, not a shape we made. Its sha256
      // (and so its attachment name) comes from its identity, not its bytes:
      // a new rendering of the same revision changes no content hash.
      if (google !== undefined) {
        const ref = images.collect(google.bytes, PNG_MIME, false, google.identity);
        return [{ kind: "image", ref: { ...ref, pixelWidth: ref.pixelWidth ?? google.pixelWidth } }, ...tableBlocks, ...diagramText(slide, rest, slide.number, notices)];
      }
      // The drawing serves reading; its text follows in one collapsed
      // paragraph, for search and Rovo, which do not read an SVG's text
      // (MIKSUDOC « Spécification fonctionnelle » §9.3.3, PLATFORM-STATUS §48). What the drawing
      // omits keeps its text there; a picture it omits is a dashboard-only
      // `picture-not-drawn` notice since lot A (29/09/2026) — no line on the
      // page any more. No width on the drawing: see
      // `renderer/storage.ts#publishedImageWidthPx` and the USA 9 test.
      // The SmartArts' saved drawings join the slide's shapes: ONE picture. The model words no drawn line shows are `undrawn` for the control.
      const { svg, picturesNotDrawn, smartArtText } = renderSlideSvg(withDrawings(slide.shapes), deck.slideSize, deck.defaultTextSizes ?? {});
      const ref = images.collect(new TextEncoder().encode(svg), SVG_MIME, true);
      for (const p of picturesNotDrawn) notices.push({ kind: "picture-not-drawn", slide: slide.number, reason: p.reason, count: 1 });
      const attempted = slide.shapes.flatMap((s) => (s.kind === "graphic" ? (s.words ?? []) : []));
      return [
        { kind: "image", ref },
        ...tableBlocks,
        ...diagramText(slide, rest, slide.number, notices, undrawnWords(attempted, smartArtText)),
      ];
    }
    case "table":
      return [
        {
          kind: "table",
          rows: layout.rows.map((row) => ({
            cells: row.map((cell) => ({
              blocks: blocksOf(cell.items),
              ...(cell.colspan > 1 ? { colspan: cell.colspan } : {}),
              ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
            })),
          })),
        },
      ];
  }
};

/** "At most 21 tabs, the following slides not published" (Mikolaj: 27 on the
 *  evening of 25/09/2026, 21 on 27/09/2026). A display cap: the slides past
 *  `cap` are dropped BEFORE layout — they pay no image decoding and no
 *  Google call — and a `tab-cap` `DocumentNotice` names them, a DECIDED,
 *  DECLARED removal like every one the repo allows — dashboard-only since
 *  lot A of docs/CONCEPTION-CARTE-ET-REMARQUES.md (29/09/2026), no more
 *  paragraph under the tabs. Pure and exported: the repo forbids any trial
 *  past 12 slides, so the rule is exercised at a small cap and the wired
 *  value asserted on its own. */
export const tabCapNotice = (totalSlides: number, cap: number): DocumentNotice | undefined => {
  if (totalSlides <= cap) return undefined;
  return { kind: "tab-cap", from: cap + 1, to: totalSlides };
};

/** One entry per (kind, slide, what/reason [, outcome]) with a `count` — the
 *  per-shape notices (`unsupported-element`, `picture-not-drawn`) fold, `chart-withheld` folds into one for the deck, every
 *  other kind passes through unchanged. Keeps the order of first occurrence.
 *  Bounded by slides × distinct causes, not by the number of shapes (item E,
 *  30/09/2026: 21 × 500 frames was ~10 500 entries, past Forge's value limit). */
export const foldNotices = (notices: readonly DocumentNotice[]): DocumentNotice[] => {
  const out: DocumentNotice[] = [];
  const seen = new Map<string, Extract<DocumentNotice, { count: number }>>();
  let chartsWithheld = 0;
  for (const n of notices) {
    if (n.kind === "chart-withheld") {
      chartsWithheld += n.count;
      continue;
    }
    if (n.kind !== "unsupported-element" && n.kind !== "picture-not-drawn") {
      out.push(n);
      continue;
    }
    const key = n.kind === "unsupported-element" ? `u|${n.slide}|${n.what}|${n.outcome}` : `p|${n.slide}|${n.reason}`;
    const existing = seen.get(key);
    if (existing) existing.count += n.count;
    else {
      const copy = { ...n };
      seen.set(key, copy);
      out.push(copy);
    }
  }
  // The charts kept out, one notice for the deck (as docx and xlsx).
  return [...out, ...unpublishedPartNotices({ chartsWithheld, imagesMissing: 0 })];
};

export const extractPptx = async (
  bytes: Uint8Array,
  google?: GoogleSlidesSource,
  language: PageLanguage = "en",
  limits?: ReaderLimits,
  /** The caller's own labels, when it gave any (`lib/page-labels.ts#resolveLabels`): ours in `language` otherwise. */
  labels?: PageLabelOverride,
): Promise<PptxExtractResult> => {
  // No blanket net here (review 27/09 evening, finding 4): the zip layer's
  // rejections are netted where they happen (`ooxml/package.ts`, next
  // to the XML net), so a TypeError from OUR reader stays OURS — UNKNOWN,
  // retried, visibly our defect — instead of blaming the user's file.
  // `detailCap`: the reader itself stops reading shapes, media and charts
  // past the display cap — a dropped slide pays neither the inflation of its
  // media parts nor its chart parts (its XML is still read: the notice needs
  // the true total, and damage there still fails the deck).
  const deck = await readPptx(bytes, { detailCap: limits?.presentationTabs ?? NO_CAP, limits });
  const images = new ImageCollector();
  const size = deck.slideSize;
  const notices: DocumentNotice[] = [];
  // The display cap cuts HERE (tabCapNotice above): a dropped slide pays no
  // layout, no image decoding, no Google call.
  const shown = deck.slides.slice(0, limits?.presentationTabs ?? NO_CAP);
  const capNotice = tabCapNotice(deck.slides.length, limits?.presentationTabs ?? NO_CAP);
  if (capNotice) notices.push(capNotice);
  // A slide over the element cap is withheld whole (7a): it pays no layout
  // and no Google image either.
  const layouts = shown.map((slide) =>
    size === undefined || slide.elementCount > (limits?.slideElements ?? NO_CAP) ? undefined : layoutSlide(slideLayoutInput(slide, size)),
  );
  const googleImages = await googleDiagramImages({ ...deck, slides: shown }, layouts, google);
  // A7 of docs/CONCEPTION-CARTE-ET-REMARQUES.md (Mikolaj, 29/09/2026): a
  // slide over the element cap carries NO TAB AT ALL — the other slides
  // keep their real numbers (`slide.number`, never a re-rank), the dashboard
  // says why (`slide-withheld` notice). A plain loop, not `shown.map`: a
  // withheld slide contributes nothing to `tabs`.
  const tabs: IRTab[] = [];
  const tabsSlides: PptxSlide[] = [];
  const tabForms: (SlideLayout<PptxShape>["form"] | undefined)[] = [];
  shown.forEach((slide, i) => {
    // 7a of the arbitrages (28/09/2026, revised the same day by Mikolaj:
    // « il ne faut pas la publier du tout ») — the spreadsheet design of
    // decision (a): a slide over the cap is withheld WHOLE, the document
    // still publishes. Nothing of the slide is read past the cap, and
    // nothing read is kept.
    if (slide.elementCount > (limits?.slideElements ?? NO_CAP)) {
      notices.push({ kind: "slide-withheld", slide: slide.number, elementCount: slide.elementCount });
      return;
    }
    tabsSlides.push(slide);
    tabForms.push(layouts[i]?.form);
    const heading: IRBlock[] =
      slide.title !== undefined && !slide.titleRepeated ? [{ kind: "heading", level: 2, inlines: [{ text: slide.title }] }] : [];
    // The footer, date and number zones close the tab, as plain paragraphs in shape order (they took no part in the layout).
    const footer = slide.shapes.filter(isFooterShape).flatMap((s) => shapeBlocks(s, images, slide.number, notices, deck));
    const blocks = [...heading, ...slideBody(slide, deck, layouts[i], images, googleImages.get(slide.number), notices), ...footer];
    tabs.push({
      // The label is the slide's rank only; its declared title is the
      // heading inside the tab (Mikolaj, 25/09/2026).
      title: resolveLabels(language, labels).slideTabTitle(slide.number),
      slideNumber: slide.number,
      // A tab with nothing to show still holds an empty paragraph, as the
      // editor writes one in an empty tab (page 50429973).
      blocks: blocks.length > 0 ? blocks : emptyTabBlocks(),
    });
  });
  // The text of the diagram slides is gathered AFTER the tabs: ONE block for the whole deck (Mikolaj, 29/09/2026), a section per
  // diagram slide labelled with its tab's « Slide N ». The renderer publishes none of it since 19/10/2026 (no collapsed block); the
  // conservation control reads it from the IR. Gathered from the CAPPED, SURVIVING tabs, so a slide
  // the 21-tab cap or the element cap dropped never leaves its text behind.
  const sections: DiagramTextSection[] = [];
  // Tables wider than MAX_TABLE_COLS or longer than MAX_TABLE_ROWS are not published; counted over the deck, said once.
  let tablesWithheld = 0;
  // Hidden shapes of the slides that carry a tab (a withheld or dropped slide reads none), said once.
  const hiddenShapes = tabsSlides.reduce((sum, slide) => sum + (slide.hiddenShapes ?? 0), 0);
  const layoutTables: number[] = [];
  const framed = tabs.map((tab, tabIndex) => {
    // One section per slide: a flow slide with several SmartArts gives one
    // block each, their pieces run on with the same separator.
    const mine: DiagramTextSection[] = [];
    // A table-form slide holds its frames in cells: the pull goes into every container.
    const pull = (blocks: readonly IRBlock[]): IRBlock[] =>
      blocks.flatMap((b): IRBlock[] => {
        if (b.kind === "diagramText") {
          mine.push(...b.sections);
          return [];
        }
        return [mapBlockChildren(b, pull)];
      });
    const kept = pull(tab.blocks);
    if (mine.length > 0) sections.push({ label: tab.title, ...(tab.slideNumber !== undefined ? { slideNumber: tab.slideNumber } : {}), ...mergedSections(mine) });
    const { blocks: narrow, withheld } = withholdOversizedTables(kept, undefined, limits);
    tablesWithheld += withheld;
    // The layout table of a slide of form "table" is the one top-level table of its tab, unless the width cap just withheld it.
    layoutTables.push(tabForms[tabIndex] === "table" ? narrow.filter((b) => b.kind === "table").length : 0);
    return { ...tab, blocks: narrow.length > 0 ? narrow : emptyTabBlocks() };
  });
  const gathered: IRBlock[] = sections.length > 0 ? [{ kind: "diagramText", sections }] : [];
  return {
    doc: { blocks: framed.length > 0 ? [{ kind: "tabs", tabs: framed }, ...gathered] : [] },
    images: images.images,
    layoutTables,
    notices: [...foldNotices(notices), ...unpublishedPartNotices({ chartsWithheld: 0, imagesMissing: 0, tablesWithheld, hiddenShapes }), ...(deck.themeDamaged === true ? [{ kind: "styles-defaulted" as const }] : [])],
  };
};
