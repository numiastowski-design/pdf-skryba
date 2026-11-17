/** Which lines of a PDF column stand inside a closed rectangle DRAWN on the page (a boxed masthead, a « Register here »
 *  box), and how the reader publishes them: flat in their cell, nested at their place, or below the column table (the
 *  product) (`FramedBlocks`, the two variants the maintainer judges at the bench, 06/11/2026). Decides frame membership and the
 *  split of a band into framed groups and the lines between them.
 *  NOT here: the rectangles themselves (`extractor/pdf-table-detector.ts`, `boxesByPage`), nor what the groups become
 *  (`extractor/pdf-image-anchors.ts#rowBlocks`).
 *  Called by: `extractor/pdf-image-anchors.ts`. */

import type { ContainerBox } from "./pdf-line-breaks";
import type { PdfTextRun } from "./pdf-source";

/**
 * HOW THE BOXED BLOCKS OF A COLUMN ARE PUBLISHED (06/11/2026: « essaye table imbriquée dans sa colonne et
 * tables séparées sous les colonnes en a/b »). The specimen is page 2 of `fixtures/pdf/58-Alouette-Colloque-journal.pdf`:
 * the « Alouette / Parution trimestrielle » masthead, ADHÉREZ, « Informations pratiques », « Inscriptions » and the
 * turned « P.P. 1000 LAUSANNE 12 » banner, each drawn as a closed rectangle inside its column.
 *   - `flat`: the lines of a frame read in the flow of their cell (the product until 06/11/2026);
 *   - `nested`: each frame is a one-cell table (`framed: true`, `lib/ir.ts`) at its place inside the cell;
 *   - `below`: the frames leave the cell and follow the column table as one-cell tables, in reading order.
 * The choice will be made by switching the default here, nothing more.
 * ⚠️ `nested` MEASURED ON A PUBLISHED PAGE (06/11/2026, FIDREVIEW 110297110, `docs/PLATFORM-STATUS.md` §97): Confluence
 * stores each nested table as a `nested-table` MIGRATION EXTENSION — the form search does not index (29/09/2026). `below`
 * (FIDREVIEW 110526465) is stored native: 0 extension in a cell. DECIDED on that page (06/11/2026, « on part
 * là-dessus »): `below` is the product's default.
 */
export type FramedBlocks = "flat" | "nested" | "below";

/** The default of the product: `below` (06/11/2026, see above). */
export const DEFAULT_FRAMED_BLOCKS: FramedBlocks = "below";

/**
 * HOW FAR A FRAGMENT MAY STEP OUT OF A FRAME AND STILL BELONG TO IT, in points, on each edge. Starting value to calibrate
 * (06/11/2026). Measured on the five frames of the Alouette bulletin, page 2: the inked lines of a frame sit 2 pt or more
 * inside its edges (« Inscriptions » runs x 366..656 in a box 364..660; the masthead's lines 131..341 in 125..349) ; the
 * nearest line OUTSIDE a frame is a neighbouring column, 15 pt and more away. Nothing between 2 and 15: the value sits at
 * the inner edge of the measured population, so a frame drawn tight on its text still holds it.
 */
export const MAX_FRAME_OVERHANG_PT = 2;

/** A group of lines that stand in one frame, placed at the index of their first line in the band. */
export interface FramedGroup {
  frame: ContainerBox;
  /** Index in the band of the first line of the group: where the group is published in `nested`. */
  at: number;
  lines: PdfTextRun[][];
}

/** A band split: the lines no frame holds, in order, each with its index; and the groups, in order of their first line. */
export interface FramedSplit {
  rest: { at: number; line: PdfTextRun[] }[];
  groups: FramedGroup[];
}

/** The two ends of a fragment's BASELINE: from its origin, `width` along its writing direction. A turned run (`rotated`,
 *  `pdf-source.ts`) runs along `matrix` (a, b); its `width`/`height` box describes nothing of its extent. The baseline
 *  is what decides membership: the glyphs' ascent may poke out of a frame drawn tight on the text (the 18 pt « P. P. » of the
 *  turned banner, whose full-height box reaches 4 pt past the frame while its baseline stands inside). */
const baselineOf = (it: PdfTextRun): [{ x: number; y: number }, { x: number; y: number }] => {
  const start = { x: it.x, y: it.y };
  if (!it.rotated) return [start, { x: it.x + it.width, y: it.y }];
  const n = Math.hypot(it.matrix.a, it.matrix.b);
  if (n === 0) return [start, start];
  return [start, { x: it.x + (it.width * it.matrix.a) / n, y: it.y + (it.width * it.matrix.b) / n }];
};

/** The box of every baseline end of a line's inked fragments, computed ONCE per line; `undefined` for a line of blanks only,
 *  which is nowhere. Every end inside a rectangle is the same as this box inside it. */
interface LineBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** The smallest box holding both; either may be absent. */
const joinBoxes = (a: LineBox | undefined, b: LineBox | undefined): LineBox | undefined => {
  if (a === undefined || b === undefined) return a ?? b;
  return {
    xMin: Math.min(a.xMin, b.xMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMin: Math.min(a.yMin, b.yMin),
    yMax: Math.max(a.yMax, b.yMax),
  };
};

const boxOfLine = (line: readonly PdfTextRun[]): LineBox | undefined => {
  let box: LineBox | undefined;
  for (const it of line.filter((f) => f.text.trim() !== "")) {
    for (const p of baselineOf(it)) box = joinBoxes(box, { xMin: p.x, xMax: p.x, yMin: p.y, yMax: p.y });
  }
  return box;
};

/** Every inked fragment's baseline inside the frame, each edge widened by `MAX_FRAME_OVERHANG_PT`. */
const boxInside = (box: LineBox, frame: ContainerBox): boolean => {
  const t = MAX_FRAME_OVERHANG_PT;
  return (
    box.xMin >= frame.left - t &&
    box.xMax <= frame.right + t &&
    box.yMin >= frame.bottom - t &&
    box.yMax <= frame.top + t
  );
};

/** The frames of a page by growing area, SORTED ONCE per frames array (one page calls `splitFramed` for each of its bands). */
const sortedByArea = ((): ((frames: readonly ContainerBox[]) => ContainerBox[]) => {
  const memo = new WeakMap<readonly ContainerBox[], ContainerBox[]>();
  return (frames) => {
    let sorted = memo.get(frames);
    if (sorted === undefined) {
      sorted = [...frames].sort(
        (p, q) => (p.right - p.left) * (p.top - p.bottom) - (q.right - q.left) * (q.top - q.bottom),
      );
      memo.set(frames, sorted);
    }
    return sorted;
  };
})();

/**
 * THE LINES OF A BAND BY THE FRAME THAT HOLDS THEM. A line belongs to a frame when ALL its inked fragments fall in the
 * rectangle (`MAX_FRAME_OVERHANG_PT`); a line split between two frames, or half out, stays in the flow. The innermost frame
 * wins when several hold the line (a box drawn inside a box). ONE group per frame: a frame's lines are gathered even when
 * another frame's lines interleave with them in the band (the turned banner stands BESIDE the masthead in the same band,
 * so their lines alternate by height) — the group is published where its first line is.
 *
 * WRITTEN GUARD — A PAGE BORDER IS NOT A FRAME: a rectangle that holds EVERY inked line of the band is the border of the
 * column or of the page, and it frames nothing. A rectangle that holds no line of the band is not a frame of this band.
 */
export const splitFramed = (lines: readonly PdfTextRun[][], frames: readonly ContainerBox[]): FramedSplit => {
  const boxes = lines.map(boxOfLine);
  const inkedCount = boxes.filter((b) => b !== undefined).length;
  // A frame that does not reach the band's own ink holds none of its lines: left out before any line is tested.
  const reach = boxes.reduce<LineBox | undefined>(joinBoxes, undefined);
  const t = MAX_FRAME_OVERHANG_PT;
  const candidates = sortedByArea(frames).filter(
    (f) =>
      reach !== undefined &&
      f.right + t >= reach.xMin &&
      f.left - t <= reach.xMax &&
      f.top + t >= reach.yMin &&
      f.bottom - t <= reach.yMax,
  );
  const owners = boxes.map((b) => (b === undefined ? undefined : candidates.find((f) => boxInside(b, f))));
  const borders = new Set(
    candidates.filter((f) => inkedCount > 0 && owners.filter((o) => o === f).length === inkedCount),
  );
  const groups: FramedGroup[] = [];
  const rest: FramedSplit["rest"] = [];
  lines.forEach((line, at) => {
    const owner = owners[at];
    if (owner === undefined || borders.has(owner)) {
      rest.push({ at, line: [...line] });
      return;
    }
    const group = groups.find((g) => g.frame === owner);
    if (group === undefined) groups.push({ frame: owner, at, lines: [[...line]] });
    else group.lines.push([...line]);
  });
  return { rest, groups };
};
