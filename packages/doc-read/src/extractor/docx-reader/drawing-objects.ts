/** The two DrawingML objects a `w:drawing` can hold besides pictures and
 *  shapes: a native CHART (`c:chart`, a part of its own) and a SmartArt
 *  (`dgm:relIds`, a data-model part). Both live in parts the synchronous walk
 *  of `docx-reader/body.ts` cannot inflate, so they are read BEFORE the walk
 *  (`preloadObjects`), by relationship target, and looked up during it.
 *
 *  The chart is read by the SAME code as the pptx and xlsx readers
 *  (`pptx-reader/chart.ts#readChartOrWithheld`), the SmartArt by `extractor/smartart.ts`
 *  (ECMA-376 Part 1 §21.4); a Word chart is a `wp:inline`/`wp:anchor`
 *  `a:graphicData` with uri `…/drawingml/2006/chart` (ECMA-376 Part 1
 *  §20.4.2.8, §21.2.2.27 `c:chart`).
 *  A damaged part gives nothing, never a refusal of the document (as in the
 *  pptx reader). The chart's own rendering image is not taken here: the page
 *  gets the data table (MIKSUDOC « Spécification technique » §5.4).
 *  A SmartArt gives back TWO blocks at the place of its frame (29/10/2026): its drawing as a picture, then its model as
 *  the `diagramText` block the renderer turns into a nested bullet list. Only the drawing caches whose model is missing
 *  still travel through `gathered()` to the end of the document — the file ties them to no frame.
 *  NOT here: the synchronous walk that places them (`docx-reader/body.ts`), the chart parsing (`pptx-reader/chart.ts`)
 *  and the SmartArt reading order (`extractor/smartart.ts`).
 *  Called by: `docx-reader/index.ts`, `docx-reader/body.ts`. */

import { type DiagramTextSection, type IRBlock } from "doc-ir/lib/ir";
import type { Size } from "doc-ir/layout/slide-elements";
import { finiteNumber as num } from "../../lib/ooxml-num";
import { cachesWithoutModel, readSmartArt } from "../smartart";
import { readSmartArtDrawing, themeColorContext, undrawnWords } from "../smartart-drawing";
import { renderSlideSvg } from "../slide-svg";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { chartToIr, type PptxChart, readChartOrWithheld } from "../pptx-reader/chart";
import type { ColorContext } from "../pptx-reader/color";
import { internalTarget, orDamaged, PartDamagedError, relationOfKind, type DocxPackage, type Relationship } from "../ooxml/package";
import type { DrawingImageRegistrar } from "./shapes";
import { attr, child, drawingFrame, graphicData, kids, tagOf, type XNode } from "../ooxml/xml";

/** `true` when the SmartArt data model itself cannot be read (damaged), as opposed to its drawing cache. */
const modelUnreadable = async (pkg: DocxPackage, rel: Relationship): Promise<boolean> => {
  if (rel.external) return false;
  try {
    await pkg.readXml(rel.target);
    return false;
  } catch (e) {
    if (e instanceof PartDamagedError) return true;
    throw e;
  }
};

/** What the `a:graphicData` of a drawing names, by the relationship id. */
export type DrawingObject = { kind: "chart"; relId: string } | { kind: "smartart"; relId: string; extent?: Size };

/** The chart(s) and SmartArt(s) a `w:drawing` holds ITSELF: directly in its
 *  `a:graphicData`, or in a frame of a group (`wpg:graphicFrame`, Word 2010
 *  group). A text box's paragraphs (`w:txbxContent`) are not entered: the
 *  walk reads them as a story, and meets their drawings there. */
export const drawingObjectsOf = (drawing: XNode): DrawingObject[] => {
  const frame = drawingFrame(drawing);
  const data = frame ? graphicData(frame) : undefined;
  if (!data) return [];
  const found: DrawingObject[] = [];
  const walk = (node: XNode): void => {
    for (const k of kids(node)) {
      const tag = tagOf(k);
      if (tag === "w:txbxContent") continue;
      const object = objectOf(k);
      if (object) found.push(object);
      else walk(k);
    }
  };
  walk(data);
  return found;
};

/** A `c:chart` or `dgm:relIds` element. */
const objectOf = (node: XNode): DrawingObject | undefined => {
  const tag = tagOf(node);
  if (tag === "c:chart") {
    const id = attr(node, "r:id");
    return id === undefined ? undefined : { kind: "chart", relId: id };
  }
  if (tag === "dgm:relIds") {
    const id = attr(node, "r:dm");
    return id === undefined ? undefined : { kind: "smartart", relId: id };
  }
  return undefined;
};

/** The `wp:extent` of a `wp:inline` or `wp:anchor` (EMU): the canvas a SmartArt's drawing is cropped to. */
const extentOf = (node: XNode): Size | undefined => {
  if (tagOf(node) !== "wp:inline" && tagOf(node) !== "wp:anchor") return undefined;
  const extent = child(node, "wp:extent");
  const cx = extent === undefined ? undefined : num(attr(extent, "cx"));
  const cy = extent === undefined ? undefined : num(attr(extent, "cy"));
  return cx === undefined || cy === undefined || cx <= 0 || cy <= 0 ? undefined : { cx, cy };
};

/** Every drawing object under `node`, at any depth (a text box, a group, a
 *  Fallback…), document order; a SmartArt with the extent of the drawing around it. */
const objectsUnder = (node: XNode, out: DrawingObject[] = [], extent?: Size): DrawingObject[] => {
  for (const k of kids(node)) {
    const around = extentOf(k) ?? extent;
    const object = objectOf(k);
    if (object) out.push(object.kind === "smartart" && around !== undefined ? { ...object, extent: around } : object);
    else objectsUnder(k, out, around);
  }
  return out;
};

export interface DrawingObjects {
  /** The chart block of a `c:chart r:id` in the part whose relationships are `rels`. `undefined` when there is
   *  none; a chart a bound or a damaged part keeps out is counted (`chartsWithheld`), once per place it stands. */
  chart(rels: ReadonlyMap<string, Relationship>, relId: string): IRBlock | undefined;
  /** How many chart placements `chart` withheld: their title and labels are not on the page. */
  chartsWithheld(): number;
  /** The blocks a `dgm:relIds r:dm` puts WHERE THE FRAME STANDS: its saved drawing as the picture to publish (bytes taken by
   *  `register`), then its model as the `diagramText` block the renderer turns into a nested list. Empty: no drawing (none
   *  saved, damaged, kept out, or the picture allowance spent) AND no word. Mikolaj, 29/10/2026, seeing the lists gathered
   *  at the end of the page: « ils sont bien, mais à la fin……… » — the frame's place is exact in the file and the picture
   *  already used it. */
  smartArt(rels: ReadonlyMap<string, Relationship>, relId: string, register: DrawingImageRegistrar): IRBlock[];
  /** What no frame could carry: the drawing caches whose model is missing, as one diagram-text block at the end of the
   *  document. A cache is tied to no frame by the file (`cachesWithoutModel`), so it has no place of its own to go to. */
  gathered(): IRBlock[];
}

const SVG_MIME = "image/svg+xml";

/** What is kept of a SmartArt between the read ahead of the walk and the walk: its words, and its saved drawing as the picture's bytes and
 *  the lines it draws; "not-drawn": a drawing exists but is kept out (past `MAX_SLIDE_ELEMENTS` shapes, or no canvas to crop it to).
 *  Absent: no drawing to draw (none saved, unlinked, damaged or without a shape). */
interface SmartArtEntry {
  words: string[];
  /** The level of each word in the model's tree (`extractor/smartart.ts`), which the published list nests on. */
  levels: number[];
  drawing?: { svg: Uint8Array; lines: string[] } | "not-drawn";
}

/** The document's theme colours (`word/theme/theme1.xml`), read once and only if a SmartArt's drawing needs them. */
const themeOf = (pkg: DocxPackage): (() => Promise<ColorContext | undefined>) => {
  let read: Promise<ColorContext | undefined> | undefined;
  return () => {
    read ??= (async () => {
      const part = relationOfKind(await pkg.relationships(pkg.mainPart), "theme")?.target;
      return themeColorContext(part === undefined ? undefined : await orDamaged(() => pkg.readXml(part)));
    })();
    return read;
  };
};

/** A SmartArt's saved drawing (`part`, named by its data model) drawn on a canvas of `extent`, the frame's own size: the drawing's space
 *  is the frame's, scale 1 (`extractor/smartart-drawing.ts`). */
const drawingOf = async (
  pkg: DocxPackage,
  part: string | undefined,
  extent: Size | undefined,
  theme: () => Promise<ColorContext | undefined>,
  limits: ReaderLimits | undefined,
): Promise<SmartArtEntry["drawing"]> => {
  const root = part === undefined ? undefined : await orDamaged(() => pkg.readXml(part));
  if (root === undefined) return undefined;
  const read = readSmartArtDrawing(root, await theme(), limits);
  if (read === "too-many") return "not-drawn";
  if (read.shapes.length === 0) return undefined;
  if (extent === undefined) return "not-drawn";
  const { svg, smartArtText } = renderSlideSvg(read.shapes, extent);
  return { svg: new TextEncoder().encode(svg), lines: smartArtText };
};

/** Reads the objects of the stories `roots` (each with the relationships of
 *  its part) ahead of the walk. */
export const preloadObjects = async (
  pkg: DocxPackage,
  roots: readonly { root: XNode; rels: ReadonlyMap<string, Relationship> }[],
  limits?: ReaderLimits,
): Promise<DrawingObjects> => {
  const charts = new Map<string, PptxChart | "withheld" | undefined>();
  let withheld = 0;
  const smartArts = new Map<string, SmartArtEntry>();
  const theme = themeOf(pkg);
  // SmartArts with no data model: their words wait for the end of the
  // gathered block (no reading position is known for them).
  const withoutModel: string[][] = [];
  for (const { root, rels } of roots) {
    const claimed = new Set<string>();
    let modelless = 0;
    for (const object of objectsUnder(root)) {
      const rel = rels.get(object.relId);
      const target = internalTarget(rels, object.relId);
      try {
        if (object.kind === "chart") {
          if (target !== undefined && !charts.has(target)) charts.set(target, await readChartOrWithheld(pkg, target, { picture: false, limits }));
          continue;
        }
        // `r:dm` names the data-model part itself.
        const read = target !== undefined ? await readSmartArt(pkg, rels, target) : undefined;
        if (read?.claimed !== undefined) claimed.add(read.claimed);
        if (read === undefined) modelless++;
        else if (rel && !smartArts.has(rel.target)) {
          const drawing = await drawingOf(pkg, read.claimed, object.kind === "smartart" ? object.extent : undefined, theme, limits);
          smartArts.set(rel.target, { words: read.words, levels: read.levels, ...(drawing === undefined ? {} : { drawing }) });
        }
      } catch (e) {
        // A damaged part: the object gives nothing, the document stands.
        if (!(e instanceof PartDamagedError)) throw e;
        if (rel && (await modelUnreadable(pkg, rel))) modelless++; // the words fall back on the drawing cache, as for an absent model
        else if (rel) smartArts.set(rel.target, { words: [], levels: [] });
      }
    }
    withoutModel.push(...(await cachesWithoutModel(pkg, rels, claimed, modelless)));
  }
  // A SmartArt's outline: one paragraph per piece of the model, each carrying its level, published as a nested bullet
  // list (`renderer/storage.ts#renderOutline`). No separator any more: the point médian joined pieces that shared a line,
  // and an item of a list does not share a line with the next one.
  const outline = (words: readonly string[], levels: readonly number[]): DiagramTextSection => ({
    inlines: words.map((w) => ({ text: w })),
    ...(words.length > 1 ? { breaks: words.map((_, i) => i).slice(1) } : {}),
    levels: words.map((_, i) => levels[i] ?? 0),
  });
  return {
    chart: (rels, relId) => {
      const target = internalTarget(rels, relId);
      // No picture: the document's chart is its data table.
      // A relationship that does not resolve is a missing part: said like a damaged one (Mikolaj, 07/10/2026).
      const { block, withheld: kept } = chartToIr(target !== undefined ? charts.get(target) : "withheld");
      if (kept) withheld++;
      return block;
    },
    chartsWithheld: () => withheld,
    smartArt: (rels, relId, register) => {
      const rel = rels.get(relId);
      const entry = rel ? smartArts.get(rel.target) : undefined;
      if (!entry) return [];
      const picture = typeof entry.drawing === "object" ? register(entry.drawing.svg, SVG_MIME) : undefined;
      const lines = typeof entry.drawing === "object" && picture !== undefined ? entry.drawing.lines : [];
      const blocks: IRBlock[] = picture === undefined ? [] : [{ kind: "image", ref: picture }];
      if (entry.words.length > 0) {
        // The words no drawn line shows are « not drawn »: kept for a reader of the IR, and no longer a loss — the list publishes them all.
        const undrawn = undrawnWords(entry.words, lines);
        blocks.push({ kind: "diagramText", sections: [{ ...outline(entry.words, entry.levels), ...(undrawn.length > 0 ? { undrawn } : {}) }] });
      }
      return blocks;
    },
    gathered: () => {
      // A drawing cache holds no tree: its words make a flat list, published all the same.
      const sections = withoutModel.filter((w) => w.length > 0).map((w): DiagramTextSection => outline(w, w.map(() => 0)));
      return sections.length === 0 ? [] : [{ kind: "diagramText", sections }];
    },
  };
};
