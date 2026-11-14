/** D2 voie A (MIKSUDOC « Spécification fonctionnelle » §9.5): Google's own image of a
 *  Google Doc's drawing, read from the zipped HTML export and matched to the
 *  drawing by what BOTH files declare — its size and the paragraph before it.
 *  Exactly one match gives Google's PNG in place of our SVG (voie B); zero,
 *  several, or an export that cannot be read leave our SVG. Never a failure
 *  of the document.
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

/** ECMA-376 §20.4.2.7 (`wp:extent`, in EMU) against CSS pixels: 914 400 EMU
 *  per inch, 96 px per inch. Exact on both real specimens (Essai 11: 5 334 000
 *  x 895 350 EMU = 560 x 94 px; Essai 13: 5 943 600 x 2 819 400 = 624 x 296). */
export const EMU_PER_PX = 9_525;

/** How far apart, in px, the drawing's declared size and the export's `<img>`
 *  `style` may be and still be the same size. Starting value to calibrate:
 *  the two real specimens agree to 0 px (Essai 11 560/94, Essai 13 624/296),
 *  so this only forgives Google's own rounding of an EMU count to two
 *  decimals. Nothing measured of a size that differs by more. */
const SIZE_TOLERANCE_PX = 0.5;

/** The ceilings the export's archive is inflated under. Starting values to
 *  calibrate: Google itself caps a `files.export` at 10 MB (exportSizeLimit-
 *  Exceeded, refused by the adapter), so no honest part inflates past this;
 *  the package layer's own 64 / 256 MB are for Office files a user uploads. */
const HTML_EXPORT_LIMITS: PackageLimits = { partMaxBytes: 16_000_000, packageMaxBytes: 32_000_000 };

const unreadable = (): ReaderError => new ReaderError("EXTRACT_FAILED", "the Google Docs HTML export could not be opened");

/** One `<img>` of the HTML export that has a file and a declared size. */
export interface HtmlExportImage {
  /** Its path in the archive. */
  path: string;
  widthPx: number;
  heightPx: number;
  /** The text of the last non-empty paragraph that ENDS before the image's
   *  own paragraph (§5.3 : « le texte du paragraphe précédent »), or "". */
  previousText: string;
}

export interface HtmlExport {
  images: HtmlExportImage[];
  bytesOf(path: string): Promise<Uint8Array | undefined>;
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "table", "tr", "td", "th", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"]);
const UNREAD_TAGS = new Set(["head", "style", "script"]);

/** `style="… width: 560.00px; height: 94.00px …"` — the image's own declared
 *  size, never `max-width`. */
const declared = (style: string, property: "width" | "height"): number | undefined => {
  const m = new RegExp(`(?:^|;)\\s*${property}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(style);
  return m?.[1] === undefined ? undefined : Number(m[1]);
};

const attrOf = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

/** Google's zipped HTML export, its `<img>` in document order. `undefined`
 *  when the bytes are not a readable zip with an HTML part — an abstention,
 *  never a throw. */
export const readHtmlExport = async (zip: Uint8Array): Promise<HtmlExport | undefined> => {
  try {
    const archive = await openArchive(zip, unreadable, HTML_EXPORT_LIMITS);
    const htmlName = archive?.names.filter((n) => /\.html?$/i.test(n) && !n.includes("/")).sort()[0];
    if (archive === undefined || htmlName === undefined) return undefined;
    const htmlBytes = await archive.readBytes(htmlName);
    if (htmlBytes === undefined) return undefined;
    const present = new Set(archive.names);

    const images: HtmlExportImage[] = [];
    let current = "";
    let previous = "";
    const endParagraph = (): void => {
      const text = collapseBlanks(current);
      if (text !== "") previous = text;
      current = "";
    };
    const walk = (node: Node): void => {
      if (node.nodeName === "#text") {
        current += (node as DefaultTreeAdapterMap["textNode"]).value;
        return;
      }
      if (!("childNodes" in node)) return;
      const element = "tagName" in node ? (node as Element) : undefined;
      const tag = element?.tagName;
      if (tag !== undefined && UNREAD_TAGS.has(tag)) return;
      if (element !== undefined && tag === "img") {
        const src = attrOf(element, "src");
        const style = attrOf(element, "style") ?? "";
        const widthPx = declared(style, "width");
        const heightPx = declared(style, "height");
        const path = src === undefined ? undefined : posix.normalize(src);
        if (path !== undefined && present.has(path) && widthPx !== undefined && heightPx !== undefined) {
          images.push({ path, widthPx, heightPx, previousText: previous });
        }
        return;
      }
      const block = tag !== undefined && BLOCK_TAGS.has(tag);
      if (block) endParagraph();
      for (const child of node.childNodes) walk(child);
      if (block) endParagraph();
    };
    walk(parse(new TextDecoder("utf-8").decode(htmlBytes)));
    return { images, bytesOf: (path) => (present.has(path) ? archive.readBytes(path).catch(() => undefined) : Promise.resolve(undefined)) };
  } catch {
    // Bias (Relevé des échecs déguisés, point 9 (06/10/2026)): an unreadable export means our own SVG of the drawing is published instead of Google's
    // picture. The drawing stays on the page; only its look differs. No remark: nothing the admin can act on.
    return undefined;
  }
};

/** What a drawing of the .docx declares, to be found in the export. */
export interface DrawingProbe {
  widthPx: number;
  heightPx: number;
  previousText: string;
}

const sameSize = (probe: DrawingProbe, image: HtmlExportImage): boolean =>
  Math.abs(probe.widthPx - image.widthPx) <= SIZE_TOLERANCE_PX && Math.abs(probe.heightPx - image.heightPx) <= SIZE_TOLERANCE_PX;

/**
 * For each drawing, THE image of the export it is, or `undefined`. A drawing
 * matches an image when both declare the same size AND the same paragraph
 * before them. Exactly one image for the drawing, and that image claimed by
 * no other drawing: two same-size drawings after the same paragraph (or two
 * candidate images) are told apart by nothing that either file declares, so
 * none is matched — the two readings disagree or say too little, we abstain.
 */
export const matchDrawings = (probes: readonly DrawingProbe[], images: readonly HtmlExportImage[]): (HtmlExportImage | undefined)[] => {
  const candidates = probes.map((p) => images.filter((i) => sameSize(p, i) && i.previousText === p.previousText));
  return candidates.map((mine, k) => {
    const only = mine.length === 1 ? mine[0] : undefined;
    if (only === undefined) return undefined;
    return candidates.some((other, j) => j !== k && other.includes(only)) ? undefined : only;
  });
};

/** A drawing of ours that Google's image may replace: the picture we drew
 *  (voie B), its canvas, and the paragraph before it. */
export interface DrawingSlot {
  picture: ImageRef;
  canvas: DrawingCanvas;
  previousText: string;
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
  ref: ImageRef;
  bytes: Uint8Array;
}

/** The picture's identity in the IR: the hash of its own bytes, so a Drive
 *  version bump that leaves the drawing untouched (rename, sharing) keeps the
 *  same reference and the metadata-only fast path. The bias: if Google renders
 *  the same drawing differently from one export to the next, the page is
 *  republished — visible, never wrong. */
const identityOf = (bytes: Uint8Array): string => sha256Hex(bytes);

/** For each slot, Google's PNG when exactly one image of the export is that
 *  drawing, else `undefined`. No slot, no call. Anything that goes wrong on
 *  the way (the export, the archive, an image that is not a PNG with a
 *  readable width) is an abstention for the slots it touches. */
export const googlePictures = async (slots: readonly DrawingSlot[], source: GoogleDrawingSource): Promise<(GooglePicture | undefined)[]> => {
  const none = slots.map(() => undefined);
  if (slots.length === 0) return none;
  try {
    const zip = await source.htmlExport();
    const html = zip === undefined ? undefined : await readHtmlExport(zip);
    if (html === undefined) return none;
    const probes = slots.map((s): DrawingProbe => ({ widthPx: s.canvas.cx / EMU_PER_PX, heightPx: s.canvas.cy / EMU_PER_PX, previousText: s.previousText }));
    const matches = matchDrawings(probes, html.images);
    return await Promise.all(
      matches.map(async (match): Promise<GooglePicture | undefined> => {
        if (match === undefined) return undefined;
        const bytes = await html.bytesOf(match.path);
        const pixelWidth = bytes === undefined || !isPng(bytes) ? undefined : imagePixelWidth(bytes);
        if (bytes === undefined || pixelWidth === undefined) return undefined;
        return { ref: { sha256: identityOf(bytes), mimeType: "image/png", pixelWidth }, bytes };
      }),
    );
  } catch {
    // Same bias as the export reader above: our own SVG is published, the drawing is not lost.
    return none;
  }
};
