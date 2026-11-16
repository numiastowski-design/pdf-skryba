/** RGBA pixels encoded to a baseline JPEG, no library. One frame, 4:2:0 YCbCr
 *  (Y at full resolution, Cb and Cr at half resolution in both directions,
 *  the libjpeg default: T.81 A.1.1, A.2.3), Huffman tables built per image from
 *  its symbol counts (T.81 annex K.2, libjpeg's `optimize_coding`), a JFIF APP0,
 *  no EXIF, no comment. Written byte for byte as jpeg-js 0.4.4
 *  did until 06/10/2026 (4:4:4), then switched to 4:2:0, which measured 14.7 %
 *  smaller on the 72 fixture JPEGs at quality 80 (libjpeg), and stopped writing
 *  jpeg-js's extra whole byte of 1-bits before EOI. The fixed example tables of
 *  annex K.3 to K.6 stay only as the tests' reference (`options.fixedTables`).
 *  NOT here: decoding (`jpeg/decode.ts`), which quality to use and when to
 *  re-encode (`extractor/image-reduction.ts`, `pptx-reader/picture.ts`).
 *  Called by: `extractor/image-reduction.ts`, `extractor/pptx-reader/picture.ts`, `jpeg/encode.test.ts`. */

import type { HuffmanSpec } from "./markers";
import { ZIGZAG as DECODER_ZIGZAG } from "./sequential-scan";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, `width × height × 4` bytes; alpha is ignored. */
  readonly data: Uint8Array;
}

/**
 * WHY THIS ARITHMETIC. T.81 defines the forward DCT in real numbers (A.3.3)
 * and leaves the arithmetic to the encoder; the bytes depend on it. This
 * file keeps jpeg-js's (itself Adobe's AS3 encoder, after IJG's
 * `jfdctflt.c`): the AAN float DCT, quantisation by a reciprocal table
 * rounded half away from zero, the integer RGB → YCbCr of T.871. Changing
 * any of these changes every picture's bytes (bump `RENDER_LOGIC_VERSION`).
 *
 * TRIED AND SET ASIDE (06/10/2026, mozjpeg's ideas, measured on the 72 fixture JPEGs at quality 80, 4:2:0, optimised
 * tables; mozjpeg through @jsquash/jpeg, WASM): progressive writing, the only real gain (4.7 % fewer bytes at equal
 * PSNR, 36.99 against 36.93 dB; written here too, 4.2 %), set aside for its cost: 2.1× the encoding time on
 * a node22 bundle, seconds more on a 12 MP crop; mozjpeg's quantisation tables (quant_table 3): 5.8 % smaller but PSNR
 * 36.29 against 36.93 dB, a lower quality rather than a gain; trellis quantisation (multipass, opt zero, opt table):
 * no gain (4 310 022 against 4 309 219 bytes) for 2.7× the time.
 */

/** Natural (row-major) index → zig-zag position (T.81 figure A.6): the inverse of the decoder's table. */
const ZIGZAG = (() => {
  const position = new Array<number>(64);
  for (let k = 0; k < 64; k++) position[DECODER_ZIGZAG[k]!] = k;
  return position;
})();

/** T.81 table K.1 (luminance) and K.2 (chrominance), natural order. */
const LUMINANCE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMINANCE_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array<number>(32).fill(99),
];

/** Tables K.3 to K.6 of annex K, as T.81 annex C specifies a table: BITS (`counts`, codes of each length 1..16) and HUFFVAL (`values`). */
const specOf = (counts: readonly number[], values: readonly number[]): HuffmanSpec => ({ counts: Uint8Array.from(counts), values: Uint8Array.from(values) });

const DC_LUMINANCE = specOf([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const DC_CHROMINANCE = specOf([0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const AC_LUMINANCE = specOf(
  [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
    0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
    0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
    0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);
const AC_CHROMINANCE = specOf(
  [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
    0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
    0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
    0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);

/** Code sizes counted before the adjustment (libjpeg's MAX_CLEN): 257 symbols cannot make a deeper tree than 32 here. */
const CODE_SIZE_SLOTS = 32;

/**
 * Optimal table for symbol counts `frequencies[symbol]` (256 entries): T.81 annex K.2 as libjpeg's
 * `jpeg_gen_optimal_table` (jchuff.c) writes it.
 * 1. A dummy symbol 256 of frequency 1 takes the all-1 code, which T.81 C.2 forbids: it is the rarest, so the longest.
 * 2. Figure K.1 (code size): merge the two least frequent trees again and again (on a tie, the larger symbol), every symbol of
 *    the merged trees gains a bit.
 * 3. Figure K.2 (count BITS): how many symbols have each code size, up to 32 bits.
 * 4. Figure K.3 (adjust BITS): move pairs from the sizes over 16 to shorter ones until none is left.
 * 5. The dummy's code is released: one code is taken off the longest size.
 * 6. Figure K.4 (sort HUFFVAL): by code size, then by symbol.
 * No symbol used: symbol 0 is declared, a table must hold a value (our own reader refuses an empty one, B.2.4.2).
 */
export const optimalHuffmanSpec = (frequencies: ArrayLike<number>): HuffmanSpec => {
  const freq = new Float64Array(257);
  let used = false;
  for (let i = 0; i < 256; i++) {
    freq[i] = frequencies[i]!;
    if (freq[i]! > 0) used = true;
  }
  if (!used) freq[0] = 1;
  freq[256] = 1;
  const codeSize = new Uint8Array(257);
  const others = new Int16Array(257).fill(-1);
  for (;;) {
    // The least frequent tree c1, then the next one c2 (frequencies above 0 only; the later index wins a tie).
    let c1 = -1;
    let least = Infinity;
    for (let i = 0; i <= 256; i++) {
      if (freq[i]! > 0 && freq[i]! <= least) {
        least = freq[i]!;
        c1 = i;
      }
    }
    let c2 = -1;
    least = Infinity;
    for (let i = 0; i <= 256; i++) {
      if (i !== c1 && freq[i]! > 0 && freq[i]! <= least) {
        least = freq[i]!;
        c2 = i;
      }
    }
    if (c2 < 0) break;
    freq[c1] = freq[c1]! + freq[c2]!;
    freq[c2] = 0;
    // Both trees are chains linked by `others`: every member is one bit deeper; c2's chain is appended to c1's.
    let i = c1;
    codeSize[i]!++;
    while (others[i]! >= 0) {
      i = others[i]!;
      codeSize[i]!++;
    }
    others[i] = c2;
    for (let j = c2; j >= 0; j = others[j]!) codeSize[j]!++;
  }
  const bits = new Int32Array(CODE_SIZE_SLOTS + 1);
  for (let i = 0; i <= 256; i++) if (codeSize[i]! > 0) bits[codeSize[i]!]!++;
  for (let i = CODE_SIZE_SLOTS; i > 16; i--) {
    while (bits[i]! > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i]! -= 2;
      bits[i - 1]!++;
      bits[j + 1]! += 2;
      bits[j]!--;
    }
  }
  let longest = 16;
  while (bits[longest] === 0) longest--;
  bits[longest]!--;
  const values: number[] = [];
  for (let size = 1; size <= CODE_SIZE_SLOTS; size++) {
    for (let symbol = 0; symbol < 256; symbol++) if (codeSize[symbol] === size) values.push(symbol);
  }
  return { counts: Uint8Array.from(bits.subarray(1, 17)), values: Uint8Array.from(values) };
};

/** Code and length of each symbol, indexed by symbol (T.81 annex C:
 *  codes assigned in order of length, then of HUFFVAL). */
interface HuffmanCodes {
  readonly code: Uint16Array;
  readonly length: Uint8Array;
}

const huffmanCodes = (spec: HuffmanSpec): HuffmanCodes => {
  const code = new Uint16Array(256);
  const length = new Uint8Array(256);
  let next = 0;
  let k = 0;
  for (let size = 1; size <= 16; size++) {
    for (let i = 0; i < spec.counts[size - 1]!; i++) {
      const symbol = spec.values[k++]!;
      code[symbol] = next++;
      length[symbol] = size;
    }
    next <<= 1;
  }
  return { code, length };
};

/** The four tables of a scan: DC and AC, luminance (id 0) and chrominance (id 1). */
interface TableSet {
  readonly specs: readonly [HuffmanSpec, HuffmanSpec, HuffmanSpec, HuffmanSpec];
  readonly dcLuminance: HuffmanCodes;
  readonly acLuminance: HuffmanCodes;
  readonly dcChrominance: HuffmanCodes;
  readonly acChrominance: HuffmanCodes;
}

const tableSet = (specs: readonly [HuffmanSpec, HuffmanSpec, HuffmanSpec, HuffmanSpec]): TableSet => ({
  specs,
  dcLuminance: huffmanCodes(specs[0]),
  acLuminance: huffmanCodes(specs[1]),
  dcChrominance: huffmanCodes(specs[2]),
  acChrominance: huffmanCodes(specs[3]),
});

const FIXED_TABLES = tableSet([DC_LUMINANCE, AC_LUMINANCE, DC_CHROMINANCE, AC_CHROMINANCE]);

/** AAN scale factors of IJG's `jfdctflt.c`, as jpeg-js writes them. */
const AAN_SCALE = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** Quantisation tables of one quality: the bytes of the DQT segment
 *  (zig-zag order) and the reciprocal divisors of the float DCT (natural
 *  order). The quality scale is IJG's (`jcparam.c`), which jpeg-js copies:
 *  it is no part of T.81, which only gives example tables (annex K). */
interface QuantTables {
  readonly luminance: Uint8Array;
  readonly chrominance: Uint8Array;
  readonly luminanceDivisors: Float64Array;
  readonly chrominanceDivisors: Float64Array;
}

const quantTables = (quality: number): QuantTables => {
  const scale = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
  const scaled = (base: readonly number[]): Uint8Array => {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) out[ZIGZAG[i]!] = Math.min(255, Math.max(1, Math.floor((base[i]! * scale + 50) / 100)));
    return out;
  };
  const luminance = scaled(LUMINANCE_QUANT);
  const chrominance = scaled(CHROMINANCE_QUANT);
  const luminanceDivisors = new Float64Array(64);
  const chrominanceDivisors = new Float64Array(64);
  for (let row = 0, k = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++, k++) {
      // Same product order as jpeg-js. Reassociating it gave the same bytes on
      // every test case (mutation tried 06/10/2026): kept anyway, unproven elsewhere.
      luminanceDivisors[k] = 1.0 / (luminance[ZIGZAG[k]!]! * AAN_SCALE[row]! * AAN_SCALE[col]! * 8.0);
      chrominanceDivisors[k] = 1.0 / (chrominance[ZIGZAG[k]!]! * AAN_SCALE[row]! * AAN_SCALE[col]! * 8.0);
    }
  }
  return { luminance, chrominance, luminanceDivisors, chrominanceDivisors };
};

/** In-place AAN forward DCT of one 8×8 block (rows, then columns), then
 *  quantisation into `out`, natural order. Operation for operation as in
 *  jpeg-js's `fDCTQuant`. */
const forwardDctQuantise = (data: Float64Array, divisors: Float64Array, out: Int32Array): void => {
  for (let pass = 0; pass < 2; pass++) {
    // Pass 0 walks rows (step 1 inside a line, 8 between lines), pass 1 columns.
    const step = pass === 0 ? 1 : 8;
    const stride = pass === 0 ? 8 : 1;
    for (let line = 0, o = 0; line < 8; line++, o += stride) {
      const d0 = data[o]!;
      const d1 = data[o + step]!;
      const d2 = data[o + 2 * step]!;
      const d3 = data[o + 3 * step]!;
      const d4 = data[o + 4 * step]!;
      const d5 = data[o + 5 * step]!;
      const d6 = data[o + 6 * step]!;
      const d7 = data[o + 7 * step]!;
      const tmp0 = d0 + d7;
      const tmp7 = d0 - d7;
      const tmp1 = d1 + d6;
      const tmp6 = d1 - d6;
      const tmp2 = d2 + d5;
      const tmp5 = d2 - d5;
      const tmp3 = d3 + d4;
      const tmp4 = d3 - d4;
      // Even part.
      let tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      let tmp11 = tmp1 + tmp2;
      let tmp12 = tmp1 - tmp2;
      data[o] = tmp10 + tmp11;
      data[o + 4 * step] = tmp10 - tmp11;
      const z1 = (tmp12 + tmp13) * 0.707106781;
      data[o + 2 * step] = tmp13 + z1;
      data[o + 6 * step] = tmp13 - z1;
      // Odd part.
      tmp10 = tmp4 + tmp5;
      tmp11 = tmp5 + tmp6;
      tmp12 = tmp6 + tmp7;
      const z5 = (tmp10 - tmp12) * 0.382683433;
      const z2 = 0.5411961 * tmp10 + z5;
      const z4 = 1.306562965 * tmp12 + z5;
      const z3 = tmp11 * 0.707106781;
      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;
      data[o + 5 * step] = z13 + z2;
      data[o + 3 * step] = z13 - z2;
      data[o + step] = z11 + z4;
      data[o + 7 * step] = z11 - z4;
    }
  }
  for (let i = 0; i < 64; i++) {
    const q = data[i]! * divisors[i]!;
    out[i] = q > 0.0 ? (q + 0.5) | 0 : (q - 0.5) | 0;
  }
};

/**
 * OUTPUT BUFFER. Grows by doubling, so it never holds more than twice the
 * bytes written. The bytes written are bounded by the input: per 8×8 block,
 * a DC (16-bit code, 11 extra bits) and at most 63 AC (16-bit code, 10 extra
 * bits), 1 665 bits, at most 209 bytes, twice that with byte stuffing; six
 * blocks per 256 pixels, so under 10 bytes per pixel against 4 bytes of input.
 */
class ByteWriter {
  #bytes: Uint8Array;
  #length = 0;
  /** Pending bits, most significant first, fewer than 8 between calls. */
  #acc = 0;
  #accBits = 0;

  constructor(initial: number) {
    this.#bytes = new Uint8Array(initial);
  }

  byte(value: number): void {
    if (this.#length === this.#bytes.length) {
      const grown = new Uint8Array(this.#bytes.length * 2);
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    this.#bytes[this.#length++] = value;
  }

  word(value: number): void {
    this.byte((value >> 8) & 0xff);
    this.byte(value & 0xff);
  }

  bytes(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.byte(values[i]!);
  }

  /** `count` (≤ 16) low bits of `value` into the entropy-coded segment; a
   *  0xFF byte is followed by a stuffed 0x00 (T.81 F.1.2.3). */
  bits(value: number, count: number): void {
    this.#acc = (this.#acc << count) | (value & ((1 << count) - 1));
    this.#accBits += count;
    while (this.#accBits >= 8) {
      this.#accBits -= 8;
      const byte = (this.#acc >> this.#accBits) & 0xff;
      this.byte(byte);
      if (byte === 0xff) this.byte(0);
    }
    this.#acc &= (1 << this.#accBits) - 1;
  }

  /** Pads a partial last byte of the entropy-coded segment with 1-bits (T.81 F.1.2.3); an aligned end gets nothing. */
  padToByte(): void {
    if (this.#accBits === 0) return;
    const count = 8 - this.#accBits;
    this.bits((1 << count) - 1, count);
  }

  result(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

/** Number of bits of |value| (the "SSSS" category of T.81 F.1.2.1). */
const category = (value: number): number => (value === 0 ? 0 : 32 - Math.clz32(value < 0 ? -value : value));

/** Every coded item of one block in zig-zag order at `zz[start..start + 63]` (T.81 F.1.2.1 and F.1.2.2), the single
 *  place that decides what is coded, for the counting pass and the writing pass alike. `emit` gets the table
 *  (false DC, true AC), the symbol, and the extra bits (value, count). Returns the new DC predictor. */
const walkBlock = (zz: Int16Array, start: number, predictor: number, emit: (ac: boolean, symbol: number, extra: number, extraBits: number) => void): number => {
  const diff = zz[start]! - predictor;
  const dcSize = category(diff);
  // Negative values are written as value - 1 in `size` bits (F.1.2.1).
  emit(false, dcSize, diff < 0 ? diff - 1 : diff, dcSize);
  let last = 63;
  while (last > 0 && zz[start + last] === 0) last--;
  let run = 0;
  for (let k = 1; k <= last; k++) {
    const value = zz[start + k]!;
    if (value === 0) {
      run++;
      continue;
    }
    for (; run >= 16; run -= 16) emit(true, 0xf0, 0, 0);
    const size = category(value);
    emit(true, (run << 4) | size, value < 0 ? value - 1 : value, size);
    run = 0;
  }
  if (last !== 63) emit(true, 0x00, 0, 0);
  return zz[start]!;
};

/** Headers: SOI, APP0 (JFIF 1.01, aspect 1:1, no
 *  thumbnail, T.871), DQT, SOF0, DHT, SOS. */
const writeHeaders = (writer: ByteWriter, width: number, height: number, tables: QuantTables, huffman: TableSet): void => {
  writer.word(0xffd8);
  writer.word(0xffe0);
  writer.word(16);
  writer.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0]);
  writer.word(1);
  writer.word(1);
  writer.bytes([0, 0]);

  writer.word(0xffdb);
  writer.word(132);
  writer.byte(0);
  writer.bytes(tables.luminance);
  writer.byte(1);
  writer.bytes(tables.chrominance);

  // Three components: Y sampled 2×2 (4:2:0) on table 0, Cb and Cr 1×1 on table 1.
  writer.word(0xffc0);
  writer.word(17);
  writer.byte(8);
  writer.word(height);
  writer.word(width);
  writer.bytes([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

  writer.word(0xffc4);
  // Length: itself (2), then per table its class and id (1), 16 counts and the values (B.2.4.2).
  writer.word(2 + huffman.specs.reduce((sum, spec) => sum + 17 + spec.values.length, 0));
  for (const [index, classAndId] of [0x00, 0x10, 0x01, 0x11].entries()) {
    writer.byte(classAndId);
    writer.bytes(huffman.specs[index]!.counts);
    writer.bytes(huffman.specs[index]!.values);
  }

  writer.word(0xffda);
  writer.word(12);
  writer.bytes([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
};

export interface EncodeOptions {
  /** TESTS ONLY (no product caller passes it): write the example tables of T.81 annex K.3 to K.6 instead of per-image ones, the
   *  reference the tests and the size measure compare to. Passing it costs size, never correctness. */
  readonly fixedTables?: boolean;
}

/**
 * The 4:2:0 baseline JPEG of `image` at `quality`.
 * Inputs are the caller's own pixels (decoded and checked upstream), so a
 * bad one is a bug and throws a plain `Error`, not a refusal of a document:
 * - width and height integers in 1..65 535 (16 bits in SOF0, T.81 B.2.2);
 * - `data` exactly width × height × 4 bytes (anything else would read past it);
 * - quality an integer in 1..100 (no silent clamping). The product passes 80 and 90.
 *
 * TWO PASSES (T.81 K.2 needs the counts before the tables, hence before the first code). The first pass does the DCT and
 * the quantisation and keeps every quantised block (zig-zag order, 16-bit) so that the second pass, which writes, does not
 * repeat them: 64 × 2 bytes per block, 6 blocks per 256 pixels, 3 bytes per pixel (36 MB at the 12 MP the callers allow), on top of the
 * 4 bytes per pixel of the input.
 */
export const encodeJpegRgba = (image: RgbaImage, quality: number, options: EncodeOptions = {}): Uint8Array => {
  const { width, height, data } = image;
  const side = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65_535;
  if (!side(width) || !side(height)) throw new Error("encodeJpegRgba: width and height must be integers in 1..65535");
  if (data.length !== width * height * 4) throw new Error("encodeJpegRgba: data must hold width × height × 4 bytes");
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("encodeJpegRgba: quality must be an integer in 1..100");

  const tables = quantTables(quality);

  // One MCU is 16×16 pixels: four Y blocks, then one Cb and one Cr block, each chroma sample the
  // average of a 2×2 group of pixels (T.81 A.2.3 orders the blocks of a 2×2-sampled component first).
  const mcusAcross = Math.ceil(width / 16);
  const mcusDown = Math.ceil(height / 16);
  const coefficients = new Int16Array(mcusAcross * mcusDown * 6 * 64);
  const yFull = new Float64Array(256);
  const cbFull = new Float64Array(256);
  const crFull = new Float64Array(256);
  const yBlock = new Float64Array(64);
  const cb = new Float64Array(64);
  const cr = new Float64Array(64);
  const quantised = new Int32Array(64);
  let at = 0;
  /** The block just quantised (natural order), stored in zig-zag order. */
  const keep = (): void => {
    for (let i = 0; i < 64; i++) coefficients[at + ZIGZAG[i]!] = quantised[i]!;
    at += 64;
  };
  for (let top = 0; top < height; top += 16) {
    for (let left = 0; left < width; left += 16) {
      for (let pos = 0; pos < 256; pos++) {
        // Past the right or bottom edge, the last column or row is repeated.
        const row = Math.min(top + (pos >> 4), height - 1);
        const col = Math.min(left + (pos & 15), width - 1);
        const p = (row * width + col) * 4;
        const r = data[p]!;
        const g = data[p + 1]!;
        const b = data[p + 2]!;
        // Fixed-point RGB → YCbCr (16 fractional bits): the equations of T.871 §7, with its rounding.
        yFull[pos] = ((19595 * r + 38470 * g + 7471 * b + 0x8000) >> 16) - 128;
        cbFull[pos] = ((-11059 * r - 21709 * g + 32768 * b + 0x807fff) >> 16) - 128;
        crFull[pos] = ((32768 * r + 0x807fff - 27439 * g - 5329 * b) >> 16) - 128;
      }
      for (let block = 0; block < 4; block++) {
        const originRow = (block >> 1) * 8;
        const originCol = (block & 1) * 8;
        for (let pos = 0; pos < 64; pos++) yBlock[pos] = yFull[(originRow + (pos >> 3)) * 16 + originCol + (pos & 7)]!;
        forwardDctQuantise(yBlock, tables.luminanceDivisors, quantised);
        keep();
      }
      for (let pos = 0; pos < 64; pos++) {
        const i = (pos >> 3) * 32 + (pos & 7) * 2;
        cb[pos] = (cbFull[i]! + cbFull[i + 1]! + cbFull[i + 16]! + cbFull[i + 17]!) * 0.25;
        cr[pos] = (crFull[i]! + crFull[i + 1]! + crFull[i + 16]! + crFull[i + 17]!) * 0.25;
      }
      forwardDctQuantise(cb, tables.chrominanceDivisors, quantised);
      keep();
      forwardDctQuantise(cr, tables.chrominanceDivisors, quantised);
      keep();
    }
  }

  // Each block of an MCU is (component, predictor slot): Y Y Y Y Cb Cr, the Y blocks sharing a predictor.
  const mcuCount = mcusAcross * mcusDown;
  let huffman = FIXED_TABLES;
  if (!options.fixedTables) {
    // Counting pass: how often each DC category and each AC (run, size) symbol occurs, per table.
    const frequencies = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)] as const;
    const predictors = [0, 0, 0];
    for (let mcu = 0; mcu < mcuCount; mcu++) {
      for (let block = 0; block < 6; block++) {
        const slot = block < 4 ? 0 : block - 3;
        const chroma = block < 4 ? 0 : 2;
        const dcFrequencies = frequencies[chroma]!;
        const acFrequencies = frequencies[chroma + 1]!;
        predictors[slot] = walkBlock(coefficients, (mcu * 6 + block) * 64, predictors[slot]!, (ac, symbol) => {
          (ac ? acFrequencies : dcFrequencies)[symbol]!++;
        });
      }
    }
    huffman = tableSet([optimalHuffmanSpec(frequencies[0]), optimalHuffmanSpec(frequencies[1]), optimalHuffmanSpec(frequencies[2]), optimalHuffmanSpec(frequencies[3])]);
  }

  const writer = new ByteWriter(Math.min(Math.max(1024, width * height), 1 << 24));
  writeHeaders(writer, width, height, tables, huffman);
  const predictors = [0, 0, 0];
  for (let mcu = 0; mcu < mcuCount; mcu++) {
    for (let block = 0; block < 6; block++) {
      const slot = block < 4 ? 0 : block - 3;
      const dc = block < 4 ? huffman.dcLuminance : huffman.dcChrominance;
      const ac = block < 4 ? huffman.acLuminance : huffman.acChrominance;
      predictors[slot] = walkBlock(coefficients, (mcu * 6 + block) * 64, predictors[slot]!, (isAc, symbol, extra, extraBits) => {
        const codes = isAc ? ac : dc;
        writer.bits(codes.code[symbol]!, codes.length[symbol]!);
        if (extraBits) writer.bits(extra, extraBits);
      });
    }
  }
  writer.padToByte();
  writer.word(0xffd9);
  return writer.result();
};
