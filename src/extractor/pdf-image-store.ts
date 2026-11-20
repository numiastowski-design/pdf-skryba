/** One attachment per content: the sha256 is the name, so two identical bars
 *  share one file and a republication renames nothing.
 *  NOT here: what an image means, nor where it goes in the page
 *  (`extractor/pdf-page-markers.ts`, `extractor/pdf-page-figures.ts`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-page-markers.ts`,
 *  `extractor/pdf-page-figures.ts`. */

import { sha256Hex } from "doc-ir/internal";

import type { ImageRef } from "doc-ir";
import type { RawImage } from "doc-ir/internal";

export interface ImageStore {
  /** An image we make: a flat fill, a dot, a badge taken from the document.
   *  `selfDescribed` holds for a badge taken from the document too: an image the size of a character carries no text
   *  an analysis could read, the result would be empty, and the rule of the mute image would then drop it. */
  collect: (bytes: Uint8Array, mimeType: string) => ImageRef;
  /** An image of the document, kept only once its place is settled. */
  keep: (image: RawImage) => void;
  /** What the extraction will publish, in the order the images were taken. */
  images: () => RawImage[];
}

/** One store per extraction, never module state: two concurrent extractions must not mix their attachments. */
export const createImageStore = (): ImageStore => {
  const bySha = new Map<string, RawImage>();
  return {
    collect: (bytes, mimeType) => {
      const sha256 = sha256Hex(bytes);
      if (!bySha.has(sha256)) bySha.set(sha256, { sha256, bytes, mimeType, selfDescribed: true });
      return { sha256, mimeType };
    },
    keep: (image) => {
      if (!bySha.has(image.sha256)) bySha.set(image.sha256, image);
    },
    images: () => [...bySha.values()],
  };
};
