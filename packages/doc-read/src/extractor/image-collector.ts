/** The images of one document, one per distinct file: collect every picture
 *  a reader meets, reduce the oversized ones once, and hand the deduplicated
 *  list to the pipeline.
 *  NOT here: pixel decoding and the reduction itself (`image-reduction.ts`),
 *  nor what a picture MEANS in a document (each reader decides).
 *  Called by: `extractor/pptx.ts`, `extractor/xlsx.ts`, `extractor/docx-reader/index.ts`. */

import { sha256Hex } from "doc-ir/lib/digest";

import type { ImageRef } from "doc-ir/lib/ir";
import type { RawImage } from "doc-ir/extractor/raw-image";
import { sniffImage } from "doc-ir/extractor/image-format";
import { imagePixelSize, MAX_LONG_SIDE_PX, type ReducedImage, reduceLargeImage } from "./image-reduction";

/** Moved verbatim from `pptx.ts` (lot tableurs, step 0, 28/09/2026): the
 *  xlsx reader anchors images too, and one collector must serve both. */
export class ImageCollector {
  private readonly bySha = new Map<string, RawImage>();
  /** Reductions already made, by the sha256 of the ORIGINAL bytes: the same
   *  picture on several slides is decoded once. `undefined`: kept as it is. */
  private readonly reduced = new Map<string, ReducedImage | undefined>();

  /** `identity`: what the reference is hashed from, when not the bytes
   *  themselves (Google's image: see `pptx.ts#slideBody`).
   *  A picture over `MAX_LONG_SIDE_PX` is reduced HERE, before its sha256:
   *  the attachment's name is the sha of the bytes published, never of the
   *  original's (`image-reduction.ts`). A Google image keeps its identity
   *  as its sha; only its bytes are reduced. Our drawings (self-described)
   *  are never touched. When reduced, the ref carries the reduced file's
   *  `pixelWidth` and `image/jpeg`; otherwise no `pixelWidth` (the caller's
   *  own stands). */
  collect(bytes: Uint8Array, mimeType: string, selfDescribed = false, identity: Uint8Array | string = bytes): ImageRef {
    const reduced = selfDescribed ? undefined : this.reduce(bytes);
    const published = reduced?.bytes ?? bytes;
    const type = reduced?.mimeType ?? mimeType;
    const sha256 = sha256Hex(identity === bytes ? published : identity);
    if (!this.bySha.has(sha256)) {
      this.bySha.set(sha256, {
        sha256,
        bytes: published,
        mimeType: type,
        ...(selfDescribed ? { selfDescribed: true as const } : {}),
      });
    }
    return { sha256, mimeType: type, ...(reduced ? { pixelWidth: reduced.pixelWidth } : {}) };
  }

  private reduce(bytes: Uint8Array): ReducedImage | undefined {
    // reduceLargeImage only handles PNG and JPEG: anything else is not worth a hash.
    const format = sniffImage(bytes);
    if (format !== "png" && format !== "jpeg") return undefined;
    const size = imagePixelSize(bytes);
    if (!size || Math.max(size.width, size.height) <= MAX_LONG_SIDE_PX) return undefined;
    const key = sha256Hex(bytes);
    if (!this.reduced.has(key)) this.reduced.set(key, reduceLargeImage(bytes));
    return this.reduced.get(key);
  }

  get images(): RawImage[] {
    return [...this.bySha.values()];
  }
}
