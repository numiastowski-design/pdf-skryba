/** The raw bytes of one image travelling beside an IR document, keyed by
 *  sha256 — the ONE definition (two copies lived in `dispatch.ts` and
 *  `image.ts` until the recensement of 28/09/2026, kept apart by the
 *  dispatch↔image import cycle a shared home dissolves).
 *  NOT here: the reference the page renders (`lib/ir.ts#ImageRef`), nor
 *  who collects these (`extractor/image-collector.ts`).
 *  Called by: `extractor/dispatch.ts` (re-export), `extractor/image.ts`,
 *  and every reader that returns images. */

export interface RawImage {
  sha256: string;
  bytes: Uint8Array;
  mimeType: string;
  /** This image was FABRICATED by us from a geometry already measured in the
   *  document — a solid color fill, never a received illustration.
   *
   *  No image goes to vision any more (17/09/2026); the flag only says the image is ours. */
  selfDescribed?: true;
}
