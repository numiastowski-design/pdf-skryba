/** The intermediate document every format is turned into and everything
 *  downstream reads: blocks, inline marks, tables and image references.
 *  NOT here: how each format produces it (`extractor/**`), what a model may do
 *  to it (`ports/ai.ts`), nor how it becomes a Confluence page
 *  (`renderer/storage.ts`).
 *  Called by: every extractor, the pipeline modules, `renderer/storage.ts`,
 *  `orchestrator/doc-processor.ts`, `lib/vision-port.ts`, `tools/structured/inventory.ts`. */

/**
 * IRDoc — the common intermediate document (MIKSUDOC « Spécification technique » §5.4, normative skeleton).
 * Central API between extractor, vision, ai and renderer. Refined field by field
 * in C1 via the golden corpus; structural changes require a spec amendment first.
 */

/** Reference to an image binary held in a payload (never inline bytes). */
export interface ImageRef {
  /** sha256 (hex) of the image's IDENTITY — the bytes themselves for every
   *  image but Google's slide picture, keyed by a revision-scoped string
   *  instead because Google may render the same revision into different
   *  bytes (extractor/pptx.ts#GoogleImage; revue du 25/09/2026, constat 7).
   *  Attachment naming is this whole string (core/attachment.ts). */
  sha256: string;
  /**
   * Storage reference of the bytes, `kvs:<key>` or `obj:<key>`. Absent right after
   * extraction (C1): the extractor is pure and never writes to storage — raw bytes
   * travel alongside the IRDoc, keyed by sha256, until the doc-processor (C2/C3)
   * persists them via StoragePort and fills this in. The renderer never needs it:
   * the rendered attachment macro references the sha256-derived filename, not this.
   */
  payloadRef?: string;
  mimeType: string;
  /** Original file name inside the source archive, when known. */
  sourceName?: string;
  /** Width the image is DRAWN at in its source document, in points (1/72 in),
   *  when the source states it — the PDF path, and a .docx or Google Doc's
   *  `wp:extent` (`extractor/docx-reader/objects.ts`). Not the width of the
   *  file in pixels: a 1 353-px banner is drawn 487 pt wide (fixture 24).
   *  Absent: the renderer writes no width at all, never an invented one. */
  widthPt?: number;
  /** The file's OWN width in pixels, as its header declares it (PNG, JPEG,
   *  GIF; `extractor/image-pixel-width.ts`). The page never draws an image
   *  wider than this: an upscaled screenshot is blurry (G2, Mikolaj
   *  24/09/2026). Absent (another format, or no drawn width to limit): the
   *  drawn width alone decides, as before. */
  pixelWidth?: number;
}

/** The Confluence section types a `columns` block can be written as (`ac:type`). Absent: the type is deduced from
 *  the NUMBER of cells, and it must match it — a `three_equal` holding four cells is degraded by Confluence into a
 *  `legacy-content` extension (MESURÉ le 04/11/2026, `docs/PLATFORM-STATUS.md`). */
export type ColumnsLayout =
  | "two_equal"
  | "three_equal"
  | "four_equal"
  | "five_equal"
  | "two_left_sidebar"
  | "two_right_sidebar"
  | "three_with_sidebars";

/** The role of a chart axis, not a screen direction: `x` the category axis (horizontal bars lay it vertically), `y` a value axis, `z` a series (depth) axis. */
export type ChartAxis = "x" | "y" | "z";

/** The components the chart macro can draw: vertical / horizontal bars, plain or stacked, lines, pie, donut. */
export type ChartDrawingType = "bar" | "stackBar" | "hBar" | "hStackBar" | "line" | "pie" | "donut";

/** What a native chart needs, besides its table, to be DRAWN by the macro: its type and, per series (the table's columns after the category
 *  column), the numbers as the chart shows them (`null`: a blank point), one per table row. Names and categories are the table's own words, so a
 *  translated table gives a translated drawing. Absent: the chart has no faithful component, the table stands alone. */
export interface ChartDrawing {
  type: ChartDrawingType;
  values: (number | null)[][];
}

/** Tabular data extracted from a native chart or a sheet. */
export interface TableData {
  /** Optional column headers (first row of the rendered table). */
  headers?: string[];
  rows: string[][];
}


/** `sup` / `sub`: superscript and subscript (24/09/2026, Google Doc lot) —
 *  kept by Confluence as `<sup>` / `<sub>` (docs/PLATFORM-STATUS.md §43).
 *  Produced by the Google Doc dialect only, so far. */
export type InlineMark = "strong" | "em" | "underline" | "strike" | "sup" | "sub";

/** OUR internal href forms — `drive:<id>` (minted by
 *  `pipeline/normalize-links.ts` from an http Drive URL) and `#<name>` (an
 *  anchor a reader minted itself). A reader must never take either from a
 *  FILE's own declared target: a file spelling one would reach the
 *  renderer's internal handling with a provenance it never had. A rule of
 *  PROVENANCE — the scheme guard is the renderer's
 *  (`lib/link-schemes.ts#PUBLISHED_SCHEME`, arbitrage of 28/09/2026). */
export const INTERNAL_HREF_FORM = /^(?:drive:|#)/i;

/** The blocks of a tab with nothing to show: one empty paragraph, as the editor writes one in an empty tab (page 50429973).
 *  A fresh array per call, so no two tabs share a list a later step could edit. */
export const emptyTabBlocks = (): IRBlock[] => [{ kind: "paragraph", inlines: [] }];

/** A diagram-text section as its paragraphs: cut where `breaks` says (only the indices strictly inside the inlines count,
 *  each once, in order, whatever the order written); no break, one paragraph. Nothing is dropped. */
export const diagramParagraphs = (section: DiagramTextSection): Inline[][] => {
  const cuts = [...new Set((section.breaks ?? []).filter((b) => b > 0 && b < section.inlines.length))].sort((a, b) => a - b);
  const edges = [0, ...cuts, section.inlines.length];
  return edges.slice(1).map((end, k) => section.inlines.slice(edges[k], end));
};

/** Between two elements of a diagram's text (decision (5 ter), 25/09/2026): pptx, and the SmartArt of a docx. */
export const DIAGRAM_TEXT_SEPARATOR = " · ";

/** Inline pieces joined by `separator`; empty pieces left out. */
export const joinedInlines = (pieces: readonly Inline[][], separator: string): Inline[] =>
  pieces.filter((p) => p.length > 0).flatMap((p, i) => (i === 0 ? p : [{ text: separator }, ...p]));

export interface Inline {
  /** Le texte de ce fragment. **Toujours obligatoire, même porteur d'une
   *  image** : c'est lui que lisent la recherche, le texte de remplacement et
   *  tout consommateur qui ne sait pas rendre d'image. Une phrase reste donc
   *  lisible en entier quoi qu'il arrive à l'illustration. */
  text: string;
  marks?: InlineMark[];
  /** The colour of the TEXT, exactly as the FILE states it: a `#rrggbb`, or a colour keyword the file names
   *  (`w:highlight` writes « yellow », not a value). NEVER a colour we worked out: a theme reference is left out
   *  rather than resolved, because resolving it means a correspondence table of our own, which Mikolaj refuses
   *  (14/09/2026 : « je veux pas de table de correspondance pour les couleurs »). Published since 10/11/2026
   *  (« du coup ne les jetons plus ») — Rovo reads colour and highlight, measured by Mikolaj the same day. */
  color?: string;
  /** The colour BEHIND the text (`w:highlight`, or the shading fill the file gives), under the same rule as `color`. */
  background?: string;
  /** External href, or internal link target as `drive:<sourceFileId>` (rewritten by renderer),
   *  or `#<name>`: a link to the anchor `<name>` of this same page (see `anchor`). */
  href?: string;
  /** This inline IS an anchor target named `<name>`, with empty `text`: the
   *  renderer writes Confluence's `anchor` macro in its place, the target of
   *  `#<name>` links (docx bookmarks, checkpoint A). Only anchors some link
   *  targets are written. */
  anchor?: string;
  /**
   * UNE IMAGE **DANS** LA LIGNE DE TEXTE, pas à côté (11/09/2026).
   *
   * POURQUOI CE CHAMP EXISTE. La légende d'un bulletin porte sa clé dans des
   * pastilles colorées, chacune contenant son chiffre, collée à son libellé :
   * « ⓸ Très bonne maîtrise ⓷ Maîtrise satisfaisante … ». Mesuré sur le document
   * réel, les cinq disques sont sur une seule ligne de base, et **le chiffre est
   * à l'intérieur du disque**, pas à côté. Un bloc `image` ne peut pas rendre
   * ça : il occupe sa propre ligne et casserait la phrase en morceaux.
   *
   * CE QUE LE RENDU EN FAIT. L'image REMPLACE le texte de ce fragment, qui
   * devient son texte de remplacement — sans quoi le chiffre s'afficherait deux
   * fois, une fois dans la pastille et une fois à côté. Le texte reste donc
   * présent dans le document intermédiaire pour tous ceux qui ne rendent pas
   * l'image.
   */
  image?: ImageRef;
}

/** A paragraph's alignment, when its source DECLARES one the page keeps
 *  (checkpoint A, Mikolaj 24/09/2026): Confluence keeps center and right,
 *  and left is its default (docs/PLATFORM-STATUS.md §42/§43). Written only by
 *  formats that declare it (docx `w:jc`) — never inferred from a PDF's
 *  geometry. Absent: the renderer writes nothing. */
export type BlockAlign = "right" | "center";

export type IRBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[]; align?: BlockAlign }
  /** `size: "small"`: Confluence's « Small text », a paragraph smaller than the body of its page (notes of a PDF column;
   *  PLATFORM-STATUS §92, 05/11/2026). Written `<p data-font-size="small">`. */
  | { kind: "paragraph"; inlines: Inline[]; align?: BlockAlign; size?: "small" }
  /** `start`: only meaningful for `ordered` — an explicit restart point (docx
   *  `<w:numPr>` renumbering, HTML `<ol start="N">`), confirmed live
   *  (04/09/2026, l'audit de fidélité du 04/09/2026 (historique git)) to render correctly
   *  in Confluence storage format (`<ol start>` passes through untouched to
   *  the rendered view — standard HTML, nothing Confluence-specific to
   *  implement). Omitted means "start at 1", never written as `1` itself. */
  | { kind: "list"; ordered: boolean; items: IRBlock[][]; start?: number }
  | {
      kind: "table";
      /** `"image"`: the table is as wide as the image its first cell opens with (the figure of a PDF page, lifted out of
       *  its columns with its caption — Mikolaj, 05/11/2026). Written `data-table-width` + `align-start`. */
      width?: "image";
      /** `true`: a one-cell table born from a closed rectangle DRAWN around a block of a PDF column (the boxed masthead of a
       *  bulletin; `extractor/pdf-framed-blocks.ts`, 06/11/2026). THE ONLY table the renderer keeps nested inside a cell:
       *  every other nested table is flattened for Confluence search (`renderer/storage.ts#flattenTableCellBlocks`, decision
       *  of 29/09/2026, which the .docx readers rely on). Written by the PDF reader only, under its `framed` option.
       *  ⚠️ Confluence stores it as a `nested-table` migration extension, not a native table (measured 06/11/2026,
       *  PLATFORM-STATUS §97): the variant is stopped pending Mikolaj's decision. */
      framed?: true;
      rows: {
        cells: { blocks: IRBlock[]; colspan?: number; rowspan?: number; header?: boolean }[];
      }[];
      /** Largeurs RELATIVES des colonnes, une par colonne de la grille.
       *
       *  L'unité n'a aucune importance — seules les proportions comptent, et
       *  c'est le générateur qui les traduit dans l'unité de Confluence. Pour
       *  un PDF, ce sont les écarts entre frontières de colonne, en points.
       *
       *  POURQUOI CE CHAMP EXISTE (10/09/2026). Sans lui, Confluence répartit
       *  les colonnes à peu près également. Sur un bulletin où la colonne des
       *  appréciations occupe les deux tiers de la largeur, son texte se replie
       *  à un mot par ligne pendant qu'une colonne vide reçoit autant de place.
       *  **Ce n'est ni une valeur fausse ni une valeur perdue : c'est une
       *  proportion perdue**, et elle est déjà mesurée par la grille.
       *
       *  OPTIONNEL, ET C'EST CE QUI REND LE CHANGEMENT ADDITIF : un extracteur
       *  qui ne mesure pas de géométrie (xlsx, docx, gdoc, html) ne l'écrit
       *  pas, et son rendu ne bouge pas d'un octet. */
      columnWidths?: number[];
    }
  /** `alt` is the source document's own alt text, published with the picture. (A `vision` text, read by AI from the picture and
   *  published in a collapsed block, was removed on 19/10/2026: no producer since 17/09/2026, collapsed blocks dropped everywhere.) */
  | { kind: "image"; ref: ImageRef; alt?: string }
  | { kind: "chart"; image?: ImageRef; data: TableData; title?: string; /** Set by the chart reader when the macro can draw this chart (`core/chart-macro.ts`). */ drawing?: ChartDrawing; /** Axis titles NOT carried by the table's top-left cell, in document order: each is published as a labelled line under the table
   *  (`page-messages.ts#chartAxisLine`); `x` the category axis (or a scatter's horizontal value axis), `y` a value axis, `z` a series (depth) axis. */ axisTitles?: { axis: ChartAxis; text: string }[] }
  | { kind: "footnote"; id: string; blocks: IRBlock[] }
  /**
   * TWO OR THREE BLOCKS SIDE BY SIDE, and nothing more.
   *
   * WHY IT IS NOT A TABLE. It is condition 15-004 of the Matterhorn protocol, "Content is tagged as a table for information that is not
   * organized in rows and columns", a human-judgement checkpoint that no downstream machine can recover. A screen reader announces a table
   * and reads each cell with a row and column context that does not exist here. A bordered table would not be wrong on the CONTENT, it
   * would be wrong on the NATURE, and silently so (`docs/MATTERHORN-CIBLES.md` [purged 27/09/2026, git history]).
   *
   * The renderer writes it as a Confluence layout section, but only for a TOP-LEVEL block (`renderTopLevel` in `renderer/storage.ts`): since
   * `ac:layout` must be a top-level element, ONE such block makes the whole page body wrapped (see `renderStorageFormat`); a page that
   * carries none does not move by a byte. Below the top level (a cell, a list item, a note, a section) the cells are flattened, cell after
   * cell.
   */
  | { kind: "columns"; cells: IRBlock[][]; layout?: ColumnsLayout }
  | { kind: "equation"; image?: ImageRef; text: string }
  /** The source's table of contents, as a place and nothing more: its entries
   *  and page numbers are the source's rendering of its own headings, and the
   *  page rebuilds them from ITS headings (Confluence `toc` macro,
   *  the docx reader (`extractor/docx-reader/`)). */
  | { kind: "toc" }
  /** A titled part of the page (workbook tab). */
  | { kind: "section"; title?: string; blocks: IRBlock[] }
  /** Tabs of the page, one per slide of a presentation (Mikolaj 25/09/2026:
   *  a slide is a native Confluence tab, docs/PLATFORM-STATUS.md §47). `title`
   *  is the tab's label; `blocks` its content, heading included. */
  | { kind: "tabs"; tabs: IRTab[] }
  /** The text of the slides drawn as our SVG. NOT published (Mikolaj, 19/10/2026: no collapsed block
   *  on a page any more): it feeds the conservation control, which EXCUSES these words (a diagram is published as a drawing only, Mikolaj
   *  22/10/2026: its drawn words are not lost), and the language detection. One SECTION per diagram slide: its
   *  `label` (« Slide N », a page label: `core/page-messages.ts`), then its
   *  text as ONE paragraph — or one per chain of relations when the slide's
   *  connectors give an order (`breaks`) — each element's text joined by « · »
   *  (decision (5 ter), Mikolaj 25/09/2026). ONE block for the whole deck, at page
   *  level after the tabs (Mikolaj, 29/09/2026; option A of 27/09 already
   *  put them there, one per slide). A section without a
   *  label only lives inside a tab, before the extractor gathers them. */
  | { kind: "diagramText"; sections: DiagramTextSection[] };

/** A table block of the IR (06/11/2026: named for the column-table test and the readers of one-row column bands). */
export type IRTable = Extract<IRBlock, { kind: "table" }>;

/** One section of a `diagramText` block. `breaks`: the indices in `inlines`
 *  where a new paragraph starts (strictly increasing, each above 0) — one
 *  paragraph per chain of relations of a diagram
 *  (`layout/diagram-graph.ts`); a paragraph break is not a character, so the
 *  diagram text never gains one. Absent: the whole section is one paragraph. It stays
 *  beside `inlines` rather than splitting them so that every walk over the
 *  inlines (links, language, translation) is unchanged. */
export interface DiagramTextSection {
  label?: string;
  /** The slide the section comes from: when present the renderer labels it from the number in the page language, `label`
   *  being the fallback (Mikolaj, 08/10/2026). */
  slideNumber?: number;
  inlines: Inline[];
  breaks?: number[];
  /** A SmartArt's outline: the level of each paragraph in the model's tree (`extractor/smartart.ts#dataModelPieces`), one
   *  per paragraph `breaks` cuts, 0 for the first level. ITS PRESENCE IS WHAT PUBLISHES THE SECTION, as the nested bullet
   *  list Word stores behind the picture (Mikolaj, 29/10/2026: « si c'est en fait des listes à puces dans Word derrière le
   *  SmartArt, alors why not »); a slide's section carries none and stays off the page. All zeros when the model is not a
   *  tree: a flat list invents no structure. */
  levels?: number[];
  /** The words of a SmartArt's data model that its picture does not carry (`extractor/smartart-drawing.ts#undrawnWords`): a shape the
   *  drawer leaves out, a drawing kept out, a model richer than the saved drawing. The control counts them `smartart-not-drawn`, whereas
   *  the other words of the section are excused. Words as `lib/words.ts#wordsOf` cuts them. A SmartArt with NO drawing lists all its model
   *  words here (they are nowhere on the page, decided 22/10/2026). */
  undrawn?: string[];
  /** The arrows of a diagram whose order we cannot give (hubs: a shape with
   *  several incoming arrows), one per target, published after the
   *  paragraphs as « target ← source, source » (`diagramRelationLine`,
   *  `core/page-messages.ts`). Names only (a shape's first line, plain
   *  text): every word of the diagram is already in `inlines`, so a walk over
   *  the inlines (links, language) misses nothing. Decision of Mikolaj,
   *  02/10/2026. */
  relations?: DiagramRelation[];
}

/** One target of a diagram and the shapes whose arrows point at it. */
export interface DiagramRelation {
  target: string;
  sources: string[];
}

/** One tab. A presentation's tab carries `slideNumber`, a PDF's tab `pageNumber`; never both. With either, `title` is only the
 *  extraction-time fallback: the renderer writes the label from the rank. */
export type IRTab = {
  title: string;
  blocks: IRBlock[];
} & (
  | {
      /** A presentation's slide number (rank among the published slides). When present the renderer writes the label in the
       *  PAGE language from it (`slideTabTitle`) and `title` is only the extraction-time fallback (Mikolaj, 08/10/2026). */
      slideNumber?: number;
      pageNumber?: never;
    }
  | {
      /** A PDF's page tab: its rank among the published tabs (1, 2, 3…), written `pdfPageTabTitle` in the page language. */
      pageNumber?: number;
      slideNumber?: never;
    }
);

export interface IRDoc {
  /** BCP-47, detected programmatically (no AI). */
  lang?: string;
  blocks: IRBlock[];
}
