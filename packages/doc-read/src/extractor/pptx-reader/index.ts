/** A .pptx read by our own reader, as ECMA-376 declares it: its VISIBLE slides
 *  in `p:sldIdLst` order, each with its declared title and its other visible
 *  shapes (text, tables, charts and their data, other graphic frames,
 *  pictures, connectors), and the slide size. Speaker notes are never read:
 *  the page does not publish them (MIKSUDOC « Spécification fonctionnelle »). An
 *  intermediate model, not yet an IR document.
 *  NOT here: the package layer (`ooxml/package.ts`), the XML tree
 *  (`ooxml/xml.ts`), what a shape holds (`pptx-reader/shapes.ts`), a
 *  chart part (`pptx-reader/chart.ts`), nor what the page publishes
 *  (`extractor/pptx.ts`).
 *  Called by: `extractor/pptx.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import type { Size } from "doc-ir/layout/slide-elements";
import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import { type DocxPackage, IMAGE_MAX_TOTAL_BYTES, openPackage, orDamaged, PartDamagedError, type Relationship, relationOfKind } from "../ooxml/package";
import { isXsdFalse } from "../../lib/ooxml-bool";
import { attr, child, children, tagOf, type XNode } from "../ooxml/xml";
import { cachesWithoutModel, readSmartArt } from "../smartart";
import { placeShapes, readSmartArtDrawing } from "../smartart-drawing";
import { readChartOrWithheld } from "./chart";
import { type ColorContext, colorMapOf, elements, overrideMapOf, schemeOf } from "./color";
import type { PptxMedia } from "./picture";
import { countElements, type PptxGraphicShape, type PptxShape, type PptxTextShape, readShapes } from "./shapes";
import { sizeOf } from "./text";
import type { TextStyleSources } from "./text-color";

export type { PptxPictureNotPublished } from "./picture";
export type { PptxConnectorShape, PptxGraphicShape, PptxPictureShape, PptxShape, PptxTextShape } from "./shapes";
export type { PptxTable } from "./table";
export type { PptxParagraph } from "./text";

export interface PptxSlide {
  /** 1-based rank among the VISIBLE slides, in `p:sldIdLst` order. */
  number: number;
  /** 0-based position in `p:sldIdLst`, hidden slides counted: how a slide is
   *  matched to its Google Slides page (`extractor/pptx.ts#pageIdsOfSlides`). */
  listIndex: number;
  /** Archive path of the slide part. */
  partPath: string;
  /** Every element of the shape tree, counted at `spTreeIndex` rank —
   *  groups, hidden shapes and the ones past `MAX_SLIDE_ELEMENTS`
   *  included. Above the cap, the tab tells it (`extractor/pptx.ts`).
   *  0 for a slide past the display cap (its shapes are not read). */
  elementCount: number;
  /** Hidden shapes (`p:cNvPr hidden`) left out of this slide, a hidden group for one; absent when none or when the slide's shapes are not read. */
  hiddenShapes?: number;
  /** The text of the shape the slide DECLARES as its title: `p:ph` of type
   *  `title` or `ctrTitle` with no `idx` (a `title` WITH an `idx` is a column
   *  header: FORMAT-PPTX [purged 27/09/2026, git history] §5 point 5). Its non-blank paragraphs joined by "\n"
   *  (a line break inside one stays "\n"), the whole trimmed. Absent when no shape declares one, or when it is blank: the
   *  title is never guessed from the biggest text. */
  title?: string;
  /** The title is the previous VISIBLE slide's title, same text exactly
   *  (both trimmed): it is not published again (MIKSUDOC « Spécification fonctionnelle » §9.3.1). */
  titleRepeated: boolean;
  /** Every visible shape except the title shape, which is removed from
   *  the body even when blank. */
  shapes: PptxShape[];
}

export interface PptxReadResult {
  /** `p:sldSz cx`/`cy`, in EMU; absent when not written as positive integers
   *  within ECMA's ST_PositiveCoordinate bound. */
  slideSize?: Size;
  /** `p:defaultTextStyle`: the size, in points, its `a:lvlNpPr/a:defRPr sz`
   *  writes for each level (0-based: lvl1pPr is 0); a level writing none is
   *  absent. `a:defPPr` is not a level and is not read. Only the slide
   *  drawing uses it, for a shape that is no placeholder
   *  (`extractor/slide-svg.ts`). Absent when no level writes a size. */
  defaultTextSizes?: Readonly<Record<number, number>>;
  slides: PptxSlide[];
  /** How many slides `p:sldIdLst` lists, hidden ones included. */
  listedSlideCount: number;
  /** A theme (or theme override) part is declared but unreadable: default colours were used. Said as `styles-defaulted`. */
  themeDamaged?: boolean;
}

/** A shape that declares itself the slide title. When several do, the first in document order is taken; the others stay body. */
const isTitleShape = (shape: PptxShape): shape is PptxTextShape =>
  shape.kind === "text" &&
  shape.placeholder !== undefined &&
  shape.placeholder.idx === undefined &&
  (shape.placeholder.type === "title" || shape.placeholder.type === "ctrTitle");

const titleText = (shape: PptxTextShape): string | undefined => {
  const text = shape.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .filter((p) => p.trim() !== "")
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
};

/** The image parts a slide's relationships name, loaded before its
 *  (synchronous) shape walk. `parts` keeps each part read once for the whole
 *  deck: a logo on every slide is one read — a DAMAGED one is one refusal,
 *  remembered, so the same picture on another slide says the same thing.
 *  `budget.left` is the deck-wide `IMAGE_MAX_TOTAL_BYTES` (arbitrage of
 *  28/09/2026, same T9 reasoning as the docx reader's): each read is capped
 *  at what remains, so the part passing it meets the CEILING refusal — a
 *  bomb, never degradable. Chart-part renderings stay under the package
 *  ceilings only: they are not slide media. */
const mediaOf = async (
  pkg: DocxPackage,
  rels: ReadonlyMap<string, Relationship>,
  parts: Map<string, Uint8Array | "damaged" | undefined>,
  budget: { left: number },
): Promise<PptxMedia> => {
  const media = new Map<string, { bytes: Uint8Array; contentType: string } | "damaged">();
  for (const [id, rel] of rels) {
    if (rel.kind !== "image" || rel.external) continue;
    if (!parts.has(rel.target)) {
      try {
        const bytes = await pkg.readBytes(rel.target, budget.left);
        parts.set(rel.target, bytes);
        budget.left -= bytes?.length ?? 0;
      } catch (e) {
        // A corrupt image part degrades to the picture's own marker
        // (arbitrage of 28/09/2026); any other failure is ours — the
        // budget's own refusal is NOT PartDamagedError and passes through.
        // Not `orDamaged`: « damaged » must stay apart from « absent » here.
        if (!(e instanceof PartDamagedError)) throw e;
        parts.set(rel.target, "damaged");
      }
    }
    const bytes = parts.get(rel.target);
    if (bytes === "damaged") media.set(id, "damaged");
    else if (bytes) media.set(id, { bytes, contentType: pkg.contentType(rel.target) ?? "application/octet-stream" });
  }
  return media;
};

/** What is left of a slide's own budget of drawing shapes, and the limits the SmartArt drawings are read under. */
interface DrawingBudget {
  left: number;
  readonly limits: ReaderLimits | undefined;
}

/** The saved drawing of a SmartArt frame (`part`: the drawing the frame's data model names), carried to the frame's corner; "not-drawn"
 *  when it exists but is kept out: past `MAX_SLIDE_ELEMENTS` shapes, or past what is left of the slide's own budget of drawing
 *  shapes (`budget`: the SmartArt that crosses it is not drawn, the slide's element count never moves), or a frame a group scales, turns
 *  or mirrors. `undefined`: nothing to draw (no part, damaged, no shape), the words then stay in the diagram text alone. */
const drawingOf = async (
  pkg: DocxPackage,
  shape: PptxGraphicShape,
  part: string | undefined,
  context: ColorContext | undefined,
  budget: DrawingBudget,
): Promise<PptxGraphicShape["drawing"]> => {
  const root = part === undefined ? undefined : await orDamaged(() => pkg.readXml(part));
  if (root === undefined) return undefined;
  const read = readSmartArtDrawing(root, context, budget.limits);
  if (read === "too-many") return "not-drawn";
  if (read.shapes.length === 0) return undefined;
  if (shape.inScaledGroup === true || shape.box === undefined || read.shapes.length > budget.left) return "not-drawn";
  budget.left -= read.shapes.length;
  return { shapes: placeShapes(read.shapes, shape.box) };
};

/** A SmartArt frame with its words and its saved drawing. `claimed`: the drawing part its data model names; `modelless`: no data model
 *  part could be read (a damaged one degrades to the frame's own marker, like a chart part). */
const readSmartArtFrame = async (
  pkg: DocxPackage,
  shape: PptxGraphicShape,
  slideRels: ReadonlyMap<string, Relationship>,
  context: ColorContext | undefined,
  budget: DrawingBudget,
): Promise<{ shape: PptxGraphicShape; claimed: string | undefined; modelless: boolean }> => {
  const read = await orDamaged(() => readSmartArt(pkg, slideRels, shape.dataPart));
  const drawing = read === undefined ? undefined : await drawingOf(pkg, shape, read.claimed, context, budget);
  const words = read !== undefined && read.words.length > 0 ? { words: read.words } : {};
  return { shape: { ...shape, ...words, ...(drawing === undefined ? {} : { drawing }) }, claimed: read?.claimed, modelless: read === undefined };
};

/** Each chart frame with its part's data (`pptx-reader/chart.ts`), each SmartArt frame with its words and its saved drawing. */
const withCharts = async (
  pkg: DocxPackage,
  shapes: PptxShape[],
  slideRels: ReadonlyMap<string, Relationship>,
  context: ColorContext | undefined,
  limits: ReaderLimits | undefined,
): Promise<PptxShape[]> => {
  const drawingBudget: DrawingBudget = { left: limits?.slideElements ?? NO_CAP, limits };
  const out: PptxShape[] = [];
  // The drawing caches the slide's data models name, and the frames with no model.
  const claimed = new Set<string>();
  const modelless: number[] = [];
  for (const shape of shapes) {
    if (shape.kind === "graphic" && shape.graphic === "smartart") {
      const frame = await readSmartArtFrame(pkg, shape, slideRels, context, drawingBudget);
      if (frame.claimed !== undefined) claimed.add(frame.claimed);
      if (frame.modelless) modelless.push(out.length);
      out.push(frame.shape);
      continue;
    }
    if (shape.kind !== "graphic" || shape.graphic !== "chart") {
      out.push(shape);
      continue;
    }
    // A chart frame whose relationship does not resolve has no part: said like a missing one (Mikolaj, 07/10/2026).
    if (shape.part === undefined) {
      out.push({ ...shape, chart: "withheld" });
      continue;
    }
    // A damaged chart part is a chart kept out whole, like a bound (docx and xlsx say the same: Mikolaj, 07/10/2026).
    const chart = await readChartOrWithheld(pkg, shape.part, { limits });
    out.push(chart === undefined ? shape : { ...shape, chart });
  }
  // A SmartArt with no data model part: the caches no model claimed (`extractor/smartart.ts`).
  if (modelless.length > 0) {
    const words = await cachesWithoutModel(pkg, slideRels, claimed, modelless.length);
    modelless.forEach((at, i) => {
      const shape = out[at];
      const mine = words[i] ?? [];
      if (shape && mine.length > 0) out[at] = { ...shape, words: mine } as PptxShape;
    });
  }
  return out;
};

/** The first relationship of `kind` a part names, inside the package. */
const targetOf = (rels: ReadonlyMap<string, Relationship>, kind: string): string | undefined =>
  relationOfKind(rels, kind)?.target;

/** What a slide's `a:schemeClr` resolves through (`pptx-reader/color.ts`),
 *  and its layout and master (what its text inherits a colour from,
 *  `pptx-reader/text-color.ts`):
 *  its colour map, the slide's `p:clrMapOvr` first, then its layout's,
 *  then the master's `p:clrMap`; the master's theme, or the slide's
 *  `themeOverride` for what the override writes. The context is
 *  `undefined` when the slide names no layout, master or theme. `parts`
 *  keeps each part read once for the whole deck. */
const colorContextOf = async (
  pkg: DocxPackage,
  slide: XNode,
  slideRels: ReadonlyMap<string, Relationship>,
  parts: Map<string, XNode | undefined>,
  themeDamaged: { value: boolean },
): Promise<{ context?: ColorContext; layout?: XNode; master?: XNode }> => {
  const read = async (path: string | undefined): Promise<XNode | undefined> => {
    if (path === undefined) return undefined;
    if (!parts.has(path)) parts.set(path, await pkg.readXml(path));
    return parts.get(path);
  };
  // A damaged THEME part (or override) degrades to the same fallback as a
  // missing one — default colours, cached so the next slide does not re-parse
  // it (arbitrage of 28/09/2026). Layout and master stay strict: they carry
  // the slide's structure, not only its colours.
  const readTheme = async (path: string | undefined): Promise<XNode | undefined> => {
    if (path === undefined) return undefined;
    if (!parts.has(path)) {
      const read = await orDamaged(() => pkg.readXml(path));
      if (read === undefined && pkg.hasPart(path)) themeDamaged.value = true;
      parts.set(path, read);
    }
    return parts.get(path);
  };
  const layoutPath = targetOf(slideRels, "slideLayout");
  const layout = await read(layoutPath);
  const masterPath = layoutPath === undefined ? undefined : targetOf(await pkg.relationships(layoutPath), "slideMaster");
  const master = await read(masterPath);
  const themePath = masterPath === undefined ? undefined : targetOf(await pkg.relationships(masterPath), "theme");
  const theme = child(await readTheme(themePath) ?? {}, "a:themeElements");
  const override = await readTheme(targetOf(slideRels, "themeOverride"));
  const masterMap = child(master ?? {}, "p:clrMap");
  const parents = { ...(layout === undefined ? {} : { layout }), ...(master === undefined ? {} : { master }) };
  if (theme === undefined || masterMap === undefined) return parents;
  const clrScheme = child(override ?? {}, "a:clrScheme") ?? child(theme, "a:clrScheme");
  const fmtScheme = child(override ?? {}, "a:fmtScheme") ?? child(theme, "a:fmtScheme");
  const context = {
    map: overrideMapOf(slide) ?? overrideMapOf(layout) ?? colorMapOf(masterMap),
    scheme: schemeOf(clrScheme),
    fillStyles: elements(child(fmtScheme ?? {}, "a:fillStyleLst") ?? {}),
  };
  return { ...parents, context };
};

/** The one message for a damaged deck, never two copies to diverge. */
const damaged = (): ReaderError =>
  new ReaderError("EXTRACT_FAILED", "the file is damaged or is not a valid PowerPoint presentation");

export interface ReadPptxOptions {
  /** Shapes, media and charts are read only for the first this many VISIBLE
   *  slides; the slides past it are still read and counted (their XML
   *  fetched and validated, hidden ones skipped, `listedSlideCount` whole)
   *  but carry no shapes and no title. `extractor/pptx.ts` passes its
   *  display cap: a slide it drops never pays the inflation of its media
   *  parts nor the analysis of its chart parts. Absent: every slide. */
  detailCap?: number;
  /** The caps this reading applies (`lib/reader-limits.ts#ReaderLimits`): slide elements, the media byte allowance,
   *  the chart bounds. Absent: NONE — `NO_CAP`, nothing withheld (the app passes
   *  `core/document-caps.ts#PRODUCT_READER_LIMITS`; corrected 10/11/2026). */
  limits?: ReaderLimits | undefined;
}

/** `p:sldSz` as a size, only when both sides are positive integers within ECMA's bound. */
const readSlideSize = (presentation: XNode): Size | undefined => {
  const sldSz = child(presentation, "p:sldSz");
  const cx = Number(attr(sldSz ?? {}, "cx"));
  const cy = Number(attr(sldSz ?? {}, "cy"));
  // ECMA-376 ST_PositiveCoordinate caps at 27 273 042 316 900 EMU; a size
  // past it ("1e300" is an integer to `Number.isInteger`) is treated as not
  // written — no geometry is invented, the slides come out in file order.
  const withinBounds = (v: number): boolean => Number.isInteger(v) && v > 0 && v <= 27_273_042_316_900;
  return sldSz && withinBounds(cx) && withinBounds(cy) ? { cx, cy } : undefined;
};

/** What every slide of one deck reads against: the package, the deck's own parts and the caches shared by its slides (each part read once). */
interface DeckReading {
  pkg: DocxPackage;
  defaultTextStyle: XNode | undefined;
  slideSize: Size | undefined;
  detailCap: number | undefined;
  limits: ReaderLimits | undefined;
  parts: Map<string, Uint8Array | "damaged" | undefined>;
  mediaBudget: { left: number };
  xmlParts: Map<string, XNode | undefined>;
  themeDamaged: { value: boolean };
  /** `p:presentation firstSlideNum` (default 1): the number PowerPoint shows on the first listed slide. */
  firstSlideNum: number;
}

/** The slide part a `p:sldId` names, parsed; a slide the list names but the package lacks (or that is no `p:sld`) is damage. */
const openSlidePart = async (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>, sldId: XNode): Promise<{ target: string; slide: XNode }> => {
  const relId = attr(sldId, "r:id");
  const rel = relId === undefined ? undefined : rels.get(relId);
  if (!rel || rel.external || rel.kind !== "slide") throw damaged();
  const slide = await pkg.readXml(rel.target);
  if (!slide || tagOf(slide) !== "p:sld") throw damaged();
  return { target: rel.target, slide };
};

/** A slide counted but not read: no shapes, no title. */
const unreadSlide = (slides: readonly PptxSlide[], listIndex: number, partPath: string, elementCount: number): PptxSlide => ({
  number: slides.length + 1,
  listIndex,
  partPath,
  elementCount,
  titleRepeated: false,
  shapes: [],
});

/** The shapes of a slide's tree with their charts and SmartArts read: its colour context, media, then the walk. */
const readSlideShapes = async (
  deck: DeckReading,
  slide: XNode,
  tree: XNode | undefined,
  slideRels: ReadonlyMap<string, Relationship>,
  slideNumber: number,
): Promise<{ read: { shapes: PptxShape[]; elementCount: number; hiddenShapes: number }; all: PptxShape[] }> => {
  const { pkg, defaultTextStyle } = deck;
  const { context, layout, master } = tree ? await colorContextOf(pkg, slide, slideRels, deck.xmlParts, deck.themeDamaged) : {};
  const sources: TextStyleSources = {
    ...(layout === undefined ? {} : { layout }),
    ...(master === undefined ? {} : { master }),
    ...(defaultTextStyle === undefined ? {} : { defaultTextStyle }),
  };
  const read = tree
    ? readShapes(tree, slideRels, await mediaOf(pkg, slideRels, deck.parts, deck.mediaBudget), context, sources, deck.slideSize, slideNumber, deck.limits)
    : { shapes: [], elementCount: 0, hiddenShapes: 0 };
  const all = await withCharts(pkg, read.shapes, slideRels, context, deck.limits);
  return { read, all };
};

/** One `p:sldId` read; `undefined` for a hidden slide, which produces nothing. */
const readSlide = async (
  deck: DeckReading,
  rels: ReadonlyMap<string, Relationship>,
  slides: readonly PptxSlide[],
  listIndex: number,
  sldId: XNode,
): Promise<PptxSlide | undefined> => {
  const { pkg, detailCap } = deck;
  const { target, slide } = await openSlidePart(pkg, rels, sldId);
  // ECMA-376: `show="0"` hides the slide; it produces nothing.
  if (isXsdFalse(attr(slide, "show"))) return undefined;
  // Past the detail cap the slide is counted but its shapes are not read:
  // no media part is inflated, no chart part is opened (a broken image on
  // a slide the caller drops used to fail the whole deck).
  if (detailCap !== undefined && slides.length >= detailCap) return unreadSlide(slides, listIndex, target, 0);
  const tree = child(child(slide, "p:cSld") ?? {}, "p:spTree");
  // The element-cap withhold is DECIDED on a structural count BEFORE
  // anything else touches the slide (re-revue du 28/09, R1+R2: deciding
  // after inflating media let a withheld slide burst the shared budget,
  // and refunding purged a shared cache entry the package counter had
  // no way to forget). A withheld slide pays no colour context, no
  // media, no text, no chart — and reads NO TITLE either: the next
  // slide's `titleRepeated` suppression cannot apply after it (chosen
  // bias, written — the slide is not published, its declared title is
  // not read).
  const structuralCount = tree ? countElements(tree) : 0;
  if (structuralCount > (deck.limits?.slideElements ?? NO_CAP)) return unreadSlide(slides, listIndex, target, structuralCount);
  const slideRels = await pkg.relationships(target);
  const { read, all } = await readSlideShapes(deck, slide, tree, slideRels, deck.firstSlideNum + listIndex);
  const titleShape = all.find(isTitleShape);
  const title = titleShape === undefined ? undefined : titleText(titleShape);
  const previous = slides.at(-1)?.title;
  return {
    number: slides.length + 1,
    listIndex,
    partPath: target,
    elementCount: read.elementCount,
    ...(read.hiddenShapes > 0 ? { hiddenShapes: read.hiddenShapes } : {}),
    ...(title === undefined ? {} : { title }),
    titleRepeated: title !== undefined && title === previous,
    shapes: all.filter((s) => s !== titleShape),
  };
};

/** `p:defaultTextStyle`'s size for each of the nine levels that writes one. */
const defaultTextSizesOf = (defaultTextStyle: XNode | undefined): Record<number, number> => {
  const sizes: Record<number, number> = {};
  for (let level = 0; level < 9; level++) {
    const size = sizeOf(child(child(defaultTextStyle ?? {}, `a:lvl${level + 1}pPr`) ?? {}, "a:defRPr"));
    if (size !== undefined) sizes[level] = size;
  }
  return sizes;
};

/** ECMA-376 Part 1 §19.3.1.26: `firstSlideNum` is an integer, 1 when absent; an unreadable value counts as absent. */
const firstSlideNumOf = (presentation: XNode): number => {
  const n = Number(attr(presentation, "firstSlideNum"));
  return Number.isInteger(n) && n >= 0 && n < 10 ** 9 ? n : 1;
};

export const readPptx = async (bytes: Uint8Array, options: ReadPptxOptions = {}): Promise<PptxReadResult> => {
  const pkg = await openPackage(bytes, damaged);
  const presentation = await pkg.readXml(pkg.mainPart);
  if (!presentation || tagOf(presentation) !== "p:presentation") throw damaged();
  const rels = await pkg.relationships(pkg.mainPart);

  // The slide order is the order of `p:sldIdLst`, never the part names.
  // A slide the list names but the package lacks is damage, not a slide to
  // skip quietly.
  const slides: PptxSlide[] = [];
  const defaultTextStyle = child(presentation, "p:defaultTextStyle");
  const slideSize = readSlideSize(presentation);
  const deck: DeckReading = {
    pkg,
    defaultTextStyle,
    slideSize,
    detailCap: options.detailCap,
    limits: options.limits,
    parts: new Map(),
    mediaBudget: { left: options.limits?.payloadBytes ?? IMAGE_MAX_TOTAL_BYTES },
    xmlParts: new Map(),
    themeDamaged: { value: false },
    firstSlideNum: firstSlideNumOf(presentation),
  };
  const listed = children(child(presentation, "p:sldIdLst") ?? {}, "p:sldId");
  for (const [listIndex, sldId] of listed.entries()) {
    const slide = await readSlide(deck, rels, slides, listIndex, sldId);
    if (slide !== undefined) slides.push(slide);
  }
  const defaultTextSizes = defaultTextSizesOf(defaultTextStyle);
  return {
    ...(slideSize === undefined ? {} : { slideSize }),
    ...(Object.keys(defaultTextSizes).length === 0 ? {} : { defaultTextSizes }),
    slides,
    listedSlideCount: listed.length,
    ...(deck.themeDamaged.value ? { themeDamaged: true } : {}),
  };
};
