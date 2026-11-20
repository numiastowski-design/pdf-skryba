/** The shapes the PDF path passes around: a positioned item, the line it joins,
 *  the runs inside that line, the regions a page lays out, and what an
 *  extraction returns.
 *  NOT here: every decision taken ON these shapes (`extractor/pdf-*.ts`), nor
 *  the IR they end up in (`lib/ir.ts`).
 *  Called by: `extractor/pdf.ts` and the stages it wires together. */

import type { ImageRef, IRBlock } from "doc-ir";
import type { DocumentNotice, PdfTextUnreadReason, PictureRefusal } from "doc-ir";
import type { PdfTableDetection } from "../layout/geometry";
import type { RawImage } from "doc-ir/internal";
import type { ExtractionCost } from "./extraction-cost";
import type { Fragment } from "../layout/geometry";
import type { PdfDocumentFacts } from "./pdf-facts";
import type { PdfReferenceCycle, PdfTextRun } from "./pdf-source";

/** The geometry-only view of a text run: what the layout rules (grids, gutters) read. */
export const toFragment = (r: PdfTextRun): Fragment => ({
  text: r.text,
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
});

export type PositionedItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  /** The parts of `text` a link covers (`pdf-links.ts`). Absent on an item without a link. */
  links?: readonly PdfLinkSpan[];
  /** Italic, from the font (`pdf-source.ts#PdfTextRun.italic`). Absent on an item whose font said nothing. */
  italic?: boolean;
  /** Written in a turned direction (`pdf-source.ts#PdfTextRun.rotated`): a line of its own in the page flow, never part of a
   *  horizontal line (`pdf-lines.ts#groupItemsIntoLines`, 06/11/2026). Absent on an item that says nothing: horizontal. */
  rotated?: boolean;
};

/** `text.slice(start, end)` of an item carries `href`. */
/** One placement lost on a page: the PDF object the picture is (or its resource name, when our reader gave no object)
 *  and WHY it was refused (`lib/reader-types.ts#PictureRefusal`). The PAGE NUMBER is added by the caller, which alone
 *  knows it (`extractor/pdf.ts`). Declared here and not beside one of its three writers, so that the figures
 *  (`pdf-page-figures.ts`) and the detector (`pdf-table-detector.ts`) do not have to import each other. */
export interface LostPlace {
  readonly id: string;
  readonly why: PictureRefusal;
}

export interface PdfLinkSpan {
  start: number;
  end: number;
  href: string;
}

export interface Line {
  y: number;
  fontSize: number;
  text: string;
  /** The pieces of the line, with their emphasis: one per change of emphasis. `text` stays their concatenation, so the
   *  predicates built on it read it without knowing about bold. */
  runs: TextRun[];
  /** Left and right edges, measured on the real text. */
  left: number;
  right: number;
  /** Exact width of the line's first word, the sum of its glyph advances. 0 when glyphs are not available: that
   *  value makes a rule abstain, never decide. */
  firstWordWidth: number;
  /**
   * ESTIMATED width of this line's first word, from the text run that
   * starts the line: `run.width × wordChars / runChars`. Absent when the line
   * has no real text.
   *
   * Read by ONE decision only — whether two centred lines are a wrap
   * (`pdf-line-breaks.ts#continuesCentredLine`). Everything else keeps
   * `firstWordWidth`, which abstains without glyphs. The estimate was added on
   * 21/09/2026, when 68 fixture pages had no glyph advances (non-zero Tc/Tw and
   * TD, refused by `glyph-positions.ts` until 22/09/2026) and 52 of the 70
   * measured centred pairs sat on those pages. Those pages have glyphs now; the
   * estimate stays, and whether it is still needed is not measured.
   */
  firstWordEstimate?: number;
  /** The widest gap inside the line, in body sizes: the signature of a table row, readable even when no grid was
   *  detected. A prose line only has word spaces. */
  maxInnerGap: number;
  /** Where the text resumes after that widest inner gap — the start of the
   *  VALUE on a label/value line (`pdf-line-breaks.ts#valueColumnStarts`).
   *  Absent when the line has no inner gap. */
  valueStart?: number;
  /** The line's first real item, and where the next real item starts. On
   *  « 1.<tab>text » it gives where an item's TEXT starts, one of the two
   *  readings of `layout/list.ts#itemTextLeft`. Absent with fewer than two real
   *  items. */
  lead?: { text: string; nextLeft: number };
}

/** A piece of a line. One that carries a bitmap `marker` is never merged with its neighbours. */
export interface TextRun {
  text: string;
  bold: boolean;
  /** Italic (`em` at publication). Absent when upright. */
  italic?: boolean;
  marker?: ImageRef;
  /** The link this piece carries (`pdf-links.ts`). Two pieces merge only when they carry the same one. */
  href?: string;
  /** A note call or an ordinal suffix raised above its line (`pdf-lines.ts#isRaisedCall`): published as a `sup` inline, so it is a token of its own for a search. */
  sup?: boolean;
}

/** An image ready to publish, and the ordinate where it starts. */
export interface ImageAnchor {
  top: number;
  /** The image's bottom edge; its centre against the tables is judged before, in `renderPageTables`. */
  bottom?: number;
  xMin: number;
  /** The right edge; absent, the region has no box and falls back on vertical order alone (`PageRegion.box`). */
  xMax?: number;
  blocks: IRBlock[];
}

/** A large image located, not read yet. */
export interface ImageCandidate {
  top: number;
  bottom: number;
  xMin: number;
  xMax: number;
  /** Reads the image and returns its blocks; `undefined` when unreadable. */
  read: () => IRBlock[] | undefined;
}

/** A block placed in the page: a rendered table or an image. */
export interface PageRegion {
  top: number;
  /** Bottom of the band consumed; equal to `top` for an image, which consumes none. */
  bottom: number;
  /** Orders two regions of the same `top`, left to right. */
  xMin: number;
  blocks: IRBlock[];
  /** True for a table: the lines of `[bottom ; top]` are already published in it. */
  consumesBand: boolean;
  /** The ordinate where the text switches sides: above it goes before the region, below it goes after. A table's top
   *  edge; an image's middle line. Absent, `top` is used. */
  orderAt?: number;
  /** The real box, which `top`/`bottom` do not give: for an image `bottom` equals `top` on purpose, so that no line
   *  laid over it is dropped. It tells which region a line is closest to and which regions sit side by side.
   *  Absent, the region never forms a band with another and attracts no line. */
  box?: { top: number; bottom: number; xMin: number; xMax: number };
}

export interface PdfExtractResult {
  /** One entry per PDF page, in order — its pictures alone for a page reported in
   *  `scannedPageIndices` (nothing on a scan). Kept per-page (not pre-flattened) so a caller
   *  merging in OCR results for a mixed digital/scanned PDF can substitute
   *  the right pages without losing overall page order. */
  pages: IRBlock[][];
  scannedPageIndices: number[];
  /** ZERO-based pages where at least one one-column grid region was published FLAT by the 26/10/2026 rule
   *  (`pdf-table-render.ts#flatOneColumnRegion`): sorted, without duplicates, empty when none. A trace for the bench,
   *  which tells a DECIDED flattening from a missed table (03/11/2026): it changes nothing published — neither the
   *  page, nor the notices, nor anything `tools/pdf-output-hash.ts` hashes. */
  flattenedGridPages: readonly number[];
  /** At most one `pdf-image-unread` notice (a placed image could not be obtained), one `pdf-text-unread` notice per reason
   *  (a page's text could not be read), one `table-withheld`; absent when there is none. */
  notices?: DocumentNotice[];
  /** Per page, the placed images no reader could obtain, by cause: `extractPdfWithVision` leaves out the pages the
   *  AI's text replaced and composes the notice again (`pdfImageUnreadNotices`). */
  imageLossByPage: ReadonlyMap<number, { slow: number; unreadable: number; places: readonly LostPlace[] }>;
  /** 0-based page -> why its glyphs could not be built (`pdf-source.ts#textUnreadReasonOf`): the page is published WITHOUT
   *  its text; or `font` (17/11/2026), a page that shows glyphs of a font we could not read and lost those words only. `extractPdfWithVision` leaves out the pages the AI's text replaced and composes the notice again
   *  (`pdfTextUnreadNotices`). Empty when every page was read. */
  textUnreadByPage: ReadonlyMap<number, PdfTextUnreadReason>;
  /** What the file says about itself, reduced (`pdf-facts.ts`): tool from our table, versions, tagging, page count. */
  docFacts: PdfDocumentFacts;
  /** What this extraction cost in work: calls and volumes, never time, so that it is a deterministic regression
   *  detector (`extraction-cost.ts`). */
  cost: ExtractionCost;
  /** The images the extraction carries. Absent when the document has none. */
  images?: RawImage[];
  /** For each image of the document in `images` (by sha256), the pages that placed it; the markers we make are not
   *  in it. Present with `images`. `extractPdfWithVision` reads it to leave out the images of the pages the AI's text
   *  replaced (07/10/2026). */
  pagesOfImage?: ReadonlyMap<string, ReadonlySet<number>>;
  /** The pages whose text is an INVISIBLE layer under a full-page scan (an OCR layer). Since 05/10/2026 one of them makes
   *  the whole PDF a scan (`pdf-scanned.ts`): the layer is never published. Never in `scannedPageIndices` (which holds the
   *  pages with no text at all). Absent when none. */
  ocrLayerPageIndices?: number[];
  /** MIKSUDOC « Spécification technique » §5.4.1, régime 1 — one entry per
   *  page carrying a table candidate, whether or not it actually rendered
   *  as a real table (a conservation-invariant violation falls back to
   *  flat text — §8's own rule, "violation → repli texte plat +
   *  signalement", never a silent one — without clearing this signal). */
  tableDetections?: PdfTableDetection[];
  /** The text runs as `readPdfSource` read them, one list per page, and those
   *  this extraction removed as page furniture. Handed on so the
   *  text-conservation check (`pipeline/text-conservation.ts`) compares the
   *  render with the document without reading the PDF a second time.
   *  `deliberateRemovals`: the texts the extraction dropped ON PURPOSE — the
   *  collapsed paintings of a merged table header, the repeated header row of
   *  a continued table — one entry per removed copy, in memory only.
   *  `deliberateRemovalsByPage`: the removals made INSIDE a page (a table header painted several times, a table withheld), by
   *  the page that made them; the removals across pages (a joined table) are in no page. The tab layout's check reads it. */
  textSource: {
    runs: TextSourceRun[][];
    deliberateRemovals: string[];
    deliberateRemovalsByPage: string[][];
    /** The second reading of the letters control (`pipeline/letter-conservation.ts`): the cycles of every page (read from our glyphs; pdf.js's before its removal), with the tree order
     *  of the pages published in it and the pages that rest on the cycles alone. */
    reference: {
      pages: PdfReferenceCycle[][];
      structureOrderByPage?: Map<number, string[]>;
      singleReadingPages?: Set<number>;
      /** 0-based page -> the bands (top/bottom, y up) of the tables the table stage rendered: the letters control judges the order of the prose outside them. */
      tableBandsByPage?: Map<number, { top: number; bottom: number }[]>;
    };
  };
}

/** A text run reduced to its text and geometry. Internal handles (the
 *  font name pdf.js gave) are left behind: they differ from one opening of the
 *  same bytes to the next, and the extraction result must not. */
export interface TextSourceRun {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}
