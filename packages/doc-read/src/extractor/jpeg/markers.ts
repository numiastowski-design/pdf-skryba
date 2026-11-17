/** The marker structure of a JPEG stream, read without jpeg-js: the frame
 *  (process, size, components and their sampling, MCU grid), the
 *  quantisation tables, every scan with the Huffman tables and restart
 *  interval in effect when it starts and its entropy-coded bytes, and the
 *  JFIF and Adobe APP14 markers. Refused, with our own literal, when the
 *  structure is broken, hostile, or of a process we do not decode.
 *  Also exports `refuse` (the one refusal helper of the JPEG stages) and `componentDims`.
 *  NOT here: building the Huffman decoders (`jpeg/huffman.ts`), decoding the entropy-coded bytes
 *  (`jpeg/sequential-scan.ts`, `jpeg/progressive-scan.ts`), the inverse DCT (`jpeg/idct.ts`), colour conversion
 *  (`jpeg/color.ts`).
 *  Called by: `jpeg/markers.test.ts`, and the other stages of `jpeg/` (`decode`, `huffman`, `sequential-scan`,
 *  `progressive-scan`, `idct`, `color`, `encode`). */

import { ReaderError } from "doc-ir/lib/reader-error";
import { u16be } from "doc-ir/extractor/bytes";

/**
 * WHAT IS READ (ITU-T T.81, annex B). A stream is SOI, then marker segments,
 * then EOI (B.1.1.2 to B.1.1.4, B.2.1). Every marker may be preceded by fill
 * bytes 0xFF (B.1.1.2). A marker segment carries a two-byte length that
 * counts itself (B.1.1.4); it is checked against the bytes actually present
 * BEFORE the segment is read. After a scan header comes the entropy-coded
 * segment, where a 0xFF data byte is followed by a stuffed 0x00 and restart
 * markers RST0..RST7 may appear (B.1.1.5): the segment ends at the first
 * other marker, which is found without decoding.
 *
 * Processes: baseline (SOF0), extended sequential with Huffman coding (SOF1)
 * and progressive with Huffman coding (SOF2), the three jpeg-js reads.
 * Lossless (SOF3), hierarchical (SOF5-7, DHP, EXP) and arithmetic coding
 * (SOF9-11, SOF13-15, DAC) are refused. Precision 8 only: jpeg-js does not
 * turn 12-bit samples into 8-bit pixels either.
 *
 * GUARDS, all checked on what is declared AND present, before any table
 * proportional to the image exists (this module allocates only small per-marker structures, never one sized by the image): the frame's
 * pixel count against the caller's guard; sampling factors 1..4 (B.2.2); at
 * most 10 blocks per MCU in an interleaved scan (B.2.3); 1, 3 or 4
 * components (jpeg-js publishes nothing else), 4 only with an APP14 segment
 * (as jpeg-js); quantisation values 1..255 or 1..65535 (B.2.4.1, table B.4);
 * table ids 0..3, 0..1 for baseline Huffman tables (B.2.4.2).
 *
 * Where jpeg-js is lenient this reader refuses (two readings must agree, else
 * we abstain): bytes between segments that are not a marker (jpeg-js guesses
 * a lost 0xFF, or skips one malformed APP segment), a height of 0 deferred to
 * a DNL marker (jpeg-js decodes an empty image), a quantisation table in use
 * redefined with other values after a scan began (jpeg-js applies the last
 * one to every scan), a zero quantisation value, a sequential scan whose
 * spectral selection is not 0..63 with no approximation.
 *
 * The cap of 256 Huffman values per table is IJG libjpeg's (jdhuff.c), not a
 * T.81 rule: a table of code lengths 1..16 cannot use more distinct codes
 * meaningfully, and jpeg-js has no cap.
 */

type JpegProcess = "baseline" | "extended" | "progressive";

export interface JpegComponent {
  /** Component identifier Ci (B.2.2), as the scans name it. */
  readonly id: number;
  /** Horizontal and vertical sampling factors, 1..4. */
  readonly h: number;
  readonly v: number;
  /** Quantisation table id Tq, 0..3. */
  readonly tq: number;
}

export interface JpegFrame {
  readonly process: JpegProcess;
  readonly width: number;
  readonly height: number;
  readonly components: readonly JpegComponent[];
  readonly maxH: number;
  readonly maxV: number;
  /** MCUs of an interleaved scan per line and per column (T.81 A.2.4). */
  readonly mcusPerLine: number;
  readonly mcusPerColumn: number;
}

/** A Huffman table as DHT declares it (B.2.4.2): how many codes of each
 *  length 1..16, then the values in code order. */
export interface HuffmanSpec {
  readonly counts: Uint8Array;
  readonly values: Uint8Array;
}

interface JpegScanComponent {
  /** Index in `frame.components`. */
  readonly componentIndex: number;
  /** DC and AC Huffman table ids. */
  readonly td: number;
  readonly ta: number;
}

export interface JpegScan {
  readonly components: readonly JpegScanComponent[];
  /** Spectral selection and successive approximation (B.2.3). */
  readonly ss: number;
  readonly se: number;
  readonly ah: number;
  readonly al: number;
  /** MCUs between restart markers; 0 when there are none. */
  readonly restartInterval: number;
  /** The Huffman tables in effect when the scan starts, by id. */
  readonly dcTables: readonly (HuffmanSpec | undefined)[];
  readonly acTables: readonly (HuffmanSpec | undefined)[];
  /** The entropy-coded segment, stuffed bytes and RST markers included; a
   *  view on the caller's bytes. */
  readonly data: Uint8Array;
}

export interface JpegStructure {
  readonly frame: JpegFrame;
  /** Quantisation tables by id, in ZIGZAG order as the stream stores them. */
  readonly quantTables: readonly (Uint16Array | undefined)[];
  readonly scans: readonly JpegScan[];
  /** An APP0 segment starting "JFIF\0" was seen (T.871). */
  readonly jfif: boolean;
  /** The Adobe APP14 segment's colour transform code, when one is present. */
  readonly adobe?: { readonly transform: number };
}

export interface JpegGuard {
  /** Largest width × height accepted. */
  readonly maxPixels: number;
}

/** The one refusal of the JPEG reader: our literal reason, never a byte of the stream. */
export const refuse = (reason: string): ReaderError => new ReaderError("EXTRACT_FAILED", `jpeg: ${reason}`);

/** Refuses a table id above `max` (3 for a quantization, a Huffman or a frame's table; 1 in a baseline scan). */
const requireTableId = (id: number, max: number): void => {
  if (id > max) throw refuse("bad table id");
};

/** A component's real size in samples, and its blocks per line and per column (T.81 A.2.4: ceil(image × H / Hmax),
 *  then 8-sample blocks), as opposed to its block-padded plane. */
export const componentDims = (
  frame: JpegFrame,
  c: JpegComponent,
): {
  readonly realWidth: number;
  readonly realHeight: number;
  readonly blocksPerLine: number;
  readonly blocksPerColumn: number;
} => {
  const realWidth = Math.ceil((frame.width * c.h) / frame.maxH);
  const realHeight = Math.ceil((frame.height * c.v) / frame.maxV);
  return { realWidth, realHeight, blocksPerLine: Math.ceil(realWidth / 8), blocksPerColumn: Math.ceil(realHeight / 8) };
};

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DNL = 0xdc;
const DRI = 0xdd;
const DHT = 0xc4;
const COM = 0xfe;
const PROCESS_OF: Readonly<Record<number, JpegProcess>> = { 0xc0: "baseline", 0xc1: "extended", 0xc2: "progressive" };
/** SOF3, SOF5-7, SOF9-11, SOF13-15, DAC, DHP, EXP (table B.1). */
const UNSUPPORTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xde, 0xdf]);
const MAX_BLOCKS_PER_MCU = 10;
/** Most scans kept. Each costs a few hundred bytes the memory budget does not
 *  see, so the cap is checked while reading, never after (500 000 empty scans,
 *  5 MB, grew the heap by 335 MB: review of 06/10/2026). The fixtures have 1
 *  to 10 scans. Valeur de départ à calibrer; the CPU time of the scans has
 *  its own guard (`jpeg/decode.ts`, work ratio). jpeg-js has no bound. */
const MAX_SCANS = 256;
/** Largest successive approximation bit Al of a progressive scan (T.81 B.2.3). */
const MAX_SUCCESSIVE_BIT = 13;
const MAX_HUFFMAN_VALUES = 256;

const isRst = (m: number): boolean => m >= 0xd0 && m <= 0xd7;
const isApp = (m: number): boolean => m >= 0xe0 && m <= 0xef;

/** The end (exclusive) of the entropy-coded segment starting at `from`: the
 *  offset of the first byte of the next marker, its fill bytes included. A
 *  run of 0xFF ending in a stuffed 0x00 or an RST stays in the segment. */
const entropyEnd = (b: Uint8Array, from: number): number => {
  let at = from;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    let last = at;
    while (last + 1 < b.length && b[last + 1] === 0xff) last++;
    if (last + 1 >= b.length) break;
    const next = b[last + 1]!;
    if (next !== 0x00 && !isRst(next)) return at;
    at = last + 2;
  }
  throw refuse("truncated scan");
};

/** What the segment readers of `parseJpeg` fill in, marker by marker. */
interface ParseState {
  readonly guard: JpegGuard;
  readonly quantTables: (Uint16Array | undefined)[];
  readonly dcTables: (HuffmanSpec | undefined)[];
  readonly acTables: (HuffmanSpec | undefined)[];
  /** Quantisation table ids already used by a component of a started scan. */
  readonly quantInUse: Set<number>;
  readonly scans: JpegScan[];
  frame: JpegFrame | undefined;
  restartInterval: number;
  jfif: boolean;
  adobe: { transform: number } | undefined;
}

/** The marker code after the fill bytes at `at`, and the offset just past it. */
const readMarker = (bytes: Uint8Array, from: number): { readonly marker: number; readonly next: number } => {
  let at = from;
  if (at >= bytes.length) throw refuse("truncated stream");
  if (bytes[at] !== 0xff) throw refuse("marker expected");
  while (at < bytes.length && bytes[at] === 0xff) at++;
  if (at >= bytes.length) throw refuse("truncated stream");
  return { marker: bytes[at]!, next: at + 1 };
};

/** Refuses a marker that is not one of the supported kinds, before its length is read. */
const requireSupportedMarker = (marker: number): void => {
  if (UNSUPPORTED.has(marker) || (marker >= 0xc0 && marker <= 0xcf && marker !== DHT && !(marker in PROCESS_OF))) {
    throw refuse("unsupported process");
  }
  const known =
    marker in PROCESS_OF ||
    marker === DHT ||
    marker === DQT ||
    marker === DRI ||
    marker === SOS ||
    marker === DNL ||
    marker === COM ||
    isApp(marker);
  if (!known) throw refuse("unexpected marker");
};

/** The length of the segment at `at` (it counts its own two bytes), checked against the bytes present. */
const readSegmentLength = (bytes: Uint8Array, at: number): number => {
  if (at + 2 > bytes.length) throw refuse("truncated segment");
  const length = u16be(bytes, at);
  if (length < 2 || at + length > bytes.length) throw refuse("truncated segment");
  return length;
};

/** An APPn or COM segment: only the JFIF APP0 and the Adobe APP14 are kept. */
const readAppSegment = (marker: number, p: Uint8Array, state: ParseState): void => {
  if (
    marker === 0xe0 &&
    p.length >= 5 &&
    p[0] === 0x4a &&
    p[1] === 0x46 &&
    p[2] === 0x49 &&
    p[3] === 0x46 &&
    p[4] === 0
  )
    state.jfif = true;
  // "Adobe", then version, flags0, flags1 (two bytes each), then the
  // transform: payload byte 11 (the layout jpeg-js and IJG read).
  if (
    marker === 0xee &&
    p.length >= 12 &&
    p[0] === 0x41 &&
    p[1] === 0x64 &&
    p[2] === 0x6f &&
    p[3] === 0x62 &&
    p[4] === 0x65
  ) {
    state.adobe = { transform: p[11]! };
  }
};

/** The 64 values of the quantisation table at `at + 1`, 8 or 16 bits each. */
const readQuantTable = (p: Uint8Array, i: number, pq: number): Uint16Array => {
  const table = new Uint16Array(64);
  for (let k = 0; k < 64; k++) {
    const q = pq === 0 ? p[i + 1 + k]! : u16be(p, i + 1 + 2 * k);
    if (q === 0) throw refuse("bad quantization table");
    table[k] = q;
  }
  return table;
};

/** A DQT segment: one or more tables; a table a started scan uses may not change. */
const readDqt = (p: Uint8Array, state: ParseState): void => {
  let i = 0;
  while (i < p.length) {
    const pq = p[i]! >> 4;
    const tq = p[i]! & 15;
    if (pq > 1) throw refuse("bad quantization table");
    requireTableId(tq, 3);
    const size = pq === 0 ? 64 : 128;
    if (i + 1 + size > p.length) throw refuse("bad quantization table");
    const table = readQuantTable(p, i, pq);
    const previous = state.quantTables[tq];
    if (state.quantInUse.has(tq) && previous && previous.some((q, k) => q !== table[k]))
      throw refuse("quantization table changed after use");
    state.quantTables[tq] = table;
    i += 1 + size;
  }
};

/** A DHT segment: one or more Huffman tables, copied out of the segment. */
const readDht = (p: Uint8Array, state: ParseState): void => {
  let i = 0;
  while (i < p.length) {
    const tc = p[i]! >> 4;
    const th = p[i]! & 15;
    if (tc > 1) throw refuse("bad huffman table");
    requireTableId(th, 3);
    if (i + 17 > p.length) throw refuse("bad huffman table");
    const counts = p.slice(i + 1, i + 17);
    const total = counts.reduce((sum, n) => sum + n, 0);
    if (total > MAX_HUFFMAN_VALUES || i + 17 + total > p.length) throw refuse("bad huffman table");
    const spec: HuffmanSpec = { counts, values: p.slice(i + 17, i + 17 + total) };
    (tc === 0 ? state.dcTables : state.acTables)[th] = spec;
    i += 17 + total;
  }
};

/** An SOS segment at `at` (the offset after its header): the scan with the state in effect, then its entropy-coded
 *  bytes. Returns the offset after them. */
const readScanSegment = (bytes: Uint8Array, at: number, p: Uint8Array, state: ParseState): number => {
  const { frame, scans } = state;
  if (!frame) throw refuse("scan before frame");
  if (scans.length === MAX_SCANS) throw refuse("too many scans");
  const header = readScanHeader(frame, p, state.dcTables, state.acTables, state.quantTables);
  for (const c of header.components) state.quantInUse.add(frame.components[c.componentIndex]!.tq);
  const end = entropyEnd(bytes, at);
  scans.push({
    ...header,
    restartInterval: state.restartInterval,
    dcTables: [...state.dcTables],
    acTables: [...state.acTables],
    data: bytes.subarray(at, end),
  });
  return end;
};

/** Reads the segment of `marker` whose payload is `p` and which ends at `at`; returns where the next marker is
 *  looked for (past the entropy-coded bytes after a scan header). */
const readSegment = (bytes: Uint8Array, marker: number, p: Uint8Array, at: number, state: ParseState): number => {
  if (isApp(marker) || marker === COM) {
    readAppSegment(marker, p, state);
  } else if (marker === DQT) {
    readDqt(p, state);
  } else if (marker === DHT) {
    readDht(p, state);
  } else if (marker === DRI) {
    if (p.length !== 2) throw refuse("bad restart interval");
    state.restartInterval = u16be(p, 0);
  } else if (marker === DNL) {
    // Only meaningful with a frame height of 0, which is refused.
  } else if (marker in PROCESS_OF) {
    if (state.frame) throw refuse("more than one frame");
    state.frame = readFrame(PROCESS_OF[marker]!, p, state.guard);
  } else {
    // SOS
    return readScanSegment(bytes, at, p, state);
  }
  return at;
};

export const parseJpeg = (bytes: Uint8Array, guard: JpegGuard): JpegStructure => {
  if (!Number.isFinite(guard.maxPixels) || guard.maxPixels < 0)
    throw new Error("parseJpeg: maxPixels must be a finite number >= 0");
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) throw refuse("not a jpeg stream");

  const state: ParseState = {
    guard,
    quantTables: [undefined, undefined, undefined, undefined],
    dcTables: [undefined, undefined, undefined, undefined],
    acTables: [undefined, undefined, undefined, undefined],
    quantInUse: new Set<number>(),
    scans: [],
    frame: undefined,
    restartInterval: 0,
    jfif: false,
    adobe: undefined,
  };

  let at = 2;
  for (;;) {
    const read = readMarker(bytes, at);
    at = read.next;
    if (read.marker === EOI) break;
    requireSupportedMarker(read.marker);
    const length = readSegmentLength(bytes, at);
    const p = bytes.subarray(at + 2, at + length);
    at += length;
    at = readSegment(bytes, read.marker, p, at, state);
  }
  const { frame, scans, adobe } = state;
  if (!frame) throw refuse("no frame");
  if (scans.length === 0) throw refuse("no scan");
  if (frame.components.length === 4 && !adobe) throw refuse("four components without an adobe segment");
  return { frame, quantTables: state.quantTables, scans, jfif: state.jfif, ...(adobe ? { adobe } : {}) };
};

const readFrame = (process: JpegProcess, p: Uint8Array, guard: JpegGuard): JpegFrame => {
  if (p.length < 6) throw refuse("bad frame header");
  const precision = p[0]!;
  const height = u16be(p, 1);
  const width = u16be(p, 3);
  const count = p[5]!;
  if (p.length !== 6 + 3 * count) throw refuse("bad frame header");
  if (precision !== 8) throw refuse("unsupported precision");
  if (width === 0) throw refuse("zero width");
  if (height === 0) throw refuse("height deferred to dnl not supported");
  if (width * height > guard.maxPixels) throw refuse("image over the pixel guard");
  if (count !== 1 && count !== 3 && count !== 4) throw refuse("unsupported component count");
  const components: JpegComponent[] = [];
  for (let i = 0; i < count; i++) {
    const id = p[6 + 3 * i]!;
    const h = p[7 + 3 * i]! >> 4;
    const v = p[7 + 3 * i]! & 15;
    const tq = p[8 + 3 * i]!;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw refuse("bad sampling factor");
    requireTableId(tq, 3);
    if (components.some((c) => c.id === id)) throw refuse("duplicate component");
    components.push({ id, h, v, tq });
  }
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  return {
    process,
    width,
    height,
    components,
    maxH,
    maxV,
    mcusPerLine: Math.ceil(width / (8 * maxH)),
    mcusPerColumn: Math.ceil(height / (8 * maxV)),
  };
};

const readScanHeader = (
  frame: JpegFrame,
  p: Uint8Array,
  dcTables: readonly (HuffmanSpec | undefined)[],
  acTables: readonly (HuffmanSpec | undefined)[],
  quantTables: readonly (Uint16Array | undefined)[],
): Pick<JpegScan, "components" | "ss" | "se" | "ah" | "al"> => {
  const count = p[0] ?? 0;
  if (count < 1 || count > 4 || p.length !== 4 + 2 * count) throw refuse("bad scan header");
  const ss = p[1 + 2 * count]!;
  const se = p[2 + 2 * count]!;
  const ah = p[3 + 2 * count]! >> 4;
  const al = p[3 + 2 * count]! & 15;
  const progressive = frame.process === "progressive";
  if (!progressive && (ss !== 0 || se !== 63 || ah !== 0 || al !== 0)) throw refuse("bad sequential scan parameters");
  // T.81 B.2.3, G.1.1.1: a DC scan has Ss = Se = 0; an AC scan 1 <= Ss <= Se <= 63, one component; a refinement
  // adds one bit (Al = Ah - 1). Checked here, before `jpeg/decode.ts` sums the work of the scans: a scan with
  // Ss > Se counted negatively there (counter-review of 06/10/2026).
  const validProgressive =
    (ss === 0 ? se === 0 : ss <= se && se <= 63 && count === 1) &&
    (ah === 0 || al === ah - 1) &&
    al <= MAX_SUCCESSIVE_BIT;
  if (progressive && !validProgressive) throw refuse("bad progressive scan parameters");
  const needDc = !progressive || (ss === 0 && ah === 0);
  const needAc = !progressive || se > 0;
  const maxTable = frame.process === "baseline" ? 1 : 3;
  const components: JpegScanComponent[] = [];
  for (let i = 0; i < count; i++) {
    const componentIndex = frame.components.findIndex((c) => c.id === p[1 + 2 * i]);
    if (componentIndex < 0 || components.some((c) => c.componentIndex === componentIndex))
      throw refuse("scan names an unknown component");
    const td = p[2 + 2 * i]! >> 4;
    const ta = p[2 + 2 * i]! & 15;
    requireTableId(td, maxTable);
    requireTableId(ta, maxTable);
    if ((needDc && !dcTables[td]) || (needAc && !acTables[ta])) throw refuse("missing huffman table");
    if (!quantTables[frame.components[componentIndex]!.tq]) throw refuse("missing quantization table");
    components.push({ componentIndex, td, ta });
  }
  if (count > 1) {
    const blocks = components.reduce(
      (sum, c) => sum + frame.components[c.componentIndex]!.h * frame.components[c.componentIndex]!.v,
      0,
    );
    if (blocks > MAX_BLOCKS_PER_MCU) throw refuse("too many blocks per mcu");
  }
  return { components, ss, se, ah, al };
};
