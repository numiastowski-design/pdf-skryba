/** Huffman decoding tables built from a DHT specification, and the bit
 *  reader of an entropy-coded segment: byte unstuffing, EXTEND, restart
 *  markers. Refused, with our own literal, when a table is not a prefix code
 *  or the bits run out, hit a marker, or match no code.
 *  NOT here: where the decoded symbols go (`jpeg/sequential-scan.ts`), the
 *  DHT segment itself (`jpeg/markers.ts`).
 *  Called by: `jpeg/sequential-scan.ts`, `jpeg/progressive-scan.ts`, `jpeg/huffman.test.ts`. */

import { refuse, type HuffmanSpec } from "./markers";

/**
 * TABLES (ITU-T T.81 annex C, figures C.1 to C.3, and F.2.2.3). Codes are
 * generated in order of length; at each length the next code is the previous
 * one plus 1, shifted left when the length grows. A table is refused when a
 * code no longer fits its length (over-subscribed: IJG libjpeg's check,
 * `jdhuff.c`), when it is empty, and when it assigns the all-1 code word of
 * its length: T.81 C.2 reserves it (it would read the same as the 1-bits
 * that pad a segment, F.1.2.3). jpeg-js checks none of the three.
 *
 * BITS (T.81 B.1.1.5, F.2.2.4, F.2.2.5). A 0xFF data byte is followed by a
 * stuffed 0x00, dropped here. Any other byte after 0xFF is a marker: inside a
 * run of MCUs it is refused, at a restart boundary it must be the expected
 * RSTn. Reading past the segment's last byte is refused: jpeg-js reads
 * zeros there, which decodes a truncated file to grey blocks.
 */

export interface HuffmanTable {
  /** Largest code of each length 1..16, -1 when the length has none. */
  readonly maxCode: Int32Array;
  /** `valueIndex[l] - minCode[l]`: added to a code of length l, the index of its value. */
  readonly offset: Int32Array;
  readonly values: Uint8Array;
}


export const buildHuffmanTable = (spec: HuffmanSpec): HuffmanTable => {
  const maxCode = new Int32Array(17).fill(-1);
  const offset = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const count = spec.counts[length - 1]!;
    if (count > 0) {
      offset[length] = k - code;
      code += count;
      k += count;
      // The last code of this length is code - 1; it must fit and must not be all 1-bits.
      if (code - 1 >= (1 << length) - 1) throw refuse("bad huffman table");
      maxCode[length] = code - 1;
    }
    code <<= 1;
  }
  if (k === 0 || k !== spec.values.length) throw refuse("bad huffman table");
  return { maxCode, offset, values: spec.values };
};

const tables = new WeakMap<HuffmanSpec, HuffmanTable>();
/** The decoding table of a spec, built once per spec and shared by the sequential and progressive scans. */
export const tableOf = (spec: HuffmanSpec | undefined): HuffmanTable => {
  // `parseJpeg` refuses a scan whose needed tables are missing; this is a caller's bug.
  if (!spec) throw new Error("missing Huffman table");
  let table = tables.get(spec);
  if (!table) tables.set(spec, (table = buildHuffmanTable(spec)));
  return table;
};

export class BitReader {
  #data: Uint8Array;
  #at = 0;
  #byte = 0;
  #left = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  #fill(): void {
    const data = this.#data;
    if (this.#at >= data.length) throw refuse("truncated scan data");
    const b = data[this.#at]!;
    if (b === 0xff) {
      if (this.#at + 1 >= data.length) throw refuse("truncated scan data");
      if (data[this.#at + 1] !== 0x00) throw refuse("unexpected marker in scan data");
      this.#at += 2;
    } else {
      this.#at += 1;
    }
    this.#byte = b;
    this.#left = 8;
  }

  bit(): number {
    if (this.#left === 0) this.#fill();
    this.#left--;
    return (this.#byte >> this.#left) & 1;
  }

  /** `n` bits (0..16), most significant first. */
  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** RECEIVE then EXTEND (T.81 F.2.2.1, figure F.12): `s` bits read as a signed difference. */
  receiveExtend(s: number): number {
    if (s === 0) return 0;
    const v = this.receive(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }

  /** DECODE (T.81 F.2.2.3, figure F.16). */
  decode(table: HuffmanTable): number {
    let code = this.bit();
    for (let length = 1; ; length++) {
      if (code <= table.maxCode[length]!) return table.values[code + table.offset[length]!]!;
      if (length === 16) break;
      code = (code << 1) | this.bit();
    }
    throw refuse("bad huffman code");
  }

  /** After the last MCU of a scan: the rest of the segment must hold no
   *  restart marker. One would mean more restart intervals than the frame
   *  has MCUs (a frame header rewritten smaller, say): the frame and the
   *  data disagree, we abstain. jpeg-js refuses it too when entropy bytes
   *  follow that RST (it reads them as a marker), but accepts a lone RST
   *  right before EOI: there we are stricter (review of 06/10/2026), and a
   *  refusal only means the image is published as it is. Other trailing
   *  bytes are ignored, as jpeg-js ignores them. */
  endOfScan(): void {
    const data = this.#data;
    for (let at = this.#at; at + 1 < data.length; at++) {
      if (data[at] === 0xff && data[at + 1]! >= 0xd0 && data[at + 1]! <= 0xd7) throw refuse("scan data past the last mcu");
    }
  }

  /** At a restart boundary: drop the rest of the byte, then expect RSTn
   *  (`n` = 0..7), possibly after fill bytes 0xFF. */
  restart(n: number): void {
    this.#left = 0;
    const data = this.#data;
    let at = this.#at;
    if (data[at] !== 0xff) throw refuse("bad restart marker");
    while (data[at + 1] === 0xff) at++;
    if (data[at + 1] !== 0xd0 + n) throw refuse("bad restart marker");
    this.#at = at + 2;
  }
}
