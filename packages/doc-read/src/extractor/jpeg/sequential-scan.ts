/** The DCT coefficients of a sequential JPEG (baseline or extended, Huffman
 *  coding), decoded scan by scan into one MCU-padded block grid per
 *  component, natural order, before dequantisation. Also allocates that grid,
 *  charged to the memory budget, and exports the zigzag order and the DC/AC size bounds (`ZIGZAG`,
 *  `MAX_DC_CATEGORY`, `MAX_AC_SIZE`) that the other stages share.
 *  NOT here: the marker structure (`jpeg/markers.ts`), the Huffman tables and
 *  bit reading (`jpeg/huffman.ts`), dequantisation and the inverse DCT
 *  (`jpeg/idct.ts`), progressive scans (`jpeg/progressive-scan.ts`).
 *  Called by: `jpeg/sequential-scan.test.ts`, `jpeg/decode.ts`, `jpeg/progressive-scan.ts`, `jpeg/idct.ts` and
 *  `jpeg/encode.ts`. */

import { BitReader, tableOf, type HuffmanTable } from "./huffman";
import { componentDims, refuse, type JpegFrame, type JpegScan } from "./markers";
import type { MemoryBudget } from "./memory-budget";

/**
 * GRID (ITU-T T.81 A.1.1, A.2.3, A.2.4). A component of sampling factors
 * H × V has ceil(ceil(X × H / Hmax) / 8) blocks per line inside the image
 * (`blocksPerLine`), and as many columns of blocks; an interleaved scan
 * covers whole MCUs, so `stride` = MCUs per line × H blocks are allocated
 * (and `rows` = MCUs per column × V). A non-interleaved scan (one component)
 * covers only the blocks inside the image (A.2.2). jpeg-js counts blocks per
 * line as ceil(ceil(X / 8) × H / Hmax): the same for every ratio Hmax / H of
 * 1, 2 or 4, not always for 3 (no fixture has one).
 *
 * DECODING (T.81 F.2.2). DC: a category T from the DC table, then T bits
 * extended, added to the component's prediction (F.2.1.3.1), reset to 0 at
 * the scan start and at each restart (E.2.4). AC: symbols RRRRSSSS, a run R
 * of zeros then a coefficient of S bits; 0x00 ends the block (EOB), 0xF0
 * skips 16 zeros (ZRL). With 8-bit samples T is at most 11 and S at most 10
 * (tables F.1, F.2): larger is refused, and so is a coefficient that would
 * land past the 64th (jpeg-js writes it nowhere and goes on).
 *
 * Coefficients are 32-bit like jpeg-js's, so a hostile stream that pushes a
 * DC prediction past 16 bits gives the same numbers as jpeg-js, not a wrap.
 */

export interface ComponentCoefficients {
  /** Blocks per line and per column inside the image (A.1.1). */
  readonly blocksPerLine: number;
  readonly blocksPerColumn: number;
  /** Blocks per line and per column allocated: the MCU grid. */
  readonly stride: number;
  readonly rows: number;
  /** `rows × stride` blocks of 64 coefficients, natural (row-major) order. */
  readonly data: Int32Array;
}

/** Natural-order index of the k-th coefficient in zigzag order (T.81 figure A.6). */
export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]);

export const MAX_DC_CATEGORY = 11;
export const MAX_AC_SIZE = 10;

export const allocateCoefficients = (frame: JpegFrame, budget: MemoryBudget): ComponentCoefficients[] => {
  const grids = frame.components.map((c) => {
    const { blocksPerLine, blocksPerColumn } = componentDims(frame, c);
    return { blocksPerLine, blocksPerColumn, stride: frame.mcusPerLine * c.h, rows: frame.mcusPerColumn * c.v };
  });
  // Every grid is charged before the first is allocated: a refusal allocates nothing.
  const total = grids.reduce((sum, g) => sum + g.stride * g.rows * 64, 0);
  const all = budget.int32(total);
  let at = 0;
  return grids.map((g) => {
    const data = all.subarray(at, at + g.stride * g.rows * 64);
    at += data.length;
    return { ...g, data };
  });
};

const decodeBlock = (
  reader: BitReader,
  dc: HuffmanTable,
  ac: HuffmanTable,
  out: Int32Array,
  at: number,
  prediction: Int32Array,
  ci: number,
): void => {
  const t = reader.decode(dc);
  if (t > MAX_DC_CATEGORY) throw refuse("bad dc category");
  const dcValue = prediction[ci]! + reader.receiveExtend(t);
  prediction[ci] = dcValue;
  out[at] = dcValue;
  let k = 1;
  while (k < 64) {
    const rs = reader.decode(ac);
    const r = rs >> 4;
    const s = rs & 15;
    if (s === 0) {
      if (r !== 15) return;
      k += 16;
      continue;
    }
    if (s > MAX_AC_SIZE) throw refuse("bad ac size");
    k += r;
    if (k > 63) throw refuse("coefficient past the block");
    out[at + ZIGZAG[k]!] = reader.receiveExtend(s);
    k++;
  }
};

/** Decodes one sequential scan into `coefficients` (from `allocateCoefficients`). */
export const decodeSequentialScan = (
  frame: JpegFrame,
  scan: JpegScan,
  coefficients: readonly ComponentCoefficients[],
): void => {
  const reader = new BitReader(scan.data);
  const parts = scan.components.map((sc) => ({
    ci: sc.componentIndex,
    h: frame.components[sc.componentIndex]!.h,
    v: frame.components[sc.componentIndex]!.v,
    grid: coefficients[sc.componentIndex]!,
    dc: tableOf(scan.dcTables[sc.td]),
    ac: tableOf(scan.acTables[sc.ta]),
  }));
  const prediction = new Int32Array(frame.components.length);
  const single = parts.length === 1 ? parts[0]! : undefined;
  const mcuCount = single
    ? single.grid.blocksPerLine * single.grid.blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  let restarts = 0;
  for (let mcu = 0; mcu < mcuCount; mcu++) {
    if (scan.restartInterval > 0 && mcu > 0 && mcu % scan.restartInterval === 0) {
      reader.restart(restarts % 8);
      restarts++;
      prediction.fill(0);
    }
    if (single) {
      const { grid } = single;
      const row = Math.floor(mcu / grid.blocksPerLine);
      const col = mcu % grid.blocksPerLine;
      decodeBlock(reader, single.dc, single.ac, grid.data, (row * grid.stride + col) * 64, prediction, single.ci);
      continue;
    }
    const mcuRow = Math.floor(mcu / frame.mcusPerLine);
    const mcuCol = mcu % frame.mcusPerLine;
    for (const p of parts) {
      for (let j = 0; j < p.v; j++) {
        for (let i = 0; i < p.h; i++) {
          const at = ((mcuRow * p.v + j) * p.grid.stride + mcuCol * p.h + i) * 64;
          decodeBlock(reader, p.dc, p.ac, p.grid.data, at, prediction, p.ci);
        }
      }
    }
  }
  reader.endOfScan();
};
