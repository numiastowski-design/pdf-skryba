/** ONE slide drawn as an SVG picture, from what the reader declares: round
 *  and square rectangles and ellipses (their fill when its colour is exact,
 *  a black outline), the text of those shapes inside their box, straight connectors and bent ones
 *  (`bentConnector2` to `5`, a polyline) with their arrow heads, and the
 *  slide's pictures at their place and size, turned and mirrored as
 *  declared (`pictureTransform`), or through their groups' matrix
 *  (`pictureMatrix`). The shapes of a SmartArt's saved drawing
 *  (`PptxTextShape#smartArt`, `extractor/smartart-drawing.ts`) are drawn the same way, plus the `hexagon` preset, outlines turned by a
 *  quarter turn and text turned by one (`transform="rotate"` on its `<text>` lines); the words they draw are returned
 *  (`smartArtText`) for the control (`undrawnWords`). Everything else is
 *  OMITTED, never approximated (« ce qu'on ne sait pas dessiner
 *  juste, on ne le dessine pas plutôt que de mettre un truc faux »), and
 *  counted by reason, so the caller can say that no text is lost: the caller
 *  publishes the text as text (for a deck, its one collapsed block after the
 *  tabs, `extractor/pptx.ts`).
 *  Colours (25/09/2026, decision 12 — MIKSUDOC « Spécification fonctionnelle » §9.3.3): a box's fill and its
 *  text's colour are drawn only when EXACT (`pptx-reader/color.ts`), a box
 *  is filled only when the colour of all its text is known, and text of
 *  known colour without a fill of its own keeps it only on a box drawn
 *  filled before it; anything not known is black on white, never white.
 *  Strokes and arrows stay black, the background white; the slide's own
 *  background is not read. The picture is an image, insensitive to the
 *  page's theme, like a picture of ours,
 *  the model for this file: the page's colour decisions (16/09, 22/09)
 *  still hold for the page.
 *  The picture is cropped to what it draws, text past its box included
 *  (never clipped), plus a margin, inside the slide; shown at most 744 px
 *  wide and at most `MAX_ENLARGEMENT` times the whole slide's scale
 *  (29/09/2026).
 *  Deterministic: the same shapes give the same string, byte for byte (no
 *  random id; the two arrow markers are always "s" and "e").
 *  NOT here: which slide is a diagram (`layout/slide-layout.ts`), reading the
 *  shapes (`extractor/pptx-reader/`), attaching the picture and the text in
 *  flow (`extractor/pptx.ts`), nor Google's own picture of a Google Slides
 *  deck (MIKSUDOC « Spécification fonctionnelle » §9.3.4, step 8).
 *  Called by: `extractor/pptx.ts`, `extractor/docx-reader/shapes.ts`. */

import { utf8Length } from "../lib/utf8";
import { escapeAttr } from "../lib/xml";
import type { Box, Size } from "doc-ir/layout/slide-elements";
import { sniffImage } from "doc-ir/extractor/image-format";
import type {
  PptxConnectorShape,
  PptxPictureNotPublished,
  PptxPictureShape,
  PptxShape,
  PptxTextShape,
} from "./pptx-reader";
import type { Hex } from "./pptx-reader/color";
import { EMU_PER_PT, type Transform } from "./pptx-reader/geometry";
import { applyMatrix } from "doc-ir/layout/painted-paths";
import { holdsRect, RECT_RULES, rawFromXywh } from "doc-ir/layout/rect-rules";

/** Why a shape is missing from the drawing, in whole or in part. */
export type SlideSvgOmission =
  /** A text shape whose geometry is not "rect", "roundRect" or "ellipse":
   *  another preset (an arrow, a flowchart disk…), a free-form `a:custGeom`,
   *  or none written. Outline and text both left out: the text rectangle of
   *  another geometry is not the box. */
  | "geometry"
  /** A text shape turned (`rot`), or turned or mirrored by an enclosing
   *  group (`groupTurned`). Left out whole: its outline is not its visible
   *  box, its text turns (and PowerPoint never mirrors glyphs, so the
   *  group's matrix would draw them wrong). A turned or flipped picture is
   *  drawn. */
  | "turned"
  /** A text shape whose text is turned (`a:bodyPr vert` or `rot`) or upside
   *  down (`flipV`): its outline is drawn, its text left out. */
  | "turned-text"
  /** A connector other than a straight or a bent one (curved, unknown), or
   *  a bent one the reader gave no vertices. */
  | "connector-geometry"
  /** A text shape whose runs write no size where none can be READ: a
   *  placeholder when neither its own list style, its layout, its master nor
   *  the master's text styles write one at that level
   *  (`pptx-reader/text-size.ts`), or a free shape when `p:defaultTextStyle`
   *  declares none. Its outline is drawn, its text left out: a size is never
   *  invented. */
  | "size-not-declared"
  /** A shape without a box on the slide (a placeholder inheriting it). */
  | "no-box"
  /** A table, chart, SmartArt, OLE object or other graphic frame. */
  | "frame"
  /** A picture the reader does not publish (external, missing, video,
   *  crop it cannot apply), or a file format a browser does not draw in an
   *  SVG (only PNG, JPEG and GIF are embedded). */
  | "picture-not-published"
  /** A picture that would take the SVG past `MAX_SVG_BYTES`. */
  | "picture-over-cap"
  /** A picture turned inside a group stretched unevenly
   *  (`pptx-reader/geometry.ts#placePicture`): left out, not approximated. */
  | "picture-group-stretched";

/** Why ONE picture is not in the drawing: the reader's reason, its format
 *  ("format": not PNG, JPEG nor GIF), the cap ("over-cap"), a turn inside a
 *  group stretched unevenly ("group-stretched"), or no place on the slide
 *  ("no-box"). The caller writes a visible line for each
 *  (MIKSUDOC « Spécification fonctionnelle » §9.3.3). */
type PictureNotDrawn = PptxPictureNotPublished | "format" | "over-cap" | "group-stretched" | "no-box";

export interface SlideSvg {
  svg: string;
  /** Counts by reason; a reason that never occurred is absent. */
  omitted: Partial<Record<SlideSvgOmission, number>>;
  /** Text shapes whose text, as estimated here, runs past their box: a line
   *  wider than the box, or a line whose middle lies outside it (a height
   *  under `a:spAutoFit` is never counted); `drawText` says why. Informative
   *  only. Drawn whole all the same (never clipped): PowerPoint draws such
   *  text past the box too, and a cut word would be a lost one. */
  overflowingText: number;
  /** Every picture left out of the drawing, in shape-tree order. */
  picturesNotDrawn: { spTreeIndex: number; reason: PictureNotDrawn }[];
  /** The text lines drawn for the shapes of a SmartArt's drawing, in paint order: what the drawing shows, compared with the model's words
   *  (`extractor/smartart-drawing.ts#undrawnWords`). A line of any other shape is not here. */
  smartArtText: string[];
}

// One viewBox unit is one point (EMU_PER_PT, imported above).

/** Widest picture on the page, in CSS pixels: the width `renderer/storage.ts`
 *  gives every published image. A 960 pt slide is drawn 744 px wide —
 *  the measured inner width of a native-tab frame (27/09/2026, renderer/
 *  storage.ts#TABLE_WIDTH_PX): at 760 the drawing overflowed its tab by
 *  12-16 px and put a horizontal scrollbar on the page. */
const MAX_WIDTH_PX = 744;

/** Largest enlargement of a cropped drawing over the scale of its whole
 *  slide (29/09/2026). Valeur de départ à calibrer: the drawing is
 *  cropped to what it draws, so a drawing that fills a third of its slide
 *  could be shown three times larger; at 2× a 960 pt slide shows 12 pt text
 *  at 18.6 px instead of 9.3, and a narrow or tall drawing does not become
 *  a page-high picture. No population measured on either side. */
const MAX_ENLARGEMENT = 2;

/** White space kept around the drawn area, in points: the half stroke of
 *  an outline (0.5) and the half width of an arrow head (3) fit inside it,
 *  with room for our text-width estimate's error. Starting value to
 *  calibrate. */
const CROP_MARGIN_PT = 6;

/** Depth of a sans-serif descender below the baseline, in em: Arial's
 *  0.212, rounded up. Only the crop reads it. */
const DESCENT_EM = 0.25;

/** Largest SVG, in bytes, pictures included. Valeur de départ à calibrer:
 *  measured on the three witness slides, 26 KB (USA 20, 3 pictures), 129 KB
 *  (IT 2, 10) and 346 KB (USA 9, 14), each with every picture. 1 MB is about
 *  2.9 times the largest; no second population (a slide too heavy to
 *  attach or to display) was measured.
 *  Pictures are taken in shape-tree order; one that would pass the cap is
 *  left out and counted, the next ones still tried. */
export const MAX_SVG_BYTES = 1_000_000;

/** PowerPoint's own text insets for a side `a:bodyPr` writes none of: 0.1
 *  inch left and right, 0.05 inch top and bottom. A written inset is read
 *  (`PptxTextShape.insets`: 68 575 and 34 275 EMU on IT 3's boxes, 91 425
 *  on all four sides of its labels). */
const INSET_X_EMU = 91_440;
const INSET_Y_EMU = 45_720;

/** Widest line the wrap may build, in points (arbitrage of 28/09/2026,
 *  7c). Starting value to calibrate: ten times the widest slide seen
 *  (1 000 pt) — a guard against the degenerate box, not a separation of
 *  two populations: an ordinary box sits far under it and its rendering
 *  does not move a byte. Unbounded, a box ECMA still allows (up to
 *  ~2×10⁹ pt) never lets a line close, the measuring window never resets,
 *  and the wrap's cost turns quadratic — 40 000 words ran past 120 s,
 *  measured 28/09/2026. */
const MAX_WRAP_WIDTH_PT = 10_000;

/** Estimated advance of one character, in em of its written size, by class
 *  (conception du 27/09/2026, purgée — git history). Starting values to
 *  calibrate. No real font is measured: the SVG is drawn in the READER's
 *  sans-serif, so an exact fit is impossible by nature; the aim is « what
 *  PowerPoint fits, we fit », not the pixel. The values are Arial's
 *  (Windows' sans-serif) widths rounded per class: narrow i l t f j . , : ;
 *  ' | ! 0.222-0.278, lower case 0.5-0.556, m w M W 0.72-0.94, capitals
 *  0.61-0.78, digits 0.556, space 0.278. Checked on the witnesses of §5
 *  (slide-svg.test.ts) against PowerPoint's export: IT 3 « RMS… PREPROD »
 *  wraps in 4 lines and « OTA… » in 3, as in PowerPoint; USA 24 in 5 where
 *  PowerPoint has 4 (its decks are in Calibri, narrower than Arial), still
 *  inside its box. Known miss: IT 2-4 « Locks (Dormakaba, Omnitec, Assa
 *  Abloy) », 5 pt, 3 lines here and 2 in PowerPoint, still counted.
 *  Replaced a flat 0.55 em per character (27/09/2026), which made IT 3's
 *  « (Accurate then Duetto) » 5 lines and « Client » (6 pt) 19.8 pt wide
 *  where this table gives 14.7 pt. */
const ADVANCE_EM = { narrow: 0.25, lower: 0.52, wide: 0.8, capital: 0.66, digit: 0.556, space: 0.278 } as const;
const NARROW = new Set("iltfj.,:;'|!");
const WIDE = new Set("mwMW");

/** One character's estimated advance, in em. Any other character (another
 *  punctuation, another script) counts as a lower-case letter. */
const advanceEm = (c: string): number => {
  if (NARROW.has(c)) return ADVANCE_EM.narrow;
  if (WIDE.has(c)) return ADVANCE_EM.wide;
  if (c === " " || c === "\t") return ADVANCE_EM.space;
  if (c >= "0" && c <= "9") return ADVANCE_EM.digit;
  if (c !== c.toLowerCase()) return ADVANCE_EM.capital;
  return ADVANCE_EM.lower;
};

/** A SmartArt's text is laid out by Office in the theme's font before it is saved (Calibri in both fixtures), whose advances are
 *  narrower than the Arial-based table above: a line Office keeps whole (« Process 1 », « Proce 1.1 » at 33 pt in a 133 pt wide text
 *  rectangle) must not wrap here. Valeur de départ à calibrer, deux mesures contre les PDF d'Office (20/10/2026): Calibri / table =
 *  125.6 / 144.0 = 0.87 for « Proce 1.1 » and 125.4 / 152.8 = 0.82 for « Process 1 »; 0.85 keeps both on one line and still wraps
 *  « Point 1 » (20 pt) in its 44 pt hexagon text rectangle, as the PDF does (57 pt of Calibri, 51 here). */
const SMARTART_ADVANCE = 0.85;

/** A full turn, in 60 000ths of a degree (ST_Angle, ECMA-376 Part 1 §20.1.10.3). */
const FULL_TURN = 21_600_000;

/** Two centres closer than this (points) are one: below the 0.01 pt an SVG number is written with. */
const SAME_CENTRE_PT = 0.005;

/** Baseline-to-baseline distance of single spacing, as a fraction of the
 *  font size: the usual one of a sans-serif face. A paragraph's `a:lnSpc`
 *  scales it (`spcPct`) or replaces it (`spcPts`); `a:normAutofit
 *  lnSpcReduction` is subtracted from the percentage. */
const LINE_HEIGHT_EM = 1.2;

/** "roundRect" corner when `adj` is not written: ECMA-376's preset default. */
const DEFAULT_ROUND_ADJ = 16_667;

/** One side of the text rectangle of an ellipse inside its box, per side:
 *  (1 − cos 45°) / 2 of the box, the preset's inscribed rectangle. */
const ELLIPSE_TEXT_INSET = (1 - Math.SQRT1_2) / 2;

/** A roundRect's text rectangle is inset by 29.289 % of its corner radius
 *  (the preset's `il = x1 · 29289 / 100000`). */
const ROUND_TEXT_INSET = 0.29289;

/** Exported for `docx-reader/shapes.ts#hasNonTextGraphics`: a Word drawing's
 *  D2 publish-or-not decision (MIKSUDOC « Spécification fonctionnelle » §9.5) needs to
 *  know, BEFORE calling this file, whether a shape draws a box or a line at
 *  all — restating the same three sets there would drift. */
export const DRAWN_GEOMETRIES = new Set(["rect", "roundRect", "ellipse"]);
/** Presets drawn for a SmartArt's saved drawing ONLY: its `dsp:txXfrm` gives the text rectangle, which a shape of a slide would need the
 *  preset's own formula for. */
const SMARTART_GEOMETRIES = new Set(["hexagon", "chord"]);
/** The `hexagon` preset's defaults (ECMA-376 presetShapeDefinitions): `adj` 25 000 (inset of the slanted sides, 100 000ths of the shorter
 *  side) and `vf` 115 470 (vertical factor). */
const HEXAGON_ADJ = 25_000;
const HEXAGON_VF = 115_470;
export const STRAIGHT_CONNECTORS = new Set(["line", "straightConnector1"]);
export const BENT_CONNECTORS = new Set(["bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5"]);

/** A number of points written with at most two decimals; never "-0". */
const n = (v: number): string => String(Math.round(v * 100) / 100 + 0);
const pt = (emu: number): number => emu / EMU_PER_PT;

const STROKE = 'fill="none" stroke="#000" stroke-width="1"';

/** The MIME type the bytes themselves say, for the three formats every
 *  browser draws inside an SVG; `undefined` otherwise (EMF, TIFF, SVG…). */
const drawableType = (b: Uint8Array): string | undefined => {
  const format = sniffImage(b);
  return format === undefined ? undefined : `image/${format}`;
};

/** The SVG `transform` of a picture turned by `rot` and mirrored by
 *  `flipH`/`flipV`, its image placed at `frame` (points); "" when neither.
 *  Order: the flips FIRST, about the frame's centre, then the rotation,
 *  clockwise, about the same centre. Source: LibreOffice's DrawingML import,
 *  `oox/source/drawingml/shape.cxx`, `Shape::createAndInsert` (read on
 *  25/09/2026): « Flip in MSO is at object center » (`lcl_mirrorAtCenter`),
 *  then « Apply object rotation at current object center »
 *  (`lcl_RotateAtCenter`), and « OOXML flips shapes before rotating them ».
 *  The same order as `pptx-reader/geometry.ts#turnAbout`, and PowerPoint's
 *  own render of `fixtures/pptx/04-Images-tournees.pptx` (
 *  25/09/2026: 30° + mirror shows the mirrored arrow turned clockwise, up-left).
 *  An SVG transform list applies right to left: `scale` (the flip, carried
 *  back to the centre by `translate(2·cx 2·cy)`) runs first, `rotate` last. */
const pictureTransform = (frame: Box, rot: number | undefined, flipH: boolean, flipV: boolean): string => {
  const cx = pt(frame.x + frame.cx / 2);
  const cy = pt(frame.y + frame.cy / 2);
  const steps: string[] = [];
  if (rot !== undefined && rot !== 0) steps.push(`rotate(${n(rot / 60_000)} ${n(cx)} ${n(cy)})`);
  if (flipH || flipV)
    steps.push(
      `translate(${n(flipH ? 2 * cx : 0)} ${n(flipV ? 2 * cy : 0)}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})`,
    );
  return steps.length > 0 ? ` transform="${steps.join(" ")}"` : "";
};

/** The SVG `transform` of a picture its groups turn, mirror or stretch: the
 *  reader's whole map (`PptxPictureShape.matrix`, EMU) with its move in
 *  points. The coefficients take six decimals, not two: on a 170 pt picture
 *  −0.87 for cos 30° would move a corner by 0.7 pt. */
const pictureMatrix = (m: Transform): string => {
  const k = (v: number): string => String(Math.round(v * 1e6) / 1e6 + 0);
  return ` transform="matrix(${k(m.a)} ${k(m.b)} ${k(m.c)} ${k(m.d)} ${n(pt(m.e))} ${n(pt(m.f))})"`;
};

/** The area a picture covers once placed: its frame's four corners through
 *  its groups' matrix, or turned about its centre (a flip moves no corner
 *  out of the frame's own bounds). */
const growByPicture = (drawn: Extent, f: Box, rot: number | undefined, m: Transform | undefined): void => {
  const x = pt(f.x);
  const y = pt(f.y);
  const w = pt(f.cx);
  const h = pt(f.cy);
  if (m !== undefined) {
    const placed = { ...m, e: pt(m.e), f: pt(m.f) };
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ] as const) {
      const at = applyMatrix(placed, px, py);
      grow(drawn, at.x, at.y, at.x, at.y);
    }
    return;
  }
  const angle = ((rot ?? 0) / 60_000) * (Math.PI / 180);
  // |cos| and |sin| rounded to 1e-9: a quarter turn gives exactly 0 and 1.
  const cos = Math.round(Math.abs(Math.cos(angle)) * 1e9) / 1e9;
  const sin = Math.round(Math.abs(Math.sin(angle)) * 1e9) / 1e9;
  const halfW = (w * cos + h * sin) / 2;
  const halfH = (w * sin + h * cos) / 2;
  grow(drawn, x + w / 2 - halfW, y + h / 2 - halfH, x + w / 2 + halfW, y + h / 2 + halfH);
};

/** A paragraph as lines of text, each the [start, end) of its characters
 *  in `text`: a line break (`a:br`, a run "\n") ends a line; inside a line,
 *  words (runs of non-space) are packed greedily while their estimated
 *  width (`measure` of the characters [start, end), in points) fits
 *  `widthPt`. A word wider than the line stands alone on its line
 *  and is never cut. Spaces between words are kept as written inside a line,
 *  and dropped where a line wraps. `noWrap` (`wrap="none"`): only the line
 *  breaks end a line. */
const wrap = (
  text: string,
  widthPt: number,
  measure: (start: number, end: number) => number,
  noWrap: boolean,
): { start: number; end: number }[] => {
  const lines: { start: number; end: number }[] = [];
  const push = (start: number, rawEnd: number): void => {
    lines.push({ start, end: start + text.slice(start, rawEnd).trimEnd().length });
  };
  let base = 0;
  for (const hard of text.split("\n")) {
    const hardEnd = base + hard.length;
    if (noWrap) {
      push(base, hardEnd);
      base = hardEnd + 1;
      continue;
    }
    let lineStart = base;
    let pos = base;
    let hasWord = false;
    for (const piece of hard.match(/\s+|\S+/g) ?? []) {
      if (/^\s/.test(piece)) {
        pos += piece.length;
        continue;
      }
      if (hasWord && measure(lineStart, pos + piece.length) > widthPt) {
        push(lineStart, pos);
        lineStart = pos;
      }
      pos += piece.length;
      hasWord = true;
    }
    push(lineStart, hardEnd);
    base = hardEnd + 1;
  }
  return lines;
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The area drawn so far, in points; empty (infinite bounds) until
 *  something is drawn. */
interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const grow = (e: Extent, x0: number, y0: number, x1: number, y1: number): void => {
  e.x0 = Math.min(e.x0, x0, x1);
  e.y0 = Math.min(e.y0, y0, y1);
  e.x1 = Math.max(e.x1, x0, x1);
  e.y1 = Math.max(e.y1, y0, y1);
};

const inside = (inner: Rect, outer: Rect): boolean =>
  holdsRect(RECT_RULES["text-in-shape"], rawFromXywh(outer), rawFromXywh(inner));

/** The colour attribute of a piece of text: none for black by default. */
const fillAttr = (color: Hex | undefined): string => (color === undefined ? "" : ` fill="${color}"`);

/** The corner radius of a round rectangle (points), from its `adj` (100 000ths of the shorter side, clamped to [0, 50 000]). */
const cornerRadius = (shape: PptxTextShape, b: Rect): number =>
  (Math.min(b.w, b.h) * Math.min(Math.max(shape.adj ?? DEFAULT_ROUND_ADJ, 0), 50_000)) / 100_000;

/** A point turned by `deg` degrees clockwise (y down, as SVG `rotate`) about (cx, cy). The cosine and sine are rounded to 1e-9 so that a quarter
 *  turn is exact (`Math.cos(Math.PI / 2)` is 6e-17), as `growByPicture` does. */
const turnedPoint = (x: number, y: number, cx: number, cy: number, deg: number): [number, number] => {
  const exact = (v: number): number => Math.round(v * 1e9) / 1e9;
  const [cos, sin] = [exact(Math.cos((deg * Math.PI) / 180)), exact(Math.sin((deg * Math.PI) / 180))];
  const [dx, dy] = [x - cx, y - cy];
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
};

/** The `transform` attribute (with its leading space) turning a SmartArt shape's outline about its frame's centre; none for an angle of 0. */
const outlineTurn = (art: NonNullable<PptxTextShape["smartArt"]>): string =>
  art.turn === 0
    ? ""
    : ` transform="rotate(${n(art.turn / 60_000)} ${n(pt(art.frame.x + art.frame.cx / 2))} ${n(pt(art.frame.y + art.frame.cy / 2))})"`;

/** The six vertices (points, on the slide) of a `hexagon` preset, in its frame as written (the shape's turn comes as `transform`). Formulas of
 *  presetShapeDefinitions: `x1 = ss·a/100000` (`a` pinned to [0, 50000·w/ss]), `dy1 = (h/2)·vf/100000·sin 60°`, vertices at the left and right
 *  middles and at (x1, y1), (r − x1, y1), (r − x1, y2), (x1, y2). */
const hexagonPoints = (art: NonNullable<PptxTextShape["smartArt"]>, adj: number | undefined): [number, number][] => {
  const [l, t, w, h] = [pt(art.frame.x), pt(art.frame.y), pt(art.frame.cx), pt(art.frame.cy)];
  const ss = Math.min(w, h);
  const a = ss === 0 ? 0 : Math.min(Math.max(adj ?? HEXAGON_ADJ, 0), (50_000 * w) / ss);
  const x1 = (ss * a) / 100_000;
  const dy1 = (((h / 2) * (art.vf ?? HEXAGON_VF)) / 100_000) * Math.sin(Math.PI / 3);
  const [vc, r] = [t + h / 2, l + w];
  return [
    [l, vc],
    [l + x1, vc - dy1],
    [r - x1, vc - dy1],
    [r, vc],
    [r - x1, vc + dy1],
    [l + x1, vc + dy1],
  ];
};

/** A `chord` preset (ECMA-376 §20.1.9.18, presetShapeDefinitions): the ellipse of its frame cut by the straight line from the point at
 *  angle `adj1` to the point at angle `adj2` (60 000ths of a degree, clockwise from the right, y down), the arc between them going
 *  clockwise from `adj1`. Defaults `adj1` 2 700 000 (45 degrees), `adj2` 16 200 000 (270). A point at angle a is that of the ellipse's
 *  parameter atan2(w sin a, h cos a), the preset's own `at2` guide. The frame is as written (the shape's turn comes as `transform`).
 *  `undefined` when the arc is empty or a whole turn (the ellipse is then drawn). */
const chordPath = (art: NonNullable<PptxTextShape["smartArt"]>): string | undefined => {
  const [l, t, w, h] = [pt(art.frame.x), pt(art.frame.y), pt(art.frame.cx), pt(art.frame.cy)];
  const [cx, cy] = [l + w / 2, t + h / 2];
  const pin = (v: number): number => Math.min(Math.max(v, 0), 21_599_999);
  const start = pin(art.adj1 ?? 2_700_000);
  const swing = pin(art.adj2 ?? 16_200_000) - start;
  const sweep = swing > 0 ? swing : swing + 21_600_000;
  if (sweep >= 21_600_000 || w === 0 || h === 0) return undefined;
  const on = (angle: number): [number, number] => {
    const a = (angle / 60_000) * (Math.PI / 180);
    const param = Math.atan2((w / 2) * Math.sin(a), (h / 2) * Math.cos(a));
    return [cx + (w / 2) * Math.cos(param), cy + (h / 2) * Math.sin(param)];
  };
  const [x1, y1] = on(start);
  const [x2, y2] = on(start + sweep);
  return `M${n(x1)},${n(y1)}A${n(w / 2)} ${n(h / 2)} 0 ${sweep > 10_800_000 ? 1 : 0} 1 ${n(x2)},${n(y2)}Z`;
};

/** The element of a SmartArt shape's `hexagon` or `chord` preset; `undefined` for any other (and for a chord that is a whole turn). */
const presetElement = (
  shape: PptxTextShape,
  art: NonNullable<PptxTextShape["smartArt"]>,
  paint: string,
): string | undefined => {
  if (shape.geometry === "hexagon") {
    const points = hexagonPoints(art, shape.adj).map(([x, y]) => `${n(x)},${n(y)}`);
    return `<polygon points="${points.join(" ")}" ${paint}/>`;
  }
  const d = shape.geometry === "chord" ? chordPath(art) : undefined;
  return d === undefined ? undefined : `<path d="${d}" ${paint}/>`;
};

/** The element of a shape's outline or fill: the traced preset of a SmartArt shape, else an ellipse, else a rectangle (rounded for `roundRect`). */
const outlineElement = (shape: PptxTextShape, b: Rect, radius: number, paint: string): string => {
  const traced = shape.smartArt === undefined ? undefined : presetElement(shape, shape.smartArt, paint);
  if (traced !== undefined) return traced;
  if (shape.geometry === "ellipse" || shape.geometry === "chord") {
    return `<ellipse cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" rx="${n(b.w / 2)}" ry="${n(b.h / 2)}" ${paint}/>`;
  }
  const corner = shape.geometry === "roundRect" ? ` rx="${n(radius)}"` : "";
  return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"${corner} ${paint}/>`;
};

/** A shape's outline or fill, when it shows one, pushed onto `out` and grown into `drawn`. Says which fill was drawn (`undefined`: none) and
 *  whether the shape holds visible text. */
const drawOutline = (
  shape: PptxTextShape,
  shown: { b: Rect; bounds: Rect },
  radius: number,
  out: string[],
  drawn: Extent,
): { fill: Hex | undefined; hasText: boolean } => {
  const { b, bounds } = shown;
  // The fill is drawn only when it is exact and the colour of every visible
  // run is known too: a known fill under text of unknown colour could hide
  // it (white on white). Otherwise as before colours: an outline for a fill
  // not drawn, black text.
  const visibleRuns = shape.paragraphs.flatMap((p) => p.runs.filter((r) => r.text.trim() !== ""));
  const hasText = visibleRuns.length > 0;
  const fill =
    shape.fill !== "none" && shape.fill !== "unknown" && visibleRuns.every((r) => r.color !== undefined)
      ? shape.fill
      : undefined;
  const stroke = shape.lineShown || (fill === undefined && shape.fill !== "none");
  if (fill !== undefined || stroke) {
    const turn = shape.smartArt === undefined ? "" : outlineTurn(shape.smartArt);
    const paint =
      (fill === undefined ? STROKE : `fill="${fill}"${stroke ? ' stroke="#000" stroke-width="1"' : ""}`) + turn;
    out.push(outlineElement(shape, b, radius, paint));
    grow(drawn, bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h);
  }
  return { fill, hasText };
};

/** A turn of `deg` degrees about (`cx`, `cy`), in points. */
interface Turn {
  deg: number;
  cx: number;
  cy: number;
}

/** What a SmartArt shape's text adds to its lines: `sink` receives each line drawn; `turns` are the rotations the text is drawn under,
 *  in the order SVG applies them to a point: the text rectangle's own turn first, the shape's turn second. */
interface SmartArtText {
  sink: string[];
  turns: Turn[];
  page: Rect;
}

/** The text rectangle `t` and the `room` around which a line counts as out (`textRectangle`); `art`: a SmartArt shape's extras. */
interface TextRectangles {
  t: Rect;
  room: Rect;
  art?: SmartArtText;
}

/** The preset's own inset of the text rectangle on each side (ellipse, round rectangle). None for a SmartArt shape: its `dsp:txXfrm` IS
 *  the text rectangle, the preset's inset already taken. */
const presetInset = (shape: PptxTextShape, b: Rect, radius: number): { x: number; y: number } => {
  if (shape.smartArt !== undefined) return { x: 0, y: 0 };
  if (shape.geometry === "ellipse") return { x: b.w * ELLIPSE_TEXT_INSET, y: b.h * ELLIPSE_TEXT_INSET };
  if (shape.geometry === "roundRect") return { x: radius * ROUND_TEXT_INSET, y: radius * ROUND_TEXT_INSET };
  return { x: 0, y: 0 };
};

/** The text rectangle `t` (the preset's own, less the written insets; a side not written: PowerPoint's default) and the `room` the text may
 *  fill before it counts as overflowing. */
const textRectangle = (shape: PptxTextShape, b: Rect, radius: number): TextRectangles => {
  const { x: presetInsetX, y: presetInsetY } = presetInset(shape, b, radius);
  const inset = {
    left: pt(shape.insets?.left ?? INSET_X_EMU),
    top: pt(shape.insets?.top ?? INSET_Y_EMU),
    right: pt(shape.insets?.right ?? INSET_X_EMU),
    bottom: pt(shape.insets?.bottom ?? INSET_Y_EMU),
  };
  const t: Rect = {
    x: b.x + presetInsetX + inset.left,
    y: b.y + presetInsetY + inset.top,
    w: b.w - 2 * presetInsetX - inset.left - inset.right,
    h: b.h - 2 * presetInsetY - inset.top - inset.bottom,
  };
  // What the text may fill before it is counted as overflowing: the
  // preset's text rectangle WITH its insets. An inset is padding: the text
  // is laid out inside it (wrapped at `t.w`, anchored in `t`) but may eat
  // into it and still sit inside its shape. A line counts as out when its
  // MIDDLE leaves that rectangle: more than half of it outside.
  // Starting value to calibrate (half a line), from PowerPoint's own export
  // of the witnesses (27/09/2026). Fits in PowerPoint: IT 3 « OTA… », three
  // 7 pt lines (25.2 pt) centred in 19.5 pt, a third of a line out at each
  // end; IT 2-6's legend labels, 9 pt at 7.2 pt below the top of a 17.2 pt
  // box, 0.8 pt (7 % of the line) out. Overflows in PowerPoint: Making-the-
  // mobile-web 18, 32 lines of 14 pt (538 pt) centred in 490 pt, the first
  // and last lines 1.4 lines out. Between the two populations: 0.34 and 1.4
  // of a line.
  // Bias, chosen: a text that spills into its padding, or past its box by
  // less than half a line, is not counted.
  const room: Rect = {
    x: b.x + presetInsetX,
    y: b.y + presetInsetY,
    w: b.w - 2 * presetInsetX,
    h: b.h - 2 * presetInsetY,
  };
  return { t, room };
};

/** The paragraphs of a text shape with each run's size resolved, and the size a level falls back to. */
interface SizedParagraphs {
  sized: { p: PptxTextShape["paragraphs"][number]; sizes: { text: string; size: number | undefined }[] }[];
  fallback: (level: number) => number | undefined;
}

/** Each run's size: the one it writes; else, for a shape that is no
 *  placeholder, the one `p:defaultTextStyle` declares for the paragraph's
 *  level, or for level 1 when that level declares none; for a placeholder,
 *  the one it inherits at that level from its layout and master
 *  (`PptxTextShape.inheritedSizes`, 29/09/2026). A visible run
 *  left without a size leaves the whole text out (`undefined`): its size would be a guess. */
const sizeRuns = (
  shape: PptxTextShape,
  defaultSizes: Readonly<Record<number, number>>,
): SizedParagraphs | undefined => {
  const fallback = (level: number): number | undefined =>
    shape.placeholder === undefined ? (defaultSizes[level] ?? defaultSizes[0]) : shape.inheritedSizes?.[level];
  // `endSize` between the run's own size and the level's (8b of the
  // arbitrages, 28/09/2026): the paragraph's end mark is the one written
  // size of a box whose runs carry none — unread, that box's whole text
  // was omitted (« size-not-declared », the Chatroom case).
  const sized = shape.paragraphs.map((p) => ({
    p,
    sizes: p.runs.map((r) => ({ text: r.text, size: r.size ?? p.endSize ?? fallback(p.level ?? 0) })),
  }));
  if (sized.some(({ sizes }) => sizes.some((r) => r.size === undefined && r.text.trim() !== ""))) return undefined;
  return { sized, fallback };
};

/** A line is written as pieces of one colour and size each (colour `undefined`: black). */
type Piece = { text: string; color: Hex | undefined; size: number };
interface TextLine {
  text: string;
  pieces: Piece[];
  size: number;
  height: number;
  width: number;
  align: "ctr" | "r" | undefined;
}

/** What lays out the lines of every paragraph of one shape alike. */
interface LayoutEnv {
  /** The width a line wraps at, in points. */
  wrapWidth: number;
  /** The width of the room a line may fill before it counts as overflowing. */
  roomWidth: number;
  noWrap: boolean;
  /** The text keeps its colours; else it is black. */
  coloured: boolean;
  /** `a:normAutofit fontScale` (1: none). */
  scale: number;
  /** `lnSpcReduction`, taken off the line spacing's percentage. */
  reduction: number;
  /** Factor on every estimated advance (1 for a slide's text; `SMARTART_ADVANCE` for a SmartArt's). */
  advance: number;
}

/** The largest size among runs that have one; a loop, never `Math.max(...sizes)`: a paragraph can hold more runs
 *  than a call takes arguments (a RangeError past ~124k of them). */
const largestKnownSize = (sizes: readonly { size: number | undefined }[]): number | undefined => {
  let largest: number | undefined;
  for (const r of sizes) {
    if (r.size !== undefined && (largest === undefined || r.size > largest)) largest = r.size;
  }
  return largest;
};

/** The pieces of one line, `[start, end)` of the paragraph's text, and the largest size among its visible characters (0: none). */
const piecesOf = (
  joined: string,
  start: number,
  end: number,
  colorAt: readonly (Hex | undefined)[],
  sizeAt: readonly number[],
): { pieces: Piece[]; size: number } => {
  const pieces: Piece[] = [];
  let size = 0;
  for (let i = start; i < end; i++) {
    if (joined[i]!.trim() !== "") size = Math.max(size, sizeAt[i]!);
    const last = pieces.at(-1);
    if (last !== undefined && last.color === colorAt[i] && last.size === sizeAt[i]) last.text += joined[i];
    else pieces.push({ text: joined[i]!, color: colorAt[i], size: sizeAt[i]! });
  }
  return { pieces, size };
};

/** The lines of one paragraph, pushed onto `lines`; says whether one is wider than the room. `paragraphSize`: the height of a line with no visible text. */
const layoutParagraph = (
  p: PptxTextShape["paragraphs"][number],
  sizes: readonly { text: string; size: number | undefined }[],
  paragraphSize: number,
  env: LayoutEnv,
  lines: TextLine[],
): boolean => {
  const { wrapWidth, roomWidth, noWrap, coloured, scale, reduction } = env;
  const spacing = p.lineSpacing;
  const joined = p.runs.map((r) => r.text).join("");
  // Each character's colour and size, from the run it belongs to.
  const colorAt = p.runs.flatMap((r) => Array.from({ length: r.text.length }, () => (coloured ? r.color : undefined)));
  const sizeAt = sizes.flatMap((r) =>
    Array.from({ length: r.text.length }, () => (r.size === undefined ? paragraphSize : r.size * scale)),
  );
  const measure = (start: number, end: number): number => {
    let w = 0;
    for (let i = start; i < end; i++) w += advanceEm(joined[i]!) * sizeAt[i]! * env.advance;
    return w;
  };
  let overflow = false;
  for (const { start, end } of wrap(joined, wrapWidth, measure, noWrap)) {
    const { pieces, size: largest } = piecesOf(joined, start, end, colorAt, sizeAt);
    const size = largest === 0 ? paragraphSize : largest;
    const height =
      spacing !== undefined && "points" in spacing
        ? spacing.points
        : size * LINE_HEIGHT_EM * Math.max((spacing?.percent ?? 1) - reduction, 0);
    const width = measure(start, end);
    lines.push({ text: joined.slice(start, end), pieces, size, height, width, align: p.align });
    if (width > roomWidth) overflow = true;
  }
  return overflow;
};

/** The lines of a text shape, wrapped at the text rectangle's width, and whether one is wider than the room. The text keeps its colours
 *  (`coloured`) or is black. */
const layoutLines = (
  shape: PptxTextShape,
  { sized, fallback }: SizedParagraphs,
  t: Rect,
  room: Rect,
  coloured: boolean,
): { lines: TextLine[]; overflow: boolean } => {
  // Each character at its run's size, as PowerPoint sets it: a line is as
  // high as the largest text ON IT, not in its paragraph (USA 24: « Technical
  // unavailability » at 17 pt then 13 pt on the same line; at the
  // paragraph's 17 pt throughout it took six lines where PowerPoint shows
  // four). A line without visible text (empty paragraph, line breaks only)
  // is as high as its paragraph's largest size, else its level's default,
  // else the shape's first sized run: only a height, no text is drawn at it.
  // `a:normAutofit fontScale` shrinks every size; `lnSpcReduction` is taken
  // off the line spacing's percentage. A spacing in points is the distance
  // between baselines as written.
  const scale = shape.fontScale ?? 1;
  const env: LayoutEnv = {
    wrapWidth: Math.min(t.w, MAX_WRAP_WIDTH_PT),
    roomWidth: room.w,
    noWrap: shape.noWrap === true,
    coloured,
    scale,
    reduction: shape.lineSpaceReduction ?? 0,
    advance: shape.smartArt === undefined ? 1 : SMARTART_ADVANCE,
  };
  const shapeSize = sized.flatMap(({ sizes }) => sizes).find((r) => r.size !== undefined)!.size!;
  let overflow = false;
  const lines: TextLine[] = [];
  for (const { p, sizes } of sized) {
    const paragraphSize = (largestKnownSize(sizes) ?? fallback(p.level ?? 0) ?? shapeSize) * scale;
    if (layoutParagraph(p, sizes, paragraphSize, env, lines)) overflow = true;
  }
  return { lines, overflow };
};

/** The four corners of a box turned by `turns` (each about its own centre, the first applied first). */
const turnedCorners = (box: Rect, turns: readonly Turn[]): [number, number][] =>
  (
    [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ] as const
  ).map(([x, y]) => turns.reduce<[number, number]>(([px, py], t) => turnedPoint(px, py, t.cx, t.cy, t.deg), [x, y]));

/** `grow`, for a box turned by `turns`. */
const growTurned = (drawn: Extent, box: Rect, turns: readonly Turn[]): void => {
  for (const [tx, ty] of turnedCorners(box, turns)) grow(drawn, tx, ty, tx, ty);
};

/** Whether the bounds of a box turned by `turns` meet the page. */
const crossesPage = (box: Rect, turns: readonly Turn[], page: Rect): boolean => {
  const corners = turnedCorners(box, turns);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return (
    Math.max(...xs) > page.x &&
    Math.min(...xs) < page.x + page.w &&
    Math.max(...ys) > page.y &&
    Math.min(...ys) < page.y + page.h
  );
};

/** The `transform` attribute of a text turned by `turns` (none: nothing). SVG applies the list right to left, so the text rectangle's
 *  turn, first in `turns`, is written last. */
const transformAttr = (turns: readonly Turn[]): string => {
  if (turns.length === 0) return "";
  const rotations = [...turns].reverse().map((r) => `rotate(${n(r.deg)} ${n(r.cx)} ${n(r.cy)})`);
  return ` transform="${rotations.join(" ")}"`;
};

/** One line as its `<text>` element at `baseline`, and the area it covers (before the turns, which `growTurned` applies). `turns`, as SVG
 *  writes them, are applied right to left: the text rectangle's first. */
const lineElement = (
  line: TextLine,
  t: Rect,
  baseline: number,
  turns: readonly Turn[],
): { element: string; covers: Rect } => {
  const [x, anchor] =
    line.align === "ctr"
      ? [t.x + t.w / 2, ' text-anchor="middle"']
      : line.align === "r"
        ? [t.x + t.w, ' text-anchor="end"']
        : [t.x, ""];
  const left = line.align === "ctr" ? x - line.width / 2 : line.align === "r" ? x - line.width : x;
  const turned = transformAttr(turns);
  const one = line.pieces.length === 1 ? line.pieces[0]! : undefined;
  const sizeAttr = (q: Piece): string => (q.size === line.size ? "" : ` font-size="${n(q.size)}"`);
  const body =
    one !== undefined
      ? escapeAttr(line.text)
      : line.pieces.map((q) => `<tspan${fillAttr(q.color)}${sizeAttr(q)}>${escapeAttr(q.text)}</tspan>`).join("");
  return {
    element: `<text x="${n(x)}" y="${n(baseline)}" font-family="sans-serif" font-size="${n(line.size)}"${anchor}${fillAttr(one?.color)}${turned} xml:space="preserve">${body}</text>`,
    covers: { x: left, y: baseline - line.size, w: line.width, h: line.size * (1 + DESCENT_EM) },
  };
};

/** The lines as `<text>` elements, stacked from the anchor, grown into `drawn`; says whether a line's middle leaves the room. */
const emitLines = (
  shape: PptxTextShape,
  lines: readonly TextLine[],
  { t, room, art }: TextRectangles,
  out: string[],
  drawn: Extent,
): boolean => {
  let overflow = false;
  const height = lines.reduce((sum, l) => sum + l.height, 0);
  const top = shape.anchor === "b" ? t.y + t.h - height : shape.anchor === "ctr" ? t.y + (t.h - height) / 2 : t.y;
  let y = top;
  for (const line of lines) {
    // `a:spAutoFit`: the written box is the one PowerPoint grew to hold the
    // text; a height past it is our estimate's error, not the deck's.
    const middle = y + line.height / 2;
    if (shape.growsWithText !== true && (middle < room.y || middle > room.y + room.h)) overflow = true;
    // The baseline sits at the size below the line's top, the rest of the
    // line height below it (descenders).
    const baseline = y + line.size;
    y += line.height;
    if (line.text.trim() === "") continue;
    const { element, covers } = lineElement(line, t, baseline, art?.turns ?? []);
    // A SmartArt line turned wholly out of the page is cropped away: not drawn, its words stay undrawn.
    if (art !== undefined && !crossesPage(covers, art.turns, art.page)) continue;
    growTurned(drawn, covers, art?.turns ?? []);
    art?.sink.push(line.text);
    out.push(element);
  }
  return overflow;
};

/** What drawing the shapes of one slide shares: the deck's default sizes, the boxes drawn filled so far (paint order), what is
 *  omitted, the area drawn so far, and the text lines drawn for SmartArt shapes. */
interface DrawEnv {
  /** The page the drawing is cropped to (points, origin 0): a SmartArt line wholly outside it is not drawn. */
  page: Rect;
  defaultSizes: Readonly<Record<number, number>>;
  filled: Rect[];
  omit: (reason: SlideSvgOmission) => void;
  drawn: Extent;
  smartArtText: string[];
}

/** Whether a text shape's geometry is one the drawer traces: `rect`, `roundRect`, `ellipse`, and for a SmartArt's shape the `hexagon` too. */
const tracesGeometry = (shape: PptxTextShape): boolean => {
  const geometry = shape.geometry ?? "";
  return DRAWN_GEOMETRIES.has(geometry) || (shape.smartArt !== undefined && SMARTART_GEOMETRIES.has(geometry));
};

/** A text shape's outline or fill (when it shows one) and its text, or why
 *  not. `env.filled`: the boxes drawn filled so far, in paint order; a box this
 *  shape fills is added to it. `env.drawn` grows by what it draws: its box when
 *  outlined or filled, each line of text as estimated (past the box too). */
const drawText = (shape: PptxTextShape, env: DrawEnv, out: string[]): { overflow: boolean } => {
  const { omit } = env;
  const box = shape.box!;
  if (!tracesGeometry(shape)) {
    omit("geometry");
    return { overflow: false };
  }
  if (shape.rot !== undefined || shape.groupTurned) {
    omit("turned");
    return { overflow: false };
  }
  // `b`: what the outline is drawn in (a SmartArt shape: its frame as written, under `rotate`); `bounds`: the box it covers once turned.
  const bounds: Rect = { x: pt(box.x), y: pt(box.y), w: pt(box.cx), h: pt(box.cy) };
  const frame = shape.smartArt?.frame;
  const b: Rect = frame === undefined ? bounds : { x: pt(frame.x), y: pt(frame.y), w: pt(frame.cx), h: pt(frame.cy) };
  const radius = cornerRadius(shape, b);
  const { fill, hasText } = drawOutline(shape, { b, bounds }, radius, out, env.drawn);
  // `coloured` below reads `filled` only when this shape has no fill of its
  // own, i.e. when nothing is pushed here: no copy of the list is needed.
  // The bounds of a shape turned by other than a quarter are no background for a text laid flat (`inside` compares unturned rectangles).
  if (fill !== undefined && (shape.smartArt === undefined || shape.smartArt.turn % 5_400_000 === 0))
    env.filled.push(bounds);
  if (!hasText) return { overflow: false };
  if (shape.turnedText || shape.flipV) {
    omit("turned-text");
    return { overflow: false };
  }
  return drawLines(shape, env, out, { b, radius, fill });
};

/** The rectangle a SmartArt shape's text sits in (`dsp:txXfrm`), in points; the shape's own box otherwise. */
const textFrameOf = (shape: PptxTextShape, b: Rect): Rect => {
  const art = shape.smartArt;
  if (art === undefined) return b;
  const r: Rect = { x: pt(art.textBox.x), y: pt(art.textBox.y), w: pt(art.textBox.cx), h: pt(art.textBox.cy) };
  // `a:bodyPr vert` of 90 or 270: the lines run along the written height, so the sides are swapped about the box's centre.
  if (art.textSwap === true) return { x: r.x + r.w / 2 - r.h / 2, y: r.y + r.h / 2 - r.w / 2, w: r.h, h: r.w };
  return r;
};

/** A SmartArt shape's text is laid out flat in its rectangle, turned by `textTurn` about THAT rectangle's centre (insets included: they can
 *  differ side to side), then by the shape's turn about the FRAME's centre; one mechanism for every angle, a quarter turn is no special case. Two turns that cancel
 *  about one centre (a hexagon turned 90 and its text rectangle -90) write no transform. `undefined` for any other text. */
const smartArtText = (shape: PptxTextShape, env: DrawEnv): SmartArtText | undefined => {
  const art = shape.smartArt;
  if (art === undefined) return undefined;
  const inner: Turn = {
    deg: art.textTurn / 60_000,
    cx: pt(art.textBox.x + art.textBox.cx / 2),
    cy: pt(art.textBox.y + art.textBox.cy / 2),
  };
  const outer: Turn = {
    deg: art.turn / 60_000,
    cx: pt(art.frame.x + art.frame.cx / 2),
    cy: pt(art.frame.y + art.frame.cy / 2),
  };
  const sameCentre = Math.abs(inner.cx - outer.cx) < SAME_CENTRE_PT && Math.abs(inner.cy - outer.cy) < SAME_CENTRE_PT;
  const cancel = (art.turn + art.textTurn) % FULL_TURN === 0 && sameCentre;
  return { sink: env.smartArtText, page: env.page, turns: cancel ? [] : [inner, outer].filter((t) => t.deg !== 0) };
};

/** The text of a shape whose outline is drawn: sized, laid out in its text rectangle and emitted, or left out when a size is not declared. */
const drawLines = (
  shape: PptxTextShape,
  env: DrawEnv,
  out: string[],
  placed: { b: Rect; radius: number; fill: Hex | undefined },
): { overflow: boolean } => {
  const { b, radius, fill } = placed;
  const art = smartArtText(shape, env);
  const base = textRectangle(shape, textFrameOf(shape, b), radius);
  const rects: TextRectangles = art === undefined ? base : { ...base, art };
  const { t, room } = rects;
  // The text keeps its colours on its own drawn fill, or, without a fill of
  // its own, when its text rectangle lies inside a box drawn filled BEFORE
  // it; else it is black. The text rectangle, not the box: on IT 2 two
  // legend labels run 8 EMU below the bar they sit on. A fill of unknown
  // colour (not drawn) keeps the text black: what shows under it is not known.
  const coloured = fill !== undefined || (shape.fill === "none" && env.filled.some((f) => inside(t, f)));
  const runs = sizeRuns(shape, env.defaultSizes);
  if (runs === undefined) {
    env.omit("size-not-declared");
    return { overflow: false };
  }
  const laid = layoutLines(shape, runs, t, room, coloured);
  const outside = emitLines(shape, laid.lines, rects, out, env.drawn);
  return { overflow: laid.overflow || outside };
};

/** A straight connector's line, or a bent one's polyline through the
 *  vertices the reader computed (`pptx-reader/geometry.ts#bentPath`), with
 *  their arrow heads; or why not. An invisible line (`visibleLine` false)
 *  draws nothing and is no omission. */
const drawConnector = (
  shape: PptxConnectorShape,
  out: string[],
  omit: (reason: SlideSvgOmission) => void,
  drawn: Extent,
): boolean => {
  const geometry = shape.geometry ?? "";
  const straight = STRAIGHT_CONNECTORS.has(geometry);
  if (!straight && !(BENT_CONNECTORS.has(geometry) && shape.path !== undefined)) {
    omit("connector-geometry");
    return false;
  }
  if (!shape.visibleLine) return false;
  // Every declared head is drawn as a triangle: "triangle", "arrow" and
  // "stealth" all point the same way; the reader keeps no finer kind.
  const start = shape.startArrow ? ' marker-start="url(#s)"' : "";
  const end = shape.endArrow ? ' marker-end="url(#e)"' : "";
  if (straight) {
    if (shape.ends === undefined) return false;
    const e = shape.ends;
    out.push(
      `<line x1="${n(pt(e.x1))}" y1="${n(pt(e.y1))}" x2="${n(pt(e.x2))}" y2="${n(pt(e.y2))}" stroke="#000" stroke-width="1"${start}${end}/>`,
    );
    grow(drawn, pt(e.x1), pt(e.y1), pt(e.x2), pt(e.y2));
  } else {
    for (const v of shape.path!) grow(drawn, pt(v.x), pt(v.y), pt(v.x), pt(v.y));
    // A vertex written twice in a row (an adj of 0 or 100 000 folds a
    // segment to nothing) is dropped: a head orients on its segment, and a
    // segment of no length has no direction.
    const points = shape
      .path!.map((v) => `${n(pt(v.x))},${n(pt(v.y))}`)
      .filter((v, i, all) => i === 0 || v !== all[i - 1]);
    out.push(`<polyline points="${points.join(" ")}" fill="none" stroke="#000" stroke-width="1"${start}${end}/>`);
  }
  return shape.startArrow || shape.endArrow;
};

/** The two arrow heads, 6 × 6 stroke widths, tip on the line's end. */
const MARKERS =
  '<defs><marker id="s" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M10 0L0 5L10 10z"/></marker>' +
  '<marker id="e" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>';

/** `defaultTextSizes`: the deck's `p:defaultTextStyle` sizes by level
 *  (`PptxReadResult.defaultTextSizes`), for the runs of a free shape that
 *  write none; without it such text is left out and counted. */
export const renderSlideSvg = (
  shapes: readonly PptxShape[],
  slide: Size,
  defaultTextSizes: Readonly<Record<number, number>> = {},
): SlideSvg => {
  const omitted: Partial<Record<SlideSvgOmission, number>> = {};
  const picturesNotDrawn: SlideSvg["picturesNotDrawn"] = [];
  const omit = (reason: SlideSvgOmission): void => {
    omitted[reason] = (omitted[reason] ?? 0) + 1;
  };
  // One slot per shape, in shape-tree order: the paint order. A picture's
  // slot is filled once the size of everything else is known; its base64
  // body is PREDICTED here and encoded only for the pictures the cap keeps.
  const parts: string[][] = [];
  const pictures: { slot: number; shape: PptxPictureShape; head: string; bytes: Uint8Array }[] = [];
  let overflowingText = 0;
  const smartArtText: string[] = [];
  let arrows = false;
  const filled: Rect[] = [];
  const drawn: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const shape of shapes) {
    const out: string[] = [];
    parts.push(out);
    if (shape.box === undefined) {
      omit("no-box");
      if (shape.kind === "picture") picturesNotDrawn.push({ spTreeIndex: shape.spTreeIndex, reason: "no-box" });
      continue;
    }
    switch (shape.kind) {
      case "text":
        if (
          drawText(
            shape,
            {
              page: { x: 0, y: 0, w: pt(slide.cx), h: pt(slide.cy) },
              defaultSizes: defaultTextSizes,
              filled,
              omit,
              drawn,
              smartArtText,
            },
            out,
          ).overflow
        )
          overflowingText++;
        break;
      case "connector":
        if (drawConnector(shape, out, omit, drawn)) arrows = true;
        break;
      case "table":
      case "graphic":
        omit("frame");
        break;
      case "picture": {
        if (!("image" in shape)) {
          omit("picture-not-published");
          picturesNotDrawn.push({ spTreeIndex: shape.spTreeIndex, reason: shape.notPublished });
          break;
        }
        const type = drawableType(shape.image.bytes);
        if (type === undefined) {
          omit("picture-not-published");
          picturesNotDrawn.push({ spTreeIndex: shape.spTreeIndex, reason: "format" });
          break;
        }
        if (shape.groupStretched) {
          omit("picture-group-stretched");
          picturesNotDrawn.push({ spTreeIndex: shape.spTreeIndex, reason: "group-stretched" });
          break;
        }
        // The reader gives a frame whenever it gives a box, but for a
        // picture turned inside a group stretched unevenly.
        const f = shape.frame;
        if (f === undefined) {
          omit("no-box");
          picturesNotDrawn.push({ spTreeIndex: shape.spTreeIndex, reason: "no-box" });
          continue;
        }
        pictures.push({
          slot: parts.length - 1,
          shape,
          head:
            `<image x="${n(pt(f.x))}" y="${n(pt(f.y))}" width="${n(pt(f.cx))}" height="${n(pt(f.cy))}"` +
            (shape.matrix === undefined
              ? pictureTransform(f, shape.rot, shape.flipH === true, shape.flipV === true)
              : pictureMatrix(shape.matrix)) +
            ` preserveAspectRatio="none" href="data:${type};base64,`,
          bytes: shape.image.bytes,
        });
        // Every picture offered counts, before the size cap decides: the
        // viewBox is part of that size. One the cap then drops leaves blank
        // space where it stood — its « not drawn » line says why.
        growByPicture(drawn, f, shape.rot, shape.matrix);
        break;
      }
    }
  }

  // Cropped to what is drawn (29/09/2026), plus a margin, and
  // never past the slide: what PowerPoint shows of a slide stops at its
  // edges, and the whole slide was the former viewBox, so nothing drawn
  // before is lost. Nothing drawn: the whole slide, as before.
  const wPt = pt(slide.cx);
  const hPt = pt(slide.cy);
  const cx0 = Math.max(0, drawn.x0 - CROP_MARGIN_PT);
  const cy0 = Math.max(0, drawn.y0 - CROP_MARGIN_PT);
  const cx1 = Math.min(wPt, drawn.x1 + CROP_MARGIN_PT);
  const cy1 = Math.min(hPt, drawn.y1 + CROP_MARGIN_PT);
  // Empty: nothing drawn (infinite bounds), or all of it off the slide.
  const empty = !(cx1 > cx0 && cy1 > cy0);
  const [vx, vy, vw, vh] = empty ? [0, 0, wPt, hPt] : [cx0, cy0, cx1 - cx0, cy1 - cy0];
  // The whole slide's scale (at most 744 px for its width, never enlarged),
  // times MAX_ENLARGEMENT at most, and never past 744 px wide.
  // A SmartArt is shown at its frame's scale, not enlarged (20/10/2026: the 2x of a cropped drawing made its text twice the
  // size Office draws it at, against the page's other text).
  const enlargement = shapes.some((s) => s.kind === "text" && s.smartArt !== undefined) ? 1 : MAX_ENLARGEMENT;
  const scale = Math.min(MAX_WIDTH_PX / vw, (enlargement * Math.min(MAX_WIDTH_PX, wPt)) / wPt);
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(vw * scale)}" height="${n(vh * scale)}" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}">` +
    (arrows ? MARKERS : "") +
    `<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="#fff"/>`;
  const close = "</svg>";

  let size =
    utf8Length(open) + utf8Length(close) + parts.reduce((sum, p) => sum + p.reduce((s, x) => s + utf8Length(x), 0), 0);
  for (const picture of pictures) {
    // Base64 is ASCII, one byte per character, 4 of them per 3 bytes padded:
    // the tag's size is exact BEFORE encoding, so a picture the cap drops is
    // never encoded at all.
    const tagLength = picture.head.length + 4 * Math.ceil(picture.bytes.length / 3) + 3;
    if (size + tagLength > MAX_SVG_BYTES) {
      omit("picture-over-cap");
      picturesNotDrawn.push({ spTreeIndex: picture.shape.spTreeIndex, reason: "over-cap" });
      continue;
    }
    size += tagLength;
    parts[picture.slot]!.push(`${picture.head}${Buffer.from(picture.bytes).toString("base64")}"/>`);
  }
  // Shape-tree order: the cap is decided after the walk.
  picturesNotDrawn.sort((a, b) => a.spTreeIndex - b.spTreeIndex);
  return {
    svg: open + parts.map((p) => p.join("")).join("") + close,
    omitted,
    overflowingText,
    picturesNotDrawn,
    smartArtText,
  };
};
