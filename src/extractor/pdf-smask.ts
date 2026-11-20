/** The soft mask (`/SMask`) of a picture, read the way pdf.js read it (history): its alpha at the picture's size.
 *  Decides: a mask is ours when it is an 8-bit grey Flate or DCT image, or a 1-bit grey CCITT image, each with a `/Decode`
 *  we read (`maskSupported`); its alpha is the mask sample at the nearest position, with no centring (measured on a
 *  40 × 30 mask under a 64 × 48 picture, all 3 072 pixels; `alphaOf`). A 1-bit CCITT mask is decoded by our port of
 *  PDFium's decoder, its `/Decode [1 0]` inverts it.
 *  NOT here: the picture (`pdf-jpeg-images.ts`, `pdf-flate-images.ts`), the pixel conversions (`pdf-image-pixels.ts`).
 *  Called by: `pdf-jpeg-images.ts`, `pdf-flate-images.ts`. */

import { decodeCcittFax } from "./codecs/ccitt-fax";
import { singleFilterOf } from "./pdf-objects/document";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfStream, PdfValue } from "./pdf-objects/objects";
import {
  componentsOfSpace,
  decodeArrayOf,
  decodeSample,
  jpegFrameOf,
  numberOf,
  pictureSizeOk,
  rgbOf,
  unpackSamples,
} from "./pdf-image-pixels";

/** The filters of §7.4 that are NOT pixels and that our stream reader undoes itself, so a mask coded with one of them
 *  reaches us as plain samples. Held by a test (`pdf-smask.test.ts`: a RunLength-coded mask), not by this list alone. */
const READER_FILTERS: ReadonlySet<string> = new Set([
  "FlateDecode",
  "LZWDecode",
  "RunLengthDecode",
  "ASCIIHexDecode",
  "ASCII85Decode",
]);

/** Whether a soft mask is one we decode: a ONE-COMPONENT grey image at 1, 2, 4 or 8 bits coded with a filter the stream
 *  reader undoes (or none), an 8-bit grey DCT image, or a 1-bit grey CCITT image — each with a `/Decode` we can read
 *  (`decodeArrayOf`).
 *  03/11/2026, two refusals lifted: the colour space was read by NAME, so a grey mask declared `ICCBased` with `N 1` was
 *  refused AND took its picture down with it; and the generic branch took `FlateDecode` alone where the reader also
 *  undoes four other filters. A chain of two filters or more gives `undefined` here, like "no filter at all": the
 *  reader decodes the chain or refuses it, and a refusal is read as a mask we cannot decode. */
export function maskSupported(doc: PdfObjectsDocument, mask: { dict: ReadonlyMap<string, PdfValue> }): boolean {
  if (componentsOfSpace(doc, doc.resolve(mask.dict.get("ColorSpace"))) !== 1) return false;
  if (decodeArrayOf(doc, mask.dict, 1) === null) return false;
  const bpc = numberOf(doc.resolve(mask.dict.get("BitsPerComponent")));
  const filter = singleFilterOf(doc, mask.dict);
  if (filter === "CCITTFaxDecode") return bpc === 1;
  if (filter === "DCTDecode") return bpc === 8;
  return (bpc === 1 || bpc === 2 || bpc === 4 || bpc === 8) && (filter === undefined || READER_FILTERS.has(filter));
}

/** A 1-bit CCITT mask: a white sample is 255, a black one 0. A `/Decode` of [1 0] swaps them. The parameters are read as
 *  the picture's are (`pdf-ccitt-images.ts`), with pdf.js's default of 1728 columns. */
function ccittSamplesOf(doc: PdfObjectsDocument, mask: PdfStream, mw: number, mh: number): Uint8Array | undefined {
  const parms = doc.dictOf(doc.resolve(mask.dict.get("DecodeParms")));
  const parm = (key: string): PdfValue | undefined => doc.resolve(parms?.get(key));
  const flag = (key: string): boolean => parm(key)?.kind === "bool" && (parm(key) as { value: boolean }).value;
  const image = decodeCcittFax(doc.rawStreamBytes(mask), {
    K: numberOf(parm("K")) ?? 0,
    EndOfLine: flag("EndOfLine"),
    EncodedByteAlign: flag("EncodedByteAlign"),
    BlackIs1: flag("BlackIs1"),
    columns: numberOf(parm("Columns")) ?? 1728,
    rows: numberOf(parm("Rows")) ?? mh,
  });
  if (image === undefined || image.rows === 0) return undefined;
  const inverted = decodeArrayOf(doc, mask.dict, 1)?.[0]?.[0] === 1;
  const samples = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y += 1) {
    const row = Math.min(y, image.rows - 1);
    for (let x = 0; x < mw; x += 1) {
      const white = ((image.bits[row * image.pitch + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
      samples[y * mw + x] = (white === 1) !== inverted ? 255 : 0;
    }
  }
  return samples;
}

/** A grey JPEG mask: its own grey levels, decoded at the mask's size (the same decoder as the pictures). */
function dctSamplesOf(doc: PdfObjectsDocument, mask: PdfStream, mw: number, mh: number): Uint8Array | undefined {
  const raw = doc.rawStreamBytes(mask);
  if (jpegFrameOf(raw)?.components !== 1) return undefined;
  const grey = rgbOf(raw, { width: mw, height: mh });
  if (grey === undefined || grey.width !== mw || grey.height !== mh) return undefined;
  const samples = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i += 1) samples[i] = grey.data[i * 3]!;
  return samples;
}

/** A Flate or uncoded grey mask: its samples unpacked, and scaled to 8 bits (0 → 0, the largest value → 255). */
function flateSamplesOf(doc: PdfObjectsDocument, mask: PdfStream, mw: number, mh: number): Uint8Array | undefined {
  const bpc = numberOf(doc.resolve(mask.dict.get("BitsPerComponent"))) ?? 8;
  const values = unpackSamples(doc.streamBytes(mask), mw, mh, 1, bpc);
  if (values === undefined) return undefined;
  return bpc === 8 ? values : Uint8Array.from(values, (v) => Math.round((v * 255) / ((1 << bpc) - 1)));
}

/** The mask's samples at its own size, by its filter, or `undefined` when they cannot be read.
 *  A REFUSAL OF THE STREAM READER IS SUCH A CASE, and it is caught here (03/11/2026): a filter chain the reader does not
 *  undo, a truncated stream, a budget spent. The picture's own samples were already read this way
 *  (`pdf-flate-images.ts#samplesOf`); the mask was not, so the refusal escaped to the page. */
function maskSamplesOf(
  doc: PdfObjectsDocument,
  mask: PdfStream,
  filter: string | undefined,
  size: { mw: number; mh: number },
): Uint8Array | undefined {
  try {
    if (filter === "CCITTFaxDecode") return ccittSamplesOf(doc, mask, size.mw, size.mh);
    if (filter === "DCTDecode") return dctSamplesOf(doc, mask, size.mw, size.mh);
    return flateSamplesOf(doc, mask, size.mw, size.mh);
  } catch {
    return undefined;
  }
}

/** The alpha of a soft mask at the picture's size. pdf.js took each picture pixel's alpha from the mask sample at
 *  `floor(x · maskWidth / width)`, `floor(y · maskHeight / height)` (nearest, no centring: measured on a 40 × 30 mask
 *  under a 64 × 48 picture, all 3 072 pixels). `undefined` when the mask cannot be read. */
export function alphaOf(
  doc: PdfObjectsDocument,
  mask: PdfStream,
  width: number,
  height: number,
): Uint8Array | undefined {
  const mw = numberOf(doc.resolve(mask.dict.get("Width")));
  const mh = numberOf(doc.resolve(mask.dict.get("Height")));
  if (mw === undefined || mh === undefined || !pictureSizeOk(mw, mh) || !pictureSizeOk(width, height)) return undefined;
  const filter = singleFilterOf(doc, mask.dict);
  let samples = maskSamplesOf(doc, mask, filter, { mw, mh });
  if (samples === undefined || samples.length < mw * mh) return undefined;
  // An 8-bit mask's `/Decode` is applied to its samples as a picture's is (as pdf.js did: decodeBuffer).
  const pairs = filter === "CCITTFaxDecode" ? undefined : decodeArrayOf(doc, mask.dict, 1);
  if (pairs !== undefined && pairs !== null) {
    const pair = pairs[0]!;
    samples = Uint8Array.from(samples.subarray(0, mw * mh), (v) => decodeSample(v, pair));
  }
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const my = Math.floor((y * mh) / height);
    for (let x = 0; x < width; x += 1) alpha[y * width + x] = samples[my * mw + Math.floor((x * mw) / width)]!;
  }
  return alpha;
}
