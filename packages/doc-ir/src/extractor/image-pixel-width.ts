/** What an image file declares in its own header: the width, as a projection of `image-format.ts#imageHeader`.
 *  Also exports `isPng`, and re-exports `PNG_SIGNATURE` and `jpegHeader` from `image-format.ts` for its callers.
 *  NOT here: the published width itself, drawn width against native width
 *  against the 744-px cap (`renderer/storage.ts#publishedImageWidthPx`), nor
 *  the reduction that reads the header (`extractor/image-reduction.ts`).
 *  Called by: `extractor/docx-reader/index.ts`, `extractor/docx-reader/google-drawings.ts`, `extractor/pptx.ts`,
 *  `extractor/pdf-page-figures.ts`, `extractor/pptx-reader/picture.ts`, `extractor/image-reduction.ts`,
 *  `extractor/png.ts`, `extractor/png-decode.ts` and `adapters/google-slides.ts`. */
import { imageHeader, sniffImage } from "./image-format";

/** The bytes start with the PNG signature. */
export const isPng = (bytes: Uint8Array): boolean => sniffImage(bytes) === "png";

export { PNG_SIGNATURE, jpegHeader } from "./image-format";

/** Width a PNG, JPEG or GIF declares in its header; `undefined` for anything else (the published width stays the drawn
 *  one, as before: G2, 24/09/2026, an upscaled screenshot looks blurry). A projection of `imageHeader`. */
export const imagePixelWidth = (bytes: Uint8Array): number | undefined => imageHeader(bytes)?.width;
