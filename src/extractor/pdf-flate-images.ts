/** The pictures of a Flate or uncoded image XObject, decoded here as pdf.js drew them (the product has no pdf.js now)
 *  (`pdf-images.ts` takes the object: width, height, kind, data): RGBA, 32 bits, when the picture carries a soft mask
 *  (`/SMask`), and RGB, 24 bits, when it carries none.
 *  Decided here, for an 8-bit image with no `/Decode`: a DeviceRGB, DeviceGray, ICCBased (N = 3 or 1) or Indexed
 *  picture. The colours are the samples themselves (a grey picture repeated in three channels, a palette looked up);
 *  the alpha, when there is a mask, is the mask's (`alphaOf`), not premultiplied, as pdf.js wrote it.
 *  🔴 THE MASKLESS PICTURES CAME BACK ON 03/11/2026. Taking pdf.js out (01/11/2026) left them undecoded, hence
 *  "unreadable", hence absent from the page: measured 44 pictures on the 57 fixtures and 146 over 90 documents of the
 *  corpus, and EVERY refusal of this reader was that one cause. A picture with a mask was never the common case.
 *  LIMIT, written: a picture whose `/SMask` is a stream we do not read (`maskSupported`) stays unreadable, rather than
 *  being published opaque — its transparency is part of what it shows. Measured: zero such picture on the fixtures and
 *  on the 90 documents.
 *  Measured against pdf.js on the corpus, before its removal: see `pdf-flate-images.test.ts`.
 *  NOT here: the placement, the mask itself (`pdf-smask.ts`).
 *  Called by: `extractor/pdf-source.ts` (ahead of the other image decoders). */

import { singleFilterOf } from "./pdf-objects/document";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfStream } from "./pdf-objects/objects";
import type { PictureScope } from "./pdf-image-pixels";
import type { DecodedImageObject } from "./pdf-ccitt-images";
import { alphaOf, maskSupported } from "./pdf-smask";
import {
  objectRefOf,
  componentsOfSpace,
  entryOf,
  indexedOf,
  nameOf,
  numberOf,
  pictureSizeOk,
  unpackSamples,
} from "./pdf-image-pixels";

type Palette = NonNullable<ReturnType<typeof indexedOf>>;

/** The image dictionary's entries this module reads, once checked: the unpacked-sample layout of a masked Flate picture. */
interface FlateLayout {
  readonly width: number;
  readonly height: number;
  readonly bpc: number;
  readonly components: number;
  readonly palette: Palette | undefined;
}

/** Whether the dictionary is one this module decodes: Flate or uncoded, no stencil, no `/Decode`, no predictor, 1/2/4/8 bits. */
function flateDictSupported(doc: PdfObjectsDocument, dict: PdfDict): boolean {
  if (nameOf(doc.resolve(dict.get("Subtype"))) !== "Image") return false;
  // Flate-coded, or not coded at all (the samples as they are): the two a picture can carry here.
  const filter = singleFilterOf(doc, dict);
  if (filter !== "FlateDecode" && filter !== undefined) return false;
  // `/ImageMask`, `/Mask` and `/Decode` are read by their value, not their presence (`entryOf`): `/ImageMask false` is
  // legal, and a `/Mask` that points at a free object is no mask.
  const imageMask = entryOf(doc, dict, "ImageMask");
  if (
    entryOf(doc, dict, "Mask") !== undefined ||
    entryOf(doc, dict, "Decode") !== undefined ||
    (imageMask?.kind === "bool" && imageMask.value)
  )
    return false;
  const bpc = numberOf(doc.resolve(dict.get("BitsPerComponent")));
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8) return false;
  const parms = doc.dictOf(doc.resolve(dict.get("DecodeParms")));
  return parms === undefined || !parms.has("Predictor");
}

/** The size, depth and colour layout of the picture, or `undefined` when it is not one we read. */
function flateLayoutOf(doc: PdfObjectsDocument, dict: PdfDict): FlateLayout | undefined {
  const bpc = numberOf(doc.resolve(dict.get("BitsPerComponent")));
  const width = numberOf(doc.resolve(dict.get("Width")));
  const height = numberOf(doc.resolve(dict.get("Height")));
  if (bpc === undefined || width === undefined || height === undefined || !pictureSizeOk(width, height))
    return undefined;
  const space = doc.resolve(dict.get("ColorSpace"));
  // An indexed picture: one index per pixel, looked up in the palette (its highest index clamps, as pdf.js's `IndexedCS`).
  const palette = indexedOf(doc, space);
  const components = palette !== undefined ? 1 : componentsOfSpace(doc, space);
  if (components !== 1 && components !== 3) return undefined;
  return { width, height, bpc, components, palette };
}

/** The samples themselves in the three channels: three per pixel for a colour picture, the same one three times for a
 *  grey one. The two strides are computed ONCE, outside the pixels.
 *  🔴 A SAMPLE OF FEWER THAN 8 BITS IS SCALED TO 8 (code review of 03/11/2026, constat 1). `unpackSamples` returns the
 *  sample's VALUE, not a byte: a 1-bit grey picture gives 0 or 1, and writing that straight into the channels published
 *  a BLACK rectangle — wrong and invisible, the bias this project refuses. The maskless lot of the same day is what
 *  made those pictures reachable at all (they were refused before, so the defect could not show). `pdf-smask.ts`
 *  already scaled its own samples this way: the two readers of the same thing now agree.
 *  The palette branch does NOT scale, and must not: an index is an index, never a colour. */
function writeSampleColours(
  samples: Uint8Array,
  layout: FlateLayout,
  pixels: number,
  into: { data: Uint8Array; channels: number },
): void {
  const { data, channels } = into;
  const { components, bpc } = layout;
  const stride = components === 3 ? 3 : 1;
  // The scale is a table built once, so that the innermost loop neither divides nor rounds.
  const full = (1 << bpc) - 1;
  const scale = new Uint8Array(full + 1);
  for (let v = 0; v <= full; v += 1) scale[v] = bpc === 8 ? v : Math.round((v * 255) / full);
  // Two loops on purpose: a grey sample is read and scaled once, then written three times.
  if (components === 3) {
    for (let i = 0; i < pixels; i += 1) {
      const at = i * stride;
      for (let c = 0; c < 3; c += 1) data[i * channels + c] = scale[samples[at + c]!]!;
    }
    return;
  }
  for (let i = 0; i < pixels; i += 1) {
    const grey = scale[samples[i]!]!;
    const out = i * channels;
    data[out] = grey;
    data[out + 1] = grey;
    data[out + 2] = grey;
  }
}

/** The palette entry of each index in the three channels (its highest index clamps, as pdf.js's `IndexedCS`): the three
 *  components of the entry for a colour palette, its single one three times for a grey palette. */
function writePaletteColours(
  samples: Uint8Array,
  palette: Palette,
  pixels: number,
  into: { data: Uint8Array; channels: number },
): void {
  const { data, channels } = into;
  const step = palette.base === 3 ? 1 : 0;
  for (let i = 0; i < pixels; i += 1) {
    const entry = Math.min(samples[i]!, palette.hival) * palette.base;
    for (let c = 0; c < 3; c += 1) data[i * channels + c] = palette.lookup[entry + c * step]!;
  }
}

/** The pixels: the colours in three channels, plus the mask's alpha in a fourth when the picture has a mask. Three
 *  channels when it has none — the image reader then takes it as RGB, 24 bits. */
function pixelsOf(samples: Uint8Array, alpha: Uint8Array | undefined, layout: FlateLayout): Uint8Array {
  const pixels = layout.width * layout.height;
  const channels = alpha === undefined ? 3 : 4;
  const into = { data: new Uint8Array(pixels * channels), channels };
  if (layout.palette === undefined) writeSampleColours(samples, layout, pixels, into);
  else writePaletteColours(samples, layout.palette, pixels, into);
  if (alpha !== undefined) for (let i = 0; i < pixels; i += 1) into.data[i * channels + 3] = alpha[i]!;
  return into.data;
}

/** The decoded samples, one byte each (a picture of fewer bits is unpacked), or `undefined` on a refusal of the reader. */
function samplesOf(doc: PdfObjectsDocument, stream: PdfStream, layout: FlateLayout): Uint8Array | undefined {
  let samples: Uint8Array;
  try {
    samples = doc.streamBytes(stream);
  } catch {
    return undefined;
  }
  return unpackSamples(samples, layout.width, layout.height, layout.components, layout.bpc);
}

/** What the picture's `/SMask` gives: an `alpha` for a mask we read, an `alpha` of `undefined` for a picture that has no
 *  mask at all (an opaque one), and `undefined` for a mask we do NOT read — a refusal, because publishing such a picture
 *  opaque would show what the mask hides. */
function maskOf(
  doc: PdfObjectsDocument,
  dict: PdfDict,
  size: { width: number; height: number },
): { alpha: Uint8Array | undefined } | undefined {
  const smask = doc.resolve(dict.get("SMask"));
  // An absent `/SMask`, or one that is not a stream (`/SMask null` is written by real producers): an opaque picture.
  if (smask?.kind !== "stream") return { alpha: undefined };
  if (!maskSupported(doc, smask)) return undefined;
  const alpha = alphaOf(doc, smask, size.width, size.height);
  return alpha === undefined ? undefined : { alpha };
}

/** The Flate or uncoded picture `name` of the page, as the object the image reader takes: RGBA with its soft mask, RGB
 *  without one. `undefined` when it is not decoded here (a mask we do not read, a picture we do not read, or a refusal
 *  of the reader). */
export function flateImageObjectOf(
  doc: PdfObjectsDocument,
  scope: PictureScope,
  name: string,
  kinds: { rgb: number; rgba: number },
): DecodedImageObject | undefined {
  const xobjects = doc.dictOf(scope.resources?.get("XObject"));
  const declared = xobjects?.get(name);
  const stream = doc.resolve(declared);
  if (stream?.kind !== "stream" || !flateDictSupported(doc, stream.dict)) return undefined;
  const layout = flateLayoutOf(doc, stream.dict);
  if (layout === undefined) return undefined;
  // The mask is read BEFORE the samples: a picture refused for its mask then costs no inflating at all.
  const mask = maskOf(doc, stream.dict, layout);
  if (mask === undefined) return undefined;
  const samples = samplesOf(doc, stream, layout);
  if (samples === undefined) return undefined;
  const data = pixelsOf(samples, mask.alpha, layout);
  return {
    ref: objectRefOf(declared),
    width: layout.width,
    height: layout.height,
    kind: mask.alpha === undefined ? kinds.rgb : kinds.rgba,
    data,
  };
}
