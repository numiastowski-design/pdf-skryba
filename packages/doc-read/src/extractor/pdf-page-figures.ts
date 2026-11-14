/** The block images of ONE page: whether they are read at all, and how their bytes
 *  are recovered. A QR code is published as the picture it is, like any image:
 *  QR codes are no longer decoded (Mikolaj, 06/10/2026). jsQR read every placed
 *  image of a PDF for 4 distinct QR codes in the whole corpus (169 reads over
 *  79 PDFs), and a shape/colour pre-filter cannot separate them (a QR inside a
 *  screenshot: ratio 2.33, 4 % black/white pixels; many non-QR pictures are
 *  100 % black/white). Nothing is added after the picture.
 *  Also walks the IR tree (tables, columns, lists) to register the images placed inside containers.
 *  NOT here: where an image sits in the reading order
 *  (`extractor/pdf-image-anchors.ts`), nor which images are page furniture,
 *  which the caller decides.
 *  Called by: `extractor/pdf.ts`. */

import { sha256Hex } from "doc-ir/lib/digest";

import type { IRBlock } from "doc-ir/lib/ir";
import { count, type ExtractionCost } from "./extraction-cost";
import { imagePixelWidth } from "doc-ir/extractor/image-pixel-width";
import type { EmbeddedImageReader } from "./pdf-embedded-images";
import type { RawImage } from "doc-ir/extractor/raw-image";
import type { ImageStore } from "./pdf-image-store";
import type { ImageCandidate, LostPlace } from "./pdf-model";
import type { PdfSourcePage } from "./pdf-source";
import type { BlockImage } from "./pdf-table-detector";
import { encodePng, encodePngDeflate } from "doc-ir/extractor/png";

export interface PageFigures {
  /** Les grandes images de la page, pas encore lues. */
  candidates: ImageCandidate[];
  /** Garde pour publication les images des blocs RETENUS. */
  place: (blocks: readonly IRBlock[]) => void;
  /** The placements lost so far on this page: read for good by neither reader, by cause — and NAMED, each by the PDF
   *  object it is (`id`) and by WHY it was refused (`why`), so a count can be checked by eye (Mikolaj, 03/11/2026). */
  lost: () => { slow: number; unreadable: number; places: readonly LostPlace[] };
}

/** The PNG of a picture's pixels, by the pixel object itself (`readOurPixels`). Weak: it goes with the document's cache entry. */
const encodedPixels = new WeakMap<object, { png: { bytes: Uint8Array; mimeType: string } | undefined }>();

export const pageFigures = (
  store: ImageStore,
  cost: ExtractionCost,
  page: {
    source: PdfSourcePage | undefined;
    blockImages: readonly BlockImage[];
    readEmbedded: EmbeddedImageReader | undefined;
  },
): PageFigures => {
  const { source: sourcePage, blockImages, readEmbedded } = page;
  // No `selfDescribed`: a screenshot or a diagram of the document, not a fill we made. (No image goes to vision
  // since 17/09/2026, `orchestrator/doc-processor.ts`.)
  // Registered only once PLACED — in the flow or in a table cell. An image kept
  // out of every block would reach neither vision nor attachments (only
  // referenced images do), but `doc-processor` counts EVERY registered image:
  // vision cost (`recordVisionCost`) and the budget guard (`images.length > 0`).
  const documentImages = new Map<IRBlock, RawImage>();
  // THE WIDTH IS THE ONE THE PAGE DRAWS, per block and not per file (22/09/2026,
  // lot « 31 »): the same object painted twice at two sizes keeps one
  // attachment (sha256) and two widths. The file's pixel width is NOT it —
  // Confluence displayed that one, and a 1 559-px footer band drawn 548 pt wide
  // scrolled the page sideways (docs/PLATFORM-STATUS.md §41).
  // The file's own pixel width travels with the drawn one: the page never
  // publishes an image wider than its pixels (G2, renderer/storage.ts).
  const pixelWidthOf = (imgBytes: Uint8Array): { pixelWidth?: number } => {
    const pixelWidth = imagePixelWidth(imgBytes);
    return pixelWidth !== undefined ? { pixelWidth } : {};
  };
  const collectDocumentImage = (imgBytes: Uint8Array, mimeType: string, widthPt: number): IRBlock => {
    const sha256 = sha256Hex(imgBytes);
    const block: IRBlock = { kind: "image", ref: { sha256, mimeType, widthPt, ...pixelWidthOf(imgBytes) } };
    documentImages.set(block, { sha256, bytes: imgBytes, mimeType });
    return block;
  };
  // Walks INTO containers: an image placed in a table cell (21/09/2026) is
  // nested, and one left unregistered would be referenced but never uploaded.
  const placeDocumentImages = (blocks: readonly IRBlock[]): void => {
    for (const block of blocks) {
      const raw = documentImages.get(block);
      if (raw !== undefined) store.keep(raw);
      if (block.kind === "table") for (const row of block.rows) for (const cell of row.cells) placeDocumentImages(cell.blocks);
      else if (block.kind === "columns" || block.kind === "list") for (const part of block.kind === "columns" ? block.cells : block.items) placeDocumentImages(part);
    }
  };

  /** 🔴 THE SECOND READING OF A PICTURE, AND IT IS NOT A COMFORT (17/09/2026; back on the 03/11/2026 with OUR pixels).
   *  `readEmbedded` gives the file's own stream, not re-encoded — the faithful path, tried first. But it abstains as
   *  soon as the bytes are not what the dictionary announces, and on every shape it cannot wrap: a JPEG that carries a
   *  soft mask, an UNCODED picture, CMYK, an indexed palette, a `/Decode`, a TIFF predictor, a depth other than 8 bits
   *  — and the case that revealed it, an ENCRYPTED PDF, whose stored bytes are unusable as such.
   *  Without this second reading, that abstention costs a PUBLISHED picture. Measured on
   *  `fixtures/pdf/corpus-safedocs/0000713.pdf`: our reader decodes all FOUR of its painted pictures, and page 1
   *  published 2 of its 3 — the missing one carries a soft mask on a JPEG. This fallback existed until the
   *  01/11/2026 and left with pdf.js because the pixels were pdf.js's; they are ours now (`pdf-source.ts#readImage`).
   *  `encodePngDeflate` and NOT `encodePng`: the second writes no filter and does not compress. Measured on the
   *  encrypted bulletin, the SAME picture: 400 031 bytes without compression, 127 825 with, against 33 500 for the
   *  original JPEG. The factor twelve becomes a factor four, and the four do not come back here: we re-encode pixels
   *  losslessly where the original was a lossy JPEG, and compressing a second time would damage the picture.
   *  `gray-1` is the exception: PNG's bit order is already ours (MSB first, 1 = white, as DeviceGray) and a 1-bit
   *  picture is small, so it is copied without compression. An unwritable format publishes NOTHING, rather than
   *  channels read awry. */
  const readOurPixels = (name: string): { bytes: Uint8Array; mimeType: string } | undefined => {
    const pixels = sourcePage?.readImage(name);
    if (pixels === undefined) return undefined;
    // ONCE per pixel object (review 06/11/2026): the document's cache hands back the SAME object for every placement of
    // a picture, and compressing it again at each placement cost as much as the first time. The memo lives and dies
    // with that object, so it never outlives the cache entry.
    const known = encodedPixels.get(pixels);
    if (known !== undefined) return known.png;
    const samples = pixels.data instanceof Uint8Array ? pixels.data : Uint8Array.from(pixels.data);
    const channels = pixels.format === "rgb-24" ? 3 : 4;
    const encoded =
      pixels.format === "gray-1" ? encodePng(pixels.width, pixels.height, "gray-1", samples) : encodePngDeflate(pixels.width, pixels.height, channels, samples);
    const png = encoded === undefined ? undefined : { bytes: encoded, mimeType: "image/png" };
    encodedPixels.set(pixels, { png });
    return png;
  };

  const lostPlacements: { slow: number; unreadable: number; places: LostPlace[] } = { slow: 0, unreadable: 0, places: [] };
  /** Called only for a placed image. */
  const readBlockImage = (b: BlockImage, order: number): IRBlock[] | undefined => {
    const img = readEmbedded?.(b.ref) ?? readOurPixels(b.name);
    if (img === undefined) {
      lostPlacements[sourcePage?.imageFailure(b.name) ?? "unreadable"] += 1;
      // The PDF object names the picture best: unique in the file, and what a probe takes. The fallback, for a picture
      // the detector kept without one, is its ORDER on the page, composed here: the resource name is written by the file,
      // so it is client content and never goes in a notice (review 06/11/2026). `bytes` when the boundary has no reason
      // to give: the shape was ours to read and the reading failed, which is exactly what that word means.
      lostPlacements.places.push({ id: b.ref.length > 0 ? b.ref : `#${String(order + 1)}`, why: sourcePage?.imageRefusal(b.name) ?? "bytes" });
      return undefined;
    }
    count(cost, "imagesRead");
    return [collectDocumentImage(img.bytes, img.mimeType, b.drawnWidth)];
  };
  const imageCandidates: ImageCandidate[] = blockImages
    // Which images a rendered table takes is decided in `renderPageTables`: only it knows which tables render.
    .map((b, order) => ({ top: b.yMax, bottom: b.yMin, xMin: b.xMin, xMax: b.xMax, read: () => readBlockImage(b, order) }));

  return { candidates: imageCandidates, place: placeDocumentImages, lost: () => ({ ...lostPlacements, places: [...lostPlacements.places] }) };
};
