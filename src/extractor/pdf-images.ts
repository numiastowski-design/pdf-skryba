/** The PIXELS of a PDF image, read from the object store that `pdf-source.ts` builds from OUR reader and handed on in
 *  a shape that names no reader (the store was pdf.js's until its removal, 1/11/2026) — the decoding half of the
 *  boundary that `pdf-ops.ts` holds for operators.
 *  NOT here: the original bytes when they can be kept
 *  (`extractor/pdf-embedded-images.ts`), nor PNG encoding (`extractor/png.ts`).
 *  Called by: `extractor/pdf-source.ts`, `extractor/png.ts`. */

/**
 * pdf-images — the PIXELS of a page image, read from the object store that `pdf-source.ts` builds and handed on
 * in a shape that names no reader.
 *
 * HISTORY: everything below that talks about pdf.js or `pdfjs-dist` describes the time when the store was pdf.js's
 * (removed on 01/11/2026); `pdf-images.pdfjs.test.ts` (deleted, see git history), cited further down, no longer exists.
 *
 * ⚠️ **WITH `pdf-ops.ts`, THIS FILE IS THE OTHER DECODING HALF OF THE
 * BOUNDARY** (14/09/2026). `pdf-ops` translates the operator stream;
 * this one translates the object store.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ONE LAST OF THE THREE
 * ═══════════════════════════════════════════════════════════════════════════
 * The undeclared accesses were handled in the order of what ALREADY failed.
 * This one never failed, **and it fails closed**: any unexpected shape returns
 * `undefined`, hence no image rather than a wrong image. That is the reason
 * it comes after the decoding of the matrices (two real `NaN`s) and
 * after `constructPath`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS PUBLIC HERE, AND WHAT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *  - `PDFObjects.get(objId)` **is declared and documented** in the types of
 *    `pdfjs-dist` — but it returns `any`, and neither `PDFObjects` nor the class of
 *    the returned object appear in the public entry (`pdf.d.ts`). The method
 *    is public, the SHAPE of what it returns is not.
 *  - `{ width, height, kind, data }` **is declared nowhere**. Established by
 *    printing real objects on 11/09/2026: `kind: 2` for the two badges
 *    of a report card.
 *  - `ImageKind`, on the other hand, **IS publicly exported** by `pdfjs-dist`.
 *    We used to copy it by hand (`PNG_KIND = {1, 2, 3}` in `png.ts`), which
 *    was less safe than reading the published constant. It is now INJECTED
 *    by the caller, as `OPS` is for `decodeOps`: this module stays
 *    loadable and testable without pdf.js, and `pdf-images.pdfjs.test.ts` (deleted, see git history) checks
 *    that the three names do exist in the real constant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `get` THROWS WHEN THE OBJECT IS NOT READY, AND THAT IS NOT AN ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 * This is how that API signals "not available". The `try` that
 * surrounds it is therefore never a way of ignoring an error. FALSE for a
 * large image or a reused image, measured on 15/09/2026 on fixture
 * 24: pdf.js delivers the first after the operator list and puts the
 * second in `commonObjs`. The boundary waits for them (`awaitImageObject`)
 * before building the page.
 */

/** The pixel format: defined by the shared PNG writer and re-exported here for this module's callers. The direction
 *  matters: shared code does not depend on a format. */
import type { PixelFormat } from "doc-ir/internal";

export type { PixelFormat };

export interface PdfImageData {
  width: number;
  height: number;
  format: PixelFormat;
  data: ArrayLike<number>;
}

/** What this module needs from a page's object store. Describing less
 *  is depending on less. */
export interface ObjectStoreLike {
  get: (objId: string) => unknown;
}

/** The three names that `ImageKind` publishes. Injected rather than imported. */
export interface ImageKindLike {
  GRAYSCALE_1BPP: number;
  RGB_24BPP: number;
  RGBA_32BPP: number;
}

/** The store's object, or `undefined` when `get` throws (not resolved yet: that is how it says so) or answers a non-object. */
function storedObject(objs: ObjectStoreLike, name: string): object | undefined {
  let obj: unknown;
  try {
    obj = objs.get(name);
  } catch {
    return undefined;
  }
  return obj === null || typeof obj !== "object" ? undefined : obj;
}

/**
 * The pixels of an image of the store, or `undefined` as soon as something
 * is missing — absent object, unknown format, inconsistent dimensions.
 *
 * **ABSTENTION IS THE INTENDED BEHAVIOUR.** A half-read image would be
 * published AS an image: plausible and wrong, exactly what we refuse
 * elsewhere. And an unknown `kind` — the case that matters if the store added or
 * renumbered a format (which pdf.js could do) — is not to be guessed: we publish nothing rather than
 * channels interpreted wrongly.
 */
export function readImageObject(objs: ObjectStoreLike, name: string, kinds: ImageKindLike): PdfImageData | undefined {
  const obj = storedObject(objs, name);
  if (obj === undefined) return undefined;

  const image = obj as { width?: unknown; height?: unknown; kind?: unknown; data?: ArrayLike<number> };
  if (typeof image.width !== "number" || typeof image.height !== "number") return undefined;
  if (image.data === undefined) return undefined;

  const format = formatOf(image.kind, kinds);
  if (format === undefined) return undefined;

  return { width: image.width, height: image.height, format, data: image.data };
}

const formatOf = (kind: unknown, kinds: ImageKindLike): PixelFormat | undefined => {
  if (typeof kind !== "number") return undefined;
  if (kind === kinds.RGB_24BPP) return "rgb-24";
  if (kind === kinds.RGBA_32BPP) return "rgba-32";
  if (kind === kinds.GRAYSCALE_1BPP) return "gray-1";
  return undefined;
};

/** The PDF object number of a store image — `"53R"`, or `"53R2"` for a
 *  non-zero generation —, or `undefined`. Measured on 15/09/2026: this `ref` designates
 *  exactly the object that `pdf-lib` reads, which allows copying a JPEG without
 *  decoding it. Not declared by pdf.js (history), like the rest of the object: we check the shape. */
export function readImageRef(objs: ObjectStoreLike, name: string): string | undefined {
  const obj = storedObject(objs, name);
  if (obj === undefined) return undefined;
  const ref = (obj as { ref?: unknown }).ref;
  return typeof ref === "string" && /^\d+R\d*$/.test(ref) ? ref : undefined;
}
