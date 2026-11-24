/** The pixels of a CCITT image XObject (ISO 32000-1:2008 §7.4.6 `CCITTFaxDecode`), decoded by OUR decoder
 *  (`codecs/ccitt-fax.ts`), in the object shape the image reader takes (`pdf-images.ts`): width, height, kind, data.
 *  Decides: that an image is decoded here only when its filter is exactly `CCITTFaxDecode`, not an image mask, and its
 *  parameters are readable; that the rows are repacked to `ceil(width / 8)` bytes (the picture's own layout); that a
 *  `/Decode [1 0]` inverts the samples (§8.9.5.2). Anything else returns `undefined`: the image is not decoded here.
 *  NOT here: where the image is placed (`pdf-source.ts`), the decoder's bits (`codecs/ccitt-fax.ts`), the PNG (`png.ts`).
 *  Called by: `extractor/pdf-source.ts` (ahead of the other image decoders), `pdf-ccitt-images.test.ts`. */

import { decodeCcittFax } from "./codecs/ccitt-fax";
import { singleFilterOf, type PdfObjectsDocument } from "./pdf-objects/document";
import { objectRefOf, pictureSizeOk, type PictureScope } from "./pdf-image-pixels";
import type { PdfValue } from "./pdf-objects/objects";
import { partOrAbsent } from "./pdf-objects/refusal";

/** The object the image reader reads: `kind` is the value of the former pdf.js `ImageKind.GRAYSCALE_1BPP`, kept as the image reader's code. */
export interface DecodedImageObject {
  /** The object reference of the image (`<num>R` or `<num>R<gen>`): a block picture is read by it (`imageRef`). */
  readonly ref: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly kind: number;
  readonly data: Uint8Array;
  /** 🔴 THE BYTES THIS OBJECT RETAINS, when its `data` is LAZY and the kind alone would lie (`pdf-jpeg-images.ts`:
   *  compressed bytes before any decode, plus the pixels once decoded). The document cache charges this when it is
   *  given (`pdf-source.ts#cachedPictureBytes`); a reader whose `data` is already materialised leaves it out and is
   *  charged by its kind. */
  readonly heldBytes?: number;
}

const numberOf = (value: PdfValue | undefined): number | undefined =>
  value?.kind === "number" ? value.value : undefined;
const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** A boolean entry of a dictionary: true only for a literal `true`. */
function boolOf(value: PdfValue | undefined): boolean {
  return value?.kind === "bool" && value.value;
}

/** The image stream `name` of the page, when it is one we decode: an image (not a mask), filtered by CCITTFaxDecode only. */
function ccittStreamOf(doc: PdfObjectsDocument, declared: PdfValue | undefined) {
  const stream = doc.resolve(declared);
  if (stream?.kind !== "stream") return undefined;
  const dict = stream.dict;
  if (nameOf(doc.resolve(dict.get("Subtype"))) !== "Image") return undefined;
  if (boolOf(doc.resolve(dict.get("ImageMask")))) return undefined;
  if (singleFilterOf(doc, dict) !== "CCITTFaxDecode") return undefined;
  return stream;
}

/** The image's rows repacked to `width` pixels, whatever the decoder's own layout, with `/Decode [1 0]` applied. */
function repack(
  image: { readonly rows: number; readonly pitch: number; readonly bits: Uint8Array },
  width: number,
  height: number,
  invert: boolean,
): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y < image.rows ? y : image.rows - 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const bit = image.bits[sourceRow * image.pitch + x] ?? 0xff;
      data[y * rowBytes + x] = invert ? ~bit & 0xff : bit;
    }
  }
  return data;
}

/** The CCITT image `name` of the page, as an object the image reader takes, or `undefined` when it is not one we decode. */
export function ccittImageObjectOf(
  doc: PdfObjectsDocument,
  scope: PictureScope,
  name: string,
  grey1Kind: number,
): DecodedImageObject | undefined {
  const declared = doc.dictOf(scope.resources?.get("XObject"))?.get(name);
  const stream = ccittStreamOf(doc, declared);
  if (stream === undefined) return undefined;
  const dict = stream.dict;

  const width = numberOf(doc.resolve(dict.get("Width")));
  const height = numberOf(doc.resolve(dict.get("Height")));
  // The buffers of `repack` are sized from these two numbers, so they are bounded BEFORE anything is read (security review of 02/11/2026).
  if (width === undefined || height === undefined || !pictureSizeOk(width, height)) return undefined;
  const parms = doc.dictOf(doc.resolve(dict.get("DecodeParms")));
  const parm = (key: string): PdfValue | undefined => doc.resolve(parms?.get(key));

  // Decrypted when the file is encrypted (§7.6.2), NOT decoded: a CCITT stream is pixels, and `streamBytes` refuses to
  // decode it (`streams.ts`). Until 24/11/2026 this path read the file's bytes, so an encrypted CCITT picture was lost.
  // A refusal of ours (a holder we cannot name) leaves the image unread here (decision of 24/11/2026).
  const raw = partOrAbsent(() => doc.rawStreamBytes(stream));
  if (raw === undefined) return undefined;
  // §7.4.6 Table 11: a missing K is 0 (Group 3, one-dimensional).
  const image = decodeCcittFax(raw, {
    K: numberOf(parm("K")) ?? 0,
    EndOfLine: boolOf(parm("EndOfLine")),
    EncodedByteAlign: boolOf(parm("EncodedByteAlign")),
    BlackIs1: boolOf(parm("BlackIs1")),
    columns: numberOf(parm("Columns")) ?? 1728,
    rows: numberOf(parm("Rows")) ?? height,
  });
  if (image === undefined) return undefined;

  const data = repack(image, width, height, isInverted(doc, dict));
  return { ref: objectRefOf(declared), width, height, kind: grey1Kind, data };
}

/** `/Decode [1 0]`: the samples are inverted (§8.9.5.2). Any other array, or none, keeps them. */
function isInverted(doc: PdfObjectsDocument, dict: ReadonlyMap<string, PdfValue>): boolean {
  const decode = doc.resolve(dict.get("Decode"));
  if (decode?.kind !== "array" || decode.items.length !== 2) return false;
  return numberOf(doc.resolve(decode.items[0])) === 1 && numberOf(doc.resolve(decode.items[1])) === 0;
}
