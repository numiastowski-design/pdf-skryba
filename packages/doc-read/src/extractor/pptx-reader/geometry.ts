/** Where a shape of a slide is SEEN, in EMU on the slide: its declared frame
 *  (`a:xfrm` or, for a graphic frame, `p:xfrm`: `a:off`, `a:ext`, `rot`,
 *  `flipH`, `flipV`) carried through every enclosing group's own frame
 *  (`a:chOff`/`a:chExt` scaled onto `a:off`/`a:ext`, then the group's flips
 *  and rotation), and turned into the axis-aligned box of what is drawn: a
 *  shape rotated by 90° is as wide as it was tall, around the same centre;
 *  for a connector, also the two ends of its line, flips included, and for a
 *  bent connector the vertices of its polyline (`bentPath`).
 *  NOT here: which shape is read (`pptx-reader/shapes.ts`), what a box means
 *  for the layout — background picture, element posed on a picture
 *  (`layout/slide-elements.ts`) — nor a frame inherited from the slide layout
 *  or master: a placeholder that writes no `a:xfrm` has no box (every shape of
 *  the USA and IT decks writes one).
 *  Called by: `pptx-reader/shapes.ts`. */

import type { Matrix2D } from "doc-ir/layout/geometry-types";
import { applyMatrix, composeMatrix, IDENTITY_MATRIX } from "doc-ir/layout/painted-paths";
import type { Box } from "doc-ir/layout/slide-elements";
import { isXsdTrue } from "../../lib/ooxml-bool";
import { attributeOf, findChild, type XNode } from "../ooxml/xml";

/** EMU per point (DrawingML: 914 400 per inch, 72 points per inch). The one
 *  copy: `pptx-reader/picture.ts` and `extractor/slide-svg.ts` import it. */
export const EMU_PER_PT = 12_700;

/** A span `[start, start + size]` lies wholly outside `[0, limit]` on one axis: it begins at or past the limit, or ends before 0,
 *  or ends at 0 when it has a real size (a zero-size span lying ON the edge is still on the page). */
export const isWhollyOutside = (start: number, size: number, limit: number): boolean =>
  start >= limit || start + size < 0 || (size > 0 && start + size <= 0);

/** An affine map from a group's child coordinates to slide coordinates:
 *  x' = a·x + c·y + e, y' = b·x + d·y + f. The same six numbers as a PDF matrix: one arithmetic,
 *  `layout/painted-paths.ts`. */
export type Transform = Matrix2D;

const IDENTITY: Transform = IDENTITY_MATRIX;

/** `outer` after `inner`: a point goes through `inner` first (`composeMatrix` takes the first-applied map first). */
const compose = (outer: Transform, inner: Transform): Transform => composeMatrix(inner, outer);

const apply = (transform: Transform, x: number, y: number): [number, number] => {
  const point = applyMatrix(transform, x, y);
  return [point.x, point.y];
};

/** ST_Angle: 60 000ths of a degree, clockwise (y points down). */
export const FULL_TURN = 21_600_000;
export const QUARTER_TURN = 5_400_000;

/** Cosine and sine of a `rot`. A multiple of 90° gets exact 0 and ±1, so an
 *  unscaled shape turned by a quarter keeps integer edges (Math.cos(π/2) is
 *  6e-17, not 0). */
const QUARTERS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const cosSin = (rot: number): readonly [number, number] => {
  const turn = ((rot % FULL_TURN) + FULL_TURN) % FULL_TURN;
  if (turn % QUARTER_TURN === 0) return QUARTERS[turn / QUARTER_TURN]!;
  const radians = (turn / FULL_TURN) * 2 * Math.PI;
  return [Math.cos(radians), Math.sin(radians)];
};

/** Rotation by `rot` then (applied first) the flips, about (cx, cy). */
const turnAbout = (rot: number, flipH: boolean, flipV: boolean, cx: number, cy: number): Transform => {
  const [cos, sin] = cosSin(rot);
  const scaleX = flipH ? -1 : 1;
  const scaleY = flipV ? -1 : 1;
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  return { a, b, c, d, e: cx - a * cx - c * cy, f: cy - b * cx - d * cy };
};

/** ECMA-376 ST_CoordinateUnqualified: ±27 273 042 329 600 EMU. The bound is
 *  applied where the attribute is read: `Number.isInteger(1e300)` is true, so
 *  a written "1e308" crossed as a coordinate and two of them summed to
 *  Infinity in the boxes (an angle is far smaller, the bound is harmless). */
const MAX_COORDINATE_EMU = 27_273_042_329_600;

/** An integer attribute (ST_Coordinate, ST_Angle): `undefined` when absent,
 *  not an integer, or out of ECMA's coordinate bounds — an out-of-bounds
 *  value is treated as NOT declared, no geometry is invented. */
const integer = (node: XNode | undefined, name: string): number | undefined => {
  const raw = node === undefined ? undefined : attributeOf(node, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && Math.abs(value) <= MAX_COORDINATE_EMU ? value : undefined;
};

const flag = (node: XNode, name: string): boolean => {
  return isXsdTrue(attributeOf(node, name));
};

/** A declared frame: `a:off` and `a:ext` as written, `rot` (0 when absent). */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly rot: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

/** A frame's own rotation and flips, about its centre. */
const ownTurn = (frame: Frame): Transform =>
  turnAbout(frame.rot, frame.flipH, frame.flipV, frame.x + frame.cx / 2, frame.y + frame.cy / 2);

/** The frame an `a:xfrm` (or `p:xfrm`) declares; `undefined` without an
 *  integer `a:off` and `a:ext`. */
export const frameOf = (xfrm: XNode | undefined): Frame | undefined => {
  if (!xfrm) return undefined;
  const off = findChild(xfrm, "a:off");
  const ext = findChild(xfrm, "a:ext");
  const x = integer(off, "x");
  const y = integer(off, "y");
  const cx = integer(ext, "cx");
  const cy = integer(ext, "cy");
  if (x === undefined || y === undefined || cx === undefined || cy === undefined || cx < 0 || cy < 0) return undefined;
  return { x, y, cx, cy, rot: integer(xfrm, "rot") ?? 0, flipH: flag(xfrm, "flipH"), flipV: flag(xfrm, "flipV") };
};

/** One enclosing group: the map from its child coordinates to the
 *  coordinates its own frame is written in (`a:chOff`/`a:chExt` onto
 *  `a:off`/`a:ext`, then its flips and rotation about its centre), and
 *  whether that scale is uneven (x and y scaled differently). */
export interface GroupLevel {
  readonly map: Transform;
  readonly uneven: boolean;
}

/** Starting value to calibrate: the relative gap between x and y scales
 *  above which a group counts as stretched unevenly. PowerPoint rounds a
 *  resized group's `a:ext` to whole EMU, so a group resized with its aspect
 *  locked can land 1 EMU off (1 000 001 over 1 000 000: a gap of 1e-6); a
 *  real stretch is a gap of several percent. Neither population measured. */
const UNEVEN_RELATIVE_GAP = 1e-4;

const unevenScale = (scaleX: number, scaleY: number): boolean =>
  Math.abs(scaleX - scaleY) > UNEVEN_RELATIVE_GAP * Math.max(Math.abs(scaleX), Math.abs(scaleY));

/** A group's level, from its `p:grpSpPr`. An axis whose `chExt` is 0 or
 *  absent is not scaled; absent `chOff` is `off`. `undefined` for a group
 *  without a readable frame: it leaves its members where its parent puts
 *  them. */
export const groupLevel = (grpSpPr: XNode | undefined): GroupLevel | undefined => {
  const xfrm = findChild(grpSpPr ?? {}, "a:xfrm");
  const frame = frameOf(xfrm);
  if (!xfrm || !frame) return undefined;
  const chOff = findChild(xfrm, "a:chOff");
  const chExt = findChild(xfrm, "a:chExt");
  const chX = integer(chOff, "x") ?? frame.x;
  const chY = integer(chOff, "y") ?? frame.y;
  const chCx = integer(chExt, "cx");
  const chCy = integer(chExt, "cy");
  const scaleX = chCx === undefined || chCx === 0 ? 1 : frame.cx / chCx;
  const scaleY = chCy === undefined || chCy === 0 ? 1 : frame.cy / chCy;
  const scale: Transform = { a: scaleX, b: 0, c: 0, d: scaleY, e: frame.x - chX * scaleX, f: frame.y - chY * scaleY };
  return { map: compose(ownTurn(frame), scale), uneven: unevenScale(scaleX, scaleY) };
};

/** The map from the innermost group's child coordinates to the slide:
 *  `levels` from the outermost group in. */
export const throughGroups = (levels: readonly GroupLevel[]): Transform =>
  levels.reduce((outer, level) => compose(outer, level.map), IDENTITY);

/** The map is a turn or a mirror: anything but a move and a positive scale
 *  of each axis. */
export const turnsOrMirrors = (transform: Transform): boolean =>
  transform.b !== 0 || transform.c !== 0 || transform.a < 0 || transform.d < 0;

/** `Math.round`, without the -0 it returns for -0.5 … -0. */
const round = (value: number): number => Math.round(value) + 0;

/** The two ends of a line shape (a connector) on the slide, in integer EMU:
 *  its geometry runs from the frame's top-left corner (the start, where
 *  `a:headEnd` sits) to its bottom-right (the end, `a:tailEnd`), then its own
 *  flips and rotation about the frame's centre and every enclosing group
 *  carry both. A flip swaps which corners the line joins; the box alone
 *  cannot say it. Each coordinate rounded to the nearest EMU. */
export interface LineEnds {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export const lineEnds = (frame: Frame, parent: Transform): LineEnds => {
  const turn = compose(parent, ownTurn(frame));
  const [x1, y1] = apply(turn, frame.x, frame.y);
  const [x2, y2] = apply(turn, frame.x + frame.cx, frame.y + frame.cy);
  return { x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2) };
};

/** The box a shape is SEEN in on the slide: the four corners of its declared
 *  frame, turned by its own `rot` about its centre (its flips leave the same
 *  four corners), carried to the slide by `parent`, and the axis-aligned box
 *  around them. Each EDGE is rounded to the nearest EMU (half up), then the
 *  size taken between the rounded edges: two shapes that touch still touch.
 *  A frame with no scale and no rotation other than a quarter turn stays
 *  exact but for a half EMU when a quarter turn centres an odd difference
 *  (1 EMU is 1/12 700 pt). A shape turned inside a group stretched unevenly
 *  gets the box of the skewed parallelogram, not of the rectangle PowerPoint
 *  keeps (no witness; not decided). */
export const visibleBox = (frame: Frame, parent: Transform): Box => {
  const turn = compose(parent, turnAbout(frame.rot, false, false, frame.x + frame.cx / 2, frame.y + frame.cy / 2));
  const corners = [
    apply(turn, frame.x, frame.y),
    apply(turn, frame.x + frame.cx, frame.y),
    apply(turn, frame.x, frame.y + frame.cy),
    apply(turn, frame.x + frame.cx, frame.y + frame.cy),
  ];
  const left = round(Math.min(...corners.map((corner) => corner[0])));
  const top = round(Math.min(...corners.map((corner) => corner[1])));
  const right = round(Math.max(...corners.map((corner) => corner[0])));
  const bottom = round(Math.max(...corners.map((corner) => corner[1])));
  return { x: left, y: top, cx: right - left, cy: bottom - top };
};

/** Where the slide drawing places a picture, from its declared frame and
 *  the groups around it (`levels`, outermost first):
 *  - `{ frame }`: every group merely moves it and scales it EVENLY (or there
 *    is none): its `a:off`/`a:ext` carried to the slide, before its own
 *    rotation and flips, each edge rounded as in `visibleBox`;
 *  - `{ frame, matrix }`: a group turns, mirrors or stretches it unevenly:
 *    the frame AS WRITTEN (group coordinates) and the whole map from it to
 *    the slide, the picture's own flips and rotation included;
 *  - "stretched-turn": at a group level stretched unevenly, what lies below
 *    it (inner groups, the picture's own `rot`) turns by other than 0° or
 *    180°. PowerPoint then keeps a rectangle (it rescales the member's
 *    frame, LibreOffice's `Shape::createAndInsert` has special cases for
 *    it), not the skewed parallelogram an affine map gives: left out, not
 *    approximated. Mirrors below are allowed: they keep the axes.
 *  An uneven level is one `groupLevel` marks (`UNEVEN_RELATIVE_GAP`). */
export const placePicture = (
  frame: Frame,
  levels: readonly GroupLevel[],
): { frame: Box; matrix?: Transform } | "stretched-turn" => {
  let below = ownTurn(frame);
  for (let levelIndex = levels.length - 1; levelIndex >= 0; levelIndex--) {
    const level = levels[levelIndex]!;
    if (level.uneven && (below.b !== 0 || below.c !== 0)) return "stretched-turn";
    below = compose(level.map, below);
  }
  const parent = throughGroups(levels);
  if (!turnsOrMirrors(parent) && parent.a === parent.d) {
    const [x1, y1] = apply(parent, frame.x, frame.y);
    const [x2, y2] = apply(parent, frame.x + frame.cx, frame.y + frame.cy);
    const left = round(x1);
    const top = round(y1);
    return { frame: { x: left, y: top, cx: round(x2) - left, cy: round(y2) - top } };
  }
  // `+ 0`: a product with a zero can be -0, which is still 0.
  const matrix = { a: below.a + 0, b: below.b + 0, c: below.c + 0, d: below.d + 0, e: below.e + 0, f: below.f + 0 };
  return { frame: { x: frame.x, y: frame.y, cx: frame.cx, cy: frame.cy }, matrix };
};

/** A vertex on the slide, in integer EMU. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A bent connector's vertices, from its start to its end, in the frame's
 *  own coordinates (origin top-left, `w` × `h`), as the ECMA-376 Part 1 preset
 *  definitions draw them (`presetShapeDefinitions.xml`, read on 25/09/2026 in
 *  LibreOffice's copy, oox/source/drawingml/customshapes/):
 *  - bentConnector2: (l,t) (r,t) (r,b); no guide.
 *  - bentConnector3: x1 = w·adj1/100000; (l,t) (x1,t) (x1,b) (r,b).
 *  - bentConnector4: x1 = w·adj1/100000, y2 = h·adj2/100000;
 *    (l,t) (x1,t) (x1,y2) (r,y2) (r,b).
 *  - bentConnector5: x1 = w·adj1/100000, x3 = w·adj3/100000,
 *    y2 = h·adj2/100000; (l,t) (x1,t) (x1,y2) (x3,y2) (x3,b) (r,b).
 *  Every adj defaults to 50 000. An adj outside [0, 100 000] is kept: it puts
 *  the elbow outside the frame, which PowerPoint writes and draws.
 *  `undefined` for any other preset. */
const bentVertices = (
  preset: string,
  w: number,
  h: number,
  adj: (name: string) => number,
): [number, number][] | undefined => {
  const guidePosition = (size: number, name: string): number => (size * adj(name)) / 100_000;
  switch (preset) {
    case "bentConnector2":
      return [
        [0, 0],
        [w, 0],
        [w, h],
      ];
    case "bentConnector3": {
      const x1 = guidePosition(w, "adj1");
      return [
        [0, 0],
        [x1, 0],
        [x1, h],
        [w, h],
      ];
    }
    case "bentConnector4": {
      const x1 = guidePosition(w, "adj1");
      const y2 = guidePosition(h, "adj2");
      return [
        [0, 0],
        [x1, 0],
        [x1, y2],
        [w, y2],
        [w, h],
      ];
    }
    case "bentConnector5": {
      const x1 = guidePosition(w, "adj1");
      const x3 = guidePosition(w, "adj3");
      const y2 = guidePosition(h, "adj2");
      return [
        [0, 0],
        [x1, 0],
        [x1, y2],
        [x3, y2],
        [x3, h],
        [w, h],
      ];
    }
    default:
      return undefined;
  }
};

/** The PRESET DEFAULT of every bent connector guide. */
const DEFAULT_BENT_ADJ = 50_000;

/** A bent connector's polyline on the slide: the preset's vertices
 *  (`bentVertices`) carried by the SAME map as `lineEnds` (own flips and
 *  rotation about the frame's centre, then every enclosing group), each
 *  coordinate rounded to the nearest EMU. `adj` holds the guides the
 *  connector writes (`adj1`…`adj3`); a missing one takes 50 000. `undefined`
 *  for a preset that is not `bentConnector2` to `bentConnector5`. */
export const bentPath = (
  frame: Frame,
  parent: Transform,
  preset: string,
  adj: Readonly<Record<string, number>>,
): Point[] | undefined => {
  const vertices = bentVertices(preset, frame.cx, frame.cy, (name) => adj[name] ?? DEFAULT_BENT_ADJ);
  if (vertices === undefined) return undefined;
  const turn = compose(parent, ownTurn(frame));
  return vertices.map(([vertexX, vertexY]) => {
    const [x, y] = apply(turn, frame.x + vertexX, frame.y + vertexY);
    return { x: round(x), y: round(y) };
  });
};
