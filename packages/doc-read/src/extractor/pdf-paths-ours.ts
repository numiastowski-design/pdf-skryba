/** The PATHS of a page (ISO 32000-1:2008 §8.5.2 path construction, §8.5.3 painting), read from OUR content stream, in the
 *  shape `pdf-ops.ts` decodes (pdf.js's `constructPath` shape, inherited): one operator per painting, with its painted name and its
 *  sub-paths.
 *  Decides: which segments a painting carries, and the sub-paths `decodePathSubpaths` makes of them. A rectangle with a
 *  zero side is a diagonal, as pdf.js drew it (`buildPath`, OPS.rectangle); a curve stops its sub-path there, as
 *  `decodePathSubpaths` stops at a curve; `s`, `b` and `b*` close before they paint; coordinates are Float32 values,
 *  as pdf.js stored them. The packed form is pdf.js's own, inherited, so the same decoder reads it.
 *  NOT here: the bounding box (`minMax`: no consumer reads it), the clipping (`W`, `W*`: no consumer reads a clip),
 *  the colour and the transformation of the path (`pdf-table-detector.ts`, `glyph-positions.ts`).
 *  Measured against pdf.js's `constructPath` before its removal, on the fixtures (0 difference outside form pages): `tools/poc/paths-shadow.ts` (deleted, see git history).
 *  Called by: `extractor/pdf-ops-ours.ts` (the path operators of a page, in their order), `pdf-paths-ours.test.ts`. */

import type { PdfValue } from "./pdf-objects/objects";
import { decodePathSubpaths, type PdfPathArg } from "./pdf-ops";

/** pdf.js's packed segment codes (its `DrawOPS`): moveTo, lineTo, curve, closePath. */
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const CLOSE = 4;

/** The painting operator's name, as pdf.js named it: `n` paints nothing (`endPath`). */
const PAINT_NAME: Readonly<Record<string, string>> = {
  f: "fill",
  F: "fill",
  "f*": "eoFill",
  S: "stroke",
  s: "closeStroke",
  B: "fillStroke",
  "B*": "eoFillStroke",
  b: "closeFillStroke",
  "b*": "closeEOFillStroke",
  n: "endPath",
};

/** The paintings that close their path first: `s`, `b`, `b*`. */
const CLOSING_PAINTS = new Set(["s", "b", "b*"]);

/** The path-construction and painting operators: the only ones a path builder takes. */
export const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re", ...Object.keys(PAINT_NAME), "W", "W*"]);

const numberOf = (value: PdfValue | undefined): number | undefined => (value?.kind === "number" ? value.value : undefined);

/** One page's path under construction. `feed` takes each operator of the path family, in order, and returns the painted
 *  path when the operator paints (`f`, `S`, `n`…), `undefined` otherwise. Clipping (`W`, `W*`) only sets the clip flag:
 *  nothing consumes it, so it paints nothing. */
/** THE BOX OF A PACKED PATH, CURVES INCLUDED (05/11/2026): `decodePathSubpaths` stops at the first curve, so a disc or a
 *  rounded box had no extent — and a white digit on a green disc (`pdf.test.ts`) passed for text on the bare page. The
 *  control points of a curve bound it, so the box is exact enough to say what a glyph sits on. `[xMin, yMin, xMax, yMax]`,
 *  `undefined` for a path without a point. */
const OPERANDS_BY_CODE: Readonly<Record<number, number>> = { [CURVE]: 6, [CLOSE]: 0 };

/** Every point of a packed path (a curve's control points included), one `[x, y]` at a time. */
function* packedPoints(packed: readonly number[]): Generator<[number, number]> {
  let i = 0;
  while (i < packed.length) {
    const count = OPERANDS_BY_CODE[packed[i]!] ?? 2;
    for (let k = 0; k < count; k += 2) yield [packed[i + 1 + k]!, packed[i + 2 + k]!];
    i += 1 + count;
  }
}

const minMaxOf = (packed: readonly number[]): [number, number, number, number] | undefined => {
  // By LOOP, never `Math.min(...xs)`: a path of 120 000 points or more threw a RangeError and failed the document.
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const [x, y] of packedPoints(packed)) {
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  if (xMin === Infinity) return undefined;
  return [xMin, yMin, xMax, yMax];
};

export class PathBuilder {
  private packed: number[] = [];
  private current = { x: 0, y: 0 };
  private start: { x: number; y: number } | undefined;

  feed(op: string, operands: readonly PdfValue[]): PdfPathArg | undefined {
    const n = operands.map(numberOf);
    // An operator whose operands are not all numbers is read as having none: a painting still paints what it has.
    const v = n.every((x): x is number => x !== undefined) ? n.map((x) => Math.fround(x as number)) : [];
    if (v.length !== n.length) return this.paint(op);
    switch (op) {
      case "m":
        this.packed.push(MOVE, v[0]!, v[1]!);
        this.current = { x: v[0]!, y: v[1]! };
        this.start = { ...this.current };
        return undefined;
      case "l":
        this.packed.push(LINE, v[0]!, v[1]!);
        this.current = { x: v[0]!, y: v[1]! };
        return undefined;
      case "c":
        this.packed.push(CURVE, ...v.slice(0, 6));
        this.current = { x: v[4]!, y: v[5]! };
        return undefined;
      case "v":
        this.packed.push(CURVE, this.current.x, this.current.y, v[0]!, v[1]!, v[2]!, v[3]!);
        this.current = { x: v[2]!, y: v[3]! };
        return undefined;
      case "y":
        this.packed.push(CURVE, v[0]!, v[1]!, v[2]!, v[3]!, v[2]!, v[3]!);
        this.current = { x: v[2]!, y: v[3]! };
        return undefined;
      case "h":
        this.packed.push(CLOSE);
        if (this.start !== undefined) this.current = { ...this.start };
        return undefined;
      case "re":
        this.rectangle(n as number[]);
        return undefined;
      case "W":
      case "W*":
        return undefined;
      default:
        return this.paint(op);
    }
  }

  /** As pdf.js did, the sides are added in double precision, from the operands as read, and only then stores each corner in a
   *  Float32 buffer: the sum is taken before the rounding, not after it. */
  private rectangle(raw: readonly number[]): void {
    const [rx, ry, rw, rh] = [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
    if (rx === undefined || ry === undefined || rw === undefined || rh === undefined) return;
    const x = Math.fround(rx);
    const y = Math.fround(ry);
    const xw = Math.fround(rx + rw);
    const yh = Math.fround(ry + rh);
    // As pdf.js did: a zero side draws the diagonal only; otherwise the four sides, closed.
    if (rw === 0 || rh === 0) this.packed.push(MOVE, x, y, LINE, xw, yh, CLOSE);
    else this.packed.push(MOVE, x, y, LINE, xw, y, LINE, xw, yh, LINE, x, yh, CLOSE);
    this.current = { x, y };
    this.start = { x, y };
  }

  private paint(op: string): PdfPathArg | undefined {
    const paint = PAINT_NAME[op];
    if (paint === undefined) return undefined;
    // `s`, `b` and `b*` close the path first (as pdf.js did: closePath, then the painting), so the close is packed too.
    if (CLOSING_PAINTS.has(op)) this.packed.push(CLOSE);
    const minMax = minMaxOf(this.packed);
    const painted: PdfPathArg = { paintOp: 0, paint, subpaths: decodePathSubpaths(this.packed), ...(minMax === undefined ? {} : { minMax }) };
    this.packed = [];
    this.start = undefined;
    return painted;
  }
}
