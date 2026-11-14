/** The only file that knows how an operator's arguments are encoded (the shape pdf.js gave, which our reader reproduces):
 *  the operator stream decoded once, into names and plain values.
 *  NOT here: what the operators mean geometrically
 *  (`extractor/glyph-positions.ts`, `extractor/pdf-table-detector.ts`), nor the
 *  object store (`extractor/pdf-images.ts`).
 *  Called by: `extractor/{glyph-positions,pdf-source,pdf-table-detector}.ts`. */

/**
 * pdf-ops — THE DECODING HALF OF THE BOUNDARY: the operator stream, in the
 * shape inherited from pdf.js that our reader reproduces, translated once and for all.
 *
 * ⚠️ **THIS FILE IS THE ONLY ONE THAT KNOWS THE ENCODING OF OPERATOR
 * ARGUMENTS.** That is its reason for being (14/09/2026): this knowledge lived in nine places of `glyph-positions.ts`,
 * mixed with the geometric reconstruction, and nothing named it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ONE FIRST, AND NOT `constructPath` OR `objs.get`
 * ═══════════════════════════════════════════════════════════════════════════
 * The four undeclared accesses of the repo were ordered by what ALREADY
 * failed, not by what could fail. This one is the only one of the three
 * remaining to have produced a real defect: **two successive reconstructions
 * returned `NaN`** (09/09/2026), one because it read
 * `args as number[]` on an object with numeric keys, the other because it
 * only followed one matrix out of two.
 *
 * `constructPath` and `objs.get` never failed, and the second one fails closed
 * (`undefined` on anything unexpected). They come after.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REAL SHAPES, MEASURED AND NOT GUESSED
 * ═══════════════════════════════════════════════════════════════════════════
 * A matrix arrives under FOUR encodings depending on the operator and the version:
 * six flat numbers, a `Float32Array`, an object with numeric keys, and either
 * of these forms WRAPPED in a one-element array. Measured:
 *
 *     setTextMatrix -> [{"0":1,"1":0,"2":0,"3":1,"4":0,"5":0}]
 *
 * **The reading is INDEXED, never based on `.length`**: a `Float32Array`
 * has one, an object with numeric keys does not, and both are met.
 * We check what we need — six numbers at indices 0 to 5 — rather than
 * the type of the container.
 *
 * After `decodeOps`, `transform` and `setTextMatrix` carry an ordinary
 * `Matrix2D`. No consumer has to know these four forms any more, and (history: before the removal of pdf.js) a
 * `pdfjs-dist` upgrade that changed one of them made
 * `pdf-ops.test.ts` fail — a named test — instead of silently moving a page.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT NORMALISED
 * ═══════════════════════════════════════════════════════════════════════════
 * The other arguments are already ordinary arrays and pass through as they are.
 * Normalising them too would require specifying every operator, hence
 * describing this shape more widely than necessary — the opposite of the goal. We decode
 * what is TRICKY, not everything that exists.
 */

import { ReaderError } from "doc-ir/lib/reader-error";
import type { Matrix2D } from "doc-ir/layout/geometry";

/**
 * An operation of the stream, NAMED, with its arguments unfolded.
 *
 * `args` is a `Matrix2D` for `transform` and `setTextMatrix`, and the raw
 * argument for everything else — see "what is not normalised".
 */
export interface PdfOp {
  op: string;
  args: unknown;
}

/** The operations whose argument IS a matrix, and which are therefore the only ones
 *  to go through the unfolding above. */
const MATRIX_OPS = new Set(["transform", "setTextMatrix"]);

/** A point in PATH space — the current matrix has not yet been
 *  applied to it, that is the consumer's role. */
interface PathPoint {
  x: number;
  y: number;
}

/** `constructPath`, unfolded: the paint operation, the sub-paths already
 *  decoded, and the box that pdf.js sometimes joined. */
export interface PdfPathArg {
  /** The raw code of the paint operation. */
  paintOp: number;
  /** That same code, NAMED (`"stroke"`, `"fill"`, `"eoFillStroke"`…). Absent
   *  when no code table was provided, or when the code is not
   *  in it — a CLIPPING path alone is never painted, and that is not an
   *  anomaly. It is this name that lets the consumer classify a paint
   *  without needing `OPS`. */
  paint?: string;
  subpaths: PathPoint[][];
  minMax?: number[];
}

/** `n` numbers at indices 0..n-1, whatever the container — `Array`,
 *  `Float32Array`, or object with numeric keys. `undefined` otherwise. */
function numbersAt(source: unknown, n: number): number[] | undefined {
  const values = Array.from({ length: n }, (_, k) => {
    const v = (source as Record<number, unknown> | undefined)?.[k];
    return typeof v === "number" ? v : undefined;
  });
  return values.every((v): v is number => v !== undefined) ? (values as number[]) : undefined;
}

/** Six numbers at indices 0..5 (a matrix); `undefined` when the shape carries fewer. */
const sixAt = (source: unknown): number[] | undefined => numbersAt(source, 6);

/** A matrix in the shape pdf.js had, under any of its four encodings. */
function readMatrixArg(args: unknown): Matrix2D {
  const m = sixAt(args) ?? (Array.isArray(args) ? sixAt(args[0]) : undefined);
  if (m === undefined) throw new ReaderError("EXTRACT_FAILED", "text matrix: unrecognized argument shape");
  return matrixOfSix(m);
}

/** The form XObject `/Matrix` of a `paintFormXObjectBegin` op (`args[0]`: an
 *  Array, a Float32Array or null), or `undefined` when it is not six finite numbers. */
export function readFormMatrix(args: unknown): Matrix2D | undefined {
  const m = Array.isArray(args) ? sixAt(args[0]) : undefined;
  if (m === undefined || !m.every(Number.isFinite)) return undefined;
  return matrixOfSix(m);
}

/** Deepest `q` nesting kept by the PDF walks. Past it `q` pushes nothing and the
 *  surplus is counted, so each later `Q` pairs with an unpushed `q` first.
 *  Starting value to calibrate: our own choice, not measured on a corpus (a legitimate
 *  page nests a handful of `q`; the point is to bound the stack against a hostile file). */
export const GRAPHICS_STATE_MAX_DEPTH = 256;

/** The graphics-state stack of a PDF walk (`q`/`Q` and form XObjects), bounded by
 *  GRAPHICS_STATE_MAX_DEPTH. Each consumer chooses its state shape `S` (copied by
 *  spread on `save`). Past the cap a push is only counted, and the next pops pair
 *  with those counted pushes first. */
export class GraphicsStateStack<S extends object> {
  private readonly states: S[];
  private unpushed = 0;

  constructor(initial: S) {
    this.states = [initial];
  }

  /** The state ops mutate in place. */
  get current(): S {
    return this.states[this.states.length - 1]!;
  }

  /** `q`. */
  save(): void {
    if (this.states.length < GRAPHICS_STATE_MAX_DEPTH) this.states.push({ ...this.current });
    else this.unpushed += 1;
  }

  /** `Q`, or the end of a form XObject. A surplus `Q` on the base state is ignored. */
  restore(): void {
    if (this.unpushed > 0) this.unpushed -= 1;
    else if (this.states.length > 1) this.states.pop();
  }

  /** Begin of a form XObject: its own state, derived from the current one. Past the
   *  cap the form is not isolated and its end is paired like a surplus `Q`. */
  form(derive: (top: S) => S): void {
    if (this.states.length < GRAPHICS_STATE_MAX_DEPTH) this.states.push(derive(this.current));
    else this.unpushed += 1;
  }
}

/** The optional-content (`BDC /OC … EMC`) nesting of a PDF walk. Every marked-content begin pushes a level, so a
 *  plain `BMC` nests correctly; a level hides when it is a switched-off layer. A surplus `EMC` is ignored.
 *  Optional content arrives as `["OC", group]`, the shape pdf.js gave (`group` null when it could not read it: shown). */
export class HiddenLayerStack {
  private readonly levels: boolean[] = [];
  private hiddenCount = 0;

  /** `BMC` / `BDC`. Without a verdict (`isLayerVisible` undefined) nothing is ever hidden. */
  enter(op: string, args: unknown, isLayerVisible: ((group: unknown) => boolean) | undefined): void {
    const hides =
      isLayerVisible !== undefined &&
      op === "beginMarkedContentProps" &&
      Array.isArray(args) &&
      args[0] === "OC" &&
      args[1] != null &&
      !isLayerVisible(args[1]);
    this.levels.push(hides);
    if (hides) this.hiddenCount += 1;
  }

  /** `EMC`. */
  leave(): void {
    if (this.levels.pop() === true) this.hiddenCount -= 1;
  }

  /** True inside at least one switched-off layer. */
  get hidden(): boolean {
    return this.hiddenCount > 0;
  }
}

const matrixOfSix = (m: readonly number[]): Matrix2D => ({ a: m[0]!, b: m[1]!, c: m[2]!, d: m[3]!, e: m[4]!, f: m[5]! });

/**
 * The numeric `fnArray` (shape inherited from pdf.js, which our reader reproduces) → named, unfolded operations.
 *
 * `OPS` is INJECTED rather than imported: this module depends on no reader,
 * so it stays testable without paying for the import. It is the boundary (`pdf-source.ts`) that
 * provides it.
 *
 * An unknown code is IGNORED, never named: the stream contains colours,
 * paths and images that do not concern us, and giving them a name
 * would make a consumer throw that only throws on what looks like text.
 */
export function decodeOps(
  opList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  OPS: Record<string, number>,
): PdfOp[] {
  const byCode = new Map<number, string>(Object.entries(OPS).map(([name, code]) => [code, name]));
  const out: PdfOp[] = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const name = byCode.get(opList.fnArray[i]!);
    if (name === undefined) continue;
    const raw = opList.argsArray[i];
    if (MATRIX_OPS.has(name)) out.push({ op: name, args: readMatrixArg(raw) });
    else if (name === "constructPath") out.push({ op: name, args: readPathArg(raw, OPS) });
    else out.push({ op: name, args: raw });
  }
  return out;
}


/** Empirically verified (04/09/2026) against the real operator list of the
 *  pdf.js then installed (removed 01/11/2026; our reader reproduces this encoding) — not documented upstream, so
 *  its tests pin it. Inside a `constructPath` op's
 *  packed args (a flat numeric array), sub-path segments are encoded as
 *  `[segCode, ...coords]` repeated: `0` = moveTo (2 coords), `1` = lineTo
 *  (2 coords), `4` = closePath (no coords, and it REPEATS the sub-path's
 *  starting point — see the code). Confirmed to reconstruct both a
 *  `rectangle()` call and a plain two-point line exactly. Any other code
 *  (curves, anything this codebase hasn't seen) stops decoding THAT
 *  path — a straight-line-only table border is exactly what this detector
 *  needs, a curve is never one, so bailing out on an unrecognized segment
 *  is a safe, documented limitation, not a silently wrong answer. */
export function decodePathSubpaths(packed: ArrayLike<number>): { x: number; y: number }[][] {
  const subpaths: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  let i = 0;
  while (i < packed.length) {
    const code = packed[i];
    if (code === 0) {
      if (current.length > 0) subpaths.push(current);
      current = [{ x: packed[i + 1]!, y: packed[i + 2]! }];
      i += 3;
    } else if (code === 1) {
      current.push({ x: packed[i + 1]!, y: packed[i + 2]! });
      i += 3;
    } else if (code === 4) {
      // SUB-PATH CLOSING — fixed on 11/09/2026. Skipping this code without
      // doing anything cost the LAST SIDE of every rectangle: four points
      // only describe three segments, and the fourth connects the last point
      // to the first. Measured on a real report card: the header frame of
      // page 1 offered only ONE vertical where a grid requires two, so
      // no region could form and the block disappeared WITHOUT
      // ANY SIGNAL. The page frame lost its own in the same way.
      //
      // The table of the same page did not suffer from it: its borders are
      // painted as dozens of overlapping paths, and the missing side
      // of one rectangle is given back there by the next. A frame drawn ONCE
      // has no such safety net — that is why the defect stayed
      // invisible until now.
      //
      // Repeating the starting point is the faithful form of a closed polyline:
      // `subpathsToSegments` draws the missing side from it without having to
      // know anything about closing, and the segment thus emitted carries the same
      // paint as the other three since it comes out of the SAME path.
      const start = current[0];
      if (start !== undefined && current.length > 1) current.push({ ...start });
      i += 1;
    } else {
      break;
    }
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

/**
 * `constructPath`, unfolded — **its wrapper included**.
 *
 * `args = [paintOp, [packedSegments], minMax]`: the segments are themselves
 * in a one-element array. `args[1][0]`, never `args[1]`. Established
 * empirically on 04/09/2026, **not documented upstream**, and this unwrapping
 * used to live in a comment at two call sites without a single test.
 *
 * ⚠️ **A PATH WITHOUT SEGMENTS IS A NORMAL STATE, NOT AN UNKNOWN SHAPE.**
 * Measured on 14/09/2026 on the 34 `constructPath` of the corpus:
 *
 *     20 x   args[1] = Array(1), [0] = object     (segments)
 *     14 x   args[1] = Array(1), [0] = null       (no segment)
 *
 * Four out of ten carry none. The old code never saw it: it
 * decoded AFTER having filtered on the paint operation. By moving the
 * decoding up into the boundary, this case becomes visible — it returns `subpaths: []`,
 * and it is the oracle that found it by tripping over it.
 *
 * The NON-wrapped form has **never been observed** (34 out of 34 are
 * wrapped). It is accepted anyway because telling it apart costs one
 * line and because it is toward it that a version upgrade would tip.
 *
 * Throws on a truly unknown shape rather than returning an empty path: an
 * empty path would be indistinguishable from a path without segments, and the detector
 * would conclude "no border" instead of "I do not know".
 */
export function readPathArg(args: unknown, OPS?: Record<string, number>): PdfPathArg {
  if (!Array.isArray(args) || args.length < 2) {
    throw new ReaderError("EXTRACT_FAILED", "constructPath: unrecognized argument shape");
  }
  const [paintOp, wrapper, minMax] = args as [unknown, unknown, unknown];
  if (typeof paintOp !== "number") {
    throw new ReaderError("EXTRACT_FAILED", "constructPath: unrecognized argument shape");
  }
  const packed = Array.isArray(wrapper) && typeof wrapper[0] !== "number" ? wrapper[0] : wrapper;
  // `args[0]` lives in the SAME code space as `OPS` — its numeric value
  // is literally `OPS.stroke`, `OPS.fill`, etc. (verified on 04/09/2026 by
  // printing both side by side against a synthetic `drawLine`). Naming it
  // here is what lets a consumer classify a paint without
  // knowing pdf.js.
  const paint = OPS === undefined ? undefined : Object.keys(OPS).find((name) => OPS[name] === paintOp);
  return {
    paintOp,
    ...(paint !== undefined ? { paint } : {}),
    subpaths: packed === null || packed === undefined ? [] : decodePathSubpaths(packed as ArrayLike<number>),
    // ⚠️ `minMax` is a **Float32Array**, measured: 20 out of 20 of those that
    // carry one. `Array.isArray` returns `false` on it — I wrote it that way on the
    // first draft and the colour dots disappeared, because their
    // detection rests entirely on this box (a disc is a path with
    // CURVES that `decodePathSubpaths` refuses: `minMax` is then the only
    // trace of its extent). The test caught it; this is exactly the
    // trap that this file's header describes.
    ...(() => {
      const mm = numbersAt(minMax, 4);
      return mm === undefined ? {} : { minMax: mm };
    })(),
  };
}
