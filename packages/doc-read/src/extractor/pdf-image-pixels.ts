/** Pixels of a DCT (JPEG) or Flate image, as the image reader takes them (RGB, 24 bits), decoded with the rules pdf.js used (measured against it before its removal):
 *  - a DeviceRGB or DeviceGray JPEG (or an ICCBased with N = 3 or 1) goes through jpeg-js's `decode` (`rgbOf`), 829
 *    corpus images equal to pdf.js, never more than one level apart (1/11/2026). The product's own JPEG decoder is NOT used:
 *    its pixels differed from pdf.js on about 8 % of samples;
 *  - a DeviceCMYK JPEG goes through the vendored decoder and our DeviceCMYK conversion (`cmykToRgb`), byte-identical to pdf.js's (measured before its removal);
 *  - a `/Decode` array is applied as pdf.js did (`withDecode`, `decodeSample`).
 *  NOT here: the soft mask (`pdf-smask.ts`), the picture object (`pdf-jpeg-images.ts`), the colour formulas (`pdf-colour-ours.ts`).
 *  Called by: `pdf-jpeg-images.ts`, `pdf-smask.ts`. */

import { cmykBytes } from "./pdf-colour-ours";
import { decodeRaw } from "./codecs/vendor/jpeg-js-decoder.cjs";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import { refKey, type PdfDict, type PdfValue } from "./pdf-objects/objects";

export const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);
export const numberOf = (value: PdfValue | undefined): number | undefined => (value?.kind === "number" ? value.value : undefined);

/** 🔴 THE VALUE A DICTIONARY REALLY CARRIES for a key, which `dict.has` does NOT tell (security review of
 *  03/11/2026). `parse.ts` drops an entry written as `null` on the spot, so `has` is honest for a DIRECT value; it is
 *  not for `/Mask 12 0 R` whose object 12 is free or null, which a PDF updated by increments produces. Read by
 *  presence, those entries refused a perfectly readable picture on three paths at once and the counter blamed « mask »,
 *  the wrong place to look. Absent, free, or null: all three answer `undefined`. */
export const entryOf = (doc: PdfObjectsDocument, dict: PdfDict, key: string): PdfValue | undefined => {
  const value = doc.resolve(dict.get(key));
  return value === undefined || value.kind === "null" ? undefined : value;
};


/** Declared-size cap (width x height) above which a picture is refused BEFORE any buffer is sized from it (starting value to calibrate).
 *  Incident: an image declared 60000 x 60000 would have been scheduled for decoding. The largest buffer held is this cap x 4 channels.
 *  🔴 Security review of 02/11/2026: it used to guard the pdf-lib path alone; the Flate, CCITT and JPEG readers sized their
 *  buffers from the dictionary's `Width` and `Height` with no ceiling, so a few kilobytes declaring a huge picture allocated
 *  gigabytes on a runtime that has 512 MB. Every reader now asks `pictureSizeOk` first. */
export const MAX_EMBEDDED_IMAGE_PIXELS = 25_000_000;

/** The memory the vendored JPEG decoder may count while it decodes, passed on every call (its default, 512 MB, is the whole of the
 *  runtime). 256 is `JPEG_MAX_MEMORY_MB` of `image-reduction.ts`: the same decoder on the same runtime, not imported to keep this module
 *  light. Starting value to calibrate. The resolution limit passed beside it is the pixel ceiling above (25 M, not the default 100 M).
 *  Defence in depth, NOT SEEN BITING and written rather than disguised: an 81 M-pixel header is refused by the old limits too, so
 *  no cheap test tells the two apart; what tests hold is `pictureSizeOk` on the dictionary and on the frame header, upstream of
 *  the decoder. */
export const MAX_JPEG_DECODE_MEMORY_MB = 256;

const DECODE_OPTIONS = { maxResolutionInMP: MAX_EMBEDDED_IMAGE_PIXELS / 1_000_000, maxMemoryUsageInMB: MAX_JPEG_DECODE_MEMORY_MB };

/** Whether a declared picture size may be allocated: two positive integers whose product is within the ceiling. */
export function pictureSizeOk(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= MAX_EMBEDDED_IMAGE_PIXELS;
}

/** The number of components a JPEG declares in its frame header (SOF), or `undefined` when none is found before the scan. */
export function jpegFrameOf(raw: Uint8Array): { components: number; width: number; height: number } | undefined {
  // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC): a frame header is FF Cn, length, precision, height, width, Nf.
  let at = 2;
  while (at + 4 <= raw.length) {
    if (raw[at] !== 0xff) return undefined;
    const marker = raw[at + 1]!;
    if (marker === 0xda || marker === 0xd9) return undefined; // start of scan or end of image: no frame header before it
    const length = (raw[at + 2]! << 8) | raw[at + 3]!;
    if (length < 2) return undefined;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 10 > raw.length) return undefined;
      const height = (raw[at + 5]! << 8) | raw[at + 6]!;
      const width = (raw[at + 7]! << 8) | raw[at + 8]!;
      return { components: raw[at + 9]!, width, height };
    }
    at += 2 + length;
  }
  return undefined;
}

/** The components the colour space declares: 4 for DeviceCMYK, 3 for DeviceRGB and ICCBased N = 3, 1 for DeviceGray and
 *  ICCBased N = 1. `undefined` for any other space (not decoded here). */
export function componentsOfSpace(doc: PdfObjectsDocument, space: PdfValue | undefined): number | undefined {
  const name = nameOf(space);
  if (name === "DeviceCMYK") return 4;
  if (name === "DeviceRGB") return 3;
  if (name === "DeviceGray") return 1;
  const array = space?.kind === "array" ? space.items : undefined;
  if (array === undefined || nameOf(doc.resolve(array[0])) !== "ICCBased") return undefined;
  const n = numberOf(doc.resolve(doc.dictOf(array[1])?.get("N")));
  return n === 3 || n === 1 ? n : undefined;
}

/** A RGB or grey JPEG through jpeg-js, as RGB bytes. */
export function rgbOf(raw: Uint8Array, drawn?: { width: number; height: number }): { width: number; height: number; data: Uint8Array } | undefined {
  let decoded;
  try {
    // Drawn at another size, the JPEG is resampled to it (what pdf.js did for a size that does not match the JPEG).
    decoded = decodeRaw(raw, { ...DECODE_OPTIONS, ...drawn });
  } catch {
    return undefined;
  }
  const pixels = decoded.width * decoded.height;
  const data = new Uint8Array(pixels * 3);
  if (decoded.numComponents === 1) {
    for (let p = 0; p < pixels; p += 1) data.fill(decoded.data[p]!, p * 3, p * 3 + 3);
  } else if (decoded.numComponents === 3) {
    // pdf.js's own YCbCr -> RGB (its constants, its rounding) when the colour transform is due; the components as they are otherwise.
    for (let p = 0; p < pixels; p += 1) {
      const a = decoded.data[p * 3]!;
      const b = decoded.data[p * 3 + 1]!;
      const c = decoded.data[p * 3 + 2]!;
      if (decoded.transform) {
        data[p * 3] = roundToByte(a - 179.456 + 1.402 * c);
        data[p * 3 + 1] = roundToByte(a + 135.459 - 0.344 * b - 0.714 * c);
        data[p * 3 + 2] = roundToByte(a - 226.816 + 1.772 * b);
      } else {
        data[p * 3] = a;
        data[p * 3 + 1] = b;
        data[p * 3 + 2] = c;
      }
    }
  } else {
    return undefined;
  }
  return { width: decoded.width, height: decoded.height, data };
}

/** A value stored in an 8-bit clamped array: clamped to [0, 255], rounded half to even (the rounding of
 *  `Uint8ClampedArray`, which pdf.js wrote its colours into). */
function roundToByte(value: number): number {
  const v = Math.min(255, Math.max(0, value));
  const floor = Math.floor(v);
  const fraction = v - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The `/Decode` array, one `[dmin, dmax]` per component: `undefined` when absent or the default `[0 1]` (nothing to do),
 *  `null` when malformed (not decoded here). */
export function decodeArrayOf(doc: PdfObjectsDocument, dict: ReadonlyMap<string, PdfValue>, components: number): (readonly [number, number])[] | undefined | null {
  // `entryOf` et non `resolve` : un `/Decode` NUL est un `/Decode` absent, comme pour les trois autres lecteurs. Lu
  // autrement, il tombait dans « tableau malformé » et refusait une image que le chemin Flate décodait — même
  // dictionnaire, deux verdicts, et le compteur annonçait « forme » (contre-revue du 03/11/2026).
  const array = entryOf(doc, dict, "Decode");
  if (array === undefined) return undefined;
  if (array.kind !== "array" || array.items.length !== components * 2) return null;
  const numbers = array.items.map((item) => numberOf(doc.resolve(item)));
  if (numbers.some((n) => n === undefined)) return null;
  const pairs: [number, number][] = [];
  for (let j = 0; j < components; j += 1) pairs.push([numbers[2 * j]!, numbers[2 * j + 1]!]);
  return pairs.every(([dmin, dmax]) => dmin === 0 && dmax === 1) ? undefined : pairs;
}

/** One sample under a `/Decode` pair, as pdf.js wrote it (its `decodeBuffer`): `dmin·255 + x·(dmax − dmin)`, stored in a
 *  clamped 8-bit array (clamped, rounded half to even: `roundToByte`). */
export function decodeSample(x: number, pair: readonly [number, number]): number {
  return roundToByte(pair[0] * 255 + x * (pair[1] - pair[0]));
}

/** An RGB or grey image's pixels under its `/Decode`, when it has one. */
export function withDecode(
  image: { width: number; height: number; data: Uint8Array } | undefined,
  decodes: readonly (readonly [number, number])[] | undefined | null,
): { width: number; height: number; data: Uint8Array } | undefined {
  if (image === undefined || decodes === undefined || decodes === null) return image;
  const comps = decodes.length;
  const data = image.data;
  for (let i = 0; i < data.length; i += 1) data[i] = decodeSample(data[i]!, decodes[comps === 1 ? 0 : i % 3]!);
  return image;
}

/** A CMYK JPEG: the vendored decoder's components, converted with our DeviceCMYK conversion.  A YCCK colour transform is converted as pdf.js did. */
export function cmykToRgb(raw: Uint8Array, decodes: readonly (readonly [number, number])[] | undefined, drawn: { width: number; height: number }): { width: number; height: number; data: Uint8Array } | undefined {
  let decoded;
  try {
    decoded = decodeRaw(raw, { ...DECODE_OPTIONS, ...drawn });
  } catch {
    return undefined;
  }
  if (decoded.numComponents !== 4) return undefined;
  const pixels = decoded.width * decoded.height;
  const data = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p += 1) {
    // Four components, in the order C M Y K. With a colour transform (YCCK) they come as Y Cb Cr K, converted here to
    // C M Y as pdf.js did (its constants, its rounding); K is unchanged.
    let c = decoded.data[p * 4]!;
    let m = decoded.data[p * 4 + 1]!;
    let y = decoded.data[p * 4 + 2]!;
    const k = decoded.data[p * 4 + 3]!;
    if (decoded.ycck) {
      const yy = c;
      const cb = m;
      const cr = y;
      c = roundToByte(434.456 - yy - 1.402 * cr);
      m = roundToByte(119.541 - yy + 0.344 * cb + 0.714 * cr);
      y = roundToByte(481.816 - yy - 1.772 * cb);
    }
    if (decodes !== undefined) {
      c = decodeSample(c, decodes[0]!);
      m = decodeSample(m, decodes[1]!);
      y = decodeSample(y, decodes[2]!);
    }
    const kk = decodes !== undefined ? decodeSample(k, decodes[3]!) : k;
    const [r, g, b] = cmykBytes(c / 255, m / 255, y / 255, kk / 255);
    data[p * 3] = Math.min(255, Math.max(0, Math.round(r)));
    data[p * 3 + 1] = Math.min(255, Math.max(0, Math.round(g)));
    data[p * 3 + 2] = Math.min(255, Math.max(0, Math.round(b)));
  }
  return { width: decoded.width, height: decoded.height, data };
}


/** The `refKey` name of an indirect value, or `undefined` for a direct one. */
export function objectRefOf(declared: PdfValue | undefined): string | undefined {
  return declared?.kind === "ref" ? refKey(declared) : undefined;
}

/** The bytes of an `/Indexed` lookup table: a string's, or a stream's decoded; `undefined` for anything else or a refusal. */
function paletteBytesOf(doc: PdfObjectsDocument, table: PdfValue | undefined): Uint8Array | undefined {
  if (table?.kind === "string") return table.bytes;
  if (table?.kind !== "stream") return undefined;
  try {
    return doc.streamBytes(table);
  } catch {
    return undefined;
  }
}

/** An `/Indexed` colour space: its base's component count (1 or 3), its highest index, and its lookup table (the bytes of
 *  the string or the stream). `undefined` when the space is not indexed or its base or table is one we do not read. */
export function indexedOf(doc: PdfObjectsDocument, space: PdfValue | undefined): { base: number; hival: number; lookup: Uint8Array } | undefined {
  if (space?.kind !== "array" || space.items.length !== 4) return undefined;
  if (nameOf(doc.resolve(space.items[0])) !== "Indexed") return undefined;
  const base = componentsOfSpace(doc, doc.resolve(space.items[1]));
  if (base !== 1 && base !== 3) return undefined;
  const hival = numberOf(doc.resolve(space.items[2]));
  if (hival === undefined || hival < 0 || hival > 255) return undefined;
  const lookup = paletteBytesOf(doc, doc.resolve(space.items[3]));
  if (lookup === undefined) return undefined;
  if (lookup.length < (hival + 1) * base) return undefined;
  return { base, hival, lookup };
}

/** The samples of an image with 1, 2, 4 or 8 bits per component, one byte per sample (its value, not scaled). Each row
 *  starts on a byte boundary (PDF §8.9.3). `undefined` when the bytes are too few for the image. */
export function unpackSamples(bytes: Uint8Array, width: number, height: number, components: number, bpc: number): Uint8Array | undefined {
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8) return undefined;
  const rowBytes = Math.ceil((width * components * bpc) / 8);
  if (bytes.length < rowBytes * height) return undefined;
  const perRow = width * components;
  const out = new Uint8Array(perRow * height);
  const mask = (1 << bpc) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < perRow; i += 1) {
      const offset = i * bpc;
      const byte = bytes[y * rowBytes + (offset >> 3)]!;
      out[y * perRow + i] = (byte >> (8 - bpc - (offset & 7))) & mask;
    }
  }
  return out;
}

/** Where a picture is painted: the resources that name it (the page's, or those of the form that paints it). */
export interface PictureScope {
  readonly resources: PdfDict | undefined;
}
