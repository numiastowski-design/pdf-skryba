/** A drawing's declared SHAPES (`wpg:wgp`/`wps:wsp`, Word 2010's own
 *  DrawingML: [MS-DOCX] 2.5.76-2.5.78) turned into the shape model
 *  `extractor/slide-svg.ts` already draws, and the picture it draws them
 *  into — D2 of MIKSUDOC « Spécification fonctionnelle » §9.5 (voie B): our own SVG
 *  drawer, reused unchanged, on a Word or Google Doc drawing's declared
 *  shapes. Published only once at least one NON-textual element is drawn
 *  (§5.6, decision D2); a drawing made only of text boxes (Essai 11) gives
 *  no picture — its words are already published as text by
 *  `docx-reader/objects.ts`, unaffected by this file. How many shapes are
 *  NOT in the picture is counted (`DrawnShapes#shapesNotDrawn`) but never
 *  composed onto the page (29/09/2026: nothing we write joins a
 *  published page) — it travels as data, for the dashboard.
 *  What is read: a shape's box (`a:xfrm`, scaled through its group's
 *  `a:chOff`/`a:chExt` — `pptx-reader/geometry.ts`, namespace-agnostic), its
 *  preset geometry (`a:prstGeom prst`; a custom one, `a:custGeom`, reads as
 *  none — omitted like any other undrawable geometry, never approximated),
 *  its fill and line — a DIRECT `a:solidFill`/`a:srgbClr` or `a:noFill`
 *  only, no `wps:style` theme reference (no fixture needs one; a shape with
 *  neither writes no visible fill or line) — and its text box's
 *  WordprocessingML paragraphs, each run's size from `w:sz` (half-points:
 *  ECMA-376 §17.3.2.38). A connector is a `wps:wsp` too, told apart by
 *  `wps:cNvCnPr` in place of `wps:cNvSpPr` (Open XML SDK,
 *  `CT_WordprocessingShape`, choice of `cNvSpPr`/`cNvCnPr`).
 *  What is NOT read: a shape's colour is never a run's own — no fixture
 *  needs one, and every run built here carries no `color`, so
 *  `slide-svg.ts#drawText`'s own fill rule (a filled box keeps its colour
 *  only when EVERY visible run's colour is known) already treats a filled,
 *  texted box as unknown-colour text; `hasNonTextGraphics` below mirrors
 *  that same fact instead of re-deciding it. A `pic:pic` or `wpg:graphicFrame`
 *  inside a group (schema-legal, `WordprocessingGroup`'s `CT_WordprocessingGroup`
 *  choice, ECMA-376/[MS-DOCX] 2.5.78 — Microsoft Learn, 29/09/2026) is never
 *  turned into a drawn shape here — a `pic:pic`'s own picture, when it can be
 *  read, is already published on its own by `docx-reader/objects.ts#collect`
 *  — but it counts in `shapesNotDrawn` (`DrawingShapes#unwalked`) like any
 *  other omission, instead of vanishing silently.
 *  `readDrawingDiagram` (end of file) reads, of the SAME shapes, only what puts
 *  the text boxes in the order of their connectors (milestone 1 of the
 *  diagram text): each text box's box, the lines' ends and arrow heads.
 *  NOT here: which content of a drawing is published as TEXT
 *  (`docx-reader/objects.ts`, `docx-reader/body.ts`), the drawer itself
 *  (`extractor/slide-svg.ts`), nor pptx's `picture-not-drawn` notice for a
 *  picture the SAME drawer omits (`extractor/pptx.ts`, dashboard-only —
 *  unrelated: a Word drawing counts WHOLE shapes, not pictures).
 *  Called by: `docx-reader/body.ts`. */

import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import type { IRBlock } from "doc-ir/lib/ir";
import { finiteNumber as num } from "../../lib/ooxml-num";
import { solidFillColor, writtenFillOf, type PptxFill } from "../pptx-reader/color";
import {
  frameOf,
  type GroupLevel,
  groupLevel,
  lineEnds,
  type LineEnds,
  throughGroups,
  turnsOrMirrors,
  visibleBox,
} from "../pptx-reader/geometry";
import type { Box } from "doc-ir/layout/slide-elements";
import type { PptxConnectorShape, PptxShape, PptxTextShape } from "../pptx-reader/shapes";
import type { PptxParagraph, PptxRun } from "../pptx-reader/text";
import {
  BENT_CONNECTORS,
  DRAWN_GEOMETRIES,
  renderSlideSvg,
  STRAIGHT_CONNECTORS,
  type SlideSvgOmission,
} from "../slide-svg";
import { connectorBody, groupTurnedOf, guidesOf, isNotLabel, arrowAt, presetOf, shapeBase } from "../pptx-reader/shape-parts";
import { attributeOf, findChild, findChildren, findDrawingFrame, findGraphicData, childNodesOf, qualifiedNameOf, textContentOf, type XNode } from "../ooxml/xml";

/** `p:spPr`'s fill — DIRECT only (decided in this file's header): no
 *  `wps:style` reference is read, so a shape with no `a:noFill`/`a:solidFill`
 *  written draws no fill, never falling back to a theme. */
const fillOf = (spPr: XNode | undefined): PptxFill => {
  const written = writtenFillOf(spPr);
  if (written === undefined) return "none";
  switch (qualifiedNameOf(written)) {
    case "a:noFill":
      return "none";
    case "a:solidFill":
      return solidFillColor(written) ?? "unknown";
    default:
      return "unknown";
  }
};

/** `a:ln`'s fill shows unless it writes `a:noFill`; no `a:ln` at all shows
 *  nothing (no style-reference fallback, this file's header). */
const lineShownOf = (spPr: XNode | undefined): boolean => {
  const written = writtenFillOf(findChild(spPr ?? {}, "a:ln"));
  return written !== undefined && qualifiedNameOf(written) !== "a:noFill";
};

/** A connector's line shows unless its `a:ln` writes `a:noFill`; with no
 *  written fill, when its `wps:style` references a line (`a:lnRef idx` above
 *  0) — Word's own connector is exactly that (`Doc1.docx`). */
const connectorLineShown = (node: XNode, spPr: XNode | undefined): boolean => {
  const written = writtenFillOf(findChild(spPr ?? {}, "a:ln"));
  if (written !== undefined) return qualifiedNameOf(written) !== "a:noFill";
  const ref = findChild(findChild(node, "wps:style") ?? {}, "a:lnRef");
  const idx = ref === undefined ? undefined : num(attributeOf(ref, "idx"));
  return idx !== undefined && idx > 0;
};

/** ST_HpsMeasure (ECMA-376 §17.18.87): a whole number of half-points. */
const runSizeOf = (rPr: XNode | undefined): number | undefined => {
  const raw = rPr ? attributeOf(findChild(rPr, "w:sz") ?? {}, "w:val") : undefined;
  const n = num(raw);
  return n !== undefined && n > 0 ? n / 2 : undefined;
};

/** A text box's `w:p` as a paragraph the drawer reads: its runs' text and
 *  written size only (`extractor/slide-svg.ts` needs no more — marks,
 *  colour, alignment and lists are the PAGE's concern, already read by
 *  `docx-reader/body.ts` for the SAME paragraph, published as text). A run
 *  with no `w:t` (Essai 13's trailing formatting-only run) gives nothing. */
const shapeParagraph = (p: XNode): PptxParagraph => {
  const runs: PptxRun[] = [];
  for (const r of findChildren(p, "w:r")) {
    const text = findChildren(r, "w:t").map(textContentOf).join("");
    if (text === "") continue;
    const size = runSizeOf(findChild(r, "w:rPr"));
    runs.push({ text, ...(size === undefined ? {} : { size }) });
  }
  return { runs };
};

let spTreeIndex = 0;

const readShape = (node: XNode, levels: readonly GroupLevel[]): PptxShape => {
  const spPr = findChild(node, "wps:spPr");
  const frame = frameOf(findChild(spPr ?? {}, "a:xfrm"));
  const transform = throughGroups(levels);
  const geometry = presetOf(spPr);
  const base = shapeBase(spTreeIndex++, frame, transform);
  if (findChild(node, "wps:cNvCnPr") !== undefined) {
    const connector: PptxConnectorShape = {
      kind: "connector",
      ...base,
      ...connectorBody(spPr, frame, transform, connectorLineShown(node, spPr)),
    };
    return connector;
  }
  const content = findChild(findChild(node, "wps:txbx") ?? {}, "w:txbxContent");
  const adj = guidesOf(spPr)["adj"];
  const shape: PptxTextShape = {
    kind: "text",
    ...base,
    paragraphs: content ? findChildren(content, "w:p").map(shapeParagraph) : [],
    ...(geometry === undefined ? {} : { geometry }),
    ...(adj === undefined ? {} : { adj }),
    fill: fillOf(spPr),
    lineShown: lineShownOf(spPr),
    ...groupTurnedOf(transform),
  };
  return shape;
};

/** The picture's canvas, in EMU: `wp:extent`. */
export interface DrawingCanvas {
  cx: number;
  cy: number;
}

interface DrawingShapes {
  shapes: PptxShape[];
  canvas: DrawingCanvas;
  /** A `pic:pic` or `wpg:graphicFrame` met while walking a group: schema-legal
   *  but never turned into a `PptxShape` (this file's header) — counted here
   *  so `drawnShapeBlocks` can still add it to `shapesNotDrawn`. */
  unwalked: number;
}

/**
 * A `w:drawing`'s declared shapes, walking its `a:graphicData`: a single
 * `wps:wsp` written directly (Essai 11's lone text box, `graphicData` uri
 * ".../wordprocessingShape") or a `wpg:wgp` group of them (Essai 13,
 * ".../wordprocessingGroup") — the uri itself is not read, only the
 * children present, like `docx-reader/objects.ts#collect`. `undefined`
 * without a usable `wp:extent` or graphic data; an empty `shapes` list
 * (a picture-only drawing: no `wps:wsp`/`wpg:wgp` at all) is a normal result,
 * not an error — the caller then has nothing to draw.
 */
const readDrawingShapes = (drawing: XNode): DrawingShapes | undefined => {
  const frame = findDrawingFrame(drawing);
  if (!frame) return undefined;
  const extent = findChild(frame, "wp:extent");
  const cx = extent ? num(attributeOf(extent, "cx")) : undefined;
  const cy = extent ? num(attributeOf(extent, "cy")) : undefined;
  if (cx === undefined || cy === undefined || cx <= 0 || cy <= 0) return undefined;
  const data = findGraphicData(frame);
  if (!data) return undefined;
  const shapes: PptxShape[] = [];
  let unwalked = 0;
  spTreeIndex = 0;
  // `depth` counts GROUP NESTING itself (every `wpg:wgp`/`wpg:grpSp`
  // entered), separately from `levels` (only the groups whose `a:xfrm` gives
  // a scale, `groupLevel`): a group with no readable transform still leaves
  // its members "inside a group" for `unwalked`'s purpose below, even though
  // it adds no `GroupLevel`.
  const walk = (nodes: readonly XNode[], levels: readonly GroupLevel[], depth: number): void => {
    for (const node of nodes) {
      switch (qualifiedNameOf(node)) {
        case "wpg:wgp":
        case "wpg:grpSp": {
          const level = groupLevel(findChild(node, "wpg:grpSpPr"));
          walk(childNodesOf(node), level === undefined ? levels : [...levels, level], depth + 1);
          break;
        }
        case "wps:wsp":
          shapes.push(readShape(node, levels));
          break;
        case "pic:pic":
        case "wpg:graphicFrame":
          // Only INSIDE a group (this file's header): a bare top-level
          // `pic:pic` is an ordinary picture drawing (no `wps:wsp`/`wpg:wgp`
          // at all), read entirely by `docx-reader/objects.ts` — not a shape
          // this file omits.
          if (depth > 0) unwalked++;
          break;
        default:
          break;
      }
    }
  };
  walk(childNodesOf(data), [], 0);
  return { shapes, canvas: { cx, cy }, unwalked };
};

/** Whether `shape` draws something OTHER than text: the exact condition
 *  `extractor/slide-svg.ts#drawText`/`drawConnector` draw a box or a line
 *  under — restated here (not imported: it lives deep inside a drawing loop)
 *  so the publish-or-not decision (D2) never guesses at what was actually
 *  drawn. The one shortcut taken (documented in this file's header): a run
 *  built here never carries a `color`, so a box that also has visible text
 *  is NEVER counted as a known fill, exactly like `drawText` itself decides
 *  once every run's colour is unknown. */
const hasNonTextGraphics = (shape: PptxShape): boolean => {
  if (shape.kind === "text") {
    if (!DRAWN_GEOMETRIES.has(shape.geometry ?? "")) return false;
    if (shape.rot !== undefined || shape.groupTurned) return false;
    const hasText = shape.paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== ""));
    const fillKnown = !hasText && shape.fill !== "none" && shape.fill !== "unknown";
    return fillKnown || shape.lineShown;
  }
  if (shape.kind === "connector") {
    const geometry = shape.geometry ?? "";
    return shape.visibleLine && (STRAIGHT_CONNECTORS.has(geometry) || (BENT_CONNECTORS.has(geometry) && shape.path !== undefined));
  }
  return false;
};

/** Every `SlideSvgOmission` reason that means a shape is not drawn AT ALL
 *  (as opposed to `turned-text`/`size-not-declared`, where its outline still
 *  is): what "N shapes not drawn" counts. */
const WHOLE_SHAPE_OMISSIONS: readonly SlideSvgOmission[] = [
  "geometry",
  "turned",
  "connector-geometry",
  "no-box",
  "frame",
  "picture-not-published",
  "picture-over-cap",
  "picture-group-stretched",
];

const shapesNotDrawnCount = (omitted: Partial<Record<SlideSvgOmission, number>>): number =>
  WHOLE_SHAPE_OMISSIONS.reduce((sum, reason) => sum + (omitted[reason] ?? 0), 0);

/** Registers a self-described image's bytes and answers its reference, or
 *  `undefined` when the document's picture byte budget is spent —
 *  `docx-reader/index.ts#readDocx`'s own drawing-image registry, threaded
 *  through `ReadContext` (`docx-reader/body.ts`). */
export type DrawingImageRegistrar = (bytes: Uint8Array, mimeType: string) => { sha256: string; mimeType: string } | undefined;

const SVG_MIME = "image/svg+xml";

/** One `w:drawing`'s result: its picture (`[]` when nothing NON-textual is
 *  drawn, D2 — a drawing made only of text boxes, Essai 11, gives no
 *  picture, its words stay published as before) and how many of its
 *  declared shapes are not in it. `shapesNotDrawn` is NEVER put on the page
 *  (29/09/2026: nothing composed may join a published page) — it is display-only data for the dashboard, carried up through
 *  `DocxReadResult#drawingShapesNotDrawn` (`docx-reader/index.ts`) to
 *  `SyncedDocument` and `orchestrator/document-summaries.ts`. */
export interface DrawnShapes {
  blocks: IRBlock[];
  shapesNotDrawn: number;
  /** The drawing's canvas (`wp:extent`), only when it gives a picture: what
   *  Google's own image is matched by (`docx-reader/google-drawings.ts`). */
  canvas?: DrawingCanvas;
}

const NOTHING_DRAWN: DrawnShapes = { blocks: [], shapesNotDrawn: 0 };

export const drawnShapeBlocks = (drawing: XNode, register: DrawingImageRegistrar, limits?: ReaderLimits): DrawnShapes => {
  const parsed = readDrawingShapes(drawing);
  if (!parsed) return NOTHING_DRAWN;
  const { shapes, canvas, unwalked } = parsed;
  // A group whose only members are a `pic:pic`/`wpg:graphicFrame` (or that
  // draws nothing non-textual) gives no picture of ours — but `unwalked`
  // must still surface: an early return of `NOTHING_DRAWN` here silently
  // dropped it (the fix this file makes).
  if (shapes.length === 0 || !shapes.some(hasNonTextGraphics)) return { blocks: [], shapesNotDrawn: unwalked };
  // The pptx element cap, reused (starting value to calibrate,
  // `lib/reader-limits.ts`): a drawing past it is not drawn at all.
  if (shapes.length > (limits?.slideElements ?? NO_CAP)) return { blocks: [], shapesNotDrawn: shapes.length + unwalked };
  const { svg, omitted } = renderSlideSvg(shapes, canvas);
  const ref = register(new TextEncoder().encode(svg), SVG_MIME);
  // Byte budget spent (IMAGE_MAX_TOTAL_BYTES, counted by the registrar): the
  // same « shapes not drawn » path, no picture.
  if (ref === undefined) return { blocks: [], shapesNotDrawn: shapes.length + unwalked };
  return { blocks: [{ kind: "image", ref }], shapesNotDrawn: shapesNotDrawnCount(omitted) + unwalked, canvas };
};

/** What the connectors of ONE drawing say about its text boxes: each text
 *  box's `w:txbxContent` node with its box, the connectors' line ends and
 *  arrow heads, and the other shapes (touched by a line end, never read).
 *  Coordinates are EMU in the DRAWING's own space, its top-left corner being
 *  (0, 0): the drawing's anchor offsets place it among its neighbours
 *  (`docx-reader/body.ts`). Word declares no `a:stCxn`/`a:endCxn` on the
 *  files measured (01/10/2026: 9 connectors of 3 documents, so a Word
 *  connector drawn by hand is not glued): geometry alone, so none is read here. */
export interface DrawingDiagram {
  texts: Map<XNode, { box: Box; notLabel: boolean }>;
  obstacles: Box[];
  connectors: { ends: LineEnds; startArrow: boolean; endArrow: boolean; visible: boolean }[];
}

export const readDrawingDiagram = (drawing: XNode, limits?: ReaderLimits): DrawingDiagram | undefined => {
  const frame = findDrawingFrame(drawing);
  const data = frame ? findGraphicData(frame) : undefined;
  if (!data) return undefined;
  const found: DrawingDiagram = { texts: new Map(), obstacles: [], connectors: [] };
  const walk = (nodes: readonly XNode[], levels: readonly GroupLevel[], origin: { x: number; y: number } | undefined): void => {
    for (const node of nodes) {
      switch (qualifiedNameOf(node)) {
        case "wpg:wgp":
        case "wpg:grpSp": {
          const grpSpPr = findChild(node, "wpg:grpSpPr");
          const level = groupLevel(grpSpPr);
          const own = frameOf(findChild(grpSpPr ?? {}, "a:xfrm"));
          walk(childNodesOf(node), level === undefined ? levels : [...levels, level], origin ?? (own === undefined ? undefined : { x: own.x, y: own.y }));
          break;
        }
        case "wps:wsp": {
          const spPr = findChild(node, "wps:spPr");
          const own = frameOf(findChild(spPr ?? {}, "a:xfrm"));
          if (own === undefined) break;
          const transform = throughGroups(levels);
          const at = origin ?? { x: own.x, y: own.y };
          const shift = (x: number, y: number): [number, number] => [x - at.x, y - at.y];
          const seen = visibleBox(own, transform);
          const [bx, by] = shift(seen.x, seen.y);
          const box: Box = { x: bx, y: by, cx: seen.cx, cy: seen.cy };
          if (findChild(node, "wps:cNvCnPr") !== undefined) {
            const ends = lineEnds(own, transform);
            const [x1, y1] = shift(ends.x1, ends.y1);
            const [x2, y2] = shift(ends.x2, ends.y2);
            const ln = findChild(spPr ?? {}, "a:ln");
            found.connectors.push({
              ends: { x1, y1, x2, y2 },
              startArrow: arrowAt(ln, "a:headEnd"),
              endArrow: arrowAt(ln, "a:tailEnd"),
              visible: connectorLineShown(node, spPr),
            });
            break;
          }
          const content = findChild(findChild(node, "wps:txbx") ?? {}, "w:txbxContent");
          if (content === undefined) {
            found.obstacles.push(box);
            break;
          }
          const geometry = presetOf(spPr);
          const turned = own.rot !== 0 || turnsOrMirrors(transform);
          found.texts.set(content, { box, notLabel: isNotLabel(turned, geometry) });
          break;
        }
        default:
          break;
      }
    }
  };
  walk(childNodesOf(data), [], undefined);
  // One drawing past the element cap gives no diagram: its text boxes stay in today's order.
  if (found.texts.size + found.obstacles.length + found.connectors.length > (limits?.slideElements ?? NO_CAP)) return undefined;
  return found;
};
