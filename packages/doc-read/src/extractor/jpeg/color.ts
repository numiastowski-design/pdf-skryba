/** Component sample planes turned into RGBA pixels: chroma upsampled as
 *  libjpeg's "fancy" (triangle) filter does for 2:1 ratios and by replication
 *  otherwise, YCbCr to RGB with T.871's constants and truncation, CMYK and
 *  YCCK (Adobe APP14) through jpeg-js's formulas, alpha 255. Refuses the one
 *  case where the Adobe reading and jpeg-js's disagree (three components,
 *  APP14 transform 0).
 *  NOT here: the samples themselves (`jpeg/idct.ts`), the RGBA buffer's
 *  budget (`jpeg/decode.ts` passes it).
 *  Called by: `jpeg/decode.ts`. */

import type { SamplePlane } from "./idct";
import { componentDims, refuse, type JpegFrame } from "./markers";

/**
 * UPSAMPLING. T.81 does not say how a decoder fills the pixels between
 * subsampled chroma samples. Since 06/10/2026 (Mikolaj's decision) a component
 * subsampled 2:1 horizontally, with 1:1 or 2:1 vertically (4:2:2, 4:2:0), is
 * upsampled as libjpeg-turbo's `h2v1_fancy_upsample` / `h2v2_fancy_upsample`
 * (`jdsample.c`) compute it: each output sample is a weighted mean of the two
 * nearest input samples (3:1 horizontally, and vertically 3:1 with the
 * neighbouring row, whose own sums are weighted 3:1 again), in integers with
 * libjpeg's rounding biases (alternating 1 and 2 for h2v1, 8 and 7 for h2v2),
 * the first and last sample of a row kept as they are, the rows above the first
 * and below the last replicated. Edges are those of the component's real width
 * and height (ceil(image × H / Hmax)), not of its block-padded plane. libjpeg
 * only filters when that width exceeds 2; narrower, it replicates, so do we.
 * Every other ratio (4:4:0, 4:1:1, 3:1, ...) keeps jpeg-js's replication: pixel x reads
 * sample `x × (H / Hmax)` truncated (same vertically), computed in floating point
 * so a ratio of 1/3 truncates as jpeg-js's does. libjpeg-turbo also has a fancy
 * 4:4:0 filter; not taken, 4:4:0 is rare. Measured against Pillow 12.3.0
 * (libjpeg-turbo): `upsampling.test.ts`.
 *
 * COLOUR. T.871 §7 gives R = Y + 1.402 (Cr − 128),
 * G = Y − 0.344136 (Cb − 128) − 0.714136 (Cr − 128), B = Y + 1.772 (Cb − 128).
 * These are the constants used (jpeg-js wrote 0.3441363 and 0.71413636: the same pixels on every
 * fixture, checked 06/10/2026 against jpeg-js at tolerance 0). Clamped to 0..255, stored into a byte
 * (truncation), as jpeg-js did.
 * Three components are converted unless the stream says otherwise; jpeg-js
 * converts them whatever APP14 says. The Adobe reading (transform 0: no
 * conversion, the samples are RGB — as IJG libjpeg reads it) disagrees for
 * transform 0: refused rather than guessed. Four components (CMYK, or YCCK
 * when the APP14 transform is not 0) follow jpeg-js's two steps literally,
 * inverted samples included. No standard gives CMYK -> RGB: IJG libjpeg hands CMYK
 * back as is and leaves RGB to the application. Checked instead against a second,
 * independent reading (06/10/2026): a real Photoshop CMYK JPEG decodes within 3
 * levels of 255 of Pillow's reading (`decode.test.ts`, `fixtures/jpeg/`). YCCK has
 * no real sample yet: open limit.
 */


const clamp = (a: number): number => (a < 0 ? 0 : a > 255 ? 255 : a);

/** YCbCr to RGB, one channel at a time (a tuple would allocate once per pixel); the expressions keep their float order. */
const ycbcrRed = (y: number, cr: number): number => clamp(y + 1.402 * (cr - 128));
const ycbcrGreen = (y: number, cb: number, cr: number): number => clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
const ycbcrBlue = (y: number, cb: number): number => clamp(y + 1.772 * (cb - 128));

/** For each output column (or row), the sample index it reads in a plane. */
const indexMap = (size: number, ratio: number, planeSize: number): Int32Array => {
  const out = new Int32Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.min((i * ratio) | 0, planeSize - 1);
  return out;
};

/** h2v1_fancy_upsample of one row: `n` input samples at `at` of `src` give 2n outputs. n > 2. */
const fancyRowH2V1 = (src: Uint8Array, at: number, n: number, out: Uint8Array): void => {
  out[0] = src[at]!;
  out[1] = (src[at]! * 3 + src[at + 1]! + 2) >> 2;
  for (let i = 1; i < n - 1; i++) {
    const three = src[at + i]! * 3;
    out[2 * i] = (three + src[at + i - 1]! + 1) >> 2;
    out[2 * i + 1] = (three + src[at + i + 1]! + 2) >> 2;
  }
  out[2 * n - 2] = (src[at + n - 1]! * 3 + src[at + n - 2]! + 1) >> 2;
  out[2 * n - 1] = src[at + n - 1]!;
};

/** h2v2_fancy_upsample of one output row: rows `near` (3/4) and `far` (1/4) of the input. n > 2. */
const fancyRowH2V2 = (src: Uint8Array, near: number, far: number, n: number, out: Uint8Array): void => {
  let last = 0;
  let here = src[near]! * 3 + src[far]!;
  let next = src[near + 1]! * 3 + src[far + 1]!;
  out[0] = (here * 4 + 8) >> 4;
  out[1] = (here * 3 + next + 7) >> 4;
  last = here;
  here = next;
  for (let i = 1; i < n - 1; i++) {
    next = src[near + i + 1]! * 3 + src[far + i + 1]!;
    out[2 * i] = (here * 3 + last + 8) >> 4;
    out[2 * i + 1] = (here * 3 + next + 7) >> 4;
    last = here;
    here = next;
  }
  out[2 * n - 2] = (here * 3 + last + 8) >> 4;
  out[2 * n - 1] = (here * 4 + 7) >> 4;
};

/** How each component's row is produced: filtered (2:1 horizontally, libjpeg's `fancy` cases) or replicated. */
interface RowSource {
  readonly plane: SamplePlane;
  readonly fancy: "h2v1" | "h2v2" | undefined;
  /** Real (unpadded) size of the component. */
  readonly realWidth: number;
  readonly realHeight: number;
  readonly xs: Int32Array;
  readonly ys: Int32Array;
  readonly line: Uint8Array;
}

const rowSource = (frame: JpegFrame, c: JpegFrame["components"][number], plane: SamplePlane): RowSource => {
  const { width, height } = frame;
  const { realWidth, realHeight } = componentDims(frame, c);
  const horizontal = c.h * 2 === frame.maxH && realWidth > 2;
  const fancy = horizontal && c.v === frame.maxV ? "h2v1" : horizontal && c.v * 2 === frame.maxV ? "h2v2" : undefined;
  return {
    plane,
    fancy,
    realWidth,
    realHeight,
    xs: indexMap(width, c.h / frame.maxH, plane.width),
    ys: indexMap(height, c.v / frame.maxV, plane.height),
    line: new Uint8Array(Math.max(width, 2 * realWidth)),
  };
};

/** Fills `source.line` with the component's samples of output row `y`. */
const fillLine = (source: RowSource, y: number, width: number): void => {
  const { plane, line } = source;
  if (source.fancy === "h2v1") {
    fancyRowH2V1(plane.data, Math.min(y, source.realHeight - 1) * plane.width, source.realWidth, line);
  } else if (source.fancy === "h2v2") {
    const row = y >> 1;
    const far = y & 1 ? Math.min(row + 1, source.realHeight - 1) : Math.max(row - 1, 0);
    fancyRowH2V2(plane.data, row * plane.width, far * plane.width, source.realWidth, line);
  } else {
    const at = source.ys[y]! * plane.width;
    for (let x = 0; x < width; x++) line[x] = plane.data[at + source.xs[x]!]!;
  }
};

export const toRgba = (frame: JpegFrame, planes: readonly SamplePlane[], adobe: { transform: number } | undefined, out: Uint8Array): void => {
  const { width, height } = frame;
  const count = frame.components.length;
  if (count === 3 && adobe && adobe.transform === 0) throw refuse("adobe rgb colour transform not supported");
  const sources = frame.components.map((c, i) => rowSource(frame, c, planes[i]!));
  const transform = count === 3 || (count === 4 && adobe !== undefined && adobe.transform !== 0);
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (const source of sources) fillLine(source, y, width);
    const l0 = sources[0]!.line;
    const l1 = sources[1]?.line;
    const l2 = sources[2]?.line;
    const l3 = sources[3]?.line;
    for (let x = 0; x < width; x++) {
      const s0 = l0[x]!;
      if (count === 1) {
        out[o] = s0;
        out[o + 1] = s0;
        out[o + 2] = s0;
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      const s1 = l1![x]!;
      const s2 = l2![x]!;
      if (count === 3) {
        // Byte stores truncate, as jpeg-js's `Uint8Array` stores do.
        out[o] = ycbcrRed(s0, s2);
        out[o + 1] = ycbcrGreen(s0, s1, s2);
        out[o + 2] = ycbcrBlue(s0, s1);
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      const k = l3![x]!;
      let c: number, m: number, ye: number;
      if (transform) {
        c = 255 - ycbcrRed(s0, s2);
        m = 255 - ycbcrGreen(s0, s1, s2);
        ye = 255 - ycbcrBlue(s0, s1);
      } else {
        c = s0;
        m = s1;
        ye = s2;
      }
      // jpeg-js's intermediate buffer holds bytes: 255 - C stored, truncated.
      const cb = (255 - c) & 0xff;
      const mb = (255 - m) & 0xff;
      const yb = (255 - ye) & 0xff;
      const kb = (255 - k) & 0xff;
      out[o] = 255 - clamp(cb * (1 - kb / 255) + kb);
      out[o + 1] = 255 - clamp(mb * (1 - kb / 255) + kb);
      out[o + 2] = 255 - clamp(yb * (1 - kb / 255) + kb);
      out[o + 3] = 255;
      o += 4;
    }
  }
};
