/** The DCT coefficients of a progressive JPEG (Huffman coding), decoded scan
 *  by scan into the block grid of `jpeg/sequential-scan.ts`: DC first and
 *  refinement scans, AC first scans with end-of-band runs, AC refinement
 *  scans. Refused, with our own literal, when a scan's parameters break
 *  T.81's rules or a coefficient leaves its band.
 *  NOT here: the marker structure (`jpeg/markers.ts`), the bit reader
 *  (`jpeg/huffman.ts`), the grid's allocation (`jpeg/sequential-scan.ts`),
 *  the bound on the number of scans (`jpeg/decode.ts`).
 *  Called by: `jpeg/decode.ts`. */

import { BitReader, tableOf, type HuffmanTable } from "./huffman";
import { refuse, type JpegFrame, type JpegScan } from "./markers";
import { MAX_AC_SIZE, MAX_DC_CATEGORY, ZIGZAG, type ComponentCoefficients } from "./sequential-scan";

/**
 * PARAMETERS (ITU-T T.81 B.2.3, table B.3, G.1.1.1). A DC scan has Ss = Se = 0
 * and may interleave components; an AC scan has 1 ≤ Ss ≤ Se ≤ 63 and one
 * component; a refinement (Ah ≠ 0) adds exactly one bit: Al = Ah − 1; Al is
 * at most 13. jpeg-js checks none of these. Checked while reading
 * (`jpeg/markers.ts`), before the work of the scans is summed (`jpeg/decode.ts`):
 * a scan with Ss > Se counted negatively there (counter-review of 06/10/2026).
 *
 * DECODING (T.81 G.1.2). DC first: the sequential DC difference, shifted
 * left by Al. DC refinement: one bit per block, OR-ed at bit Al. AC first: a
 * symbol RRRRSSSS as in sequential mode, values shifted left by Al; a symbol
 * with S = 0 and R < 15 opens an end-of-band run of 2^R + R more bits − 1
 * further blocks (EOBRUN). AC refinement: symbols of size 1 (a new
 * coefficient of ±2^Al) or 0 (ZRL, EOB run); every coefficient already
 * non-zero that the walk passes over receives a correction bit. The
 * correction is added whenever the bit is 1, as jpeg-js does (IJG adds it
 * only when that bit is not yet set: the same on a valid stream).
 *
 * Stricter than jpeg-js: a coefficient past the band (jpeg-js writes it
 * anyway, or nowhere past 63), a refinement symbol of size other than 1, a
 * DC category over 11, an AC size over 10.
 */

/** Decodes one progressive scan into `coefficients` (from `allocateCoefficients`). */
export const decodeProgressiveScan = (
  frame: JpegFrame,
  scan: JpegScan,
  coefficients: readonly ComponentCoefficients[],
): void => {
  const { ss, se, ah, al } = scan;
  const reader = new BitReader(scan.data);
  const prediction = new Int32Array(frame.components.length);
  let eobrun = 0;

  type BlockDecoder = (
    out: Int32Array,
    at: number,
    ci: number,
    dc: HuffmanTable | undefined,
    ac: HuffmanTable | undefined,
  ) => void;

  const dcFirst: BlockDecoder = (out, at, ci, dc) => {
    const t = reader.decode(dc!);
    if (t > MAX_DC_CATEGORY) throw refuse("bad dc category");
    const value = prediction[ci]! + (t === 0 ? 0 : reader.receiveExtend(t) << al);
    prediction[ci] = value;
    out[at] = value;
  };

  const dcRefine: BlockDecoder = (out, at) => {
    out[at] = out[at]! | (reader.bit() << al);
  };

  const acFirst: BlockDecoder = (out, at, _ci, _dc, ac) => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    let k = ss;
    while (k <= se) {
      const rs = reader.decode(ac!);
      const r = rs >> 4;
      const s = rs & 15;
      if (s === 0) {
        if (r < 15) {
          eobrun = reader.receive(r) + (1 << r) - 1;
          return;
        }
        k += 16;
        continue;
      }
      if (s > MAX_AC_SIZE) throw refuse("bad ac size");
      k += r;
      if (k > se) throw refuse("coefficient past the band");
      out[at + ZIGZAG[k]!] = reader.receiveExtend(s) * (1 << al);
      k++;
    }
  };

  const acRefine: BlockDecoder = (out, at, _ci, _dc, ac) => {
    const p1 = 1 << al;
    const correct = (z: number): void => {
      if (reader.bit()) out[z] = out[z]! + (out[z]! < 0 ? -p1 : p1);
    };
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(ac!);
        let r = rs >> 4;
        const s = rs & 15;
        let value = 0;
        if (s !== 0) {
          if (s !== 1) throw refuse("bad ac refinement");
          value = reader.bit() ? p1 : -p1;
        } else if (r !== 15) {
          eobrun = (1 << r) + (r > 0 ? reader.receive(r) : 0);
          break;
        }
        // Walk to the r-th zero coefficient (or past ZRL's 16), correcting the non-zero ones met.
        // eslint-disable-next-line sonarjs/updated-loop-counter -- the loop walks to the r-th zero coefficient; the position k is read after the loop
        for (; k <= se; k++) {
          const z = at + ZIGZAG[k]!;
          if (out[z] !== 0) correct(z);
          else if (r-- === 0) break;
        }
        if (value !== 0) {
          if (k > se) throw refuse("coefficient past the band");
          out[at + ZIGZAG[k]!] = value;
        }
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k]!;
        if (out[z] !== 0) correct(z);
      }
      eobrun--;
    }
  };

  const decodeBlock: BlockDecoder = ss === 0 ? (ah === 0 ? dcFirst : dcRefine) : ah === 0 ? acFirst : acRefine;
  const parts = scan.components.map((sc) => ({
    ci: sc.componentIndex,
    h: frame.components[sc.componentIndex]!.h,
    v: frame.components[sc.componentIndex]!.v,
    grid: coefficients[sc.componentIndex]!,
    dc: ss === 0 && ah === 0 ? tableOf(scan.dcTables[sc.td]) : undefined,
    ac: ss > 0 ? tableOf(scan.acTables[sc.ta]) : undefined,
  }));
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
      eobrun = 0;
    }
    if (single) {
      const { grid } = single;
      const at = (Math.floor(mcu / grid.blocksPerLine) * grid.stride + (mcu % grid.blocksPerLine)) * 64;
      decodeBlock(grid.data, at, single.ci, single.dc, single.ac);
      continue;
    }
    const mcuRow = Math.floor(mcu / frame.mcusPerLine);
    const mcuCol = mcu % frame.mcusPerLine;
    for (const p of parts) {
      for (let j = 0; j < p.v; j++) {
        for (let i = 0; i < p.h; i++) {
          decodeBlock(p.grid.data, ((mcuRow * p.v + j) * p.grid.stride + mcuCol * p.h + i) * 64, p.ci, p.dc, p.ac);
        }
      }
    }
  }
  reader.endOfScan();
};
