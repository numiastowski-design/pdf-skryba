/** A PNG decoded to raw pixels, with no dependency (`node:zlib` inflates) —
 *  so a cropped picture can be cut to its visible part and re-encoded.
 *  Only the variants it can decode exactly: 8 bits per channel, grey, grey +
 *  alpha, RGB, RGBA, not interlaced, no `tRNS` transparent colour. Any other
 *  PNG gives `undefined`: the caller then publishes nothing rather than a
 *  wrong image.
 *  NOT here: encoding (`extractor/png.ts`), nor what to cut
 *  (`extractor/pptx-reader/picture.ts`).
 *  Called by: `extractor/pptx-reader/picture.ts`, `extractor/image-reduction.ts`, and `extractor/pdf-embedded-images.ts`
 *  (`unfilterPngRows`). */

import { inflateSync } from "node:zlib";

import { concatBytes, u32be as u32 } from "./bytes";
import { isPng } from "./image-pixel-width";
import { channelsOfColorType } from "./png-color";

export interface DecodedPng {
  width: number;
  height: number;
  /** 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. */
  channels: 1 | 2 | 3 | 4;
  /** `height` rows of `width × channels` bytes, no filter byte. */
  pixels: Uint8Array;
}

// Palette (type 3) is left out of `png-color.ts`: none of the cropped pictures of the USA deck is one
// (all RGB or RGBA, read 25/09/2026), and the encoder has no palette.

/** PNG filter 4: the neighbour closest to `left + up − upLeft`. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * `maxPixels` refuses an image before anything is inflated; the inflated
 * stream is also capped at the exact size the header announces, so a small
 * file cannot unpack into a large one.
 */
export const decodePng = (bytes: Uint8Array, maxPixels: number): DecodedPng | undefined => {
  if (bytes.length < 33 || !isPng(bytes)) return undefined;
  let width = 0;
  let height = 0;
  let channels: 1 | 2 | 3 | 4 | undefined;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (data.length !== length) return undefined;
    if (type === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      const [depth, colorType, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      channels = colorType === undefined ? undefined : channelsOfColorType(colorType);
      if (depth !== 8 || channels === undefined || compression !== 0 || filter !== 0 || interlace !== 0) return undefined;
    } else if (type === "tRNS") {
      // A transparent colour on a grey or RGB image: dropping it would make
      // the transparent areas opaque.
      return undefined;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length; // length, type, data, CRC
  }
  if (channels === undefined || width === 0 || height === 0 || width * height > maxPixels || idat.length === 0) return undefined;

  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    raw = inflateSync(concatBytes(idat), { maxOutputLength: expected });
  } catch {
    return undefined;
  }
  if (raw.length !== expected) return undefined;

  const pixels = unfilterPngRows(raw, width, height, channels);
  return pixels === undefined ? undefined : { width, height, channels, pixels };
};

/** Undoes the PNG row filters (None, Sub, Up, Average, Paeth), 8 bits per channel. `data` is `height` rows of a
 *  filter byte then `width × channels` bytes; any other length, or a filter type above 4, gives `undefined`. */
export function unfilterPngRows(data: Uint8Array, width: number, height: number, channels: number): Uint8Array | undefined {
  const stride = width * channels;
  if (data.length !== height * (stride + 1)) return undefined;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      else return undefined;
      out[dst + x] = (data[src + x]! + predicted) & 0xff;
    }
  }
  return out;
}
