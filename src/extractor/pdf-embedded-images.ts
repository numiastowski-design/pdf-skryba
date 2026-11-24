/** A PDF's images read out of the document structure, byte for byte when the
 *  format allows it, so a republished image is the original and not a re-encode.
 *  Read from OUR object reader (`pdf-objects/`), which decrypts and bounds every stream: this module used to open the whole file
 *  with `pdf-lib`, which inflated every object stream with none of our bounds (security review of 02/11/2026, finding 9).
 *  Decides: that it takes the document the reading has ALREADY opened when one is handed to it (`openEmbeddedImages` accepts a
 *  `PdfObjectsDocument` as well as bytes), so the file is parsed once and the pictures spend the document's own stream budget
 *  (performance review of 02/11/2026, held by `pdf-embedded-images.shared-doc.test.ts`); given bytes alone it opens its own.
 *  NOT here: decryption (`extractor/pdf-decrypt.ts`, called by the object reader), the pixel fallback
 *  (`extractor/pdf-images.ts`), nor where an image belongs on the page
 *  (`extractor/pdf.ts`).
 *  Called by: `extractor/pdf.ts` and `extractor/pdf-page-figures.ts`. */

/**
 * `pdf-embedded-images` — the IMAGE of a PDF, read from the structure of the document, without
 * decoding it when that is not necessary (15/09/2026).
 *
 * WHY NOT DECODED PIXELS (that was pdf.js's case, removed from the product on 01/11/2026). A JPEG decoded then
 * re-encoded would lose the original that the functional specification (§6.6) asks to be "identical". Here,
 * a `DCTDecode` is copied byte for byte; `FlateDecode` pixels are
 * decompressed and wrapped in PNG. The image's POSITION and its object number (`ref`) come from our
 * reader (`pdf-source.ts`).
 *
 * FAILS CLOSED. Any unhandled shape — CMYK, indexed palette, image mask,
 * `Decode`, TIFF predictor, depth other than 8 bits, JPEG with alpha mask —
 * returns `undefined`. An approximate image would be plausible and wrong.
 */
import { inflateSync } from "node:zlib";

import { encodePngDeflate } from "doc-ir/internal";
import { unfilterPngRows } from "doc-ir/internal";
import { imageFilterOf, openPdfObjects, singleFilterOf, type PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfStream, PdfValue } from "./pdf-objects/objects";
import {
  componentsOfSpace,
  entryOf,
  MAX_EMBEDDED_IMAGE_PIXELS,
  nameOf,
  numberOf,
  pictureSizeOk,
} from "./pdf-image-pixels";
import { MAX_DOCUMENT_BYTES } from "./pdf-objects/bounds";
import { documentCacheOf, type DocumentCache } from "./document-cache";

const EMBEDDED = Symbol("embedded picture");
const MASK = Symbol("soft mask");

export { MAX_EMBEDDED_IMAGE_PIXELS };

export interface EmbeddedImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** The bytes are a VIEW of the file (an unencrypted JPEG under the DCT filter alone): they hold no memory of their own. */
  viewOfFile?: true;
}

export type EmbeddedImageReader = (ref: string) => EmbeddedImage | undefined;

/** The colour channels of a picture we read here: grey (1) or RGB (3, ICC-based included). CMYK is left to the caller. */
function channelsOf(doc: PdfObjectsDocument, space: PdfValue | undefined): 1 | 3 | undefined {
  const count = componentsOfSpace(doc, doc.resolve(space));
  return count === 1 || count === 3 ? count : undefined;
}

/** The pixels of an 8-bit FlateDecode stream, PNG predictor undone if there is one. The raw bytes come from the object reader, which
 *  decrypts them: a compressed stream of an encrypted document is encrypted THEN compressed, so it is decrypted BEFORE being inflated. */
function flatePixels(
  doc: PdfObjectsDocument,
  stream: PdfStream,
  shape: { width: number; height: number; channels: number },
  spent: { bytes: number },
): Uint8Array | undefined {
  const { width, height, channels } = shape;
  if (
    singleFilterOf(doc, stream.dict) !== "FlateDecode" ||
    numberOf(doc.resolve(stream.dict.get("BitsPerComponent"))) !== 8
  )
    return undefined;
  let contents: Uint8Array;
  try {
    contents = doc.rawStreamBytes(stream);
  } catch {
    return undefined;
  }
  // The ceiling comes from the DECLARED size: the exact length the later checks accept, so anything
  // longer is refused by zlib itself instead of being inflated first (like `png-decode.ts`).
  const parms = doc.resolve(stream.dict.get("DecodeParms"));
  const parmsDict: PdfDict | undefined = parms?.kind === "dict" ? parms.entries : undefined;
  const num = (key: string): number | undefined => numberOf(doc.resolve(parmsDict?.get(key)));
  const predictorOf = parmsDict === undefined ? 1 : (num("Predictor") ?? 1);
  const expected = predictorOf >= 10 ? height * (width * channels + 1) : width * height * channels;
  // Width x height test (`MAX_EMBEDDED_IMAGE_PIXELS`): the largest buffer held is that cap x 4 channels at most.
  // The same size judgement as every other picture reader, and the running total of what this reader has inflated (`MAX_DOCUMENT_BYTES`).
  if (
    !pictureSizeOk(width, height) ||
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    spent.bytes + expected > MAX_DOCUMENT_BYTES
  )
    return undefined;
  let raw: Uint8Array;
  try {
    const inflated = inflateSync(contents, { maxOutputLength: expected });
    // A view on the Buffer's memory, not a second copy of it.
    raw = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
    spent.bytes += raw.length;
  } catch {
    // Any failure is charged the declared size: zlib may have inflated all of it before it threw (a truncated stream, a bad checksum:
    // measured 33 ms for 75 MB), and what it did cannot be read back. A hostile file loses its own later pictures; an ordinary one has
    // no corrupt picture.
    spent.bytes += expected;
    return undefined;
  }
  const unpredicted = (): Uint8Array | undefined => (raw.length === width * height * channels ? raw : undefined);
  if (parms === undefined) return unpredicted();
  if (parmsDict === undefined) return undefined;
  const predictor = num("Predictor") ?? 1;
  if (predictor === 1) return unpredicted();
  if (predictor < 10) return undefined;
  if ((num("Colors") ?? 1) !== channels) return undefined;
  if ((num("BitsPerComponent") ?? 8) !== 8) return undefined;
  if ((num("Columns") ?? 1) !== width) return undefined;
  return unfilterPngRows(raw, width, height, channels);
}

/** The alpha of a soft mask of the same size as the picture, one byte per pixel, or `undefined` when we do not read it. */
function maskAlpha(
  doc: PdfObjectsDocument,
  mask: PdfValue | undefined,
  size: { width: number; height: number },
  state: { spent: { bytes: number }; cache: DocumentCache },
): Uint8Array | undefined {
  const { width, height } = size;
  if (mask?.kind !== "stream") return undefined;
  if (
    numberOf(doc.resolve(mask.dict.get("Width"))) !== width ||
    numberOf(doc.resolve(mask.dict.get("Height"))) !== height
  )
    return undefined;
  if (channelsOf(doc, mask.dict.get("ColorSpace")) !== 1) return undefined;
  // A soft mask shared by several pictures is inflated and charged once.
  return state.cache.getOrCompute<Uint8Array | undefined>(
    MASK,
    mask,
    (alpha) => alpha?.length ?? 0,
    () => flatePixels(doc, mask, { width, height, channels: 1 }, state.spent),
  );
}

/** Opens the document with OUR reader; it throws what that reader throws (a refusal), which the caller turns into "no embedded images". */
export async function openEmbeddedImages(source: Uint8Array | PdfObjectsDocument): Promise<EmbeddedImageReader> {
  // The document of the reading is passed when there is one: opening the file again parsed its table and object streams a second time. This
  // reader inflates a picture itself and charges the document only the bytes it reads from the file (`rawStreamBytes`), so sharing the document's
  // budget with the first pass costs it little: a budget of its own was considered and left (it would add a second kind of document view).
  const doc = source instanceof Uint8Array ? openPdfObjects(source) : source;
  const cache = documentCacheOf(doc);
  // A JPEG we pass through is a VIEW of the file when it is not encrypted (a decrypted one is a copy): it holds no memory of its own, so the cache
  // does not price it, and a scan of fifteen 5 MB JPEGs does not push the pages and forms that do cost memory out.
  const encrypted = doc.trailer().has("Encrypt");
  const spent = { bytes: 0 };
  // A picture placed on many pages (a letterhead, a background) is read ONCE: the result, `undefined` included, is kept by reference. Without
  // it each placement inflated, re-encoded and re-charged the picture, and a long document ran out of budget (performance review 02/11/2026).
  // The cache is the document's, capped: what does not fit is read again, not refused. The key is the object NUMBER, as `resolve` reads it (the
  // generation is ignored): `5R`, `5R0` and `5R1` are one.
  const readOnce = (ref: string): EmbeddedImage | undefined => {
    const m = /^(\d+)R(\d*)$/.exec(ref);
    return cache.getOrCompute<EmbeddedImage | undefined>(
      EMBEDDED,
      m === null ? `raw:${ref}` : `${Number(m[1])}`,
      (image) => (image === undefined || image.viewOfFile === true ? 0 : image.bytes.length),
      () => readImage(ref),
    );
  };

  const readImage = (ref: string): EmbeddedImage | undefined => {
    const m = /^(\d+)R(\d*)$/.exec(ref);
    if (!m) return undefined;
    let stream: PdfValue | undefined;
    try {
      stream = doc.resolve({ kind: "ref", num: Number(m[1]), gen: m[2] ? Number(m[2]) : 0 });
    } catch {
      return undefined;
    }
    if (stream?.kind !== "stream") return undefined;
    const dict = stream.dict;
    if (nameOf(doc.resolve(dict.get("Subtype"))) !== "Image") return undefined;
    // Read by its value, not its presence: `/ImageMask false` is legal and is no stencil.
    const imageMask = entryOf(doc, dict, "ImageMask");
    if (imageMask?.kind === "bool" && imageMask.value) return undefined;
    // `/Decode` by its value too: a dead reference is not a decode array.
    if (entryOf(doc, dict, "Decode") !== undefined) return undefined;
    const width = numberOf(doc.resolve(dict.get("Width")));
    const height = numberOf(doc.resolve(dict.get("Height")));
    const channels = channelsOf(doc, dict.get("ColorSpace"));
    if (width === undefined || height === undefined || channels === undefined) return undefined;
    if (numberOf(doc.resolve(dict.get("BitsPerComponent"))) !== 8) return undefined;
    // By its value too: producers write `/SMask null`, and read as a mask it cost an unmasked picture its
    // byte-for-byte path.
    const smask = entryOf(doc, dict, "SMask");

    // `imageFilterOf`: a JPEG compressed again (`/Filter [/FlateDecode /DCTDecode]`) is published byte for byte too,
    // once the Flate is undone — the bytes delivered are then the JPEG the document really carries (03/11/2026).
    if (imageFilterOf(doc, dict) === "DCTDecode") {
      if (smask !== undefined) return undefined;
      let raw: Uint8Array;
      try {
        raw = doc.imageStreamOf(stream).data;
      } catch {
        return undefined;
      }
      // 🔴 WE NEVER DELIVER BYTES WHOSE DECLARED TYPE DOES NOT MATCH
      // THE CONTENT (17/09/2026). `/DCTDecode` ANNOUNCES a JPEG; three bytes
      // suffice to check that it IS one. Without this reading, the stream was
      // returned on the word of the dictionary, and the header comment said
      // "identical to the original" — an assumption, never a verification.
      //
      // The case that revealed it: an ENCRYPTED PDF opened by a reader that did not decrypt, so the streams it returned were
      // ciphertext (four real report cards failed in production before it showed). The object reader decrypts today, but the
      // guard does not speak of encryption, and that is deliberate: it catches
      // the whole family — a truncated stream, a misread filter, a
      // fanciful producer — not only that cause. The abstention hands control
      // back to `extractPdf`, which goes back through the pixels that OUR reader decodes (`pdf-images.ts`).
      if (!(raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff)) return undefined;
      // A view only under the DCT filter alone: a chain (`[/FlateDecode /DCTDecode]`) inflated these bytes just now.
      const view = !encrypted && singleFilterOf(doc, dict) === "DCTDecode";
      return { bytes: raw, mimeType: "image/jpeg", width, height, ...(view ? { viewOfFile: true as const } : {}) };
    }

    const pixels = flatePixels(doc, stream, { width, height, channels }, spent);
    if (pixels === undefined) return undefined;
    let out = pixels;
    let outChannels: 1 | 2 | 3 | 4 = channels;
    if (smask !== undefined) {
      const alpha = maskAlpha(doc, smask, { width, height }, { spent, cache });
      if (alpha === undefined) return undefined;
      outChannels = channels === 3 ? 4 : 2;
      out = new Uint8Array(width * height * outChannels);
      // A flat loop: a `subarray` per pixel was 25 million views for a 25-megapixel picture.
      for (let i = 0, p = 0, o = 0; i < width * height; i++, p += channels, o += outChannels) {
        for (let k = 0; k < channels; k++) out[o + k] = pixels[p + k]!;
        out[o + channels] = alpha[i]!;
      }
    }
    const png = encodePngDeflate(width, height, outChannels, out);
    return png === undefined ? undefined : { bytes: png, mimeType: "image/png", width, height };
  };
  return readOnce;
}

/** Kept here for the existing importers; the one implementation lives in `png-unfilter.ts`. */
export { unfilterPngRows };
