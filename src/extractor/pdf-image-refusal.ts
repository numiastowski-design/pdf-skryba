/** WHY a picture of a PDF page could not be read, in eight words we own — the field `why` of each place a
 *  `pdf-image-unread` notice names (`lib/reader-types.ts`). 03/11/2026: naming WHERE was not enough, the
 *  dashboard said « 1 image illisible » and the cause took a throwaway probe to find.
 *  🔴 WHAT THIS MODULE IS, AND WHAT IT IS NOT. The cause is READ FROM THE PICTURE'S DICTIONARY, with the very
 *  predicates the decoders decide on (`imageFilterOf`, `chainRefusal`, `pictureSizeOk`, `maskSupported`,
 *  `componentsOfSpace`, `decodeArrayOf`) — it is NOT a message a decoder hands back. Two consequences, both written:
 *  a cause cannot drift from the decoders as long as it calls their predicates (and a test holds `chainRefusal`
 *  against `decodeToImageFilter`), but a picture whose every DECLARATION is one we handle and which failed all the
 *  same — a truncated stream, a zlib error, a budget spent — is `bytes`, the honest residue. `bytes` means « look,
 *  the shape is one we read »; it never means « we do not know what this is ».
 *  NOT here: the counting and the notice (`extractor/pdf.ts`), where the places come from
 *  (`extractor/pdf-page-figures.ts`, `extractor/pdf-table-detector.ts`), the words shown to a human
 *  (`static/dashboard/src/UnpublishedPartsDialog.tsx`).
 *  Called by: `extractor/pdf-source.ts` (`imageRefusal`, beside `imageFailure`). */

import type { PictureRefusal } from "doc-ir";
import { chainRefusal } from "./pdf-objects/streams";
import { imageFilterOf, type PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict } from "./pdf-objects/objects";
import { componentsOfSpace, decodeArrayOf, entryOf, indexedOf, numberOf, pictureSizeOk } from "./pdf-image-pixels";
import { maskSupported } from "./pdf-smask";

/** The codecs whose pixels we never decode: the written limit of 05/10/2026 (pdf.js's decoders were set aside for the
 *  memory they wanted, and nothing replaced them). `CCITTFaxDecode` is NOT one of them — we decode it ourselves. */
const UNDECODED_CODECS: ReadonlySet<string> = new Set(["JPXDecode", "JBIG2Decode"]);

/** Whether the picture's colour, depth and `/Decode` are ones a decoder of ours reads. */
function shapeSupported(doc: PdfObjectsDocument, dict: PdfDict): boolean {
  const bpc = numberOf(doc.resolve(dict.get("BitsPerComponent")));
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8) return false;
  const space = doc.resolve(dict.get("ColorSpace"));
  const components = indexedOf(doc, space) !== undefined ? 1 : componentsOfSpace(doc, space);
  if (components !== 1 && components !== 3) return false;
  return decodeArrayOf(doc, dict, components) !== null;
}

/** Why this picture is not read, from what it declares. The order is from the most specific to the most general, so
 *  that a JPX picture that is ALSO too large is named by its codec: that is the fact that decides it. */
export function pictureRefusalOf(doc: PdfObjectsDocument, dict: PdfDict): PictureRefusal {
  const filter = imageFilterOf(doc, dict);
  if (filter !== undefined && UNDECODED_CODECS.has(filter)) return "codec";
  if (chainRefusal(dict) !== undefined) return "filters";
  const width = numberOf(doc.resolve(dict.get("Width")));
  const height = numberOf(doc.resolve(dict.get("Height")));
  // A size that is MISSING is not a size that is too big: it is a declaration we cannot read, which is `shape`.
  if (width === undefined || height === undefined) return "shape";
  if (!pictureSizeOk(width, height)) return "too-large";
  // `/ImageMask` by its value: `/ImageMask false` is legal, and reading it by presence named "mask" for an image
  // really refused for its colour or depth. `/Mask` likewise: a `/Mask 12 0 R` whose object is free masks nothing
  // (`entryOf`).
  const imageMask = entryOf(doc, dict, "ImageMask");
  if (entryOf(doc, dict, "Mask") !== undefined || (imageMask?.kind === "bool" && imageMask.value)) return "mask";
  const smask = entryOf(doc, dict, "SMask");
  if (smask?.kind === "stream" && !maskSupported(doc, smask)) return "mask";
  if (!shapeSupported(doc, dict)) return "shape";
  return "bytes";
}
