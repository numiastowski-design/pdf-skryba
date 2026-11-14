/** The contract for Google's own image of a Google Slides page, DECLARED by the reading library and implemented by the app: the
 *  deck's page ids, one page's picture, then whether the Drive file changed meanwhile (MIKSUDOC « Spécification fonctionnelle » §9.3.4).
 *  NOT here: which slide asks for one, nor the fallback to our drawing (`extractor/pptx.ts`), nor the real calls
 *  (`adapters/google-slides.ts`). `ports/slide-image.ts` re-exports these three types, so the app keeps ONE definition, at this address.
 *  Called by: `extractor/pptx.ts` reads through it; `ports/slide-image.ts` re-exports it to `orchestrator/doc-processor.ts`,
 *  `adapters/google-slides.ts` (implements it) and `sim/fake-slide-image.ts` (implements it). */

/** One page of the deck, in deck order. `skipped`: the author hid it from
 *  the slideshow ("Skip slide"). */
export interface SlidePage {
  objectId: string;
  skipped: boolean;
}

/** The PNG bytes of one page. */
export interface SlideImage {
  bytes: Uint8Array;
}

/**
 * Every call answers `undefined` (or `false`) when Google gives nothing usable (quota,
 * 403, 404, network, timeout, a malformed answer): the caller then keeps our drawing.
 * The real adapter logs its own composed message before answering
 * it; it never throws. A caller still treats a throw as a refusal.
 */
export interface SlideImagePort {
  /** Every page of the presentation, skipped ones included, in deck order. */
  slidePages(presentationId: string): Promise<SlidePage[] | undefined>;
  /** Google's picture of one page, PNG. */
  slideImage(presentationId: string, pageObjectId: string): Promise<SlideImage | undefined>;
  /** The Drive file's `modifiedTime` is still `modifiedTime`: asked after
   *  the images, to see whether the deck changed since the export they are
   *  matched to. `false` when it changed or cannot be read. */
  unchangedSince(fileId: string, modifiedTime: string): Promise<boolean>;
}
