/** The two DrawingML objects a `w:drawing` can hold besides pictures and
 *  shapes: a native CHART (`c:chart`, a part of its own) and a SmartArt
 *  (`dgm:relIds`, a data-model part). Both live in parts the synchronous walk
 *  of `docx-reader/body.ts` cannot inflate, so they are read BEFORE the walk
 *  (`preloadObjects`), by relationship target, and looked up during it.
 *  The chart is read by the SAME code as the pptx and xlsx readers, so the three cannot drift apart.
 *  Decides: a damaged part gives nothing, never a refusal of the document. The chart's own rendering image is not
 *  taken: the page gets the data table (MIKSUDOC « Spécification technique » §5.4). A SmartArt gives back TWO blocks
 *  at the place of its frame (29/10/2026): its drawing as a picture, then its model as the `diagramText` block the
 *  renderer turns into a nested bullet list. Only the drawing caches whose model is missing still travel through
 *  `gathered()` to the end of the document — the file ties them to no frame.
 *  NOT here: the synchronous walk that places them (`docx-reader/body.ts`), the chart parsing (`pptx-reader/chart.ts`)
 *  and the SmartArt reading order (`extractor/smartart.ts`).
 *  Called by: `docx-reader/index.ts`, `docx-reader/body.ts`. */

import { type DiagramTextSection, type IRBlock } from "doc-ir/lib/ir";
import type { Size } from "doc-ir/layout/slide-elements";
import { finiteNumber } from "../../lib/ooxml-num";
import { cachesWithoutModel, readSmartArt } from "../smartart";
import { readSmartArtDrawing, themeColorContext, undrawnWords } from "../smartart-drawing";
import { renderSlideSvg } from "../slide-svg";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { chartToIr, type PptxChart, readChartOrWithheld } from "../pptx-reader/chart";
import type { ColorContext } from "../pptx-reader/color";
import {
  findInternalTarget,
  readUnlessDamaged,
  PartDamagedError,
  findRelationshipOfKind,
  type OpcPackage,
  type Relationship,
} from "../ooxml/package";
import type { DrawingImageRegistrar } from "./shapes";
import {
  attributeOf,
  findChild,
  findDrawingFrame,
  findGraphicData,
  childNodesOf,
  qualifiedNameOf,
  type XNode,
} from "../ooxml/xml";

/** `true` when the SmartArt data model itself cannot be read (damaged), as opposed to its drawing cache. */
const modelUnreadable = async (pkg: OpcPackage, relationship: Relationship): Promise<boolean> => {
  if (relationship.external) return false;
  try {
    await pkg.readXml(relationship.target);
    return false;
  } catch (error) {
    if (error instanceof PartDamagedError) return true;
    throw error;
  }
};

/** What the `a:graphicData` of a drawing names, by the relationship id. */
export type DrawingObject =
  | { readonly kind: "chart"; readonly relId: string }
  | { readonly kind: "smartart"; readonly relId: string; readonly extent?: Size };

/** The chart(s) and SmartArt(s) a `w:drawing` holds ITSELF: directly in its
 *  `a:graphicData`, or in a frame of a group (`wpg:graphicFrame`, Word 2010
 *  group). A text box's paragraphs (`w:txbxContent`) are not entered: the
 *  walk reads them as a story, and meets their drawings there. */
export const drawingObjectsOf = (drawing: XNode): DrawingObject[] => {
  const frame = findDrawingFrame(drawing);
  const graphicData = frame ? findGraphicData(frame) : undefined;
  if (!graphicData) return [];
  const found: DrawingObject[] = [];
  const walk = (node: XNode): void => {
    for (const childNode of childNodesOf(node)) {
      const tag = qualifiedNameOf(childNode);
      if (tag === "w:txbxContent") continue;
      const object = objectOf(childNode);
      if (object) found.push(object);
      else walk(childNode);
    }
  };
  walk(graphicData);
  return found;
};

/** A `c:chart` or `dgm:relIds` element. */
const objectOf = (node: XNode): DrawingObject | undefined => {
  const tag = qualifiedNameOf(node);
  if (tag === "c:chart") {
    const id = attributeOf(node, "r:id");
    return id === undefined ? undefined : { kind: "chart", relId: id };
  }
  if (tag === "dgm:relIds") {
    const id = attributeOf(node, "r:dm");
    return id === undefined ? undefined : { kind: "smartart", relId: id };
  }
  return undefined;
};

/** The `wp:extent` of a `wp:inline` or `wp:anchor` (EMU): the canvas a SmartArt's drawing is cropped to. */
const extentOf = (node: XNode): Size | undefined => {
  const tag = qualifiedNameOf(node);
  if (tag !== "wp:inline" && tag !== "wp:anchor") return undefined;
  const extent = findChild(node, "wp:extent");
  if (extent === undefined) return undefined;
  const cx = finiteNumber(attributeOf(extent, "cx"));
  const cy = finiteNumber(attributeOf(extent, "cy"));
  return cx === undefined || cy === undefined || cx <= 0 || cy <= 0 ? undefined : { cx, cy };
};

/** Every drawing object under `node`, at any depth (a text box, a group, a
 *  Fallback…), document order; a SmartArt with the extent of the drawing around it. */
const objectsUnder = (node: XNode, found: DrawingObject[] = [], extent?: Size): DrawingObject[] => {
  for (const childNode of childNodesOf(node)) {
    const enclosingExtent = extentOf(childNode) ?? extent;
    const object = objectOf(childNode);
    if (object)
      found.push(
        object.kind === "smartart" && enclosingExtent !== undefined ? { ...object, extent: enclosingExtent } : object,
      );
    else objectsUnder(childNode, found, enclosingExtent);
  }
  return found;
};

export interface DrawingObjects {
  /** The chart block of a `c:chart r:id` in the part whose relationships are `relationships`. `undefined` when there is
   *  none; a chart a bound or a damaged part keeps out is counted (`chartsWithheld`), once per place it stands. */
  chart(relationships: ReadonlyMap<string, Relationship>, relId: string): IRBlock | undefined;
  /** How many chart placements `chart` withheld: their title and labels are not on the page. */
  chartsWithheld(): number;
  /** The blocks a `dgm:relIds r:dm` puts WHERE THE FRAME STANDS: its saved drawing as the picture to publish (bytes taken by
   *  `register`), then its model as the `diagramText` block the renderer turns into a nested list. Empty: no drawing (none
   *  saved, damaged, kept out, or the picture allowance spent) AND no word. 29/10/2026: the lists were gathered at the
   *  end of the page and judged good but misplaced — the frame's place is exact in the file and the picture already
   *  used it. */
  smartArt(relationships: ReadonlyMap<string, Relationship>, relId: string, register: DrawingImageRegistrar): IRBlock[];
  /** What no frame could carry: the drawing caches whose model is missing, as one diagram-text block at the end of the
   *  document. A cache is tied to no frame by the file (`cachesWithoutModel`), so it has no place of its own to go to. */
  gathered(): IRBlock[];
}

const SVG_MIME = "image/svg+xml";

/** What is kept of a SmartArt between the read ahead of the walk and the walk: its words, and its saved drawing as the picture's bytes and
 *  the lines it draws; "not-drawn": a drawing exists but is kept out (past `ReaderLimits.slideElements` shapes, or no canvas to crop it to).
 *  Absent: no drawing to draw (none saved, unlinked, damaged or without a shape). */
interface SmartArtEntry {
  readonly words: readonly string[];
  /** The level of each word in the model's tree (`extractor/smartart.ts`), which the published list nests on. */
  readonly levels: readonly number[];
  readonly drawing?: { readonly svg: Uint8Array; readonly lines: readonly string[] } | "not-drawn";
}

/** The document's theme colours (the main part's `theme` relationship), read once and only if a SmartArt's drawing
 *  needs them. */
const themeOf = (pkg: OpcPackage): (() => Promise<ColorContext | undefined>) => {
  let themeRead: Promise<ColorContext | undefined> | undefined;
  return () => {
    themeRead ??= (async () => {
      const part = findRelationshipOfKind(await pkg.relationships(pkg.mainPart), "theme")?.target;
      return themeColorContext(part === undefined ? undefined : await readUnlessDamaged(() => pkg.readXml(part)));
    })();
    return themeRead;
  };
};

/** A SmartArt's saved drawing (`part`, named by its data model) drawn on a canvas of `extent`, the frame's own size: the drawing's space
 *  is the frame's, scale 1 (`extractor/smartart-drawing.ts`). */
const drawingOf = async (
  pkg: OpcPackage,
  part: string | undefined,
  extent: Size | undefined,
  theme: () => Promise<ColorContext | undefined>,
  limits: ReaderLimits | undefined,
): Promise<SmartArtEntry["drawing"]> => {
  const root = part === undefined ? undefined : await readUnlessDamaged(() => pkg.readXml(part));
  if (root === undefined) return undefined;
  const smartArtDrawing = readSmartArtDrawing(root, await theme(), limits);
  if (smartArtDrawing === "too-many") return "not-drawn";
  if (smartArtDrawing.shapes.length === 0) return undefined;
  if (extent === undefined) return "not-drawn";
  const { svg, smartArtText } = renderSlideSvg(smartArtDrawing.shapes, extent);
  return { svg: new TextEncoder().encode(svg), lines: smartArtText };
};

/** What the read ahead of the walk shares across the stories: the package, its bounds, its theme, and what is read so far. */
interface PreloadState {
  readonly pkg: OpcPackage;
  readonly limits: ReaderLimits | undefined;
  readonly theme: () => Promise<ColorContext | undefined>;
  readonly charts: Map<string, PptxChart | "withheld" | undefined>;
  readonly smartArts: Map<string, SmartArtEntry>;
}

/** Reads one object of a story ahead of the walk. `true`: a SmartArt whose data model is absent or damaged. */
const preloadObject = async (
  state: PreloadState,
  object: DrawingObject,
  relationships: ReadonlyMap<string, Relationship>,
  claimed: Set<string>,
): Promise<boolean> => {
  const { pkg, smartArts } = state;
  const relationship = relationships.get(object.relId);
  const target = findInternalTarget(relationships, object.relId);
  try {
    if (object.kind === "chart") {
      await preloadChart(state, target);
      return false;
    }
    // `r:dm` names the data-model part itself.
    const smartArt = target !== undefined ? await readSmartArt(pkg, relationships, target) : undefined;
    if (smartArt?.claimed !== undefined) claimed.add(smartArt.claimed);
    if (smartArt === undefined) return true;
    await keepSmartArt(state, relationship, smartArt, object.extent);
    return false;
  } catch (error) {
    // A damaged part: the object gives nothing, the document stands.
    if (!(error instanceof PartDamagedError)) throw error;
    if (relationship && (await modelUnreadable(pkg, relationship))) return true; // the words fall back on the drawing cache, as for an absent model
    if (relationship) smartArts.set(relationship.target, { words: [], levels: [] });
    return false;
  }
};

/** Reads a chart part once, however many frames name it. */
const preloadChart = async (state: PreloadState, target: string | undefined): Promise<void> => {
  if (target !== undefined && !state.charts.has(target))
    state.charts.set(target, await readChartOrWithheld(state.pkg, target, { picture: false, limits: state.limits }));
};

/** Keeps a SmartArt's words and its drawing, drawn on the frame's `extent`, once per data-model part. */
const keepSmartArt = async (
  state: PreloadState,
  relationship: Relationship | undefined,
  smartArt: NonNullable<Awaited<ReturnType<typeof readSmartArt>>>,
  extent: Size | undefined,
): Promise<void> => {
  if (!relationship || state.smartArts.has(relationship.target)) return;
  const drawing = await drawingOf(state.pkg, smartArt.claimed, extent, state.theme, state.limits);
  state.smartArts.set(relationship.target, {
    words: smartArt.words,
    levels: smartArt.levels,
    ...(drawing === undefined ? {} : { drawing }),
  });
};

/** Reads the objects of one story ahead of the walk; answers the words of its drawing caches whose model is missing. */
const preloadStory = async (
  state: PreloadState,
  root: XNode,
  relationships: ReadonlyMap<string, Relationship>,
): Promise<string[][]> => {
  const claimed = new Set<string>();
  let modelless = 0;
  for (const object of objectsUnder(root)) {
    if (await preloadObject(state, object, relationships, claimed)) modelless++;
  }
  return cachesWithoutModel(state.pkg, relationships, claimed, modelless);
};

// A SmartArt's outline: one paragraph per piece of the model, each carrying its level, published as a nested bullet
// list (`renderer/storage.ts#renderOutline`). No separator any more: the middle dot joined pieces that shared a line,
// and an item of a list does not share a line with the next one.
const outline = (words: readonly string[], levels: readonly number[]): DiagramTextSection => ({
  inlines: words.map((word) => ({ text: word })),
  ...(words.length > 1 ? { breaks: words.map((_, wordIndex) => wordIndex).slice(1) } : {}),
  levels: words.map((_, wordIndex) => levels[wordIndex] ?? 0),
});

/** The blocks of a SmartArt where its frame stands: its drawing as a picture (when `register` takes it), then its outline. */
const smartArtBlocks = (entry: SmartArtEntry, register: DrawingImageRegistrar): IRBlock[] => {
  const picture = typeof entry.drawing === "object" ? register(entry.drawing.svg, SVG_MIME) : undefined;
  const lines = typeof entry.drawing === "object" && picture !== undefined ? entry.drawing.lines : [];
  const blocks: IRBlock[] = picture === undefined ? [] : [{ kind: "image", ref: picture }];
  if (entry.words.length > 0) {
    // The words no drawn line shows are « not drawn »: kept for a reader of the IR, and no longer a loss — the list publishes them all.
    const undrawn = undrawnWords(entry.words, lines);
    blocks.push({
      kind: "diagramText",
      sections: [{ ...outline(entry.words, entry.levels), ...(undrawn.length > 0 ? { undrawn } : {}) }],
    });
  }
  return blocks;
};

/** Reads the objects of the stories `roots` (each with the relationships of
 *  its part) ahead of the walk. */
export const preloadObjects = async (
  pkg: OpcPackage,
  roots: readonly { root: XNode; rels: ReadonlyMap<string, Relationship> }[],
  limits?: ReaderLimits,
): Promise<DrawingObjects> => {
  const state: PreloadState = { pkg, limits, theme: themeOf(pkg), charts: new Map(), smartArts: new Map() };
  const { charts, smartArts } = state;
  let withheldCount = 0;
  // SmartArts with no data model: their words wait for the end of the
  // gathered block (no reading position is known for them).
  const withoutModel: string[][] = [];
  for (const { root, rels: relationships } of roots) {
    withoutModel.push(...(await preloadStory(state, root, relationships)));
  }
  return {
    chart: (relationships, relId) => {
      const target = findInternalTarget(relationships, relId);
      // No picture: the document's chart is its data table.
      // A relationship that does not resolve is a missing part: said like a damaged one (07/10/2026).
      const { block, withheld } = chartToIr(target !== undefined ? charts.get(target) : "withheld");
      if (withheld) withheldCount++;
      return block;
    },
    chartsWithheld: () => withheldCount,
    smartArt: (relationships, relId, register) => {
      const relationship = relationships.get(relId);
      const entry = relationship ? smartArts.get(relationship.target) : undefined;
      return entry ? smartArtBlocks(entry, register) : [];
    },
    gathered: () => {
      // A drawing cache holds no tree: its words make a flat list, published all the same.
      const sections = withoutModel
        .filter((cacheWords) => cacheWords.length > 0)
        .map((cacheWords): DiagramTextSection =>
          outline(
            cacheWords,
            cacheWords.map(() => 0),
          ),
        );
      return sections.length === 0 ? [] : [{ kind: "diagramText", sections }];
    },
  };
};
