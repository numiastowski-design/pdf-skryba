/** A JPEG (baseline, extended or progressive, Huffman coding) decoded to
 *  RGBA pixels without jpeg-js, with the two guards the product callers give
 *  jpeg-js (megapixels, megabytes): the same pixels as jpeg-js, or our own
 *  refusal. Memory is counted on what is actually allocated (coefficients,
 *  sample planes, the RGBA output).
 *  NOT here: the stages themselves (`jpeg/markers.ts`,
 *  `jpeg/sequential-scan.ts`, `jpeg/progressive-scan.ts`, `jpeg/idct.ts`,
 *  `jpeg/color.ts`), nor what the callers do with the pixels
 *  (`extractor/image-reduction.ts`, `extractor/pptx-reader/picture.ts`).
 *  Called by: `extractor/image-reduction.ts`, `extractor/pptx-reader/picture.ts`, `jpeg/decode.test.ts`. */

import { toRgba } from "./color";
import { componentPlanes } from "./idct";
import { componentDims, parseJpeg, refuse, type JpegStructure } from "./markers";
import { MemoryBudget } from "./memory-budget";
import { decodeProgressiveScan } from "./progressive-scan";
import { allocateCoefficients, decodeSequentialScan } from "./sequential-scan";

/** The same two guards, in the same units, as jpeg-js's `decode` options. */
export interface JpegDecodeGuard {
  /** Largest width × height, in millions of pixels (jpeg-js: 10^6, not 2^20). */
  readonly maxResolutionInMP: number;
  /** Largest memory allocated by the decode, in MiB (jpeg-js: 2^20 bytes). */
  readonly maxMemoryUsageInMB: number;
}

export interface DecodedJpeg {
  readonly width: number;
  readonly height: number;
  /** RGBA, alpha 255, row-major. */
  readonly data: Uint8Array;
}

/** CPU TIME. A scan walks every block it covers, over its band Ss..Se, whatever
 *  bytes it carries: a refinement scan of end-of-band runs costs a dozen bytes
 *  and a full walk (255 of them on 12 MP took 7.5 s, review of 06/10/2026). The
 *  scan count alone bounds nothing, so the walk itself is summed from the scan
 *  headers, in coefficients, and refused above this many times the image's
 *  coefficients, BEFORE any scan is decoded. Valeur de départ à calibrer:
 *  the 12 progressive JPEGs of the fixtures walk 1.03 to 2.66 times, the
 *  hostile stream of the review 250 times. jpeg-js has no bound. Times here
 *  are measured on an esbuild node22 bundle, as shipped: under tsx the same
 *  decode runs about ten times slower (15 s against 1.5 s), which first
 *  misled the review. At the guard, the slowest stream found takes 1.5 s. */
const MAX_WORK_RATIO = 8;
/** Least cost of a scan per block, in coefficients: a DC scan walks one
 *  coefficient but pays the per-block cost of the loop (255 DC refinements on
 *  12 MP 4:4:4 took 3 s under the guard, counter-review of 06/10/2026).
 *  Valeur de départ à calibrer: with it the 72 fixture JPEGs walk 1.00 to 2.91. */
const MIN_SCAN_COST = 8;

/** Coefficients the scans will walk, over the coefficients of the image. */
const workRatio = (structure: JpegStructure): number => {
  const { frame } = structure;
  const blocks = frame.components.map((c) => {
    const dims = componentDims(frame, c);
    return dims.blocksPerLine * dims.blocksPerColumn;
  });
  const mcus = frame.mcusPerLine * frame.mcusPerColumn;
  let walked = 0;
  for (const scan of structure.scans) {
    const covered =
      scan.components.length === 1
        ? blocks[scan.components[0]!.componentIndex]!
        : mcus *
          scan.components.reduce(
            (sum, c) => sum + frame.components[c.componentIndex]!.h * frame.components[c.componentIndex]!.v,
            0,
          );
    walked += covered * Math.max(scan.se - scan.ss + 1, MIN_SCAN_COST);
  }
  return walked / (blocks.reduce((sum, b) => sum + b, 0) * 64);
};

/**
 * MEMORY. jpeg-js counts its coefficient blocks, its sample lines, an
 * intermediate buffer of width × height × components and the RGBA output;
 * this decoder has no intermediate buffer, so for the same image it counts
 * less, and accepts everything jpeg-js accepts under the same guard (and a
 * little more: the gap is width × height × components bytes).
 */
export const decodeJpegRgba = (bytes: Uint8Array, guard: JpegDecodeGuard): DecodedJpeg => {
  const { maxResolutionInMP, maxMemoryUsageInMB } = guard;
  if (
    !Number.isFinite(maxResolutionInMP) ||
    maxResolutionInMP < 0 ||
    !Number.isFinite(maxMemoryUsageInMB) ||
    maxMemoryUsageInMB < 0
  ) {
    throw new Error("decodeJpegRgba: guards must be finite numbers >= 0");
  }
  const structure = parseJpeg(bytes, { maxPixels: maxResolutionInMP * 1000 * 1000 });
  const { frame } = structure;
  if (workRatio(structure) > MAX_WORK_RATIO) throw refuse("scans over the work guard");
  const budget = new MemoryBudget(maxMemoryUsageInMB * 1024 * 1024);
  const coefficients = allocateCoefficients(frame, budget);
  const decodeScan = frame.process === "progressive" ? decodeProgressiveScan : decodeSequentialScan;
  for (const scan of structure.scans) decodeScan(frame, scan, coefficients);
  const planes = componentPlanes(structure, coefficients, budget);
  const data = budget.uint8(frame.width * frame.height * 4);
  toRgba(frame, planes, structure.adobe, data);
  return { width: frame.width, height: frame.height, data };
};
