/** Image formats by their own bytes: the ONE sniff (PNG, JPEG, GIF) and the ONE header reader (format, width, height).
 *  Only the header is read, never the pixels: deterministic and cheap. Any other format (SVG, EMF, WebP…), or a header
 *  too short to hold the sizes, has no header here.
 *  Two JPEG segment walks exist and both are legitimate: `jpegHeader` below (stops at the first start-of-frame, reads
 *  the size and the EXIF orientation) and `jpeg/markers.ts` (reads the whole stream and refuses what the decoder cannot
 *  read). NOT here: the published width (`renderer/storage.ts#publishedImageWidthPx`), the reduction
 *  (`extractor/image-reduction.ts`).
 *  Called by: `extractor/image-pixel-width.ts`, `extractor/image-reduction.ts`, `extractor/pptx-reader/picture.ts`,
 *  `extractor/slide-svg.ts`. */

import { u16be, u32be } from "./bytes";

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ImageFormat = "png" | "jpeg" | "gif";

/** The format the bytes START with: the full 8-byte PNG signature, `ff d8 ff` for JPEG, "GIF8" for GIF. */
export const sniffImage = (bytes: Uint8Array): ImageFormat | undefined => {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  return undefined;
};

/** A dimension above this is no real size (a signed 32-bit reader would see it negative). */
const MAX_DIMENSION = 0x7fffffff;

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
}

export const imageHeader = (bytes: Uint8Array): ImageHeader | undefined => {
  const format = sniffImage(bytes);
  if (format === undefined) return undefined;
  if (format === "jpeg") {
    // A JPEG height of 0 is legal (deferred to a DNL marker): the width stays, the caller that needs both guards it.
    const jpeg = jpegHeader(bytes);
    return jpeg === undefined ? undefined : { format, width: jpeg.width, height: jpeg.height };
  }
  let width: number;
  let height: number;
  if (format === "png") {
    // 8-byte signature, then the IHDR chunk (length, "IHDR", width, height).
    if (bytes.length < 24) return undefined;
    width = u32be(bytes, 16);
    height = u32be(bytes, 20);
  } else {
    // "GIF87a"/"GIF89a", then the logical screen size, little-endian.
    if (bytes.length < 10) return undefined;
    width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
    height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  }
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION
    ? { format, width, height }
    : undefined;
};

export interface JpegHeader {
  width: number;
  height: number;
  /** EXIF orientation (1–8), when an APP1 EXIF segment declares one. */
  orientation?: number;
}

/** The EXIF orientation of an APP1 payload ("Exif\0\0", then a TIFF
 *  header and IFD0), or `undefined` when it declares none. */
const exifOrientationOf = (b: Uint8Array, start: number, end: number): number | undefined => {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0];
  if (!exif.every((v, i) => b[start + i] === v)) return undefined;
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const u16 = (at: number): number => (little ? (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) : u16be(b, at));
  const u32 = (at: number): number => (little ? (u16(at) | (u16(at + 2) << 16)) >>> 0 : u32be(b, at));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return undefined;
};

/** A JPEG's size and EXIF orientation from its segments, up to the first
 *  start-of-frame (the walk of `image-pixel-width.ts`, which reads only the
 *  width). */
export const jpegHeader = (b: Uint8Array): JpegHeader | undefined => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let orientation: number | undefined;
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (marker === 0xe1 && orientation === undefined)
      orientation = exifOrientationOf(b, at + 4, Math.min(b.length, at + 2 + length));
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 8 >= b.length) return undefined;
      // Height 0 is legal: ITU T.81 defers it to a DNL marker after the
      // first scan. The width is still declared and G2 needs it; a reader
      // that needs the height guards `height > 0` itself (recensement
      // 28/09, constat 5 — the unified walk demanded it and lost widths
      // the old width-only walker returned).
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      return width > 0 ? { width, height, ...(orientation === undefined ? {} : { orientation }) } : undefined;
    }
    if (marker === 0xda || length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
};
