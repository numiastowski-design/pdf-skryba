/** The shapes the PDF path passes around: a positioned item, the line it joins,
 *  the runs inside that line, the regions a page lays out, and what an
 *  extraction returns.
 *  NOT here: every decision taken ON these shapes (`extractor/pdf-*.ts`), nor
 *  the IR they end up in (`lib/ir.ts`).
 *  Called by: `extractor/pdf.ts` and the stages it wires together. */

import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import type { DocumentNotice, PdfTextUnreadReason, PictureRefusal } from "doc-ir/lib/reader-types";
import type { PdfTableDetection } from "doc-ir/layout/geometry";
import type { RawImage } from "doc-ir/extractor/raw-image";
import type { ExtractionCost } from "./extraction-cost";
import type { Fragment } from "doc-ir/layout/geometry";
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

/** Un item positionné : ce que tout le chemin PDF mesure, et le minimum qu'une
 *  ligne demande. */
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
  /** Les morceaux de la ligne, avec leur emphase. Une ligne ordinaire en a un
   *  seul ; une ligne qui mélange gras et maigre en a autant que de bascules.
   *  `text` reste leur concaténation — tous les prédicats bâtis dessus (mots
   *  lisibles, rythme, colonnes) continuent de le lire sans rien savoir du
   *  gras. */
  runs: TextRun[];
  /** Bords gauche et droit de la ligne, mesurés sur le TEXTE RÉEL. */
  left: number;
  right: number;
  /** Largeur EXACTE du premier mot de cette ligne, somme des avances de ses
   *  glyphes. Vaut 0 quand les glyphes ne sont pas disponibles — et cette
   *  valeur-là fait ABSTENIR, jamais décider. */
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
  /**
   * LE PLUS GRAND TROU À L'INTÉRIEUR DE LA LIGNE, en multiples du corps.
   *
   * C'est la signature d'une ligne de TABLEAU : quelques mots posés dans des
   * colonnes, donc de grands blancs entre eux. Une ligne de prose n'a que des
   * espaces mots, autour de 0,3 corps.
   *
   * Ajouté le 16/09/2026 pour le second chemin de titraille : sur un document
   * dont la grille n'est PAS détectée, « hors tableau » ne veut rien dire — il
   * n'y a pas de tableau à nos yeux. Ce trou-là, si.
   */
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

/** Un morceau de ligne : son texte, son emphase, et le MARQUEUR bitmap qu'il porte
 *  quand il y en a un. Un marqueur n'est jamais fusionné avec ses voisins. */
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

/** Une image prête à publier, et l'ordonnée où elle commence. */
export interface ImageAnchor {
  top: number;
  /** The image's bottom edge; its centre against the tables is judged before, in `renderPageTables`. */
  bottom?: number;
  xMin: number;
  /** Le bord droit ; absent, la région n'aura pas d'emprise et retombera sur
   *  l'ordre vertical seul — voir `PageRegion.box`. */
  xMax?: number;
  /** Les blocs posés à cette ancre, DANS L'ORDRE. */
  blocks: IRBlock[];
}

/** Une grande image repérée, pas encore lue : sa place, et de quoi la lire. */
export interface ImageCandidate {
  top: number;
  bottom: number;
  xMin: number;
  xMax: number;
  /** Reads the image and returns its blocks; `undefined` when unreadable. */
  read: () => IRBlock[] | undefined;
}

/** Un bloc posé dans la page : un tableau rendu ou une image. */
export interface PageRegion {
  top: number;
  /** Bas de la bande consommée ; égal à `top` pour une image, qui n'en consomme aucune. */
  bottom: number;
  /** Départage deux régions de même `top`, de gauche à droite. */
  xMin: number;
  blocks: IRBlock[];
  /** Vrai pour un tableau : les lignes de `[bottom ; top]` y sont déjà publiées. */
  consumesBand: boolean;
  /**
   * L'ORDONNÉE OÙ LE TEXTE BASCULE : au-dessus il passe avant la région, en
   * dessous il passe après. Pour un tableau, c'est son bord haut. Pour une
   * IMAGE, c'est sa **ligne médiane** (décision de 16/09/2026).
   *
   * Absent, `top` fait office — le comportement d'avant.
   */
  orderAt?: number;
  /**
   * L'EMPRISE RÉELLE, et elle ne se déduit pas de `top`/`bottom` : pour une
   * image `bottom` vaut `top` À DESSEIN, pour qu'aucune ligne posée dessus ne
   * soit jetée. C'est cette boîte-là qui sert à mesurer de quelle région une
   * ligne est la plus proche, et à savoir quelles régions sont CÔTE À CÔTE.
   *
   * Absente, la région n'a ni largeur ni hauteur : elle ne forme jamais de bande
   * avec une autre et n'attire aucune ligne de préférence. C'est exactement le
   * comportement d'avant le 16/09/2026.
   */
  box?: { top: number; bottom: number; xMin: number; xMax: number };
}

export interface PdfExtractResult {
  /** One entry per PDF page, in order — its pictures alone for a page reported in
   *  `scannedPageIndices` (nothing on a scan). Kept per-page (not pre-flattened) so a caller
   *  merging in OCR results for a mixed digital/scanned PDF can substitute
   *  the right pages without losing overall page order. */
  pages: IRBlock[][];
  scannedPageIndices: number[];
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
  /** Ce que cette extraction a COÛTÉ en travail — appels et volumes, jamais du
   *  temps. Sert de détecteur de régression déterministe (`extraction-cost.ts`).
   *  Rendu toujours ; personne n'est obligé de le lire. */
  cost: ExtractionCost;
  /** Les aplats de couleur rendus en SVG (écart 15). Absent quand le document
   *  n'en porte aucun — la très grande majorité des PDF. */
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
