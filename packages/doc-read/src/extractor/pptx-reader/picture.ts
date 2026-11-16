/** One picture (`p:pic`) as the slide declares it: the image file its
 *  `a:blip r:embed` names, cut to its visible part when `a:srcRect` crops it
 *  (PNG and JPEG only) or whole when the crop window lies entirely outside
 *  it, and its declared display width (`a:ext cx`). Or the reason it is not
 *  published: an external `r:link` (never fetched), a missing part, a video
 *  or a sound, a crop that cannot be applied.
 *  Its alternative text (`p:cNvPr descr`) is never read: a presentation's
 *  alt text is not published (25/09/2026).
 *  NOT here: the published width, capped by the file's own pixels and 744 px
 *  (`renderer/storage.ts#publishedImageWidthPx`), the group scale
 *  (`chOff`/`chExt`, applied in `pptx-reader/shapes.ts`), decoding a PNG
 *  (`extractor/png-decode.ts`) or encoding one (`extractor/png.ts`).
 *  Called by: `pptx-reader/shapes.ts`. */

import { encodeJpegRgba } from "../jpeg/encode";

import type { Relationship } from "../ooxml/package";
import { attributeOf, findChild, childNodesOf, qualifiedNameOf, type XNode } from "../ooxml/xml";
import { sniffImage } from "doc-ir/extractor/image-format";
import { imagePixelWidth, jpegHeader } from "doc-ir/extractor/image-pixel-width";
import { decodeJpegGuarded, isTurnedByExif, MAX_DECODED_MP } from "../image-reduction";
import { EMU_PER_PT } from "./geometry";
import { encodePngDeflate } from "doc-ir/extractor/png";
import { decodePng } from "doc-ir/extractor/png-decode";

/** The media parts of one slide, by relationship id, loaded before the
 *  (synchronous) shape walk. `"damaged"`: the part exists but its bytes
 *  cannot be read (corrupt stream) — the picture degrades to its marker
 *  instead of refusing the deck (arbitrage of 28/09/2026). */
export type PptxMedia = ReadonlyMap<string, { bytes: Uint8Array; contentType: string } | "damaged">;

interface PptxImage {
  /** The file to publish: the part's bytes untouched, or its visible part
   *  re-encoded when the picture is cropped. */
  bytes: Uint8Array;
  contentType: string;
  /** The published file's own width in pixels, when its header says (PNG,
   *  JPEG, GIF): the page never draws it wider. */
  pixelWidth?: number;
}

/** Why a picture is not published. The marker's wording is composed when the
 *  slide is mapped to the IR (`extractor/pptx.ts`), not here. */
export type PptxPictureNotPublished =
  /** `r:link`: a file outside the package, never fetched. */
  | "external-link"
  /** No `a:blip`, or its `r:embed` names no part of the package. */
  | "missing-part"
  /** The part is in the package but its bytes cannot be read (corrupt
   *  stream) — not "missing": the file does carry it. */
  | "damaged-part"
  /** A video or a sound: the picture is only its poster frame. */
  | "video-or-audio"
  /** A crop that cannot be applied: a format other than PNG and JPEG, a
   *  PNG or JPEG this code does not decode (or refuses by size), a window
   *  partly outside the image, an inset unreadable or leaving nothing.
   *  Never published uncropped: the hidden part would show. (A window
   *  ENTIRELY outside the image is published whole: `windowOutsideImage`.) */
  | "cropped-unsupported";

export type PptxPictureContent = { image: PptxImage } | { notPublished: PptxPictureNotPublished };

/** `a:srcRect` insets are thousandths of a percent: 100 000 is the whole side. */
const WHOLE = 100_000;

// The decode guards (largest image decoded for a crop, the JPEG decoder's memory
// guard) are ONE definition shared with the reducer, imported above —
// the bounds register flushed out the two copies (28/09/2026).

/** Quality of a cropped JPEG, re-encoded once. 90: the source quality is not
 *  known, and at 90 a second generation adds no artefact visible at page
 *  size, while 95 to 100 roughly double the file for nothing a reader sees.
 *  A PNG would weigh several times more for a photograph
 *  (MIKSUDOC « Spécification fonctionnelle » §9.3.6). */
const JPEG_QUALITY = 90;

/** The `a:videoFile`… elements of `p:nvPr` that make a `p:pic` a video or a sound. */
const MEDIA_TAGS = new Set(["a:videoFile", "a:audioFile", "a:quickTimeFile", "a:wavAudioFile", "a:audioCd"]);

interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** An ST_Percentage: an integer in thousandths of a percent, or (Strict) a
 *  number followed by "%". Absent is 0. `undefined` when unreadable. */
const percentage = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return 0;
  const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : undefined;
};

/** The insets of `a:srcRect`, `null` when there is no crop (no element, or
 *  every inset 0 — Google's exports write it on every picture), `undefined`
 *  when an inset is unreadable. */
const insetsOf = (srcRect: XNode | undefined): Insets | null | undefined => {
  if (!srcRect) return null;
  const [l, t, r, b] = ["l", "t", "r", "b"].map((k) => percentage(attributeOf(srcRect, k)));
  if (l === undefined || t === undefined || r === undefined || b === undefined) return undefined;
  return l === 0 && t === 0 && r === 0 && b === 0 ? null : { l, t, r, b };
};

/** True when the insets' window is non-empty and shares no area with the
 *  image: on one axis it lies wholly beyond one edge (merely touching it
 *  counts as outside). Horizontally the window runs from `l` to
 *  `WHOLE - r`; it misses the image when `l >= WHOLE` or `r >= WHOLE`
 *  (same with `t`, `b`). An empty or inverted window (`l + r >= WHOLE`) is
 *  not "outside": it keeps the marker.
 *  Such a picture is published WHOLE, bytes untouched: PowerPoint shows the
 *  whole image there, nothing is hidden from the author. Observed
 *  on 25/09/2026 on the USA deck's image7.png "headset" icons (slides 9 and
 *  10, Google exports, `t="-184570" b="184570" l="22220" r="-22220"`). A
 *  window only partly outside keeps the marker: no specimen shows what
 *  PowerPoint draws there. */
const windowOutsideImage = (i: Insets): boolean =>
  i.l + i.r < WHOLE && i.t + i.b < WHOLE && (i.l >= WHOLE || i.r >= WHOLE || i.t >= WHOLE || i.b >= WHOLE);

/** The pixel rectangle the insets leave visible, or `undefined` when an
 *  inset is negative (the frame reaches beyond the image) or nothing is left. */
const visibleRect = (width: number, height: number, insets: Insets): { x: number; y: number; w: number; h: number } | undefined => {
  if (insets.l < 0 || insets.t < 0 || insets.r < 0 || insets.b < 0) return undefined;
  const x = Math.round((width * insets.l) / WHOLE);
  const y = Math.round((height * insets.t) / WHOLE);
  const w = width - Math.round((width * insets.r) / WHOLE) - x;
  const h = height - Math.round((height * insets.b) / WHOLE) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
};

/** The rows `rect` covers, `channels` bytes per pixel. */
const cut = (pixels: Uint8Array, width: number, channels: number, rect: { x: number; y: number; w: number; h: number }): Uint8Array => {
  const out = new Uint8Array(rect.w * rect.h * channels);
  for (let row = 0; row < rect.h; row++) {
    const from = ((rect.y + row) * width + rect.x) * channels;
    out.set(pixels.subarray(from, from + rect.w * channels), row * rect.w * channels);
  }
  return out;
};

/** The visible part of a cropped PNG or JPEG, re-encoded in its own format;
 *  `undefined` when it cannot be cut exactly. The format is read in the
 *  bytes, never in the content type. */
const crop = (bytes: Uint8Array, insets: Insets): PptxImage | undefined => {
  const format = sniffImage(bytes);
  if (format === "png") {
    const png = decodePng(bytes, MAX_DECODED_MP * 1_000_000);
    const rect = png && visibleRect(png.width, png.height, insets);
    if (!png || !rect) return undefined;
    const out = encodePngDeflate(rect.w, rect.h, png.channels, cut(png.pixels, png.width, png.channels, rect));
    return out && { bytes: out, contentType: "image/png", pixelWidth: rect.w };
  }
  if (format === "jpeg") {
    const jpeg = decodeJpegGuarded(bytes);
    if (!jpeg) return undefined;
    const rect = visibleRect(jpeg.width, jpeg.height, insets);
    if (!rect) return undefined;
    const out = encodeJpegRgba({ width: rect.w, height: rect.h, data: cut(jpeg.data, jpeg.width, 4, rect) }, JPEG_QUALITY);
    return { bytes: out, contentType: "image/jpeg", pixelWidth: rect.w };
  }
  return undefined;
};

/** The declared display width, in points: `p:spPr/a:xfrm/a:ext cx`. Inside
 *  a group it is in the group's own coordinates: the caller scales it. */
export const pictureWidthPt = (pic: XNode): number | undefined => {
  const ext = findChild(findChild(findChild(pic, "p:spPr") ?? {}, "a:xfrm") ?? {}, "a:ext");
  const cx = Number(attributeOf(ext ?? {}, "cx"));
  return ext && Number.isFinite(cx) && cx > 0 ? cx / EMU_PER_PT : undefined;
};

export const readPicture = (pic: XNode, rels: ReadonlyMap<string, Relationship>, media: PptxMedia): PptxPictureContent => {
  const nvPr = findChild(findChild(pic, "p:nvPicPr") ?? {}, "p:nvPr");
  if (nvPr && childNodesOf(nvPr).some((k) => MEDIA_TAGS.has(qualifiedNameOf(k) ?? ""))) return { notPublished: "video-or-audio" };
  const blipFill = findChild(pic, "p:blipFill");
  const blip = findChild(blipFill ?? {}, "a:blip");
  const embed = attributeOf(blip ?? {}, "r:embed");
  const rel = embed === undefined ? undefined : rels.get(embed);
  if (rel?.external || (embed === undefined && attributeOf(blip ?? {}, "r:link") !== undefined)) return { notPublished: "external-link" };
  const part = embed === undefined ? undefined : media.get(embed);
  if (!part) return { notPublished: "missing-part" };
  if (part === "damaged") return { notPublished: "damaged-part" };

  const insets = insetsOf(findChild(blipFill ?? {}, "a:srcRect"));
  // A JPEG that its EXIF turns (orientation other than 1) is published whole, not cropped:
  // re-encoding drops the EXIF orientation. Same policy as image-reduction.ts (audit 07/10).
  const turned = insets !== undefined && insets !== null && isTurnedByExif(jpegHeader(part.bytes)?.orientation);
  if (insets === null || turned || (insets !== undefined && windowOutsideImage(insets))) {
    const pixelWidth = imagePixelWidth(part.bytes);
    return { image: { bytes: part.bytes, contentType: part.contentType, ...(pixelWidth === undefined ? {} : { pixelWidth }) } };
  }
  const image = insets === undefined ? undefined : crop(part.bytes, insets);
  return image ? { image } : { notPublished: "cropped-unsupported" };
};
