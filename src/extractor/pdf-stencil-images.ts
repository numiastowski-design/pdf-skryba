/** A STENCIL MASK (`/ImageMask true`, ISO 32000-1:2008 §8.9.6.2) as the object the image reader takes: a one-bit
 *  picture that is not a colour picture at all — it says, for each pixel, « paint the current fill colour here » or
 *  « leave the page showing ». A monochrome logo, a stamp, a rule. Decoded here as RGBA, 32 bits: the fill colour
 *  where it paints, fully transparent elsewhere.
 *  Decided here: a sample of 0 paints and a 1 does not (`/Decode [0 1]`, the default); `/Decode [1 0]` swaps them
 *  (§8.9.5.2). Rows are padded to the byte, which `unpackSamples` undoes. The colour comes from the PAGE's graphics
 *  state at the moment of the painting, read by the boundary (`pdf-source.ts`), because a stencil has no colour of its
 *  own — the same stencil painted twice in two colours is two different pictures.
 *  🔴 WHY IT EXISTS (03/11/2026). Until that day a stencil left the page in SILENCE: no decoder read one, and
 *  no path even looked at `paintImageMaskXObject`, so the stamp was neither published nor counted. pdf.js did not
 *  publish them either — it named the operator, which is how we know the case exists, but our box recording never took
 *  it (verified in the history: the condition has excluded it since the first day). MEASURED FIRST: ZERO stencil over
 *  the 57 fixtures and the 251 documents of the corpus, which is a population of zero and is written as such; our
 *  corpus leans towards documents exported from Office, which do not emit stencils, so the rate elsewhere is unknown.
 *  LIMIT, written: a stencil coded with `CCITTFaxDecode` is NOT read here (its decoder refuses an image mask), and a
 *  depth other than one bit is not a stencil at all. Both keep the cause `mask` at the counter, which says to look.
 *  NOT here: where the colour comes from (`pdf-source.ts`), the PNG (`png.ts`), the placement (`pdf-page-figures.ts`).
 *  Called by: `extractor/pdf-source.ts` (with the other image decoders). */

import { singleFilterOf } from "./pdf-objects/document";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfStream } from "./pdf-objects/objects";
import type { DecodedImageObject } from "./pdf-ccitt-images";
import {
  objectRefOf,
  decodeArrayOf,
  nameOf,
  numberOf,
  pictureSizeOk,
  type PictureScope,
  unpackSamples,
} from "./pdf-image-pixels";

/** The three bytes of a `#rrggbb` colour, or `undefined` for anything else. A stencil without a colour we can read is
 *  not guessed: black would be a colour the document never asked for. */
function rgbOfHex(colour: string | undefined): readonly [number, number, number] | undefined {
  if (colour === undefined || !/^#[0-9a-f]{6}$/i.test(colour)) return undefined;
  return [
    Number.parseInt(colour.slice(1, 3), 16),
    Number.parseInt(colour.slice(3, 5), 16),
    Number.parseInt(colour.slice(5, 7), 16),
  ];
}

/** Whether the dictionary is a stencil this module reads: an image mask of one bit, Flate-coded or uncoded. */
function stencilSupported(doc: PdfObjectsDocument, dict: PdfDict): boolean {
  if (nameOf(doc.resolve(dict.get("Subtype"))) !== "Image") return false;
  // By its value: `/ImageMask false` is no stencil. An ordinary image reaching this module would otherwise be painted
  // as a stencil, in one colour.
  const imageMask = doc.resolve(dict.get("ImageMask"));
  if (imageMask?.kind !== "bool" || !imageMask.value) return false;
  const bpc = numberOf(doc.resolve(dict.get("BitsPerComponent")));
  if (bpc !== undefined && bpc !== 1) return false;
  const filter = singleFilterOf(doc, dict);
  return filter === undefined || filter === "FlateDecode";
}

/** The RGBA pixels: the colour where the stencil paints, fully transparent where it does not. */
function pixelsOf(
  samples: Uint8Array,
  rgb: readonly [number, number, number],
  paintsOn: number,
  pixels: number,
): Uint8Array {
  const data = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    if (samples[i] !== paintsOn) continue;
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** The size and the sample that PAINTS, or `undefined` when the stencil is not one we read. §8.9.5.2: the default
 *  `/Decode` of an image mask is [0 1], so a sample of 0 paints; [1 0] swaps them. */
function stencilLayoutOf(
  doc: PdfObjectsDocument,
  dict: PdfDict,
): { width: number; height: number; paintsOn: number } | undefined {
  if (!stencilSupported(doc, dict)) return undefined;
  const width = numberOf(doc.resolve(dict.get("Width")));
  const height = numberOf(doc.resolve(dict.get("Height")));
  if (width === undefined || height === undefined || !pictureSizeOk(width, height)) return undefined;
  const decodes = decodeArrayOf(doc, dict, 1);
  if (decodes === null) return undefined;
  return { width, height, paintsOn: decodes?.[0]?.[0] === 1 ? 1 : 0 };
}

/** The stencil's samples, one byte each (one bit unpacked), or `undefined` on a refusal of the reader. */
function samplesOf(doc: PdfObjectsDocument, stream: PdfStream, width: number, height: number): Uint8Array | undefined {
  try {
    return unpackSamples(doc.streamBytes(stream), width, height, 1, 1);
  } catch {
    return undefined;
  }
}

/** The stencil `name` of the page, painted in `colour`, as the object the image reader takes (RGBA), or `undefined`
 *  when it is not one we read. */
export function stencilImageObjectOf(
  doc: PdfObjectsDocument,
  scope: PictureScope,
  name: string,
  kinds: { rgba: number },
  colour: string | undefined,
): DecodedImageObject | undefined {
  const rgb = rgbOfHex(colour);
  if (rgb === undefined) return undefined;
  const declared = doc.dictOf(scope.resources?.get("XObject"))?.get(name);
  const stream = doc.resolve(declared);
  if (stream?.kind !== "stream") return undefined;
  const layout = stencilLayoutOf(doc, stream.dict);
  if (layout === undefined) return undefined;
  const samples = samplesOf(doc, stream, layout.width, layout.height);
  if (samples === undefined) return undefined;
  const data = pixelsOf(samples, rgb, layout.paintsOn, layout.width * layout.height);
  return { ref: objectRefOf(declared), width: layout.width, height: layout.height, kind: kinds.rgba, data };
}
