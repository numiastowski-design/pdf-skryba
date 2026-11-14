/** The adapter of table detection to our reader (pdf.js until 1/11/2026): turns real operators and text items into the segments and fragments the pure
 *  geometry accepts (`layout/geometry.ts`), combines the detection stages into page grids, and takes a few page-level
 *  decisions that need those operators: the OCR text layer (`FULL_PAGE_IMAGE_COVERAGE`), inline image or block
 *  (`INLINE_IMAGE_MAX_HEIGHT_RATIO`, PNG encoding of the inline ones), the bounded column cut above the grids
 *  (`boundedCutAboveGrids`), rule R1, and the second opinion on a grid (`gridHoldsItsContent`).
 *  NOT here: the tolerances and what counts as a grid (`layout/geometry.ts`), nor how a grid becomes a table block
 *  (`extractor/pdf-table-render.ts`).
 *  Called by: `extractor/pdf-open.ts` (`detectPdfPageSignals`) and `tools/image-proximity.ts`; its types by
 *  `extractor/pdf-page-figures.ts` and `extractor/pdf-page-markers.ts`. */

/**
 * PDF table detection — the ADAPTER of our reader (pdf.js until 01/11/2026; docs/ARBITRAGE-TABLEAUX-
 * PDF.md [purged 27/09/2026, git history] §8, milestone 1). All the design decisions (tolerances, what
 * counts as "a grid") live in the PURE module `layout/geometry.ts`;
 * the only work here is to turn a real list of operators and real
 * text items into segments and fragments that this module accepts, then to
 * combine the detection stages of §8.
 *
 * THIS IS THE COUPLED SIDE OF THE BOUNDARY, and it is deliberate: this file was allowed to
 * import `pdfjs-dist` (removed on 01/11/2026), `layout/geometry` never was. On 09/09/2026,
 * the matrix arithmetic, `subpathsToSegments` and
 * `positionKey` moved from here to that module: they were PURE but
 * lived on the wrong side, hence untestable without loading pdf.js.
 *
 * Zero AI (milestone 1's scope, §8). The detection itself writes no page; the inline-image PNGs and the bounded column
 * cut it computes are published by the stages that read its signals.
 */

import { maxOf, minOf } from "doc-ir/lib/extent";
import { type ExtractionCost } from "./extraction-cost";
import { NOT_PAINTED_MODES } from "./glyph-positions";
import { toFragment, type LostPlace } from "./pdf-model";
import { GRAPHICS_STATE_MAX_DEPTH, GraphicsStateStack, HiddenLayerStack, readFormMatrix, type PdfOp, type PdfPathArg } from "./pdf-ops";
import { readPdfSource, type PdfSource, type PdfSourcePage } from "./pdf-source";
import { encodePng } from "doc-ir/extractor/png";

import type { PdfTableDetection } from "doc-ir/layout/geometry";
import {
  assignFragmentsToCells,
  buildGridFromAlignedRows,
  buildGridsFromVectorLines,
  withoutImageFrames,
  findCellsByIntersection,
  isBoxesInVoidsRegion,
  classifyLineSegment,
  detectAlignedColumns,
  dominantTextSize,
  detectColumnGutter,
  groupFragmentsIntoVisualLines,
  hasRepeatedSecondRhythm,
  hasWeakTabularitySignal,
  identifyAlignedTableLines,
  looksLikeTextColumns,
  applyMatrix,
  positionKey,
  subpathsToSegments,
  composeMatrix,
  IDENTITY_MATRIX,
  type CellRect,
  type ClassifiedLine,
  type Matrix2D,
  type MergeMap,
  type PdfTableOrigin,
  type Fragment,
  type LineSegment,
  type TableGrid,
} from "doc-ir/layout/geometry";
import { hiddenRepaintFills, type PaintedBox } from "doc-ir/layout/hidden-repaints";
import { detectMergedCells } from "doc-ir/layout/merged-cells";
import { mergeDoubledBoundaries } from "doc-ir/layout/straddled-boundaries";

export { GRAPHICS_STATE_MAX_DEPTH };

/**
 * Share of the page area that a SINGLE image must cover to count
 * as "the page is a scan" (point 12 of the former ideas log (git history) v0.6, 08/09/2026).
 *
 * **Starting value to calibrate, NOT a measurement.** The reasoning: an archive
 * scan is drawn edge to edge or with a margin of a few millimetres,
 * so 90 to 100%; a logo, a stamp or a signature weigh a few
 * percent; a generous decorative illustration rarely exceeds 60%.
 *
 * And this threshold is NOT the real protection against the false positive — it is the
 * condition "no visible text on the page" that is. A mode-3
 * watermark laid over a perfectly readable contract would satisfy "invisible
 * text exists"; it does not satisfy "all the text is invisible".
 *
 * Known limit: a scan emitted in STRIPS (some scanners cut the
 * page into several images) has no single image above the threshold, and
 * is therefore not detected. Handling the union of the areas would require handling
 * overlaps — not done, recorded.
 */
const FULL_PAGE_IMAGE_COVERAGE = 0.8;


/** A painted image, identified by its object name and its footprint in
 *  page coordinates. */
interface ImageBox {
  name: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** The drawn length of the image's OWN horizontal edge, in points: the unit
   *  square's x axis through the matrix, `hypot(a, b)`. Equals `xMax - xMin`
   *  for an upright image; for a quarter-turned one the box width is its drawn
   *  HEIGHT, while the published bytes are never rotated. */
  drawnWidth: number;
  /** Painted inside an `/Artifact` marked-content sequence — see `walkPage`. */
  artifact: boolean;
}

/** Beyond this height, expressed in multiples of the document's body
 *  text, an image is no longer a marker within a sentence but a block.
 *  Two populations measured on page 2 of a real report card on 11/09/2026:
 *  the two legend badges are 1.03 times the body, the signature image
 *  of the same page is 6.5. **Starting value to calibrate** — a single
 *  document, but the gap between the two populations is a factor of six. */
const INLINE_IMAGE_MAX_HEIGHT_RATIO = 2;

/** Two column boundaries of a vector grid at most this far apart (pt, inclusive), with no fragment centre between them, are the
 *  doubled edge of ONE thick rail and merge (`layout/straddled-boundaries.ts`). Starting value to calibrate, measured 27/10/2026:
 *  doubled rails 3.7-3.84 pt (141-sand p70); narrowest real column WITH text 4.73 pt, kept by the fragment-centre guard
 *  (106-fedramp p24); narrowest empty box to preserve 15.1 pt (safedocs 0000523 p1 comb). The value is ALSO capped by geometry
 *  (review of 27/10/2026): an inner merge lands at the pair's midpoint, and `merged-cells.ts` only recognises a boundary within
 *  SAME_POSITION_PT (2 pt) of a painted stroke — past 2 x 2 pt the midpoint belongs to no stroke and every row reads a colspan
 *  across it, collapsing the table. So 4, not 5: [3.84, 4.73] still separates the populations. */
const DOUBLED_RAIL_MAX_GAP_PT = 4;

/** How far it is worth LOOKING at a pair of tight boundaries (the short-circuit below). It is not a
 *  decision threshold: beyond `DOUBLED_RAIL_MAX_GAP_PT`, only a pair that TEXT CROSSES collapses, and the
 *  measurement of 30/10/2026 (77 PDFs, 445 grids, 193 columns under 12 pt) gives its bound — crossed slivers
 *  go up to 11.5 pt, the only populated narrow column is 6.50 pt and its text protects it. */
const MAX_NARROW_COLUMN_LOOK_PT = 12;

/** A filled rectangle inside a strictly larger one of the SAME colour, within this many pt on each edge, is an invisible repaint:
 *  its edges are not row boundaries (`layout/hidden-repaints.ts`). Starting value to calibrate, measured 27/10/2026 on 32 Word
 *  PDFs: real overshoot of a band past its container 0.12 pt; real inset of a band in its frame 2.88 pt. */
const REPAINT_CONTAINMENT_LIMIT_PT = 0.3;

/** A hidden repaint SPANS its container: the container is at most twice this wider (left plus right insets). Starting value to
 *  calibrate, measured 27/10/2026: insets of real repaints 2.88 / 5.15 / 5.4 pt per side; a same-colour nested cell shading is
 *  95 pt or more narrower than its frame (06-homes p8: 122 and 333 pt in 523 pt), and its edges are the form's only row structure. */
const REPAINT_MAX_INSET_PT = 8;

/** A hidden repaint is also at least this fraction of its container's width. Starting value to calibrate, in the middle of the gap,
 *  measured 27/10/2026: the tick mark of a small round swatch 0.25 (071 p7: 3.4 pt in 13.7); the narrowest real repaint 0.83
 *  (071 p10; jvmalin 0.98 and more, osfi 0.85 and more). */
const REPAINT_WIDTH_RATIO_LIMIT = 0.5;

/**
 * The PIXELS of a page image, encoded as PNG. Returns `undefined` as soon as
 * anything is missing — absent object, unhandled pixel format, inconsistent
 * dimensions: a half-read image would be published as an image, hence
 * "plausible and wrong".
 *
 * The reading of the object and the translation of its format have lived in
 * `./pdf-images` since 14/09/2026: `{width, height, kind, data}`
 * is declared nowhere in pdf.js, and `ImageKind` is on the contrary
 * publicly exported there. Only the encoding remains here.
 */
function encodeImageObject(page: PdfSourcePage, name: string): Uint8Array | undefined {
  const image = page.readImage(name);
  if (image === undefined) return undefined;
  return encodePng(image.width, image.height, image.format, image.data);
}

/** An image placed INSIDE a text line, ready to be published. */
export interface InlineImage {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  png: Uint8Array;
}

/** A large image of the page: its footprint and the number of its PDF object. */
export interface BlockImage {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  ref: string;
  /** The object's name on ITS page, to re-read its pixels (`PdfSourcePage.readImage`)
   *  when pdf-lib cannot copy its stream. */
  name: string;
  /** See `ImageBox.drawnWidth`. */
  drawnWidth: number;
  /** See `ImageBox.artifact`. */
  artifact: boolean;
}

/** A FILLED rectangle with its colour. Data bars are nothing but a run of these, and nothing in the text signals them.
 *  The colour arrives as a hex STRING (the form pdf.js gave, kept) (`"#f80a0a"`), never as three numbers (that misunderstanding made
 *  them look absent). */
type FilledRect = PaintedBox;

interface PageWalk {
  segments: LineSegment[];
  /** ALL the solid rectangles of the page, colour included.
   *
   *  ⚠️ **WHITE CANNOT BE DISCARDED**, contrary to what a first
   *  version of this comment claimed. A report card's legend names
   *  `#ffffff` "not assessed": a white fill IS data. What distinguishes
   *  a cell background from a data fill is therefore not its colour but its
   *  GEOMETRY — a background hugs the boundaries of its cell, a data fill
   *  lives strictly inside. The sorting is done where the grid is known,
   *  never here. */
  filled: FilledRect[];
  /** The painted images of the page, with their footprint and object name.
   *  None is read yet: only their POSITION is known here. */
  imageBoxes: ImageBox[];
  /** The page carries text AND all that text is invisible AND an image
   *  covers the page. All three together, never one alone. */
  ocrLayer: boolean;
}


/** The painting operations, BY NAME. `decodeOps` translates the code of
 *  `constructPath` — it lives in the same space as `OPS` — so this file no
 *  longer needs pdf.js's numeric table (14/09/2026). */
const PAINT_OPS = new Set(["stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);
const FILL_OPS = new Set(["fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);
const STROKE_OPS = new Set(["stroke", "closeStroke", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);

/** Bounding box of every point of the sub-paths under `matrix`, by a loop (no
 *  argument-count limit, unlike `Math.max(...xs)`); `undefined` when there is no point. */
function boundingBox(
  subpaths: readonly (readonly { x: number; y: number }[])[],
  matrix: Matrix2D,
): { xMin: number; xMax: number; yMin: number; yMax: number } | undefined {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let any = false;
  for (const subpath of subpaths) {
    for (const p of subpath) {
      const q = applyMatrix(matrix, p.x, p.y);
      xMin = Math.min(xMin, q.x);
      xMax = Math.max(xMax, q.x);
      yMin = Math.min(yMin, q.y);
      yMax = Math.max(yMax, q.y);
      any = true;
    }
  }
  return any ? { xMin, xMax, yMin, yMax } : undefined;
}

/** The part of the graphics state `walkPage` reads. `lineWidth` AND THE FILL COLOUR are part of the graphics state
 *  just like the matrix: pushed and popped with it, never tracked on the side.
 *
 *  ⚠️ THIS COMMENT CLAIMED THE OPPOSITE for the colour ("the last one set holds
 *  until the next one"), corrected 15/09/2026. The PDF standard puts it in the
 *  state that `q`/`Q` save. Measured on fixture 24, page 1: a red text
 *  set inside a `save`…`restore`, then a frame filled with no new colour —
 *  white in the document, published as a RED box.
 *  `fillAlpha` is the fill opacity `ca` of the graphics state (`gs`), saved and
 *  restored with the rest. */
interface WalkState {
  matrix: Matrix2D;
  textMode: number;
  lineWidth: number;
  fillColor: string;
  fillAlpha: number;
}

/** What one walk over a page's operators carries from one operator to the next, and what it collects. */
interface PageWalker {
  stack: GraphicsStateStack<WalkState>;
  /** ⚠️ MARKED CONTENT HAS ITS OWN STACK, which is NOT the graphics state:
   *  `BDC`/`BMC`…`EMC` nest independently of `q`/`Q`. So we push on the
   *  side, one boolean per level — "is this level an /Artifact?".
   *
   *  WHY WE TRACK IT (ISO 32000-1 §14.8.2.2.2, table 330). The standard says that
   *  running headers and footers "shall be identified as Pagination
   *  artifacts": an artifact is not author content and leaves the reading
   *  order. The document itself declares it — no threshold, no
   *  geometry, no repetition. Nothing is removed on this basis: the images the
   *  document declares as artifacts are published like the others. */
  markedIsArtifact: boolean[];
  /** Number of open Artifact levels, kept beside the stack so an image test is O(1). */
  artifactDepth: number;
  /** Optional-content levels, beside the artifact stack (same independence from `q`/`Q`). */
  layers: HiddenLayerStack;
  pageArea: number;
  segments: LineSegment[];
  filled: FilledRect[];
  /** For each pure fill (no stroke), the range of `segments` its four edges produced, so the edges of a hidden repaint can be
   *  dropped at the end of the page, once every fill is known. */
  fillEdges: { fill: FilledRect; from: number; to: number }[];
  imageBoxes: ImageBox[];
  visibleTextOps: number;
  invisibleTextOps: number;
  maxImageCoverage: number;
}

/** The fill opacity an ExtGState sets: it arrives as `[[key, value], …]` (the shape pdf.js gave); only `ca` is read, the last one wins.
 *  `current` when it sets none. */
function fillAlphaOf(args: unknown, current: number): number {
  let alpha = current;
  const entries = (args as unknown[] | null)?.[0];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (Array.isArray(entry) && entry[0] === "ca" && typeof entry[1] === "number") alpha = entry[1];
    }
  }
  return alpha;
}

/** The operators that change the graphics state: `q`/`Q`, form XObjects, `cm`, line width, fill colour, `gs`, `Tr`. */
function applyStateOp(op: string, args: unknown, walker: PageWalker): void {
  const { stack } = walker;
  const top = stack.current;
  if (op === "save") {
    stack.save();
  } else if (op === "restore") {
    stack.restore();
  } else if (op === "paintFormXObjectBegin") {
    // A form XObject runs in its own graphics state, and its /Matrix is
    // concatenated to the current one before its content (ISO 32000-1 8.10.1).
    // Past the depth cap the form is not isolated; its End is paired the same way.
    const formMatrix = readFormMatrix(args);
    stack.form((cur) => ({ ...cur, matrix: formMatrix === undefined ? cur.matrix : composeMatrix(formMatrix, cur.matrix) }));
  } else if (op === "paintFormXObjectEnd") {
    stack.restore();
  } else if (op === "transform") {
    // The matrix arrives UNTRAPPED — `decodeOps` absorbed the four encodings
    // of pdf.js.
    top.matrix = composeMatrix(args as Matrix2D, top.matrix);
  } else if (op === "setLineWidth") {
    top.lineWidth = (args as number[])[0] ?? top.lineWidth;
  } else if (op === "setFillRGBColor") {
    // The colour arrives (as pdf.js returned it) as a hexadecimal STRING (`"#f80a0a"`), never as
    // three numbers — the misunderstanding that made colours look absent
    // from the pipeline until 11/09/2026.
    top.fillColor = String((args as string[])[0] ?? top.fillColor);
  } else if (op === "setGState") {
    top.fillAlpha = fillAlphaOf(args, top.fillAlpha);
  } else if (op === "setTextRenderingMode") {
    top.textMode = (args as number[])[0] ?? 0;
  }
}

/** `BDC`/`BMC` and `EMC`: the artifact stack and the optional-content stack move together. */
function applyMarkedContentOp(op: string, args: unknown, walker: PageWalker, isLayerVisible: ((group: unknown) => boolean) | undefined): void {
  if (op === "endMarkedContent") {
    if (walker.markedIsArtifact.pop() === true) walker.artifactDepth -= 1;
    walker.layers.leave();
    return;
  }
  const isArtifact = Array.isArray(args) && args[0] === "Artifact";
  walker.markedIsArtifact.push(isArtifact);
  if (isArtifact) walker.artifactDepth += 1;
  walker.layers.enter(op, args, isLayerVisible);
}

/** A text-showing operator counts as visible or invisible text, unless it sits in a layer that is switched off. */
function countShownText(walker: PageWalker): void {
  if (walker.layers.hidden) return;
  if (NOT_PAINTED_MODES.has(walker.stack.current.textMode)) walker.invisibleTextOps += 1;
  else walker.visibleTextOps += 1;
}

/** An image is painted in the unit square: the determinant of the current matrix IS its area in points, and its box
 *  is the unit square's two opposite corners through the matrix. The name is what will later fetch its pixels from
 *  `page.objs` — here we only note where it is, never what it is worth (11/09/2026). */
function recordImage(walker: PageWalker, args: unknown): void {
  const top = walker.stack.current;
  const { a, b, c, d } = top.matrix;
  const area = Math.abs(a * d - b * c);
  if (walker.pageArea > 0) walker.maxImageCoverage = Math.max(walker.maxImageCoverage, area / walker.pageArea);

  // THE IMAGE'S BOX, kept with its NAME (11/09/2026).
  const name = (args as unknown[])[0];
  if (typeof name === "string") {
    const p0 = applyMatrix(top.matrix, 0, 0);
    const p1 = applyMatrix(top.matrix, 1, 1);
    walker.imageBoxes.push({
      name,
      xMin: Math.min(p0.x, p1.x),
      xMax: Math.max(p0.x, p1.x),
      yMin: Math.min(p0.y, p1.y),
      yMax: Math.max(p0.y, p1.y),
      drawnWidth: Math.hypot(a, b),
      artifact: walker.artifactDepth > 0,
    });
  }
}

/** The thickness of a painted path. THE THICKNESS CANNOT BE READ ON THE SEGMENT, it only lives in the
 *  path it comes from — measured 10/09/2026. `subpathsToSegments`
 *  reduces a filled rectangle to its four edges: a cell background
 *  16.1 pt high therefore reaches the detector as TWO thin
 *  horizontals, indistinguishable from a rule. It is here, and only here, that the
 *  distinction still exists.
 *
 *  A STROKED path carries the thickness of its stroke, whatever its
 *  shape — the outline of a rectangle is made of four rules. A
 *  FILLED path carries the smallest dimension of its box: its
 *  flat-fill thickness, lying or standing. */
function pathThickness(paint: string, subpaths: PdfPathArg["subpaths"], top: WalkState): number {
  const { a, b, c, d } = top.matrix;
  const scale = Math.sqrt(Math.abs(a * d - b * c));
  const thickness = top.lineWidth * scale;
  if (STROKE_OPS.has(paint)) return thickness;
  const box = boundingBox(subpaths, top.matrix);
  return box === undefined ? 0 : Math.min(box.xMax - box.xMin, box.yMax - box.yMin);
}

/** A painted path gives its segments, and, when it is filled, the fill itself. The SHAPE of `constructPath` — envelope and
 *  paint NAME included — has been untrapped by `decodeOps` since 14/09/2026. It used to live here as a comment
 *  ("args[1][0], not args[1]") and was tested nowhere. A path whose paint is not a known one (a clip-only path)
 *  is not painted, so no segments come from it. */
function recordPath(walker: PageWalker, args: unknown): void {
  const { paint, subpaths } = args as PdfPathArg;
  if (paint === undefined || !PAINT_OPS.has(paint)) return;
  const top = walker.stack.current;
  const edgesFrom = walker.segments.length;
  // A loop, not a spread: a spread of a huge path overflows the argument limit.
  for (const segment of subpathsToSegments(subpaths, top.matrix, pathThickness(paint, subpaths, top))) walker.segments.push(segment);

  // THE FLAT FILL ITSELF, kept in addition to its edges (gap 15). A flat fill
  // carries a datum that the text does not carry — the bars of the base
  // table, the legend dots — and its colour survives nowhere
  // else in the chain.
  // A FILL AT ZERO FILL OPACITY LEAVES NO INK, so it is no fill (lot « 33 »,
  // Mikolaj, 22/09/2026). Canva ends each page of fixture 26 with one
  // invisible rectangle per tagged figure (`ca 0`, initial colour black):
  // 13 of them were published as black panels. `ca === 0` is an exact
  // value, not a threshold. A PARTIAL opacity is deliberately NOT decided:
  // no document of the corpus shows one, so nothing to calibrate on. Its
  // edges still reach the grid vote, as before.
  if (FILL_OPS.has(paint) && top.fillAlpha !== 0) {
    const box = boundingBox(subpaths, top.matrix);
    // A DEGENERATE FILL CARRIES NO INK, and the document produces
    // many: a bar encodes ALL its levels, including those whose
    // share is nil — measured, `x=[350.1;350.1]`. To these add the legend
    // dots, of which `decodePathSubpaths` keeps only one point
    // for lack of a way to read their curves.
    if (box !== undefined && box.xMax - box.xMin > 0 && box.yMax - box.yMin > 0) {
      const fill = { color: top.fillColor, ...box };
      walker.filled.push(fill);
      if (!STROKE_OPS.has(paint)) walker.fillEdges.push({ fill, from: edgesFrom, to: walker.segments.length });
    }
  }
}

/** The page's segments, less the HORIZONTAL edges of every fill hidden under a larger one of the same colour (invisible repaints).
 *  Done at the end of the page, because only then is the container known. The hidden repaint's verticals still OUTLINE the painted
 *  region (the container's own short sides are lying-fill ends, out of the vote); only its horizontals cut cells, and only their
 *  removal was verified against the Word truth (9 -> 79 exact row counts, 27/10/2026). The container and fills of another colour
 *  keep all their edges. */
function withoutHiddenRepaintHorizontals(walker: PageWalker): LineSegment[] {
  const hidden = hiddenRepaintFills(walker.filled, REPAINT_CONTAINMENT_LIMIT_PT, REPAINT_MAX_INSET_PT, REPAINT_WIDTH_RATIO_LIMIT);
  const dropped = new Set<number>();
  for (const { fill, from, to } of walker.fillEdges) {
    if (!hidden.has(fill)) continue;
    for (let i = from; i < to; i += 1) if (walker.segments[i]!.y1 === walker.segments[i]!.y2) dropped.add(i);
  }
  return dropped.size === 0 ? walker.segments : walker.segments.filter((_, i) => !dropped.has(i));
}

/** Walks ONE page's real operator list, tracking the graphics-state matrix
 *  stack (`save`/`restore`/`transform`), and returns every straight
 *  segment from a path that was actually PAINTED (stroked or filled — a
 *  clip-only path, never painted, leaves no visible mark and is excluded),
 *  already in page-space (the same PDF-point space `extractTextItems`
 *  uses, per this codebase's own `pdf.ts`/probe precedent — zero further
 *  conversion needed by callers).
 *
 *  Empirically verified (04/09/2026), and NOT how the PDF spec's own `S`/
 *  `f`/`B` operators read: pdf.js's operator-list COMPILER fused "construct
 *  path, then immediately paint it" into a SINGLE `constructPath` fnArray
 *  entry — there is no separate `stroke`/`fill` entry to look for
 *  afterward. The paint operation is encoded as `args[0]` of
 *  `constructPath` itself (its numeric value is literally `OPS.stroke`,
 *  `OPS.fill`, etc. — confirmed by printing both side by side against a
 *  real synthetic `drawLine`). A path whose `args[0]` isn't one of the
 *  known paint codes (e.g. a clip-only path) is simply not painted, so no
 *  segments come from it.
 *
 *  One pass serves both needs, table geometry and OCR-layer detection, the second almost free. The text state (`Tr`)
 *  is part of the graphics state, so it is pushed and popped with the matrix, not tracked aside.
 *
 *  `isLayerVisible` is the optional-content verdict of the document (`HidePolicy.isLayerVisible`): text inside a layer
 *  that is switched off is invisible ("Rien d'invisible"), so it counts as neither visible nor invisible text here. */
export function walkPage(ops: readonly PdfOp[], pageWidth: number, pageHeight: number, isLayerVisible?: (group: unknown) => boolean): PageWalk {
  const walker: PageWalker = {
    stack: new GraphicsStateStack<WalkState>({ matrix: IDENTITY_MATRIX, textMode: 0, lineWidth: 1, fillColor: "#000000", fillAlpha: 1 }),
    markedIsArtifact: [],
    artifactDepth: 0,
    layers: new HiddenLayerStack(),
    pageArea: Math.abs(pageWidth * pageHeight),
    segments: [],
    filled: [],
    fillEdges: [],
    imageBoxes: [],
    visibleTextOps: 0,
    invisibleTextOps: 0,
    maxImageCoverage: 0,
  };

  for (const { op, args } of ops) {
    if (op === "constructPath") recordPath(walker, args);
    else if (op === "showText" || op === "showSpacedText") countShownText(walker);
    // A STENCIL IS AN IMAGE TOO, for the box and for the count (03/11/2026). `/ImageMask true` is a 1-bit picture
    // painted with the fill colour — a monochrome logo, a stamp, a rule. No decoder of ours reads one, and until this
    // day none of the three paths even looked at it: the picture left the page with NOTHING at the counter, the
    // « échec déguisé » the rule of 06/10/2026 forbids. Recorded here, it goes through the ordinary road and comes out
    // counted and named, with the cause `mask`. Measured first: ZERO stencil in the 57 fixtures and the 251 documents
    // of the corpus, so this adds no notice to any document we know — it adds one the day a stencil turns up.
    else if (op === "paintImageXObject" || op === "paintInlineImageXObject" || op === "paintImageMaskXObject") recordImage(walker, args);
    else if (op === "beginMarkedContent" || op === "beginMarkedContentProps" || op === "endMarkedContent") applyMarkedContentOp(op, args, walker, isLayerVisible);
    else applyStateOp(op, args, walker);
  }

  return {
    segments: withoutHiddenRepaintHorizontals(walker),
    filled: walker.filled,
    imageBoxes: walker.imageBoxes,
    ocrLayer: walker.invisibleTextOps > 0 && walker.visibleTextOps === 0 && walker.maxImageCoverage >= FULL_PAGE_IMAGE_COVERAGE,
  };
}

/**
 * ⚠️ `textPositionSignals` DISAPPEARED on 14/09/2026, AND WHAT IT
 * KNEW IS KEPT HERE.
 *
 * It did a SECOND reading of each page's text — `getTextContent` —
 * then glued its results back to the first (`extractTextItems`) by an
 * `(x, y, text)` key. Two reasons for this second reading, both obsolete:
 *
 *  1. **ROTATION.** `unpdf`'s `extractTextItems` DROPS it. Measured on an
 *     axis label at 90° of `11-Brochure-Deux-Colonnes.pdf`:
 *
 *       extractTextItems : { str: "2023", x: 154, y: 320, width: 22.24, dir: "ltr" }
 *       getTextContent   : { str: "2023", transform: [~0, 10, -10, ~0, 154, 320] }
 *
 *     The matrix IS the rotation; `unpdf` consumes it and keeps nothing of it. It
 *     returns a HORIZONTAL box of 22.24 pt for a text that occupies a vertical
 *     strip of 10 pt. The label is therefore declared where it is not, with
 *     a width it does not have — and a few axis labels are enough to
 *     fill a real gutter, which is the entry guard of the discriminant.
 *
 *  2. **WEIGHT.** `extractTextItems` replaces the font name with a generic
 *     family ("sans-serif" for everything, bold included).
 *
 * `readPdfSource` carries both DIRECTLY on each run (`rotated`,
 * `weight`): there are no longer two readings, so nothing left to glue back. The position
 * key survives where it is still used — pairing runs with FRAGMENTS,
 * which are another granularity.
 *
 * WHAT REMAINS A SEPARATE WORKSTREAM: RESTORING the rotated text. Knowing that it
 * is rotated and knowing where to put it back are two questions, and the second awaits
 * a product arbitration — content to take up elsewhere, or decoration to discard
 * like a mute image.
 */

export interface PageTableGrid {
  pageIndex: number;
  origin: PdfTableOrigin;
  /** Present only when a real, usable grid was built — the regime 1
   *  candidate (§8 milestone 2). Absent for `no-grid` (nothing to build a grid
   *  from at all). Callers still need to check the conservation invariant
   *  themselves (`assignFragmentsToCells`'s `ambiguous`) before rendering —
   *  a grid existing here means "one was constructed", not "it's proven
   *  clean". */
  /** The FIRST region of the page. Kept as is: it is the signal that the
   *  dashboard and the tests have read since milestone 1. Rendering, for its part, goes
   *  through `regions` — a page can carry several. */
  grid?: TableGrid;
  /** ALL the tabular regions of the page, in the order the vote
   *  finds them. A page that carries two tables has two (measured on 10/09/2026:
   *  the second was simply lost). Absent for alignment
   *  grids, which only produce one. */
  regions?: readonly { grid: TableGrid; merge?: MergeMap }[];
  /** The merge map, when a vector grid was read — a merged
   *  cell leaves a HOLE in the separators, and this is the only place where
   *  that hole is still visible (`layout/merged-cells`).
   *  Absent for alignment grids: with no border, there is no
   *  separator whose absence would mean anything. */
  merge?: MergeMap;
  /** `vector-borders` only: absent — the grid's own row/col bounds already
   *  delimit the table (anything outside is `outside`, ordinary prose).
   *  `alignment-no-borders` only: which lines (indices into the caller's
   *  OWN `fragmentsByLine`, built from the SAME bytes — see this module's
   *  own doc on why that's safe) are the table, vs surrounding prose. */
  lineRange?: { startLine: number; endLine: number };
}

export interface PdfPageSignals {
  /** What milestone 1/2 of tables produces — unchanged. */
  grids: PageTableGrid[];
  /**
   * Pages where an INVISIBLE text layer covers a full-page scan
   * (point 12 of the former ideas log (git history) v0.6). Deliberately NOT a field of
   * `PageTableGrid`, for two reasons:
   *
   *  1. semantics — `PageTableGrid` describes a TABLE candidate. A scan page
   *     is not one, and most of the pages concerned have
   *     no entry in `grids` (the "ordinary prose" branch pushes
   *     nothing): the signal would be lost for the pages that need it
   *     most;
   *  2. lifetime — `PageTableGrid` is projected onto a PERSISTED signal
   *     (`SyncedDocument.pdfTableDetections`). This signal is not
   *     persisted: it only exists for the duration of an extraction, to steer the
   *     page towards OCR.
   */
  ocrLayerPages: number[];
  /**
   * Pages whose text reads in TWO BANDS, with the x coordinate where to cut
   * (point 13, stage 3). Separate from `grids` for the same reason
   * as `ocrLayerPages`: it is not a table candidate, and this signal is not
   * persisted — it only serves the reading order, for the duration of an
   * extraction.
   */
  columnCuts: { pageIndex: number; cut: number; above?: number }[];
  /**
   * Per page, the positions of the items drawn in BOLD — `positionKey` keys,
   * to be paired with `unpdf`'s items.
   *
   * Separate from `grids` for the same reason as the two previous signals: it
   * is not a table candidate, and it is not persisted. Absent for a
   * page without any bold, rather than an empty set — the distinction has
   * no consequence here, it just avoids keeping empty sets for
   * every page of a document that has none anywhere.
   */
  boldByPage: Map<number, Set<string>>;
  /** The SOLID rectangles of each page, colour included (gap 15). Empty
   *  for a page that carries none.
   *
   *  ⚠️ **NO RENDERING READS THEM SINCE 23/09/2026**: colour
   *  bars are no longer published (`extractor/pdf-table-render.ts`). They
   *  remain measured, and this is a written choice rather than an oversight: the DISCS,
   *  for their part, are still published, they come out of the SAME branch of `walkPage`,
   *  and the two guards of that branch — the zero opacity of lot « 33 », the
   *  degenerate path — are only observable through the fills. Removing them
   *  would remove the only witnesses of rules that still protect the swatches.
   *  To be reopened if the swatches go in turn. */
  filledByPage: Map<number, FilledRect[]>;
  /** The images the SIZE OF A CHARACTER, already encoded as PNG, with their
   *  footprint. These are the markers placed within a text line. Large
   *  images are NOT here — see `INLINE_IMAGE_MAX_HEIGHT_RATIO`. */
  inlineImagesByPage: Map<number, InlineImage[]>;
  /** The images taller than `INLINE_IMAGE_MAX_HEIGHT_RATIO` body sizes, per page:
   *  footprint and object number, not yet read. Absent for a page without any. */
  blockImagesByPage: Map<number, BlockImage[]>;
  /** Per page, the large images the detector left out because our reader gave no reference for them, counted by
   *  cause (`PdfSourcePage.imageFailure`). Added to what `pageFigures` loses at reading time (`extractPdf`). */
  droppedImagesByPage: Map<number, { slow: number; unreadable: number; places: LostPlace[] }>;
  /** Every closed rectangle drawn on a page (`findCellsByIntersection` over all
   *  its strokes). Absent for a page without any. */
  boxesByPage: Map<number, CellRect[]>;
}

/** The cut of a page read as two columns of prose: a gutter, no repeated second line rhythm (a table's), and prose on both
 *  sides. `secondRhythm` is a thunk so the rhythm is only measured once a gutter exists. */
function proseColumnCut(
  fragmentsByLine: readonly Fragment[][],
  gutter: { cut: number } | undefined,
  secondRhythm: () => boolean,
): number | undefined {
  return gutter && !secondRhythm() && looksLikeTextColumns(fragmentsByLine, gutter.cut) ? gutter.cut : undefined;
}

/**
 * A COLUMN CUT IN THE BAND ABOVE THE TABLES, drawn from the INK.
 *
 * The problem (measured on 11/09/2026 on a real report card). The header of page 1
 * is made of two blocks side by side, and it comes out INTERLEAVED line by line: name of
 * the school, title of the report card, address, name of the pupil. Worse, two pairs
 * of neighbouring fragments end up concatenated into a sentence that exists in
 * neither block. `readingSegments` knows how to re-read a page in bands, but
 * stage 0 exits as soon as it finds a vector grid, so this page
 * never received a cut.
 *
 * WHAT SERVES AS THE CUT HERE IS NOT AN INFERRED GUTTER. It is the edge of a
 * cell that is REALLY PAINTED, found by `findCellsByIntersection` — a box
 * drawn in the document. No statistical threshold enters into it: we
 * ask the ink where the separation is, and the corpus has already shown that
 * distance does not know how to answer that question.
 *
 * THREE GUARDS, because a wrong cut costs more than no cut:
 *   1. the cut is BOUNDED above the highest grid — below it, the
 *      lines of a table have text on both sides and the zone would swallow it;
 *   2. no fragment of the band may CROSS the cut;
 *   3. at least one line of the band must carry text on BOTH sides, without
 *      which there is nothing to untangle.
 *
 * A FOURTH SAFEGUARD WAS WRITTEN THEN REMOVED the same day: "the band must
 * have at least four lines". It was not measured, it was a
 * preference, and the fixture caught it with a three-line band. The three
 * guards above already cover what it claimed to cover.
 *
 * On a tie, the smallest x coordinate wins: arbitrary, but
 * deterministic, a condition of the golden master.
 */
function boundedCutAboveGrids(
  classified: readonly ClassifiedLine[],
  fragmentsByLine: readonly Fragment[][],
  grids: readonly TableGrid[],
): { cut: number; above: number } | undefined {
  const gridTop = maxOf(grids.flatMap((g) => g.rowBoundaries), (b) => b);
  const band = fragmentsByLine.filter((line) => line.every((f) => f.y > gridTop));
  if (band.length === 0) return undefined;

  // THE FILTERING PRECEDES THE CALL, AND IT IS NOT COSMETIC.
  // `findCellsByIntersection` sweeps the candidate x AND y coordinates,
  // then, for each corner, looks for the smallest closed cell: its cost
  // grows as the square of the product of the two. Fed with a whole page,
  // it made the two `05b` tests (40 scanned pages) EXCEED the 5 s timeout
  // — measured on 11/09/2026. A cell located above the grid
  // only has edges located above it: restricting the input gives the
  // SAME result for a fraction of the work.
  const aboveGrid = classified.filter((l) => (l.orientation === "vertical" ? l.yMin > gridTop : l.y > gridTop));
  const edges = [...new Set(findCellsByIntersection(aboveGrid).flatMap((c) => [c.xLeft, c.xRight]))].sort((a, b) => a - b);

  let best: { cut: number; straddling: number } | undefined;
  for (const cut of edges) {
    const real = (line: readonly Fragment[]): Fragment[] => line.filter((f) => f.text.trim().length > 0);
    if (band.some((line) => real(line).some((f) => f.x < cut && f.x + f.width > cut))) continue;
    const straddling = band.filter(
      (line) => real(line).some((f) => f.x + f.width / 2 < cut) && real(line).some((f) => f.x + f.width / 2 >= cut),
    ).length;
    if (straddling < MIN_STRADDLING_LINES) continue;
    if (best === undefined || straddling > best.straddling) best = { cut, straddling };
  }
  return best === undefined ? undefined : { cut: best.cut, above: gridTop };
}

/** A single straddling line is ENOUGH, and this is not a low threshold out of optimism.
 *  What proves the separation here is the INK — a really painted cell
 *  edge —, not the number of lines. The count only answers "is there
 *  anything to untangle", and a single straddling line is already a wrong sentence
 *  published: measured on a real report card, a field label glued to the
 *  value of the neighbouring block. Requiring two lines let exactly that through. */
const MIN_STRADDLING_LINES = 1;

/**
 * A GRID WHOSE RUNS DO NOT FIT IS NOT A GRID (14/09/2026).
 *
 * ⚠️ **THIS IS A SECOND OPINION, NOT A STRICTER THRESHOLD**, and that is what
 * makes it a usable guard. The grid was produced by grouping LEFT
 * EDGES; this check counts RUNS against CELLS. The two
 * readings are independent, and where they diverge we abstain — the
 * repository rule, applied to a case where it was missing.
 *
 * ⚠️ **THE SAME RULE ALREADY EXISTED, BUT TOO LATE.** `renderTableRegion`
 * (`pdf.ts`) has always refused to render a region of which a fragment is
 * `ambiguous` or `outside` — same function, `assignFragmentsToCells`. It
 * decided AT RENDERING, when the band already existed: the heading rule abstained
 * then because the remaining prose outside the band no longer represented the
 * document, and on `15` « FACTURE » (20 pt) came out as an ordinary paragraph
 * for that reason alone. No table was lost — it was already refused.
 *
 * MEASURED, and this is what makes the move FREE: the verdict is the same
 * on runs as on glyphs, whereas the detector already has the runs
 * and would have to rebuild the glyphs.
 *
 *     05a  glyphs 0/0      runs 0/0        kept
 *     15   glyphs 322/15   runs 33/1       discarded
 *     17   glyphs 442/0    runs 17/0       discarded
 *     18   glyphs 350/0    runs 14/0       discarded
 *
 * ZERO TOLERANCE, and it is not calibrated: the two populations are 0 on one
 * side and 46 to 82% on the other. There is no grey zone to arbitrate — and an
 * invented threshold here would be a preference, not a measurement.
 */
function gridHoldsItsContent(grid: TableGrid, fragmentsByLine: readonly Fragment[][], merge?: MergeMap): boolean {
  const inRange = fragmentsInRowExtent(grid, fragmentsByLine.flat());
  if (inRange.length === 0) return false;
  const { ambiguous, outside } = assignFragmentsToCells(inRange, grid, merge);
  return ambiguous.length === 0 && outside.length === 0;
}

/** The non-blank fragments whose baseline sits inside the grid's row extent — the ONE scoping rule the second
 *  opinion and the A2 centre guard share (review of 27/10/2026: it was written twice, French names included). */
function fragmentsInRowExtent(grid: TableGrid, fragments: readonly Fragment[]): Fragment[] {
  const bottom = minOf(grid.rowBoundaries, (b) => b);
  const top = maxOf(grid.rowBoundaries, (b) => b);
  return fragments.filter((f) => f.y >= bottom && f.y <= top && f.text.trim().length > 0);
}

/** §8's two-stage detector, orchestrated per page: vector-line prefilter
 *  first (reads the grid FROM the document when real borders are drawn,
 *  highest confidence), x/y clustering on text alignment as the fallback
 *  when no usable grid of lines exists. The richer result milestone 2's regime
 *  1 rendering needs (`grid`/`lineRange` alongside the origin signal milestone
 *  1 already shipped) — `detectPdfTableOrigins` below is now a thin
 *  projection of this, so the two never drift apart. */
export async function detectPdfPageSignals(
  bytes: Uint8Array,
  /** The caller's single read of the boundary: document already opened, items already extracted, so a PDF is not
   *  analysed twice (measured 14/09/2026: two openings and two extractions without it; detections identical on the
   *  twelve fixtures). It also gave the detector pdf.js's full configuration (cMaps, standard fonts) before pdf.js was removed. Optional on
   *  purpose: `detectPdfTableGrids` stays a public entry for tools and tests with bytes only, and then opens the
   *  document itself. */
  partage?: PdfSource,
  /** Work counter, fed at the call sites — see `extraction-cost`. */
  cost?: ExtractionCost,
): Promise<PdfPageSignals> {
  // THE BOUNDARY IS THE ONLY READING (14/09/2026). This file
  // no longer opens a document, no longer calls `extractTextItems`, nor
  // `getTextContent`, nor `getOperatorList`: it receives runs that already carry
  // their weight and their rotation, and operations that are already named.
  const source = partage ?? (await readPdfSource(bytes, { cost, wantOps: (_i, runs) => runs.length > 0 }));

  const results: PageTableGrid[] = [];
  const ocrLayerPages: number[] = [];
  const columnCuts: { pageIndex: number; cut: number; above?: number }[] = [];
  const boldByPage = new Map<number, Set<string>>();
  const filledByPage = new Map<number, FilledRect[]>();
  const inlineImagesByPage = new Map<number, InlineImage[]>();
  const blockImagesByPage = new Map<number, BlockImage[]>();
  const droppedImagesByPage = new Map<number, { slow: number; unreadable: number; places: LostPlace[] }>();
  const boxesByPage = new Map<number, CellRect[]>();

  /** The page's pictures, sorted by their drawn height: a marker in a line below `inlineMaxHeight` (encoded here), a block
   *  above it (read later by its PDF object, `pdf-embedded-images`; one with no object is counted as dropped, by cause). */
  const classifyImages = (pageIndex: number, page: PdfSourcePage, imageBoxes: readonly ImageBox[], inlineMaxHeight: number): void => {
    const inlineImages: InlineImage[] = [];
    const blockImages: BlockImage[] = [];
    for (const [order, box] of imageBoxes.entries()) {
      if (box.yMax - box.yMin > inlineMaxHeight) {
        // A BLOCK, NOT A MARKER (15/09/2026): read from the PDF structure by
        // its object (`pdf-embedded-images`), never re-encoded here.
        const ref = page.imageRef(box.name);
        if (ref === undefined) {
          const dropped = droppedImagesByPage.get(pageIndex) ?? { slow: 0, unreadable: 0, places: [] };
          dropped[page.imageFailure(box.name) ?? "unreadable"] += 1;
          // Named by its ORDER among the page's pictures: this is the very case where our reader gave no object
          // (`imageRef`), so there is no object number to give, and the resource name is written by the file (client
          // content, never in a notice). The cause comes from the boundary, which read the dictionary.
          dropped.places.push({ id: `#${String(order + 1)}`, why: page.imageRefusal(box.name) ?? "bytes" });
          droppedImagesByPage.set(pageIndex, dropped);
          continue;
        }
        blockImages.push({
          xMin: box.xMin,
          xMax: box.xMax,
          yMin: box.yMin,
          yMax: box.yMax,
          ref,
          name: box.name,
          drawnWidth: box.drawnWidth,
          artifact: box.artifact,
        });
        continue;
      }
      const png = encodeImageObject(page, box.name);
      if (png !== undefined) inlineImages.push({ xMin: box.xMin, xMax: box.xMax, yMin: box.yMin, yMax: box.yMax, png });
    }
    if (inlineImages.length > 0) inlineImagesByPage.set(pageIndex, inlineImages);
    if (blockImages.length > 0) blockImagesByPage.set(pageIndex, blockImages);
  };

  for (const [pageIndex, page] of source.pages.entries()) {
    const allFragments = page.runs.map(toFragment);
    if (!page.hasText) {
      // A page with no text: the SAME reading as the `scanned-page` stage and `PdfSourcePage.hasText` (a run of spaces
      // alone is no text). Nothing to build a table from, no OCR layer, no column. Its PICTURES are still sorted and kept
      // (07/10/2026): a cover or a full-page diagram of a document with text is published like any picture. EVERY picture is a block, however small: a marker is placed before a word
      // of its line (`pdf-page-markers.ts#markerBefore`) and this page has none, so a marker would be neither published
      // nor counted. Tried first, then dropped (07/10/2026): sorting against the DOCUMENT's body size. Ugly and visible
      // (a 1-point rule published as a picture) rather than wrong and invisible. A scan's page has no named operator
      // (`pdf-open.ts`): it walks nothing and pays nothing, as before.
      if (page.ops.length > 0) classifyImages(pageIndex, page, walkPage(page.ops, page.width, page.height, page.isLayerVisible).imageBoxes, 0);
      continue;
    }

    // BOLD AND ROTATION ARE ATTRIBUTES OF THE RUN, no longer sets of
    // positions to glue back. Both came from a SECOND reading
    // of the text, paired with the first by an `(x, y, text)` key; the
    // boundary carries them directly.
    const bold = new Set(
      page.runs.filter((r) => r.weight === "bold" && r.text.trim().length > 0).map((r) => positionKey(r.x, r.y, r.text)),
    );
    if (bold.size > 0) boldByPage.set(pageIndex, bold);
    // Rotated runs come out BEFORE any geometric reading: their bounding
    // box is wrong, and the gutter is the entry guard of the column
    // discriminant.
    const rotated = new Set(page.runs.filter((r) => r.rotated).map((r) => positionKey(r.x, r.y, r.text)));
    const fragmentsByLine = groupFragmentsIntoVisualLines(
      rotated.size === 0 ? allFragments : allFragments.filter((f) => !rotated.has(positionKey(f.x, f.y, f.text))),
    );
    if (fragmentsByLine.length === 0) continue;

    const { segments: rawSegments, filled, imageBoxes, ocrLayer } = walkPage(page.ops, page.width, page.height, page.isLayerVisible);
    if (filled.length > 0) filledByPage.set(pageIndex, filled);

    // IMAGES THE SIZE OF A CHARACTER (11/09/2026). A report card places two
    // 16×16 pixel badges on its legend line, right before « Absent »
    // and « Dispensé ». They are neither paths nor text: nothing but
    // their PIXELS describes them, so we copy them.
    //
    // THE THRESHOLD IS RELATIVE TO THE DOCUMENT, and its two populations are measured
    // on page 2 of the report card: the badges are 6.7 pt tall for a body
    // text of 6.5 — that is 1.03 times — while the signature image of the
    // same page is 42.5, that is 6.5 times. Twice the body separates the two
    // without squeezing them. **Starting value to calibrate**, a single document.
    //
    // Large images no longer go through this encoder: they are blocks,
    // read from the PDF structure (15/09/2026).
    const body = dominantTextSize(allFragments);
    if (body !== undefined && body > 0) classifyImages(pageIndex, page, imageBoxes, INLINE_IMAGE_MAX_HEIGHT_RATIO * body);
    if (ocrLayer) ocrLayerPages.push(pageIndex);
    const classified = rawSegments.map(classifyLineSegment).filter((l): l is ClassifiedLine => l !== undefined);
    // Every CLOSED rectangle the page draws: the containers the centred-pair
    // rule measures against (`pdf-line-breaks.ts#centredContainerReader`).
    const boxes = findCellsByIntersection(classified);
    if (boxes.length > 0) boxesByPage.set(pageIndex, boxes);

    // STAGE 0 — the vector grid decides alone: it reads the grid IN the
    // document, where everything else infers it.
    // An image frame is never a grid border (`withoutImageFrames`).
    // RULE R1 (Mikolaj 01/10/2026): a region whose painted cells are boxes separated by voids (>= 2 closed cells, none touching
    // another) is a diagram or a layout of cards, not a table — `isBoxesInVoidsRegion`. It is dropped and the page flows as
    // paragraphs and images in reading order, all words kept. A page left with no region records `no-grid` and must NOT fall to
    // the alignment path (not measured on these pages). Tried and set aside: a page-wide « non-axis edge >= 5 pt » rule (R2)
    // hits test-held tables (0000754 p0-p1: legend arrows of 11.5-15.6 pt; 33-Policy p5: 54 pt), the populations overlap.
    // Known leftover: a lone box (1x1) stays a one-cell table. Curves give no edge at all (decodePathSubpaths stops at one).
    const gridLines = withoutImageFrames(classified, imageBoxes);
    // Rule A2: the doubled edge of one thick rail is ONE column boundary (`straddled-boundaries.ts`). Rows are not touched.
    // The guard reads what the geometry reads (review of 27/10/2026): rotated runs stay out (their boxes are false, see the
    // filter above), and only the fragments inside THIS grid's row extent can veto a merge — prose elsewhere on the page says
    // nothing about the grid's rails (same scoping as `gridHoldsItsContent`). Centres are built per grid, only when one exists.
    let flatFragments: readonly Fragment[] | undefined;
    const allVectorGrids = buildGridsFromVectorLines(gridLines).map((grid) => {
      // Short-circuit: no pair of consecutive boundaries anywhere near delta means nothing to merge and no centres to build.
      const cols = grid.colBoundaries;
      // The short-circuit bound is that of the MEASUREMENT, not of the ceiling: a CROSSED pair collapses beyond
      // `DOUBLED_RAIL_MAX_GAP_PT`, so it still has to be looked at. Measured on 30/10/2026: crossed slivers are
      // 5.67 pt on average and go up to 11.5; the only POPULATED narrow column of the corpus is 6.50 pt and the fragment
      // centres guard protects it.
      if (!cols.some((b, i) => i > 0 && Math.abs(b - cols[i - 1]!) <= MAX_NARROW_COLUMN_LOOK_PT)) return grid;
      flatFragments ??= fragmentsByLine.flat();
      const inExtent = fragmentsInRowExtent(grid, flatFragments);
      const fragmentCenters = inExtent.map((f) => f.x + f.width / 2);
      // The text PASSES OVER the pair: a fragment starts before its lower boundary and ends after the upper one.
      const crosses = (low: number, high: number): boolean => inExtent.some((f) => f.x < low && f.x + f.width > high);
      return { ...grid, colBoundaries: mergeDoubledBoundaries(cols, fragmentCenters, DOUBLED_RAIL_MAX_GAP_PT, crosses) };
    });
    const vectorGrids = allVectorGrids.filter((grid) => !isBoxesInVoidsRegion(grid, boxes));
    if (allVectorGrids.length > 0 && vectorGrids.length === 0) {
      results.push({ pageIndex, origin: "no-grid" });
      // Every region was rejected, so nothing on this page is a table — but the page may still be prose in two columns
      // (a diagram or a banner box beside two columns of text): the gutter stage runs, and ONLY it (the alignment path
      // stays closed, as before). Same rule as stage 3, no new threshold. WRITTEN LIMIT: a page whose region is an
      // edge frame is accepted here as a one-cell table (the retired edge-frame pass used to remove it); it does not get this cut.
      const rejectedCut = proseColumnCut(fragmentsByLine, detectColumnGutter(fragmentsByLine), () => hasRepeatedSecondRhythm(fragmentsByLine));
      if (rejectedCut !== undefined) columnCuts.push({ pageIndex, cut: rejectedCut });
      continue;
    }
    if (vectorGrids.length > 0) {
      const regions = vectorGrids.map((grid) => ({ grid, merge: detectMergedCells(gridLines, grid) }));
      results.push({ pageIndex, origin: "vector-borders", grid: regions[0]!.grid, merge: regions[0]!.merge, regions });
      const bounded = boundedCutAboveGrids(gridLines, fragmentsByLine, vectorGrids);
      if (bounded !== undefined) columnCuts.push({ pageIndex, ...bounded });
      continue;
    }

    // STAGE 1 — is the page in bands? Otherwise nothing that follows makes
    // sense, and we fall back on the behaviour from before point 13.
    const gutter = detectColumnGutter(fragmentsByLine);
    // STAGE 2 — a repeated second line-spacing rhythm is POSITIVE proof of a
    // table. Its absence is not proof of columns (see
    // `hasRepeatedSecondRhythm`), hence stage 3.
    const secondRhythm = hasRepeatedSecondRhythm(fragmentsByLine);

    // STAGE 3 — positive proof of columns. A page in bands, without a
    // table rhythm, dense enough for a statistic to mean
    // something, and of which BOTH bands carry prose.
    const proseCut = proseColumnCut(fragmentsByLine, gutter, () => secondRhythm);
    if (proseCut !== undefined) {
      columnCuts.push({ pageIndex, cut: proseCut });
      continue;
    }

    const aligned = detectAlignedColumns(fragmentsByLine);
    if (aligned) {
      // The BORDERLESS TABLE path goes behind stage 2 (decision of
      // 08/09/2026): without a second rhythm and without a vector grid, no
      // grid is built. Measured reason: this path has NO fixture
      // that succeeds — its positive coverage is entirely synthetic — and
      // on `11-Brochure-Deux-Colonnes.pdf` only ONE ambiguous fragment was
      // missing to publish two columns of prose as a table. The origin stays
      // reported (it is a dashboard signal), only the grid is no
      // longer.
      // ⚠️ THIS PATH BUILDS A BAND FAR TOO WIDE, AND THE PROSE
      // PUBLISHED FROM IT COMES OUT UNREADABLE. Measured on 14/09/2026 on
      // `15-Facture-Libelle-Valeur.pdf`, measurement session — nothing is fixed
      // here, the detector is the place where the fix will have to live.
      //
      // ═══ WHAT THIS COMMENT SAID, AND WAS INACCURATE ═══
      // It announced « swallows whole pages… the whole page, except its
      // first line and its footer ». Remeasured: the band is `y 429.3 → 786.7`,
      // i.e. **42% of the height**, and the FIRST line is inside it, not
      // outside. The wording mattered for whoever would take the subject back up.
      //
      // ═══ WHAT THE BAND TAKES, AND WHAT IT CUTS ═══
      //     782 → 727   header: company name, addresses, SIRET, VAT      INSIDE
      //     686         « FACTURE », 20 pt — the document title          INSIDE
      //     650 → 602   metadata: no., dates, reference                  INSIDE
      //     560 → 492   the REAL table: header + 4 line items            inside
      //     450, 434    « Total HT », « TVA 20 % »                       inside
      //     418         « Total TTC »                                    OUTSIDE
      //
      // So TWO errors in opposite directions: over-inclusion at the top, and an
      // under-inclusion that SPLITS THE TOTALS BLOCK. Both mechanisms are
      // measured and written in `layout/geometry.ts`, on the two functions
      // concerned — contiguous interval for the first, grouping on
      // LEFT edges whereas the amounts are aligned to the RIGHT for the
      // second.
      //
      // ═══ WHAT IS ACTUALLY PUBLISHED — worse than « the title is lost » ═══
      // `renderPageTables` REFUSES the grid, so NO table comes out: it is
      // the right choice, and it is what the previous comment said. But the
      // prose fallback is unreadable, because the band has already crushed the
      // structure of the lines:
      //
      //   <p>Numerisation de fonds documentaire 120 4,50 540,00 Indexation et
      //      controle qualite 120 2,10 252,00 Restitution sur support securise
      //      1 85,00 85,00 Frais de transport et manutention 2 35,00 70,00</p>
      //
      // The FOUR line items of the invoice come out in ONE paragraph: one can no
      // longer tell where one item ends and the next begins. Same for the
      // totals. And the two-column header comes out interleaved —
      // « ATELIER MIKSUMIAFacture adressee a ». The title as an ordinary paragraph
      // is the least of the three damages.
      //
      // ═══ A SIGNAL EXISTS AND IS NOT READ ═══
      //     gaps inside a block   : 12 · 13 · 13 · 13 · 16 ×9 · 20
      //     gaps between blocks   : 36 · 41 · 42 · 42
      // Free interval from 20 to 36 pt, no overlap, ratio 1.80.
      //
      // ═══ WHAT THE MEASUREMENT DOES NOT SAY ═══
      // What to do. It is not a threshold to widen: three families of error
      // have been observed on three documents — this one, the right-aligned
      // column, and on `18-Composition-Reelle` TWO-COLUMN PROSE read
      // as a table, which is yet another thing. The `vector-borders`
      // path (`05a`) does not suffer from it.
      const lineRange = secondRhythm ? identifyAlignedTableLines(fragmentsByLine, aligned) : undefined;
      const candidate = lineRange ? buildGridFromAlignedRows(fragmentsByLine.slice(lineRange.startLine, lineRange.endLine + 1), aligned) : undefined;
      // The SECOND OPINION — see `gridHoldsItsContent`. A grid discarded here costs
      // no table: it would have been refused at rendering anyway.
      const grid = candidate && gridHoldsItsContent(candidate, fragmentsByLine) ? candidate : undefined;
      results.push({ pageIndex, origin: "alignment-no-borders", ...(grid && lineRange ? { grid, lineRange, regions: [{ grid }] } : {}) });
    } else if (hasWeakTabularitySignal(fragmentsByLine)) {
      // No clean grid or alignment, but real reason to suspect a table is
      // here anyway (§8's 04/09/2026 correction: this case must never be
      // silently skipped). Ordinary prose never reaches this branch at all
      // — `hasWeakTabularitySignal` already filtered it out.
      results.push({ pageIndex, origin: "no-grid" });
    }
    // Neither branch: ordinary prose, nothing worth reporting for this page.
  }
  return { grids: results, ocrLayerPages, columnCuts, boldByPage, filledByPage, inlineImagesByPage, blockImagesByPage, droppedImagesByPage, boxesByPage };
}

/** The original form — table detection alone. Kept because
 *  `detectPdfTableOrigins` and the milestone 1 tests have no use for the OCR
 *  layer signal, and a single pass serves them all. */
export async function detectPdfTableGrids(bytes: Uint8Array): Promise<PageTableGrid[]> {
  return (await detectPdfPageSignals(bytes)).grids;
}

/** jalon 1's original, unchanged shape — the persisted dashboard signal
 *  (`SyncedDocument.pdfTableDetections`) never needs the render-time
 *  `grid`/`lineRange` data, only the origin. */
export async function detectPdfTableOrigins(bytes: Uint8Array): Promise<PdfTableDetection[]> {
  const grids = await detectPdfTableGrids(bytes);
  return grids.map(({ pageIndex, origin }) => ({ pageIndex, origin }));
}
