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

/** A media part whose bytes were read: what `PptxMedia` holds when not "damaged". */
interface MediaPart {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

interface PptxImage {
  /** The file to publish: the part's bytes untouched, or its visible part
   *  re-encoded when the picture is cropped. */
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The published file's own width in pixels, when its header says (PNG,
   *  JPEG, GIF): the page never draws it wider. */
  readonly pixelWidth?: number;
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
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** An ST_Percentage: an integer in thousandths of a percent, or (Strict) a
 *  number followed by "%". Absent is 0. `undefined` when unreadable. */
const percentage = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return 0;
  const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
  return raw.trim() !== "" && Number.isFinite(value) ? value : undefined;
};

/** The insets of `a:srcRect`, `null` when there is no crop (no element, or
 *  every inset 0 — Google's exports write it on every picture), `undefined`
 *  when an inset is unreadable. */
const insetsOf = (srcRect: XNode | undefined): Insets | null | undefined => {
  if (!srcRect) return null;
  const [l, t, r, b] = ["l", "t", "r", "b"].map((attributeName) => percentage(attributeOf(srcRect, attributeName)));
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
const windowOutsideImage = (insets: Insets): boolean =>
  insets.l + insets.r < WHOLE &&
  insets.t + insets.b < WHOLE &&
  (insets.l >= WHOLE || insets.r >= WHOLE || insets.t >= WHOLE || insets.b >= WHOLE);

/** The pixel rectangle the insets leave visible, or `undefined` when an
 *  inset is negative (the frame reaches beyond the image) or nothing is left. */
const visibleRect = (
  imageWidth: number,
  imageHeight: number,
  insets: Insets,
): { x: number; y: number; width: number; height: number } | undefined => {
  if (insets.l < 0 || insets.t < 0 || insets.r < 0 || insets.b < 0) return undefined;
  const x = Math.round((imageWidth * insets.l) / WHOLE);
  const y = Math.round((imageHeight * insets.t) / WHOLE);
  const width = imageWidth - Math.round((imageWidth * insets.r) / WHOLE) - x;
  const height = imageHeight - Math.round((imageHeight * insets.b) / WHOLE) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/** The rows `rect` covers, `channels` bytes per pixel. */
const cut = (
  pixels: Uint8Array,
  imageWidth: number,
  channels: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8Array => {
  const visiblePixels = new Uint8Array(rect.width * rect.height * channels);
  for (let row = 0; row < rect.height; row++) {
    const sourceOffset = ((rect.y + row) * imageWidth + rect.x) * channels;
    visiblePixels.set(pixels.subarray(sourceOffset, sourceOffset + rect.width * channels), row * rect.width * channels);
  }
  return visiblePixels;
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
    const encoded = encodePngDeflate(
      rect.width,
      rect.height,
      png.channels,
      cut(png.pixels, png.width, png.channels, rect),
    );
    return encoded && { bytes: encoded, contentType: "image/png", pixelWidth: rect.width };
  }
  if (format === "jpeg") {
    const jpeg = decodeJpegGuarded(bytes);
    if (!jpeg) return undefined;
    const rect = visibleRect(jpeg.width, jpeg.height, insets);
    if (!rect) return undefined;
    const encoded = encodeJpegRgba(
      { width: rect.width, height: rect.height, data: cut(jpeg.data, jpeg.width, 4, rect) },
      JPEG_QUALITY,
    );
    return { bytes: encoded, contentType: "image/jpeg", pixelWidth: rect.width };
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

/** The `p:nvPr` of the picture names a video or a sound file. */
const isVideoOrAudio = (pic: XNode): boolean => {
  const nvPr = findChild(findChild(pic, "p:nvPicPr") ?? {}, "p:nvPr");
  return nvPr !== undefined && childNodesOf(nvPr).some((childNode) => MEDIA_TAGS.has(qualifiedNameOf(childNode) ?? ""));
};

/** The media part an `a:blip r:embed` names, or why the picture is not published: an external
 *  `r:link`, no part, or a part whose bytes cannot be read. */
const embeddedPartOf = (
  blip: XNode | undefined,
  relationships: ReadonlyMap<string, Relationship>,
  media: PptxMedia,
): MediaPart | "external-link" | "missing-part" | "damaged-part" => {
  const embed = attributeOf(blip ?? {}, "r:embed");
  const relationship = embed === undefined ? undefined : relationships.get(embed);
  if (relationship?.external || (embed === undefined && attributeOf(blip ?? {}, "r:link") !== undefined))
    return "external-link";
  const part = embed === undefined ? undefined : media.get(embed);
  if (!part) return "missing-part";
  if (part === "damaged") return "damaged-part";
  return part;
};

/** The part published as it is, bytes untouched. */
const wholeImage = (part: MediaPart): PptxImage => {
  const pixelWidth = imagePixelWidth(part.bytes);
  return { bytes: part.bytes, contentType: part.contentType, ...(pixelWidth === undefined ? {} : { pixelWidth }) };
};

/** The image to publish for `a:srcRect` insets (`insetsOf`): whole when there is no crop, or cropped;
 *  `undefined` when the crop cannot be applied. */
const publishedImageOf = (part: MediaPart, insets: Insets | null | undefined): PptxImage | undefined => {
  if (insets === undefined) return undefined;
  if (insets === null) return wholeImage(part);
  // A JPEG that its EXIF turns (orientation other than 1) is published whole, not cropped:
  // re-encoding drops the EXIF orientation. Same policy as image-reduction.ts (audit 07/10).
  if (isTurnedByExif(jpegHeader(part.bytes)?.orientation) || windowOutsideImage(insets)) return wholeImage(part);
  return crop(part.bytes, insets);
};

export const readPicture = (
  pic: XNode,
  relationships: ReadonlyMap<string, Relationship>,
  media: PptxMedia,
): PptxPictureContent => {
  if (isVideoOrAudio(pic)) return { notPublished: "video-or-audio" };
  const blipFill = findChild(pic, "p:blipFill");
  const part = embeddedPartOf(findChild(blipFill ?? {}, "a:blip"), relationships, media);
  if (typeof part === "string") return { notPublished: part };
  const image = publishedImageOf(part, insetsOf(findChild(blipFill ?? {}, "a:srcRect")));
  return image ? { image } : { notPublished: "cropped-unsupported" };
};
