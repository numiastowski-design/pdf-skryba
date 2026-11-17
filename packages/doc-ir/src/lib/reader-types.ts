/** The shapes a reading reports about a document, for whoever shows or stores them: the language a page's labels are written in, the
 *  notices an extraction raises (what it could not read or publish), the tools a PDF names, and the results of the two fidelity controls
 *  (words, structure). A LEAF module: it imports nothing.
 *  NOT here: how any of them is produced (`extractor/`, `pipeline/`), how the app stores them (`core/entities.ts` holds the synced
 *  document and every other entity), nor which labels go on a page (`core/page-messages.ts`).
 *  Called by: `extractor/` and `pipeline/` (type imports), and `core/entities.ts`, which re-exports every type here so the
 *  app's own imports of them are unchanged. */

/** The ONE language a connection's pages are written in (features/page-language.feature,
 *  30/09/2026): the labels the app puts on a page and the numbers and
 *  dates of spreadsheets. Not the dashboard's language (`context.locale`).
 *  A setting, prefilled from the admin's locale, because no API gives the site's
 *  indexing language; `systemInfo.defaultLocale` was dropped: its scope
 *  (`manage:confluence-configuration`) is absent from the manifest, adding one
 *  is a MAJOR version, and the value was never observed. */
export type PageLanguage = "fr" | "en";

/** A class-1 "remark" (docs/CONCEPTION-CARTE-ET-REMARQUES.md lot A
 *  29/09/2026): a fact an extraction produced that used to be a marker line
 *  ON the published page — moved off it entirely (the owner rule: the app
 *  adds nothing to a page, not even a banner since 30/09/2026). One entry per occurrence, carried
 *  by `extractor/dispatch.ts#ExtractionResult.notices` into
 *  `SyncedDocument.notices`, never read by anything that decides what to
 *  publish. Every field is a technical identifier (a slide number, a reason
 *  code) — except a SHEET NAME, which IS client text: bounded (at most
 *  `MAX_NOTICE_SHEET_NAME_CHARS` characters, `MAX_NOTICE_SHEET_NAMES` names,
 *  `lib/reader-limits.ts`), shown on the dashboard only, never on a page.
 *  The dashboard puts the rest in words with its own translated labels, one
 *  lookup per `kind`. A notice list is BOUNDED whatever the document: the
 *  per-shape kinds are FOLDED into one entry per (slide, what/reason) with a
 *  `count` (a deck of 21 × 500 frames once made ~10 500 entries, ~800 KB,
 *  past Forge's value limit — the record's write failed after the page was
 *  published, 30/09/2026).
 *  The `what`/`reason` literal unions mirror `extractor/pptx-reader/picture.ts#PptxPictureNotPublished`
 *  and `extractor/slide-svg.ts#PictureNotDrawn` — duplicated rather than
 *  imported, to keep this file a leaf (it imports nothing); a mismatch fails the type check at
 *  the one call site that builds each notice. */
export type DocumentNotice =
  /** `extractor/pptx.ts`: a chart/SmartArt/embedded-object/other graphic
   *  frame this app cannot convert ("converted"), or a picture this app
   *  cannot publish ("published") — the marker that used to stand for it on
   *  the slide. */
  | {
      kind: "unsupported-element";
      slide: number;
      what:
        | "chart"
        | "smartart"
        | "ole"
        | "other"
        | "external-link"
        | "missing-part"
        | "damaged-part"
        | "video-or-audio"
        | "cropped-unsupported";
      outcome: "converted" | "published";
      /** How many frames/pictures of this slide fold into this entry (>= 1). */
      count: number;
    }
  /** `extractor/pptx.ts`: a picture a diagram slide's own SVG drawing leaves
   *  out — the drawing still publishes, this picture alone is missing from it. */
  | {
      kind: "picture-not-drawn";
      slide: number;
      reason:
        | "external-link"
        | "missing-part"
        | "damaged-part"
        | "video-or-audio"
        | "cropped-unsupported"
        | "format"
        | "over-cap"
        | "group-stretched"
        | "no-box";
      /** How many pictures of this slide fold into this entry (>= 1). */
      count: number;
    }
  /** `extractor/pptx.ts`: the display cap (`MAX_PRESENTATION_TABS`) — slides
   *  `from`..`to` (1-based, inclusive) are not published at all. */
  | { kind: "tab-cap"; from: number; to: number }
  /** `extractor/pptx.ts` (A7, 29/09/2026): a slide past `MAX_SLIDE_ELEMENTS`
   *  carries no tab at all — the other slides keep their real numbers. */
  | { kind: "slide-withheld"; slide: number; elementCount: number }
  /** `extractor/xlsx.ts`, `extractor/google-sheet.ts` (A7): a sheet past
   *  `MAX_SHEET_ROWS`/`MAX_SHEET_COLS` carries no tab at all. */
  | { kind: "sheet-withheld"; sheet: string; rows: number; cols: number }
  /** `lib/table-width-cap.ts` (08/10/2026): tables wider than `MAX_TABLE_COLS` (grid columns, after the empty ones are
   *  removed) or longer than `MAX_TABLE_ROWS` are not published. One entry per document, `count` >= 1, absent at 0. */
  | { kind: "table-withheld"; count: number }
  /** `extractor/xlsx.ts`, `extractor/google-sheet.ts`: the workbook tab cap
   *  (`MAX_WORKBOOK_TABS`) — these sheets are not published at all. `sheets`
   *  holds at most `MAX_NOTICE_SHEET_NAMES` names (each cut to
   *  `MAX_NOTICE_SHEET_NAME_CHARS`); `more` counts the others. */
  | { kind: "workbook-cap"; sheets: string[]; more: number }
  /** `extractor/sheet-workbook.ts` (decision of 08/10/2026: a missing part is said): visible sheets whose worksheet part is
   *  absent from the archive carry no tab. Same shape and bounds as `workbook-cap`; one entry per document. */
  | { kind: "sheet-unreadable"; sheets: string[]; more: number }
  /** `extractor/xlsx.ts`: formula cells the file carries no cached value for
   *  (decision (f)) — left empty on the published table, never invented. */
  | { kind: "formula-cells-empty"; sheet: string; count: number }
  /** `extractor/docx-reader/`: Word fields of the body with no computed result (no « separate », or an empty w:fldSimple)
   *  — published empty, never invented. One entry per document, `count` >= 1. */
  | { kind: "field-results-empty"; count: number }
  /** `orchestrator/doc-processor.ts`: pictures the rendered page references
   *  but the extraction handed over no bytes for (not resolved, not uploaded)
   *  — the page carries none of them. One entry per document, `count` >= 1. */
  | { kind: "image-missing"; count: number }
  /** `extractor/docx-reader/`: charts kept out whole — past a bound (series, points, levels, cells) or in a damaged
   *  part. Their title and labels are not on the page. One entry per document, `count` >= 1. */
  | { kind: "chart-withheld"; count: number }
  /** `extractor/docx-reader/`, `extractor/google-sheet.ts` (08/10/2026): hidden content the reader drops, said by
   *  its count only, never its content — `shape`: hidden drawings (each counts 1, text box included); `filtered-rows`:
   *  non-empty rows a sheet filter hides; `tracked-deletion`: tracked deletions (`w:del`) holding text. One entry per
   *  document and per `what`, `count` >= 1. */
  | { kind: "hidden-dropped"; what: "shape" | "filtered-rows" | "tracked-deletion"; count: number }
  /** `extractor/pdf.ts`: images a PDF page places but the extraction could not obtain — `slow` were not delivered
   *  in time, `unreadable` failed any other way. The page is published without them, nothing drawn in their place.
   *  `places` NAMES them (03/11/2026: « est-ce que notre compteur sait dire les images qu'on manque ? »): the
   *  page number, counted from 1, and a TECHNICAL id — the PDF object (`103R`) when our reader gave one, else the
   *  resource name the page uses (`X0`). NO CLIENT CONTENT: an id and a page number are what a count needs to be
   *  checked by eye. Each place also says WHY, in the eight words of `extractor/pdf-image-refusal.ts` — read from what
   *  the picture declares, never a message a decoder hands back, and `bytes` is the honest residue (every declaration
   *  is one we read, the reading failed all the same). At most `MAX_NOTICE_IMAGE_PLACES` places, in page order, the
   *  rest counted in `more`.
   *  One entry per document, `slow + unreadable` >= 1. */
  | {
      kind: "pdf-image-unread";
      slow: number;
      unreadable: number;
      places: readonly { page: number; id: string; why: PictureRefusal }[];
      more: number;
    }
  /** `extractor/pdf.ts` (16/11/2026): pages whose glyphs could not be built, published WITHOUT their text (their pictures
   *  alone, or empty) — or, for the reason `font` (17/11/2026), pages missing the words of one font only. One entry per `reason`, CLASSIFIED from the error and the error dropped (`PdfTextUnreadReason`).
   *  `pages`: counted from 1, inclusive, folded into ranges in page order, at most `MAX_NOTICE_PAGE_RANGES` of them;
   *  `more` counts the pages the kept ranges leave out; `count` is every page of this reason. Pages the AI reading
   *  replaced are not in it. */
  | {
      kind: "pdf-text-unread";
      reason: PdfTextUnreadReason;
      count: number;
      pages: readonly { from: number; to: number }[];
      more: number;
    }
  /** `orchestrator/doc-processor.ts`: the lost-words check could not RUN (never a deliberate abstention) — `source`: the
   *  document could not be read again or the check threw; `page`: the published page could not be read back or compared.
   *  The page is published all the same. At most one entry per part. */
  | { kind: "conservation-unchecked"; part: "source" | "page" }
  /** `orchestrator/doc-processor.ts` (Relevé des échecs déguisés, point 10): the translation the folder asks for did not happen
   *  for a reason that would repeat (refused, too large, invalid answer, invariant: the AI port's `refused`). The page is
   *  published in its source language. Never raised for a passing failure (retried) nor for the month's cap (own marker). */
  | { kind: "translation-failed" }
  /** `extractor/{docx-reader,xlsx,pptx-reader}`: a styles part (docx `styles.xml` / `numbering.xml`, xlsx `styles.xml`, pptx
   *  theme) could not be read, so the document is published with DEFAULT formatting (08/10/2026). No other field;
   *  one entry per document. */
  | { kind: "styles-defaulted" };

/** The EIGHT causes a picture of a PDF can be refused for (`extractor/pdf-image-refusal.ts` reads them from what the
 *  picture declares). Each one tells a human what to do about it, which is the whole point of naming them:
 *  - `codec`: the picture is JPEG 2000 or JBIG2, which we never decode (written limit, 05/10/2026). Nothing to do.
 *  - `filters`: its filter chain is one we refuse (an unknown filter, or an image filter that is not the last).
 *  - `mask`: it carries a stencil `/Mask`, or an `/SMask` we cannot read — publishing it would show what the mask hides.
 *  - `shape`: a declaration we do not handle: the colour space, the bit depth, or a `/Decode` array.
 *  - `too-large`: more pixels than `MAX_EMBEDDED_IMAGE_PIXELS`.
 *  - `ambiguous`: the same resource name is painted in TWO scopes, so which picture it is would be a guess.
 *  - `absent`: the page paints a name its resources do not declare — the FILE is broken, not our reading.
 *  - `bytes`: everything it declares is ours to read, and reading it failed anyway. The one worth looking at.
 *  `ambiguous` and `absent` are decided by the CALLER (`pdf-source.ts`, which alone knows the scopes a name was
 *  painted in and what the resources declare); everything else is read from the dictionary here. */
export type PictureRefusal = "codec" | "filters" | "mask" | "shape" | "too-large" | "ambiguous" | "absent" | "bytes";

/** Why a PDF page's text could not be read (`extractor/pdf-source.ts#textUnreadReasonOf` classifies the error, then drops it):
 *  - `limit`: a bound of our reader bit (too many glyphs shown on the page, a budget of the object reader).
 *  - `unsupported`: what the page does is one we refuse to guess — vertical writing, a text operator the glyph builder does
 *    not cover — named by a closed tag at the throw site, never by reading a message.
 *  - `damaged`: the file is broken where the page's text is read (a refusal of our object reader, or of our own).
 *  - `unexpected`: anything else. The one worth looking at.
 *  - `font` (17/11/2026): the page's glyphs WERE built, but at least one glyph it shows is in a font we could not read
 *    (an unexpected error reading the font's tables, or an Adobe predefined CMap we do not decode). No stand-in table is
 *    used: the page keeps the text of its other fonts, only that font's words are missing. A page whose whole text is
 *    already unread keeps its own reason. */
export type PdfTextUnreadReason = "limit" | "unsupported" | "damaged" | "unexpected" | "font";

/** The source element a missing word came from (MIKSUDOC « Spécification technique » T11,
 *  lot C addendum, 29/09/2026) — recorded by the independent reader
 *  so `DocumentConservation.causeCounts` and the dev-only log line
 *  (`adapters/conservation-log.ts`) can say WHY, grouped, never just THAT.
 *  `"unrepaired"` is the PDF's own, single cause: after its existing repairs
 *  (`pipeline/glued-word-repair.ts`, `pipeline/lost-text-repair.ts`), a PDF
 *  invents no finer one. The others are Word/Google-Doc ECMA-376 element
 *  families `pipeline/source-reading-docx.ts` already walks: `w:sdt`
 *  (§17.5.2, content control), a field's cached result (`w:fldSimple`/
 *  `w:fldChar` §17.16.18-19), `w:txbxContent` (§17.3.3.34, text box),
 *  `word/footnotes.xml`/`word/endnotes.xml` (§17.11.5/§17.11.14), `w:ruby`
 *  (§17.3.3.25, a phonetic guide — base text and guide text alike). `"text"`
 *  is the default: ordinary paragraph/table text, no special container — the
 *  most common cause is likely to be this one, and that is itself diagnostic
 *  (a body-text bug, not a specialty one). `"number"`/`"date"` are xlsx-only
 *  (lot E addendum, 29/09/2026, MIKSUDOC « Spécification technique » T11):
 *  a NON-EMPTY numeric or date-formatted source cell whose published
 *  position is empty or missing — checked by POSITION against the page table
 *  (`pipeline/xlsx-page-cells.ts`), never by word match (a number's page text
 *  is our own formatter's output, not the source's). The « word » recorded
 *  for either is the cell reference (« Budget!D5 »), never the value. */
export type MissingWordCause =
  | "text"
  | "content-control"
  | "field-result"
  | "text-box"
  | "footnote"
  | "endnote"
  | "ruby"
  | "unrepaired"
  | "number"
  | "date"
  /** A word of a SmartArt's data model that the picture drawn from its saved drawing does not show: a shape the drawer leaves out, a
   *  drawing kept out, a model richer than its last-saved drawing, or a SmartArt with no drawing at all.
   *  The words that ARE drawn are not lost (a diagram is published as a drawing only, 22/10/2026). */
  | "smartart-not-drawn"
  /** NOT A LOSS — A CASE FOR A HUMAN (29/10/2026: « le compteur peut nous demander une vérif humaine si
   *  nécessaire »). The source carries one word where the page carries its pieces, side by side: not a letter is missing,
   *  but the word is no longer a word, so a search will not find it. Measured the same day on a real report: the document
   *  puts a heading and the next paragraph in ONE `w:p` with nothing between the two runs, so the source reads
   *  « competitionthere » while the page publishes « …Competition » then « There are no… ». Counting that as a loss told
   *  the owner of the page that a word had vanished when none had; counting it as nothing would hide the day a real loss
   *  hides behind the same shape. So it is counted apart, and said. */
  | "split-by-page";

/** The tools a PDF can say it was written with — OUR table (`extractor/pdf-facts.ts`), never the raw
 *  Producer/Creator string. `other`: the file names a tool that is not in the table. */
export type PdfToolLabel =
  | "word"
  | "powerpoint"
  | "libreoffice"
  | "google"
  | "canva"
  | "reportlab"
  | "pages"
  | "indesign"
  | "pdflib"
  | "itext"
  | "msprint"
  | "skia"
  | "wkhtmltopdf"
  | "prince"
  | "cairo"
  | "ghostscript"
  | "quartz"
  | "adobepdf"
  | "fpdf"
  | "tcpdf"
  | "mpdf"
  | "pdfsharp"
  | "fop"
  | "other";

/** What the text-conservation check said of a document's last publish
 *  (`pipeline/publish-conservation.ts`): counts, causes and unit labels,
 *  never a word of the document (owner decision, 09/10/2026: the app keeps
 *  no content of a document, only its titles). Display-only: nothing that decides what to
 *  publish reads it. `"missing-words"` is the lot A cause
 *  (Word, Google Doc, MIKSUDOC « Spécification technique » T11): a declared format's own words absent from the
 *  page, never repaired — `"lost"`/`"glued"` stay PDF-only (letter
 *  coverage, word re-spacing) and never set `causeCounts`. */
export interface DocumentConservation {
  decision: "ok" | "lost" | "glued" | "missing-words" | "abstain";
  lostLetters: number;
  gluedWords: number;
  /** Declared-format word loss (docx, Google Doc — MIKSUDOC « Spécification technique » T11: missing
   *  words only, never counted words in excess). Always 0 for a PDF record. */
  missingWords: number;
  /** The units the decision is about, ascending: 1-based PDF page numbers as
   *  text; empty for Word/Google Doc, whose single unit is never worth
   *  naming (`pages`
   *  renamed `units`, pre-launch — no compatibility kept). */
  units: string[];
  /** Lot 6 (21/09/2026): letters and digits of the storage we sent
   *  that the ADF Confluence read back lacks (`pipeline/adf-conservation.ts`).
   *  Absent when the publisher read no ADF back, or when the comparison
   *  failed. */
  adfLostLetters?: number;
  /** Lot C addendum (29/09/2026, MIKSUDOC « Spécification technique » T11):
   *  `missingWords` grouped by the source element each missing word came
   *  from — a technical cause tag and a count, never the words (the
   *  preview decided on 29/09/2026 is withdrawn, owner decision 09/10/2026).
   *  Shown on the admin dashboard (`orchestrator/document-summaries.ts`,
   *  `static/dashboard/src/UnpublishedPartsDialog.tsx`). Only for `"missing-words"` (docx, Google Doc): a PDF's
   *  `"lost"` always has ONE cause ("unrepaired") and does not bother
   *  recording it here. */
  causeCounts?: { cause: MissingWordCause; count: number }[];
}

/** The numbers the structure control (`pipeline/structure-conservation.ts`) counts, in the source and on the published page: headings in
 *  total and per level (`h1`..`h6`), tables, table cells, list items and table rows. Counts only, never a word. */
export interface StructureCounts {
  headings: number;
  /** Headings of level 1 to 6, in that order. */
  headingsByLevel: [number, number, number, number, number, number];
  tables: number;
  cells: number;
  items: number;
  rows: number;
}

/** What the structure control said of a document's last publish (`docs/CONCEPTION-CONTROLE-STRUCTURE.md` section 5.1), next to
 *  `DocumentConservation` and never inside it: the words and the structure are two controls. Display-only, counts and unit labels, never a word.
 *  `expected` = declared - withheld - flattened + added over the units that have a tab; the counts the format does not compare are zero in
 *  `expected`, `published` and `flattened`. The gap is `published - expected`, signed, with no threshold. `decision` is `abstain` for a
 *  document the model rewrote or whose second reading was refused. `units`: the labels of the tabs (a slide, a sheet) that show a gap. */
export interface DocumentStructure {
  decision: "ok" | "gap" | "abstain";
  expected: StructureCounts;
  published: StructureCounts;
  flattened: StructureCounts;
  units: string[];
}
