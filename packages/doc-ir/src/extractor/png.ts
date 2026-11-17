/** A PNG encoded from raw pixels, with no dependency — so a bitmap badge that
 *  carries meaning can be republished instead of vanishing.
 *  NOT here: getting the pixels (`extractor/pdf-images.ts`), nor deciding an
 *  image is worth keeping (`extractor/pdf-page-figures.ts`).
 *  Called by: `extractor/{pdf-embedded-images,pdf-table-detector,pdf-page-figures}.ts`,
 *  `extractor/pptx-reader/picture.ts`. */

/**
 * png.ts — encode a PNG from raw pixels, with no dependency at all.
 *
 * WHY THIS FILE EXISTS (11/09/2026). A report card puts two badges on the
 * line of its legend, just before "Absent" and "Dispensé". They are neither
 * paths nor text: they are 16×16 BITMAP IMAGES, measured at the
 * abscissas 315.7 and 402.2. The neighbouring numbered dots are reproduced as
 * SVG because the document gives a circle AND a digit; these give
 * only a grid of pixels. **Redrawing them would be inventing them** — we do not even
 * know, from the document, which letter they carry. We therefore copy the
 * pixels, and nothing else.
 *
 * WHY WITHOUT A LIBRARY, AND WITHOUT COMPRESSION. A `zlib` stream accepts
 * STORED blocks, that is uncompressed ones: a two-byte header, then
 * the data as is, then an Adler-32 sum. It is valid zlib, which
 * any decoder reads. It avoids adding a dependency to the Forge bundle to
 * save a few hundred bytes on a 16×16 image — and it keeps
 * the encoder DETERMINISTIC by construction, hence same pixels, same bytes,
 * same `sha256`, hence no attachment republished for no reason.
 *
 * The cost is real and accepted: a 400×333 image would come out at 400 KB instead of
 * about a hundred. This is why the caller must only use it for
 * SMALL images.
 *
 * THIS DAY HAS COME (15/09/2026): `encodePngDeflate` compresses, via `node:zlib`,
 * the large images of a PDF (`pdf-embedded-images.ts`). "Without compression"
 * now only holds for `encodePng`, the small markers, whose bytes do not
 * change.
 */

import { deflateSync } from "node:zlib";

/** `PNG_KIND` disappeared on 14/09/2026 (pdf.js boundary). This module copied pdf.js's `ImageKind` constants
 *  (`{1, 2, 3}`), and nothing would have flagged an upstream renumbering although `pdfjs-dist` exports `ImageKind`
 *  publicly.
 *
 *  The translation now lives in `./pdf-images`, which reads the published constant; this encoder receives only a
 *  format name and knows nothing of pdf.js.
 *  🔴 `PixelFormat` EST DÉFINI ICI depuis le 03/11/2026, et la raison est le SENS de la dépendance : cet écrivain est
 *  un commun (docx, pptx et xlsx l'appellent par `./image-*`), et il prenait son type au lecteur PDF. Un commun qui
 *  dépend d'un format est la première marche vers le plat de spaghettis. Le lecteur PDF l'importe désormais d'ici. */

import { concatBytes as concat, putU32be as u32 } from "./bytes";
import { PNG_SIGNATURE } from "./image-pixel-width";
import { colorTypeOfChannels } from "./png-color";

/** The pixel layouts this encoder accepts, in plain terms. No number, no borrowed constant. */
export type PixelFormat = "gray-1" | "rgb-24" | "rgba-32";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Adler-32, the sum that the `zlib` header demands. The modulo 65521 is the
 *  largest prime under 2^16 — that is the definition, not a setting. */
const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

/** A PNG chunk: length, type, data, CRC of the type AND of the data. */
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
};

/** Signature, IHDR, one IDAT, IEND. 8 bits per channel; compression 0, filter 0, no interlacing: the only values
 *  the format allows. Color type 2 is RGB, 6 is RGB + alpha. */
const assemblePng = (width: number, height: number, colorType: number, idat: Uint8Array, bitDepth = 8): Uint8Array =>
  concat([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", concat([u32(width), u32(height), new Uint8Array([bitDepth, colorType, 0, 0, 0])])),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);

/** The largest stored block that the `deflate` format accepts. */
const MAX_STORED_BLOCK = 0xffff;

/** A `zlib` stream made of STORED blocks — see the file header. */
function zlibStored(raw: Uint8Array): Uint8Array {
  // `0x78 0x01`: deflate method, 32 KB window, no compression announced.
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += MAX_STORED_BLOCK) {
    const slice = raw.subarray(at, Math.min(at + MAX_STORED_BLOCK, raw.length));
    const isLast = at + MAX_STORED_BLOCK >= raw.length;
    const len = slice.length;
    parts.push(new Uint8Array([isLast ? 1 : 0, len & 0xff, (len >>> 8) & 0xff, ~len & 0xff, (~len >>> 8) & 0xff]));
    parts.push(slice);
    if (isLast) break;
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

/**
 * Encodes an image as PNG. Returns `undefined` when the data does not match
 * the announced dimensions — better to publish nothing than a truncated
 * image, which would be "plausible and wrong" exactly like a paragraph
 * cut in mid-sentence.
 *
 * `format` is a NAME, not a number borrowed from pdf.js — see above. One-bit
 * gray (`gray-1`) is still not handled: the corpus carries none,
 * and guessing the bit order without being able to check it would produce a
 * wrong image. It therefore returns `undefined`, as before.
 */
export function encodePng(
  width: number,
  height: number,
  format: PixelFormat,
  data: ArrayLike<number>,
): Uint8Array | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  if (format === "gray-1") return encodeGrey1(width, height, data);
  const channels = format === "rgb-24" ? 3 : format === "rgba-32" ? 4 : 0;
  if (channels === 0 || data.length < width * height * channels) return undefined;

  // Each row of a PNG starts with its FILTER byte. `0` means "no
  // filter": the following bytes are as they are. Filters serve to compress
  // better, and we do not compress.
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    for (let x = 0; x < stride; x++) raw[at + 1 + x] = data[y * stride + x]!;
  }

  return assemblePng(width, height, colorTypeOfChannels(channels), zlibStored(raw));
}

/** One-bit gray: colour type 0, depth 1, pixels MSB first (§ PNG 2.3). A row takes `ceil(width / 8)`
 *  bytes, unfiltered. A 1 is white and a 0 black, as in a PDF DeviceGray space (§8.6.4.2): the image's bits
 *  are copied as they are. The padding bits of the last byte of a row are those of the source. */
function encodeGrey1(width: number, height: number, data: ArrayLike<number>): Uint8Array | undefined {
  const rowBytes = Math.ceil(width / 8);
  if (data.length < rowBytes * height) return undefined;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1);
    raw[at] = 0;
    for (let x = 0; x < rowBytes; x++) raw[at + 1 + x] = data[y * rowBytes + x]!;
  }
  return assemblePng(width, height, 0, zlibStored(raw), 1);
}

/**
 * A COMPRESSED PNG, for the large images of a PDF (15/09/2026). The encoder
 * above stores without compressing, and says so: from 200 KB to 1.1 MB per capture of
 * fixture 24, against 18 to 123 KB here. `deflateSync` is deterministic for the same
 * Node version: same pixels, same bytes, same `sha256`.
 */
export function encodePngDeflate(
  width: number,
  height: number,
  channels: 1 | 2 | 3 | 4,
  pixels: Uint8Array,
): Uint8Array | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  const stride = width * channels;
  if (pixels.length < stride * height) return undefined; // longer is fine: only stride * height bytes are read
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return assemblePng(width, height, colorTypeOfChannels(channels), new Uint8Array(deflateSync(raw, { level: 9 })));
}
