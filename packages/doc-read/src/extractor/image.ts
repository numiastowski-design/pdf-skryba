/** A standalone image file turned into an IR document: one image block, and
 *  nothing else guessed about it.
 *  NOT here: the page title, which
 *  comes from the filename (`orchestrator/doc-processor.ts`).
 *  Called by: `extractor/dispatch.ts`. */

/**
 * Isolated-image extractor (MIKSUDOC « Spécification technique » §5.4: "Images isolées | téléchargement
 * | → vision, page = titre + image + texte"). The only extractor whose IRDoc is
 * a single `image` block by construction — the page's title comes from the
 * filename (publisher's job, C3), so the body carries just the image. No text
 * is read from it (no image goes to vision since 17/09/2026).
 */

import { sha256Hex } from "doc-ir/lib/digest";

import type { ImageRef, IRDoc } from "doc-ir/lib/ir";
import type { RawImage } from "doc-ir/extractor/raw-image";

export interface ImageExtractResult {
  doc: IRDoc;
  images: RawImage[];
}

export const extractImage = (bytes: Uint8Array, mimeType: string): ImageExtractResult => {
  const sha256 = sha256Hex(bytes);
  const ref: ImageRef = { sha256, mimeType };
  return {
    doc: { blocks: [{ kind: "image", ref }] },
    images: [{ sha256, bytes, mimeType }],
  };
};
