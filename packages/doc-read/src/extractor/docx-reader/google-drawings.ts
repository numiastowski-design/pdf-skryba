/** D2 voie A (MIKSUDOC « Spécification fonctionnelle » §9.5): Google's own image of a
 *  Google Doc's drawing, read from the zipped HTML export and matched to the
 *  drawing by what BOTH files declare — its size and the paragraph before it.
 *  Decides: exactly one match gives Google's PNG in place of our SVG (voie B);
 *  zero, several, or an export that cannot be read leave our SVG. Never a
 *  failure of the document.
 *  NOT here: fetching the export (`adapters/forge-drive.ts`), our own drawing
 *  (`docx-reader/shapes.ts`), nor where the picture lands in the page
 *  (`docx-reader/body.ts`, `docx-reader/index.ts`).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import { collapseBlanks } from "doc-ir/lib/blanks";
import { sha256Hex } from "doc-ir/lib/digest";
import { posix } from "node:path";

import { type DefaultTreeAdapterMap, parse } from "parse5";

import { ReaderError } from "doc-ir/lib/reader-error";
import type { ImageRef } from "doc-ir/lib/ir";
import { imagePixelWidth, isPng } from "doc-ir/extractor/image-pixel-width";
import { openArchive, type PackageLimits } from "../ooxml/package";
import type { DrawingCanvas } from "./shapes";

/** A drawing's `wp:extent` (EMU) against the export's CSS pixels: 914 400 EMU per inch over 96 px per inch. Exact on
 *  both real specimens (held by `google-drawings.test.ts`, Essai 11 and Essai 13). */
export const EMU_PER_PX = 9_525;

/** How far apart, in px, the drawing's declared size and the export's `<img>`
 *  `style` may be and still be the same size. Starting value to calibrate:
 *  the two real specimens agree to 0 px (Essai 11 560/94, Essai 13 624/296),
 *  so this only forgives Google's own rounding of an EMU count to two
 *  decimals. Nothing measured of a size that differs by more. */
const SIZE_TOLERANCE_PX = 0.5;

/** The ceilings the export's archive is inflated under. Starting values to
 *  calibrate: an export over 10 MB is refused by the adapter before it gets
 *  here, so no honest part inflates past this; the package layer's own, larger
 *  ceilings are for Office files a user uploads. */
const HTML_EXPORT_LIMITS: PackageLimits = { partMaxBytes: 16_000_000, packageMaxBytes: 32_000_000 };

const unreadable = (): ReaderError =>
  new ReaderError("EXTRACT_FAILED", "the Google Docs HTML export could not be opened");

/** One `<img>` of the HTML export that has a file and a declared size. */
export interface HtmlExportImage {
  /** Its path in the archive. */
  readonly path: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /** The text of the last non-empty paragraph that ENDS before the image's
   *  own paragraph (§5.3: « the text of the previous paragraph »), or "". */
  readonly previousText: string;
}

export interface HtmlExport {
  readonly images: readonly HtmlExportImage[];
  bytesOf(path: string): Promise<Uint8Array | undefined>;
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "td",
  "th",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const UNREAD_TAGS = new Set(["head", "style", "script"]);

/** `style="… width: 560.00px; height: 94.00px …"` — the image's own declared
 *  size, never `max-width`. */
const declared = (style: string, property: "width" | "height"): number | undefined => {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(style);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const htmlAttributeOf = (element: Element, name: string): string | undefined =>
  element.attrs.find((attribute) => attribute.name === name)?.value;

/** What an `<img>` of the export declares, when it has a file in the archive and a declared size. */
const exportImageOf = (
  element: Element,
  archivedNames: ReadonlySet<string>,
  previousText: string,
): HtmlExportImage | undefined => {
  const src = htmlAttributeOf(element, "src");
  const style = htmlAttributeOf(element, "style") ?? "";
  const widthPx = declared(style, "width");
  const heightPx = declared(style, "height");
  const path = src === undefined ? undefined : posix.normalize(src);
  if (path === undefined || !archivedNames.has(path) || widthPx === undefined || heightPx === undefined)
    return undefined;
  return { path, widthPx, heightPx, previousText };
};

/** The images of the export's HTML, in document order, each with the paragraph text before it. */
const htmlImagesOf = (html: string, archivedNames: ReadonlySet<string>): HtmlExportImage[] => {
  const images: HtmlExportImage[] = [];
  let currentParagraphText = "";
  let previousParagraphText = "";
  const endParagraph = (): void => {
    const text = collapseBlanks(currentParagraphText);
    if (text !== "") previousParagraphText = text;
    currentParagraphText = "";
  };
  const walk = (node: Node): void => {
    if (node.nodeName === "#text") {
      currentParagraphText += (node as DefaultTreeAdapterMap["textNode"]).value;
      return;
    }
    if (!("childNodes" in node)) return;
    const element = "tagName" in node ? node : undefined;
    const tag = element?.tagName;
    if (tag !== undefined && UNREAD_TAGS.has(tag)) return;
    if (element !== undefined && tag === "img") {
      const image = exportImageOf(element, archivedNames, previousParagraphText);
      if (image !== undefined) images.push(image);
      return;
    }
    const isBlock = tag !== undefined && BLOCK_TAGS.has(tag);
    if (isBlock) endParagraph();
    for (const child of node.childNodes) walk(child);
    if (isBlock) endParagraph();
  };
  walk(parse(html));
  return images;
};

/** Google's zipped HTML export, its `<img>` in document order. `undefined`
 *  when the bytes are not a readable zip with an HTML part — an abstention,
 *  never a throw. */
export const readHtmlExport = async (zipBytes: Uint8Array): Promise<HtmlExport | undefined> => {
  try {
    const archive = await openArchive(zipBytes, unreadable, HTML_EXPORT_LIMITS);
    const htmlName = archive?.names.filter((name) => /\.html?$/i.test(name) && !name.includes("/")).sort()[0];
    if (archive === undefined || htmlName === undefined) return undefined;
    const htmlBytes = await archive.readBytes(htmlName);
    if (htmlBytes === undefined) return undefined;
    const archivedNames = new Set(archive.names);
    const images = htmlImagesOf(new TextDecoder("utf-8").decode(htmlBytes), archivedNames);
    return {
      images,
      bytesOf: (path) =>
        archivedNames.has(path) ? archive.readBytes(path).catch(() => undefined) : Promise.resolve(undefined),
    };
  } catch {
    // Bias (review of disguised failures, point 9, 06/10/2026): an unreadable export means our own SVG of the drawing is published instead of Google's
    // picture. The drawing stays on the page; only its look differs. No remark: nothing the admin can act on.
    return undefined;
  }
};

/** What a drawing of the .docx declares, to be found in the export. */
export interface DrawingProbe {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly previousText: string;
}

const sameSize = (probe: DrawingProbe, image: HtmlExportImage): boolean =>
  Math.abs(probe.widthPx - image.widthPx) <= SIZE_TOLERANCE_PX &&
  Math.abs(probe.heightPx - image.heightPx) <= SIZE_TOLERANCE_PX;

/**
 * For each drawing, THE image of the export it is, or `undefined`. A drawing
 * matches an image when both declare the same size AND the same paragraph
 * before them. Exactly one image for the drawing, and that image claimed by
 * no other drawing: two same-size drawings after the same paragraph (or two
 * candidate images) are told apart by nothing that either file declares, so
 * none is matched — the two readings disagree or say too little, we abstain.
 */
export const matchDrawings = (
  probes: readonly DrawingProbe[],
  images: readonly HtmlExportImage[],
): (HtmlExportImage | undefined)[] => {
  const candidates = probes.map((probe) =>
    images.filter((image) => sameSize(probe, image) && image.previousText === probe.previousText),
  );
  return candidates.map((ownCandidates, probeIndex) => {
    const only = ownCandidates.length === 1 ? ownCandidates[0] : undefined;
    if (only === undefined) return undefined;
    return candidates.some((otherCandidates, otherIndex) => otherIndex !== probeIndex && otherCandidates.includes(only))
      ? undefined
      : only;
  });
};

/** A drawing of ours that Google's image may replace: the picture we drew
 *  (voie B), its canvas, and the paragraph before it. */
export interface DrawingSlot {
  readonly picture: ImageRef;
  readonly canvas: DrawingCanvas;
  readonly previousText: string;
}

/** Marks a picture ref that is one of our drawings' until the export has
 *  answered; never survives `readDocx` (`docx-reader/index.ts#assertNoPendingRef`
 *  refuses every ref starting with `PENDING_REF`, which this one does). */
export const PENDING_DRAWING_REF = "\u0000pending:drawing:";

/** The drawings met while a story is walked, in the order they are met.
 *  `lastText`: the last non-empty paragraph read before the walk's current
 *  point — kept by `docx-reader/body.ts`. */
export interface DrawingLedger {
  lastText: string;
  readonly slots: DrawingSlot[];
  /** Registers one drawn picture and answers the pending ref standing for it. */
  place(picture: ImageRef, canvas: DrawingCanvas): ImageRef;
}

export const newDrawingLedger = (): DrawingLedger => {
  const slots: DrawingSlot[] = [];
  const ledger: DrawingLedger = {
    lastText: "",
    slots,
    place: (picture, canvas) => {
      slots.push({ picture, canvas, previousText: ledger.lastText });
      return { ...picture, sha256: `${PENDING_DRAWING_REF}${slots.length - 1}` };
    },
  };
  return ledger;
};

/** Where Google's export comes from. `htmlExport`: the zipped HTML export's
 *  bytes, or `undefined` when there is none to be trusted (too large, the
 *  Drive version moved, refused): asked ONLY when a drawing is drawn.
 *  `revisionKey`: the Drive revision the export was checked against. */
export interface GoogleDrawingSource {
  htmlExport: () => Promise<Uint8Array | undefined>;
  revisionKey: string;
}

/** Google's picture for a slot: the reference (its identity), its bytes. */
export interface GooglePicture {
  readonly ref: ImageRef;
  readonly bytes: Uint8Array;
}

/** The picture's identity in the IR: the hash of its own bytes, so a Drive
 *  version bump that leaves the drawing untouched (rename, sharing) keeps the
 *  same reference and the metadata-only fast path. The bias: if Google renders
 *  the same drawing differently from one export to the next, the page is
 *  republished — visible, never wrong. */
const identityOf = (bytes: Uint8Array): string => sha256Hex(bytes);

/** What a slot's drawing declares, in the export's CSS pixels. */
const probeOf = (slot: DrawingSlot): DrawingProbe => ({
  widthPx: slot.canvas.cx / EMU_PER_PX,
  heightPx: slot.canvas.cy / EMU_PER_PX,
  previousText: slot.previousText,
});

/** Google's picture for a matched image: its bytes, when they are a PNG with a readable width. */
const googlePictureOf = async (
  htmlExport: HtmlExport,
  match: HtmlExportImage | undefined,
): Promise<GooglePicture | undefined> => {
  if (match === undefined) return undefined;
  const bytes = await htmlExport.bytesOf(match.path);
  const pixelWidth = bytes === undefined || !isPng(bytes) ? undefined : imagePixelWidth(bytes);
  if (bytes === undefined || pixelWidth === undefined) return undefined;
  return { ref: { sha256: identityOf(bytes), mimeType: "image/png", pixelWidth }, bytes };
};

/** For each slot, Google's PNG when exactly one image of the export is that
 *  drawing, else `undefined`. No slot, no call. Anything that goes wrong on
 *  the way (the export, the archive, an image that is not a PNG with a
 *  readable width) is an abstention for the slots it touches. */
export const googlePictures = async (
  slots: readonly DrawingSlot[],
  source: GoogleDrawingSource,
): Promise<(GooglePicture | undefined)[]> => {
  const noPictures = slots.map(() => undefined);
  if (slots.length === 0) return noPictures;
  try {
    const exportBytes = await source.htmlExport();
    const htmlExport = exportBytes === undefined ? undefined : await readHtmlExport(exportBytes);
    if (htmlExport === undefined) return noPictures;
    const matches = matchDrawings(slots.map(probeOf), htmlExport.images);
    return await Promise.all(matches.map((match) => googlePictureOf(htmlExport, match)));
  } catch {
    // Same bias as the export reader above: our own SVG is published, the drawing is not lost.
    return noPictures;
  }
};
