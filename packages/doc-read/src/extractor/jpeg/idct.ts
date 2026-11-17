/** Dequantisation and inverse DCT of a decoded JPEG: each component's
 *  coefficient blocks turned into a plane of 8-bit samples (level shift +128,
 *  clamped), with exactly jpeg-js's integer arithmetic so the samples are the
 *  same, pixel for pixel. Planes are allocated through the memory budget.
 *  NOT here: decoding the coefficients (`jpeg/sequential-scan.ts`), colour
 *  conversion and chroma upsampling (`jpeg/color.ts`).
 *  Called by: `jpeg/idct.test.ts`, `jpeg/decode.ts`, and `jpeg/color.ts` (the `SamplePlane` type). */

import { refuse, type JpegStructure } from "./markers";
import type { MemoryBudget } from "./memory-budget";
import { ZIGZAG, type ComponentCoefficients } from "./sequential-scan";

/**
 * WHAT IS COMPUTED. T.81 defines the inverse DCT as a real-valued formula
 * (A.3.3) followed by the level shift of A.3.1, and does not prescribe an
 * arithmetic. The samples here follow the integer factorisation jpeg-js
 * uses — Loeffler, Ligtenberg, Moschytz, "Practical fast 1-D DCT algorithms
 * with 11 multiplications", ICASSP 1989, as ported by poppler then pdf.js
 * then jpeg-js (`lib/decoder.js#quantizeAndInverse`, Apache-2.0): constants
 * in 1/4096 (cos, sin of k·π/16, √2), the same rounding offsets and shifts,
 * rows then columns, the same short cut for an all-zero AC row or column.
 * This is a COMPATIBILITY choice, not a rule of the standard: it makes every
 * sample equal to jpeg-js's, so swapping the decoder republishes nothing.
 * Its distance to the real formula is pinned by a test (within 1).
 *
 * `>>` and `Int32Array` stores wrap at 32 bits exactly as in jpeg-js's
 * JavaScript, so even a hostile coefficient (a 32-bit DC prediction) gives
 * jpeg-js's sample, not a different garbage.
 *
 * Planes cover the blocks inside the image (`blocksPerLine × 8` by
 * `blocksPerColumn × 8`), as jpeg-js's: the MCU padding is never drawn.
 */

export interface SamplePlane {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const COS1 = 4017; // cos(π/16) × 4096
const SIN1 = 799; // sin(π/16) × 4096
const COS3 = 3406; // cos(3π/16) × 4096
const SIN3 = 2276; // sin(3π/16) × 4096
const COS6 = 1567; // cos(6π/16) × 4096
const SIN6 = 3784; // sin(6π/16) × 4096
const SQRT2 = 5793; // √2 × 4096
const SQRT1D2 = 2896; // √2 / 2 × 4096

/** A DQT table (zigzag order, as stored) in natural order. */
export const naturalQuantTable = (zigzag: Uint16Array): Int32Array => {
  const out = new Int32Array(64);
  for (let k = 0; k < 64; k++) out[ZIGZAG[k]!] = zigzag[k]!;
  return out;
};

/** Scratch block: one per module, the decode is synchronous. */
const p = new Int32Array(64);

/** Dequantises the 64 coefficients at `at` with `quant` (natural order) into the scratch block. */
const dequantise = (coefficients: Int32Array, at: number, quant: Int32Array): void => {
  for (let i = 0; i < 64; i++) p[i] = coefficients[at + i]! * quant[i]!;
};

/** The row pass of the scratch block, in place: an all-zero AC row is flattened to its DC. */
const inverseRows = (): void => {
  let v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, t: number;
  for (let row = 0; row < 64; row += 8) {
    if (
      p[1 + row] === 0 &&
      p[2 + row] === 0 &&
      p[3 + row] === 0 &&
      p[4 + row] === 0 &&
      p[5 + row] === 0 &&
      p[6 + row] === 0 &&
      p[7 + row] === 0
    ) {
      t = (SQRT2 * p[row]! + 512) >> 10;
      p.fill(t, row, row + 8);
      continue;
    }
    // stage 4
    v0 = (SQRT2 * p[row]! + 128) >> 8;
    v1 = (SQRT2 * p[4 + row]! + 128) >> 8;
    v2 = p[2 + row]!;
    v3 = p[6 + row]!;
    v4 = (SQRT1D2 * (p[1 + row]! - p[7 + row]!) + 128) >> 8;
    v7 = (SQRT1D2 * (p[1 + row]! + p[7 + row]!) + 128) >> 8;
    v5 = p[3 + row]! << 4;
    v6 = p[5 + row]! << 4;
    // stage 3
    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * SIN6 + v3 * COS6 + 128) >> 8;
    v2 = (v2 * COS6 - v3 * SIN6 + 128) >> 8;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;
    // stage 2
    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * SIN3 + v7 * COS3 + 2048) >> 12;
    v4 = (v4 * COS3 - v7 * SIN3 + 2048) >> 12;
    v7 = t;
    t = (v5 * SIN1 + v6 * COS1 + 2048) >> 12;
    v5 = (v5 * COS1 - v6 * SIN1 + 2048) >> 12;
    v6 = t;
    // stage 1
    p[row] = v0 + v7;
    p[7 + row] = v0 - v7;
    p[1 + row] = v1 + v6;
    p[6 + row] = v1 - v6;
    p[2 + row] = v2 + v5;
    p[5 + row] = v2 - v5;
    p[3 + row] = v3 + v4;
    p[4 + row] = v3 - v4;
  }
};

/** The column pass of the scratch block, in place: an all-zero AC column is flattened to its DC. */
const inverseColumns = (): void => {
  let v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, t: number;
  for (let col = 0; col < 8; col++) {
    if (
      p[8 + col] === 0 &&
      p[16 + col] === 0 &&
      p[24 + col] === 0 &&
      p[32 + col] === 0 &&
      p[40 + col] === 0 &&
      p[48 + col] === 0 &&
      p[56 + col] === 0
    ) {
      t = (SQRT2 * p[col]! + 8192) >> 14;
      for (let r = 0; r < 64; r += 8) p[r + col] = t;
      continue;
    }
    // stage 4
    v0 = (SQRT2 * p[col]! + 2048) >> 12;
    v1 = (SQRT2 * p[32 + col]! + 2048) >> 12;
    v2 = p[16 + col]!;
    v3 = p[48 + col]!;
    v4 = (SQRT1D2 * (p[8 + col]! - p[56 + col]!) + 2048) >> 12;
    v7 = (SQRT1D2 * (p[8 + col]! + p[56 + col]!) + 2048) >> 12;
    v5 = p[24 + col]!;
    v6 = p[40 + col]!;
    // stage 3
    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * SIN6 + v3 * COS6 + 2048) >> 12;
    v2 = (v2 * COS6 - v3 * SIN6 + 2048) >> 12;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;
    // stage 2
    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * SIN3 + v7 * COS3 + 2048) >> 12;
    v4 = (v4 * COS3 - v7 * SIN3 + 2048) >> 12;
    v7 = t;
    t = (v5 * SIN1 + v6 * COS1 + 2048) >> 12;
    v5 = (v5 * COS1 - v6 * SIN1 + 2048) >> 12;
    v6 = t;
    // stage 1
    p[col] = v0 + v7;
    p[56 + col] = v0 - v7;
    p[8 + col] = v1 + v6;
    p[48 + col] = v1 - v6;
    p[16 + col] = v2 + v5;
    p[40 + col] = v2 - v5;
    p[24 + col] = v3 + v4;
    p[32 + col] = v3 - v4;
  }
};

/** Level shift (+128), rounding and clamping of the scratch block into the 8 × 8 window at `outAt`, `stride` bytes a row. */
const storeSamples = (out: Uint8Array, outAt: number, stride: number): void => {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sample = 128 + ((p[y * 8 + x]! + 8) >> 4);
      out[outAt + y * stride + x] = sample < 0 ? 0 : sample > 255 ? 255 : sample;
    }
  }
};

/** Dequantises the 64 coefficients at `at` with `quant` (natural order),
 *  inverts the DCT and writes the 8 × 8 samples at `outAt` of `plane.data`, `plane.width` bytes a row.
 *  The plane is one object per component, built by the caller before its block loop: no allocation per block. */
export const inverseDctBlock = (
  coefficients: Int32Array,
  at: number,
  quant: Int32Array,
  plane: Pick<SamplePlane, "data" | "width">,
  outAt: number,
): void => {
  dequantise(coefficients, at, quant);
  inverseRows();
  inverseColumns();
  storeSamples(plane.data, outAt, plane.width);
};

/** Every component's sample plane, in frame order. */
export const componentPlanes = (
  structure: JpegStructure,
  coefficients: readonly ComponentCoefficients[],
  budget: MemoryBudget,
): SamplePlane[] =>
  structure.frame.components.map((component, ci) => {
    const table = structure.quantTables[component.tq];
    // A component no scan named was never checked by `parseJpeg`.
    if (!table) throw refuse("missing quantization table");
    const quant = naturalQuantTable(table);
    const grid = coefficients[ci]!;
    const width = grid.blocksPerLine * 8;
    const height = grid.blocksPerColumn * 8;
    const data = budget.uint8(width * height);
    const plane: SamplePlane = { width, height, data };
    for (let row = 0; row < grid.blocksPerColumn; row++) {
      for (let col = 0; col < grid.blocksPerLine; col++) {
        inverseDctBlock(grid.data, (row * grid.stride + col) * 64, quant, plane, row * 8 * width + col * 8);
      }
    }
    return plane;
  });
