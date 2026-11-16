/** A presentation's large picture brought down to 1 600 px on its long side
 *  and re-encoded as a JPEG, quality 80 (27/09/2026): the USA deck's
 *  2 500-px `image6.png` weighs 5.7 MB, under 400 KB once reduced (test). Pure and deterministic: same bytes
 *  in, same bytes out, so the same sha256 and no re-upload without cause.
 *  An image at or under the cap, or one this module does not reduce, gives
 *  `undefined`: the caller publishes the original bytes, untouched.
 *  Applies to pptx, Google Slides, xlsx and docx (since 08/10/2026): not PDF. Never a
 *  drawing of ours (SVG).
 *  Also reads image sizes (`imagePixelSize`), resamples (`resampleBilinear`), decodes to opaque RGBA
 *  (`decodeOpaque`, through `extractor/png-decode.ts` and `extractor/jpeg/decode.ts`), and owns the decode memory
 *  guards `MAX_DECODED_MP` and `JPEG_MAX_MEMORY_MB` (guarded JPEG decode: `decodeJpegGuarded`).
 *  NOT here: where the reduction applies (`extractor/image-collector.ts`), the PNG decoder itself
 *  (`extractor/png-decode.ts`), the published width's 744-px cap (`renderer/storage.ts#publishedImageWidthPx`).
 *  Called by: `extractor/image-collector.ts` (reduction, size), `extractor/docx-reader/index.ts` and
 *  `extractor/pptx-reader/shapes.ts` (`imagePixelSize`, `isOnePixel`), `extractor/pptx-reader/picture.ts` (`decodeJpegGuarded`, `isTurnedByExif`, `MAX_DECODED_MP`). */

import { decodeJpegRgba } from "./jpeg/decode";
import { encodeJpegRgba } from "./jpeg/encode";

import { imageHeader } from "doc-ir/extractor/image-format";
import { isPng, jpegHeader } from "doc-ir/extractor/image-pixel-width";
import { hasAlphaChannel } from "doc-ir/extractor/png-color";
import { decodePng } from "doc-ir/extractor/png-decode";

/** Longest side, in pixels, of a published presentation picture (
 *  27/09/2026). */
export const MAX_LONG_SIDE_PX = 1600;

/** Quality of the reduced JPEG (27/09/2026): about 300 KB for a
 *  1 600-px screenshot. */
const REDUCED_JPEG_QUALITY = 80;

/** Largest image decoded to be reduced. The same guard as the crop's
 *  (12 MP, about three times the USA deck's largest picture, 2 500 × 1 668
 *  = 4.2 MP): larger than that, the image is published as it is here, or
 *  becomes the crop's marker in `pptx-reader/picture.ts` — the ONE
 *  definition both consumers share since 28/09/2026 (two copies, flushed
 *  out by the bounds register). Valeur de départ à calibrer: a guard
 *  against memory, not a separation of two populations. */
export const MAX_DECODED_MP = 12;

/** The JPEG decoder's memory guard (`jpeg/decode.ts`, jpeg-js's until 06/10/2026), which counts what it allocates
 *  while decoding (coefficients, planes, output), several times the RGBA size.
 *  Valeur de départ à calibrer: the crop test "a JPEG as large as the
 *  largest real picture" pins that a 2 500 × 1 668 colour JPEG passes
 *  under it. Shared with `pptx-reader/picture.ts` (one definition). */
export const JPEG_MAX_MEMORY_MB = 256;

export interface ReducedImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  /** The reduced file's own width: the IR's `pixelWidth`. */
  pixelWidth: number;
}

/** Width and height a PNG, JPEG or GIF declares in its header; `undefined` for any other format. A projection of
 *  `imageHeader`; a JPEG height of 0 is deferred to a DNL marker, and this caller needs BOTH sides: "size unknown". */
export const imagePixelSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  const header = imageHeader(bytes);
  return header && header.height > 0 ? { width: header.width, height: header.height } : undefined;
};

/** The image declares exactly 1 × 1 pixels (the documented junk of a Fallback). */
export const isOnePixel = (bytes: Uint8Array): boolean => {
  const size = imagePixelSize(bytes);
  return size !== undefined && size.width === 1 && size.height === 1;
};

/** RGBA pixels resampled to `outW × outH`, bilinear, pixel centres aligned.
 *  Alpha is resampled like the colours (the callers give opaque pixels).
 *  Bilinear reads four neighbours only: past a factor of 2 (a 3 200-px
 *  picture or more) some source pixels count for nothing and fine lines
 *  can alias. Chosen for the decision's simplicity (27/09/2026). */
export const resampleBilinear = (src: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array => {
  const out = new Uint8Array(outW * outH * 4);
  const sx = w / outW;
  const sy = h / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), h - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, h - 1);
    const dy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), w - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, w - 1);
      const dx = fx - x0;
      const a = (y0 * w + x0) * 4;
      const b = (y0 * w + x1) * 4;
      const c = (y1 * w + x0) * 4;
      const d = (y1 * w + x1) * 4;
      const o = (y * outW + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k]! + (src[b + k]! - src[a + k]!) * dx;
        const bottom = src[c + k]! + (src[d + k]! - src[c + k]!) * dx;
        out[o + k] = Math.round(top + (bottom - top) * dy);
      }
    }
  }
  return out;
};

/** A decoded PNG as opaque RGBA. Transparency is laid on WHITE: chosen bias
 *  (27/09/2026), a JPEG has no alpha and a Confluence page is white;
 *  on a dark theme the picture shows a white box where it was transparent. */
const opaqueRgba = (pixels: Uint8Array, count: number, channels: 1 | 2 | 3 | 4): Uint8Array => {
  const out = new Uint8Array(count * 4);
  const withAlpha = hasAlphaChannel(channels);
  for (let i = 0; i < count; i++) {
    const p = i * channels;
    const grey = channels <= 2;
    const r = pixels[p]!;
    const g = grey ? r : pixels[p + 1]!;
    const b = grey ? r : pixels[p + 2]!;
    const alpha = withAlpha ? pixels[p + channels - 1]! : 255;
    const o = i * 4;
    out[o] = Math.round((r * alpha + 255 * (255 - alpha)) / 255);
    out[o + 1] = Math.round((g * alpha + 255 * (255 - alpha)) / 255);
    out[o + 2] = Math.round((b * alpha + 255 * (255 - alpha)) / 255);
    out[o + 3] = 255;
  }
  return out;
};

/** The pixels of a JPEG under the decode guards, or `undefined` when it is damaged or over a guard. */
export const decodeJpegGuarded = (bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | undefined => {
  try {
    // A damaged file throws (never grey blocks), and stays as it is. Every refusal of the JPEG reader (its guards included) ends here, so none
    // reaches a row: they keep `EXTRACT_FAILED` and are not `FILE_UNSAFE` (25/10/2026).
    return decodeJpegRgba(bytes, { maxResolutionInMP: MAX_DECODED_MP, maxMemoryUsageInMB: JPEG_MAX_MEMORY_MB });
  } catch {
    return undefined;
  }
};

/** A JPEG's EXIF orientation turns the picture (a value other than 1): re-encoding drops the EXIF segment, so such a picture is kept whole. */
export const isTurnedByExif = (orientation: number | undefined): boolean => orientation !== undefined && orientation !== 1;

/** The pixels of a PNG or JPEG as opaque RGBA, or `undefined` when this
 *  code does not decode it (a PNG `decodePng` refuses: palette, 16 bits,
 *  interlaced, transparent colour; a damaged JPEG; past `MAX_DECODED_MP`). */
const decodeOpaque = (bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | undefined => {
  if (isPng(bytes)) {
    const png = decodePng(bytes, MAX_DECODED_MP * 1_000_000);
    return png && { width: png.width, height: png.height, data: opaqueRgba(png.pixels, png.width * png.height, png.channels) };
  }
  return decodeJpegGuarded(bytes);
};

/**
 * The picture reduced to `MAX_LONG_SIDE_PX` on its long side, as a JPEG at
 * `REDUCED_JPEG_QUALITY`; `undefined` to publish the original untouched:
 * - at or under the cap (its bytes and sha256 do not move);
 * - not a PNG or a JPEG (GIF, WebP, EMF…): chosen bias, published as it is;
 * - a JPEG whose EXIF orientation turns it (≠ 1): re-encoding drops the EXIF
 *   segment and the picture would show unturned, so it is left whole;
 * - a PNG or JPEG this code does not decode (`decodeOpaque`);
 * - a result not lighter than the original (a flat drawing deflates better
 *   than a JPEG encodes it): the reduction is for weight, nothing else.
 * An ICC colour profile is not carried over: the JPEG is read as sRGB.
 */
export const reduceLargeImage = (bytes: Uint8Array): ReducedImage | undefined => {
  const png = isPng(bytes);
  const jpeg = png ? undefined : jpegHeader(bytes);
  const size = png ? imagePixelSize(bytes) : jpeg;
  // A DNL-deferred JPEG height (0) is not a size this decision can use.
  if (!size || size.height <= 0 || Math.max(size.width, size.height) <= MAX_LONG_SIDE_PX) return undefined;
  if (isTurnedByExif(jpeg?.orientation)) return undefined;
  const image = decodeOpaque(bytes);
  if (!image) return undefined;
  const scale = MAX_LONG_SIDE_PX / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = resampleBilinear(image.data, image.width, image.height, width, height);
  const out = encodeJpegRgba({ width, height, data }, REDUCED_JPEG_QUALITY);
  return out.length < bytes.length ? { bytes: out, mimeType: "image/jpeg", pixelWidth: width } : undefined;
};
