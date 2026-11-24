/** Frontier of the PDF reading: the document is opened and read by OUR reader only (`pdf-objects/`). It gives pages, text runs,
 *  glyph geometry, operators, images, links, the declared structure order, the outline and the document facts to everything
 *  else. Nothing here calls a third-party PDF library: pdf.js was removed (1/11/2026); a picture we do not decode is
 *  reported as unreadable, a page whose glyphs we cannot build keeps no text, and a file our reader refuses is refused.
 *  Decides: that the file is opened ONCE and that this open document travels on (`PdfSource.document`), so the readers that
 *  come after — the pictures first — never parse the same bytes again and share the one cache and the one stream budget this
 *  reading holds (`document-cache.ts`, performance review of 02/11/2026).
 *  NOT here: the picture decoders (`pdf-ccitt-images.ts`, `pdf-jpeg-images.ts`, `pdf-flate-images.ts`), the glyph and run builders
 *  (`glyph-positions.ts`, `glyph-runs.ts`), the structure and link readers. Each module of those is named where it is used.
 *  Called by: `extractor/pdf-open.ts` and `extractor/pdf-table-detector.ts` call the reader, with the probes of `tools/`;
 *  `extractor/pdf.ts`, the page stages and the layout helpers read its TYPES. */

import { ReaderError } from "doc-ir";
import type { PdfTextUnreadReason, PictureRefusal } from "doc-ir";
import { pictureRefusalOf } from "./pdf-image-refusal";
import { stencilImageObjectOf } from "./pdf-stencil-images";
import { PdfObjectsRefusal, type PdfObjectsRefusalReason } from "./pdf-objects/refusal";
import { count, type ExtractionCost } from "./extraction-cost";
import type { FontWeight } from "./font-weight";
import { readImageObject, readImageRef, type PdfImageData } from "./pdf-images";
import { ccittImageObjectOf, type DecodedImageObject } from "./pdf-ccitt-images";
import { refKey, type PdfDict } from "./pdf-objects/objects";
import { documentCacheOf } from "./document-cache";
import { flateImageObjectOf } from "./pdf-flate-images";
import { jpegImageObjectOf } from "./pdf-jpeg-images";
import { ourOpsOfPage } from "./pdf-ops-ours";
import {
  filteredGlyphs,
  GlyphBuilderAbstention,
  INVISIBLE_TEXT_MODES,
  readGlyphs,
  unreadFontKept,
  type FontScaleOf,
  type GlyphFragment,
  type HidePolicy,
  type SymbolFontOf,
} from "./glyph-positions";
import { runsOfGlyphs } from "./glyph-runs";
import { countShownGlyphs, dropsModeHidden, MAX_FILTERED_GLYPHS } from "./pdf-hidden-text";
import { hasReadableText, linesFromItems } from "./pdf-lines";
import { openOurGlyphs, type GlyphMemo } from "./pdf-glyph-source";
import { fontObjectsOfPage } from "./pdf-symbol-page";
import { symbolVerdictOf, type OurFontObject } from "./pdf-symbol-verdict";
import { outlineOfDocument, type PdfOutlineEntry } from "./pdf-outline";
import { documentInfoOf } from "./pdf-document-info";
import { linkAnnotationsOfPage } from "./pdf-links-ours";
import { declaredStructureOf } from "./pdf-structure";
import { layerConfigOf, type LayerConfig } from "./pdf-layers";
import { referenceOfGlyphs } from "./pdf-reference-ours";
import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import { GraphicsStateStack } from "./pdf-ops";
import type { PdfOp } from "./pdf-ops";
import type { Matrix2D } from "../layout/geometry";

export { OUTLINE_READ_MAX_ENTRIES, OUTLINE_TITLE_MAX_CHARS, type PdfOutlineEntry } from "./pdf-outline";

/** A text RUN, already carrying everything the rest of the code used to look up
 *  in three separate reads. Assembled from our glyphs (`glyph-runs.ts`);
 *  before pdf.js was removed, its runs served on a fallback page. */
export interface PdfTextRun {
  text: string;
  /** Origin of the run, in page space — `transform[4]`/`[5]`. */
  x: number;
  y: number;
  /** Width and height, with the definition pdf.js had (kept). ⚠️ The width is a
   *  HORIZONTAL box: for a rotated run it does not describe its extent.
   *  `matrix` carries the rotation, and `rotated` flags it. */
  width: number;
  height: number;
  /** `Math.hypot(c, d)` — the same definition `unpdf` used, so that the merge is
   *  verifiable as identical and not merely "equivalent". */
  fontSize: number;
  matrix: Matrix2D;
  /** The INTERNAL name of the font: the key of our bridge (`pdf-font-bridge.ts`, scope + resource name; pdf.js's was `g_d0_f1`). Opaque by
   *  construction: it only serves to find the font object, never to be
   *  read or compared with anything. */
  fontId: string | undefined;
  /** See `./font-weight` — three outcomes, one of them a named abstention. */
  weight: FontWeight;
  /** The run is not aligned on the axes. Today these runs are
   *  LEFT OUT of the geometry: their bounding box is wrong. */
  rotated: boolean;
  /** Italic, from the font (`pdf-font-objects.ts#ourItalicOf`) or the text matrix's shear (`glyph-runs.ts`), resolved by
   *  `resolveRunWeights`. Absent or false: upright, or unknown. */
  italic?: boolean;
  /** The run was written letter-spaced and was recomposed from its glyphs (`pdf-letter-spacing.ts`). Kept on
   *  purpose although no rule reads it. */
  letterSpaced?: true;
  hasEOL: boolean;
  dir: string;
  /**
   * The MARKED-CONTENT identifier this cycle is painted under
   * (`p<page>_mc<n>`), `undefined` when it is painted outside any marked
   * content. It is the ONLY link between a text cycle and the document's
   * structure tree — see `PdfSourcePage.declaredOrder` — and it is opaque:
   * it is compared, never parsed.
   */
  markedContentId: string | undefined;
  /**
   * The cycle is painted inside an `/Artifact` marked-content sequence — the
   * document itself saying "this is not author content" (ISO 32000-1
   * §14.8.2.2.2, table 330). A DECLARATION, read as-is: no threshold, no
   * geometry, no repetition.
   *
   * It is the same reading `pdf-table-detector.ts#walkPage` does for IMAGES,
   * from the operator stream; here it comes from the marked-content boundaries
   * our glyphs already carry (`glyph-positions.ts`), as pdf.js's
   * `getTextContent({ includeMarkedContent: true })` interleaved them, so it
   * costs nothing extra and holds on every page, including the ones whose
   * operators are never named.
   *
   * What is DONE with it: `./pdf-reading-order` counts a declared cycle as
   * covered, because the standard keeps artifacts OUT of the structure tree.
   * **Nothing removes text on it**, and that is measured, not cautious: on
   * safedocs 0000713 (a third-party PDF of the measurement corpus) page 1 it covers 847 characters of 1 889 —
   * letterhead, title and member-state list — and on fixture 26 page 8 it covers
   * the page's title and two postal addresses
   * (`pdf-artifact-furniture.fixtures.test.ts`).
   */
  artifact: boolean;
}

export interface PdfSourcePage {
  /** MediaBox, `page.view` — `[x0, y0, x1, y1]`. */
  width: number;
  height: number;
  /** The y of the view's bottom edge in user space (`view[1]`, the CropBox may start above 0): runs and bands are in user space. */
  bottom?: number;
  runs: PdfTextRun[];
  /** Whether `runs` hold one printable character (`hasReadableText(linesFromItems(runs))`), read once per page. */
  hasText: boolean;
  /** The page's operations, named. Empty when `wantOps` did not keep the page: a cost choice the caller makes. */
  ops: PdfOp[];
  /** The verdict of the document's optional-content layers, set when the page's hidden text was filtered: a layer switched off shows nothing. */
  isLayerVisible?: (group: unknown) => boolean;
  /**
   * The pixels of an image on the page, by its object name — `undefined` as
   * soon as anything is missing (see `./pdf-images`).
   *
   * ⚠️ **A FUNCTION INSIDE A DATA MODEL, the same deliberate deviation as
   * `wantGlyphs`.** Every image painted on a page whose operators are named is
   * AWAITED here (`imageObjectsAwaited`), so its pixels are already in memory.
   * `readImage` only converts their format, on demand: a character-sized image
   * to copy it, a large PLACED image re-encoded when pdf-lib cannot copy its stream (`pdf-page-figures.ts`).
   * Which image name matters is only known after walking the operators. This is
   * not the final shape of a neutral interface.
   */
  readImage: (name: string) => PdfImageData | undefined;
  /** The number of the PDF object of the picture painted under this name. */
  imageRef: (name: string) => string | undefined;
  /** Why our reader has no pixels under this object name: "slow" was the case where pdf.js did not deliver the object within
   *  `IMAGE_ARRIVAL_TIMEOUT_MS` (gone with pdf.js), "unreadable" when it arrived but `readImage` still gives nothing,
   *  `undefined` when `readImage` works. */
  imageFailure: (name: string) => "slow" | "unreadable" | undefined;
  /** WHY the picture `name` is not read, in the eight words of `pdf-image-refusal.ts`, or `undefined` when it IS read
   *  (and when the page's operators were not asked for, so nothing was looked at). Beside `imageFailure`, which says
   *  only that it failed: a count with nowhere to look is not a report (03/11/2026). */
  imageRefusal: (name: string) => PictureRefusal | undefined;
  /** Empty when `wantGlyphs` did not keep the page (a choice of cost, not an absence of data: see the header). Empty
   *  ALSO when the rebuild failed — `glyphsUnavailable` then says why. */
  glyphs: GlyphFragment[];
  /**
   * Why the glyphs of THIS page are missing, when they are missing for a
   * reason — absent otherwise. A word of a closed list (`textUnreadReasonOf`), never the error's text.
   *
   * `buildGlyphFragments` throws LOUDLY on a text operator it does not cover,
   * rather than returning made-up coordinates — the right decision. Letting it
   * propagate would fail the WHOLE document for one page.
   *
   * The boundary therefore degrades page by page — but WRITES it instead of
   * swallowing it. Since pdf.js was removed (1/11/2026) such a page has NO text at
   * all: no flat text to fall back on, its words are not published. `pdf.ts`
   * turns this reason into a `pdf-text-unread` notice (16/11/2026), so the loss
   * is said to the person instead of looking like a page without text.
   *
   * MEASURED ON THE CORPUS: this used to say "one page throws, `05d` p0". It
   * was 68 pages of 18 PDFs. Since 22/09/2026 no French or English page of the
   * corpus throws (measured by an oracle test removed with pdf.js); what is left
   * is a named abstention on an operator the builder does not cover, or on
   * vertical writing.
   */
  glyphsUnavailable?: PdfTextUnreadReason;
  /** Set when the page's glyphs WERE built and at least one glyph in a font we could not read (`pdf-glyph-source.ts`,
   *  `OurGlyph.read === "not-ours"`) would have been PUBLISHED, its font readable: the filter of the published text decides
   *  (`glyph-positions.ts#unreadFontKept`), so an invisible one counts for nothing. That font's words are missing, the rest is read.
   *  `pdf.ts` turns it into a `pdf-text-unread` notice of reason `font` (17/11/2026). Never set beside `glyphsUnavailable`. */
  fontUnread?: true;
  /**
   * The marked-content identifiers this page's STRUCTURE TREE holds, in the
   * tree's reading order corrected by `hoistAgainstTree` where the content
   * stream and the geometry agree against it (`hoistAgainstTree` ignores roles; the notes are put last afterwards, where `notesAfterText` does not abstain).
   * `undefined` when the page carries no tree, and never an empty array made
   * up to stand in for one.
   *
   * ⚠️ **ORDER ONLY, AND THE BOUNDARY DELIBERATELY DROPS THE REST.** The tree
   * also carries a ROLE per node (`/H1`, `/TH`, `/L`, `/Artifact`…); none of it
   * crosses. `fixtures/pdf/22-Tableau-Balise-En-Tetes-Faux.pdf` passes veraPDF
   * (`PASS ua1`) with column headers that are WRONG, and our geometry reads
   * them right: a valid tagging is not a truthful tagging. What the order is
   * used for lives in `./pdf-reading-order`.
   *
   * KNOWN LIMIT, measured 29/09/2026, CORRECTED 29/09/2026 (an independent
   * counter-diagnosis found "declares zero content" and "legal" both false —
   * see below): a document can call itself tagged (`/MarkInfo`) and still
   * handed pdf.js a NON-NULL `getStructTree()` that came back
   * `{ role: "Root", children: [] }`.
   * `fixtures/pdf/37-Circulaire-Rentree-2023-Pages.pdf` (Apple Pages/Quartz)
   * does this on all six of its pages — the only corpus document that does.
   * It is NOT an untagged document standing on its right to have no content:
   * it carries 51 `/StructElem /P` with `/Pg` and `/K <MCID>`, and 133 `BDC`
   * operators marking content in its streams. What it LACKS is `/ParentTree`
   * and, on every page, `/StructParents` — and `StructTreePage.parse()`
   * (pdf.worker.mjs ~l.40041-40054) returned immediately once `parentTree` was
   * falsy, before ever walking those 51 elements. ISO 32000-1 Table 322 marks
   * `/ParentTree` "Required if any structure element contains content
   * items" — this document has content items and no `/ParentTree`: it is
   * NON-CONFORMING, not merely sparse. The oracle's rule stays right for the
   * reason that matters here: `declaredOrder` is correctly `undefined`
   * (nothing pdf.js handed us to walk; our reader now reads the tree itself, `pdf-structure.ts`), and a caller checking "is this page
   * tagged" off `getStructTree() !== null` alone would still answer wrong;
   * check for a content leaf instead
   * (`pdf-source.oracle.test.ts#hasDeclaredContent`, a test removed with pdf.js).
   */
  declaredOrder?: readonly string[];
  /** The marked-content ids under a `Note` node of the page's tree (a footnote, ISO 32000-1 §14.8.4.3); absent when there is none. Read by
   *  `./pdf-reading-order.ts#declaredRanks` (`notesAfterText`) on the page side and by `notesLast` on the control side, which put the notes
   *  last where the geometry agrees (each abstains otherwise); neither writes into `declaredOrder`, and `hoistAgainstTree` ignores roles. */
  noteIds?: ReadonlySet<string>;
  /** The page's text cycles in content-stream order, hidden text left out (built from our glyphs, `pdf-reference-ours.ts`): the reference of the letters control, independent of `runs`
   *  (which our glyphs build). Absent on a page without text. */
  reference?: PdfReferenceCycle[];
  /** The page's link annotations whose target our reader resolved to an absolute URL (by the rules pdf.js applied), in the file's order — see
   *  `PdfLinkAnnotation`. Empty on a page without text: nothing there can carry a link. */
  links: PdfLinkAnnotation[];
}

/**
 * A `/Link` annotation (ISO 32000-1 §12.5.6.5) whose action became an absolute URL (by the rules pdf.js applied, which `pdf-links-ours.ts` keeps): its `url` and
 * its `/Rect`, normalised to `[x0, y0, x1, y1]` with x0 ≤ x1 and y0 ≤ y1, in the same default user space as the
 * text runs and glyphs. Raw: which schemes are published and which words carry it is `pdf-links.ts`'s decision.
 *
 * What pdf.js 6.2.108 resolved to `url` (`Catalog.parseDestDictionary`): a URI action (§12.6.4.7), a Launch or
 * GoToR action whose file specification is an absolute URL, and a JavaScript action shaped `window.open('…')`.
 * pdf.js said nothing of the action's type. A JavaScript action always sets `newWindow` and so does a Launch or
 * GoToR action carrying `/NewWindow`, never a URI action: those are left out here. A Launch or GoToR action
 * without `/NewWindow` whose file is an absolute URL cannot be told from a URI action and stays (none in the
 * corpus, 07/10/2026).
 */
export interface PdfLinkAnnotation {
  url: string;
  rect: readonly [number, number, number, number];
}

/** What the file says about itself (its `/Info` and catalogue, read by `pdf-document-info.ts`), raw: the strings stay inside the extractor and are
 *  classified by `pdf-facts.ts`, never carried. Only what the facts card needs — no title, author, keywords,
 *  dates or XMP, which are never read. */
export interface PdfDocumentInfo {
  producer?: string;
  creator?: string;
  pdfVersion?: string;
  linearized?: boolean;
  form?: boolean;
  /** The files attached to the document (its /Names /EmbeddedFiles tree), counted, never read. Absent at zero. */
  attachedFiles?: number;
  /** The digital signatures the file carries (the /FT /Sig form fields holding a signature dictionary),
   *  counted, never verified. Absent at zero. */
  signatures?: number;
}

/** One text cycle (pdf.js's, before its removal; now built from our glyphs), reduced to what the letters control needs (the application's `ReferenceCycle`, the same shape): the
 *  second reading of a page, kept beside the runs our own glyphs build. Hidden text is already left out. */
export interface PdfReferenceCycle {
  text: string;
  /** `y + height / 2`: the vertical centre, the table stage's own rule to give a line to a table band. */
  middle: number;
  artifact?: true;
  markedContentId?: string;
  rotated?: true;
  /** Marked content under a `Note` node of the structure tree (a footnote), set when the page's tree is read. */
  note?: true;
}

export interface PdfSource {
  pages: PdfSourcePage[];
  /** Our reader's view of the document, opened ONCE: the readers that come after (the pictures) take it instead of parsing the file again. */
  document: PdfObjectsDocument;
  /** The outline, absent when the file has none, holds too many entries, or our reader could not follow it. */
  outline?: PdfOutlineEntry[];
  /** Absent when our reader could not give the metadata: the facts are then partial, the read goes on. */
  info?: PdfDocumentInfo;
}

/** The declared order with the page's NOTE content moved after the rest, in its relative order, when every note run sits below every other
 *  run that carries text (y goes up: a smaller middle is lower): the role and the geometry must agree, else the order is unchanged. Word
 *  declares each footnote right after the line that calls it; read as declared, its body was published in mid-sentence (fixture 52, page 5:
 *  note 8 between « („big » and « data”) »). The same rule as the letters control's reference (`letter-conservation.ts#notesLast`), so both
 *  read the note at the end of the page. Rotated runs (wrong box) and artifacts take no part in the geometry. O(runs + order).
 *  Limit, written: a producer that tags its page footer as content (not `/Artifact`) puts that footer below the notes; the guard then refuses
 *  and the note stays where the tree declares it (review of d33a7c2f, 23/10/2026). */
export const notesAfterText = (
  declaredOrder: readonly string[],
  runs: readonly PdfTextRun[],
  noteIds: ReadonlySet<string>,
): readonly string[] => {
  if (noteIds.size === 0) return declaredOrder;
  let highestNote = -Infinity;
  let lowestOther = Infinity;
  for (const run of runs) {
    if (run.rotated || run.artifact || run.text.trim().length === 0) continue;
    const middle = run.y + run.height / 2;
    if (run.markedContentId !== undefined && noteIds.has(run.markedContentId))
      highestNote = Math.max(highestNote, middle);
    else lowestOther = Math.min(lowestOther, middle);
  }
  if (highestNote === -Infinity || highestNote >= lowestOther) return declaredOrder;
  return [...declaredOrder.filter((id) => !noteIds.has(id)), ...declaredOrder.filter((id) => noteIds.has(id))];
};

/** Where an id (or a cluster of ids) is read and drawn: the stream positions of its runs and the union box of their glyph boxes. */
interface IdGeometry {
  firstIndex: number;
  lastIndex: number;
  left: number;
  right: number;
  bottom: number;
  top: number;
  smallestHeight: number;
}

/** The geometry of each marked-content id from its runs, rotated, artifact and blank runs left out (the exclusions of `notesAfterText`). */
const geometryOfIds = (runs: readonly PdfTextRun[]): Map<string, IdGeometry> => {
  const geometry = new Map<string, IdGeometry>();
  runs.forEach((run, index) => {
    if (run.markedContentId === undefined || run.rotated || run.artifact || run.text.trim().length === 0) return;
    const box: IdGeometry = {
      firstIndex: index,
      lastIndex: index,
      left: run.x,
      right: run.x + run.width,
      bottom: run.y,
      top: run.y + run.height,
      smallestHeight: run.height,
    };
    const known = geometry.get(run.markedContentId);
    geometry.set(run.markedContentId, known === undefined ? box : unionOf(known, box));
  });
  return geometry;
};

const unionOf = (a: IdGeometry, b: IdGeometry): IdGeometry => ({
  firstIndex: Math.min(a.firstIndex, b.firstIndex),
  lastIndex: Math.max(a.lastIndex, b.lastIndex),
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
  top: Math.max(a.top, b.top),
  smallestHeight: Math.min(a.smallestHeight, b.smallestHeight),
});

/** `m` may move before `p`: painted before it, and drawn above it with a disjoint box that overlaps it horizontally. */
const mayPass = (p: IdGeometry, m: IdGeometry): boolean =>
  p.firstIndex > m.lastIndex && p.top < m.bottom - 0.5 * m.smallestHeight && p.left < m.right && m.left < p.right;

/** The vertical intervals of the two boxes meet: they share a line. */
const sharesLine = (a: IdGeometry, b: IdGeometry): boolean => a.bottom <= b.top && b.bottom <= a.top;

/** A unit that moves whole: ids that follow each other in the tree and share a line, plus the ids without geometry glued to them. */
interface Cluster {
  ids: string[];
  box: IdGeometry | undefined;
}

/** Clusters over the tree order: ids without geometry are skipped for the line test and glued to the cluster of the id before them. */
const clustersOf = (order: readonly string[], geometry: ReadonlyMap<string, IdGeometry>): Cluster[] => {
  const clusters: Cluster[] = [];
  let previous: IdGeometry | undefined;
  for (const id of order) {
    const mine = geometry.get(id);
    const last = clusters[clusters.length - 1];
    if (mine === undefined) {
      if (last === undefined) clusters.push({ ids: [id], box: undefined });
      else last.ids.push(id);
      continue;
    }
    if (last?.box === undefined && last !== undefined) {
      last.ids.push(id);
      last.box = mine;
    } else if (last?.box !== undefined && previous !== undefined && sharesLine(previous, mine)) {
      last.ids.push(id);
      last.box = unionOf(last.box, mine);
    } else clusters.push({ ids: [id], box: mine });
    previous = mine;
  }
  return clusters;
};

/** The most `mayPass` comparisons one page may spend. Starting value to calibrate: about 60 ms on the development machine (a hostile page of
 *  50 000 ids declared in the reverse of the stream and the geometry took 4.6 s unbounded); a real page spends a few thousand. Spent: the
 *  page abstains and keeps the tree order (`hoistAgainstTree`). Nothing interrupts a synchronous function on the platform. */
export const HOIST_MAX_COMPARISONS = 2_000_000;

/** Where a cluster lands among the already placed ones: it climbs past those it may pass, stays put unless it passed at least one, and
 *  lands after the first cluster that blocks it. `undefined` once the shared comparison budget is spent. A placed cluster without
 *  a box is a guard only: `clustersOf` grafts the first geometric id onto a leading geometry-less cluster, so one exists only on a page
 *  with no geometry at all, where nothing moves. */
const landingIndex = (
  placed: readonly Cluster[],
  box: IdGeometry | undefined,
  budget: { left: number },
): number | undefined => {
  if (box === undefined) return placed.length;
  let cursor = placed.length;
  while (cursor > 0) {
    const theirs = placed[cursor - 1]!.box;
    if (theirs === undefined || !mayPass(theirs, box)) break;
    if (--budget.left < 0) return undefined;
    cursor--;
  }
  return cursor;
};

/** The declared order corrected where the content stream and the geometry BOTH put an id before the one the tree declares first.
 *  Why: docx-reel 10 p9. Word groups a numbered list in the tree across a heading and a table: items « 2.1. » and « 2.2. » (the latter
 *  drawn under the table) are declared BEFORE the `H1` « SECTION 2: KEY DATES », which is the first marked content of the stream and the
 *  highest line of the page; read as declared, the heading was published after « 2.1. » and lost its rank. Two independent readings agree
 *  against the tree, so they win.
 *  Rule: an id named twice is read at its first place. Walking that order, an id `m` moves left past a predecessor `p` iff every run of `p`
 *  is painted after every run of `m` AND `p` lies entirely under `m` (its top below `m`'s bottom by half `m`'s smallest run height, so a
 *  title and smaller text on one baseline are not one under the other) with the boxes overlapping horizontally (columns never cross). An id
 *  with no geometry (no run, or only blank, rotated or artifact runs: the same exclusions as `notesAfterText`) is transparent: passed by
 *  the move, never blocking, and glued to the unit of the id before it in the tree (Word tags apart the tab between a bullet and its text).
 *  The unit that moves is a LINE CLUSTER, not an id: ids that follow each other in the tree (ids without geometry skipped) and whose vertical
 *  intervals meet share a line and form one cluster (union box, min/max stream index over all its runs, smallest run height). Word tags apart
 *  the number « 2.1. » (x 72-90, its text at 108) and the end of a line (« ) in the », x 472-523): narrow fragments that would block the move
 *  alone. A move stopped by a blocking cluster lands after it and after the ids without geometry glued to it. The first geometric
 *  predecessor cluster that fails the test stops the move. Roles are ignored here, only positions (a text id can come before a `Note` id;
 *  `notesAfterText` never writes into the order, the notes are put last afterwards where it does not abstain). O(ids²) comparisons at worst, bounded by
 *  `HOIST_MAX_COMPARISONS` per page: past it the tree order comes back as declared (abstention). With no duplicate and no move, the SAME array
 *  comes back; an id named twice yields a new, deduplicated array.
 *  Limits, written: a page whose tree AND stream read line by line across two columns forms a cluster astride the gutter (the document's own
 *  order, accepted). A box « In short » at the top of a page, painted first but tagged LAST by an accessibility-minded author, comes back to
 *  the top (a geometric reading, defensible for search). A table page that is not rebuilt can come out in partial order (a cell column that
 *  does not overlap stays behind). With a tagged footer under a note, the paragraphs after a note call come back before the note even where
 *  `notesAfterText` abstains. */
export const hoistAgainstTree = (declaredOrder: readonly string[], runs: readonly PdfTextRun[]): readonly string[] => {
  const order = [...new Set(declaredOrder)];
  const placed: Cluster[] = [];
  const budget = { left: HOIST_MAX_COMPARISONS };
  for (const cluster of clustersOf(order, geometryOfIds(runs))) {
    const at = landingIndex(placed, cluster.box, budget);
    if (at === undefined) return declaredOrder;
    placed.splice(at, 0, cluster);
  }
  const out = placed.flatMap((cluster) => cluster.ids);
  return out.length === declaredOrder.length && out.every((id, i) => id === declaredOrder[i]) ? declaredOrder : out;
};

interface ReadPdfSourceOptions {
  /** Called as soon as the page count is known, before any page is read. The caller may throw from it to give up the
   *  document without paying for its extraction. It is a moment, not a rule: the caller decides why. */
  onOpen?: ((pageCount: number) => void) | undefined;
  /** Read only this many pages from the first one (the rest of the document is neither opened nor counted in `pages`). Only the benchmark's reading-quality probes set it (`tools/bench/app-caps.ts`); no product path does. */
  firstPages?: number | undefined;
  /**
   * Which pages pay for the naming of their operations. By default: none.
   *
   * The predicate receives the page's runs because the caller decides on them (the detector skips the pages with no
   * visible line). The policy is the caller's, not this boundary's.
   *
   * It also receives the runs of EVERY page (07/10/2026): whether a page with no text pays for its
   * operators depends on the whole document (a scan pays nothing, a document with text publishes the
   * pictures of its pages without text, `pdf-open.ts`). The text of all pages is therefore read before
   * any operator list is built. `allHasText` is `PdfSourcePage.hasText` of every page, computed once here.
   */
  wantOps?:
    | ((
        pageIndex: number,
        runs: readonly PdfTextRun[],
        allRuns: readonly (readonly PdfTextRun[])[],
        allHasText: readonly boolean[],
      ) => boolean)
    | undefined;
  /** Which pages pay for the rebuilding of their glyphs. Implies `wantOps`. */
  wantGlyphs?:
    | ((
        pageIndex: number,
        runs: readonly PdfTextRun[],
        allRuns: readonly (readonly PdfTextRun[])[],
        allHasText: readonly boolean[],
      ) => boolean)
    | undefined;
  cost?: ExtractionCost | undefined;
}

/** The most operators one page may carry. A content stream can inflate to hundreds of millions of operators, which
 *  saturates Forge's 512 MB or its 900 s, and the retry replays the same bomb; real pages are far below.
 *  🔴 ARBITRARY THRESHOLD, settled on 31/10/2026: a "clear refusal" rather than a memory risk.
 *  It is DELIBERATELY the same number as `pdf-objects/bounds.ts#MAX_CONTENT_OPS`, so that both readers
 *  refuse the same page; the two go down together or not at all. */
export const PDF_MAX_OPS_PER_PAGE = 1_000_000;

/** The image kinds the picture readers take: fixed here, the values the image reader's format table expects (grey 1 bit,
 *  RGB 24 bits, RGBA 32 bits). */
const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 3, RGBA_32BPP: 4 } as const;

/** What every page read shares: our document, the work counter, the optional-content layers, and the file's bytes (a CCITT
 *  picture is read from them, as the file holds it). */
interface ReadContext {
  file: Uint8Array;
  cost: ExtractionCost | undefined;
  ourDoc: PdfObjectsDocument;
  /** The glyph memo of the document, shared by every page (the font-table budget is the document's). */
  memo: GlyphMemo;
  readLayerConfig: () => LayerConfig | undefined;
  /** The caller gave a `wantOps` or `wantGlyphs` predicate. */
  keepOps: boolean;
  keepGlyphs: boolean;
}

/** One page after the first pass: its operators and glyphs are built once here, and reused by the second pass. */
interface PageText {
  /** The page's index in the document. */
  index: number;
  /** Our operators of the page, named, with its fonts' keys (`pdf-ops-ours.ts`). Released after the second pass. */
  ops: PdfOp[];
  /** The font objects of the page, by our font key (`setFont`'s name). */
  fonts: ReadonlyMap<string, OurFontObject>;
  /** Set when the page holds hidden text: how its glyphs are filtered (table cells read them too). */
  hide?: HidePolicy;
  /** The page's glyphs. Released after the second pass unless the caller asked for them. */
  glyphs: GlyphFragment[];
  /** Why building the glyphs failed, when it did (`PdfSourcePage.glyphsUnavailable`). */
  glyphsUnavailable?: PdfTextUnreadReason;
  /** A glyph in a font we could not read would have been published (`PdfSourcePage.fontUnread`). */
  fontUnread?: true;
  /** The text runs of the page, built from its glyphs. */
  runs: PdfTextRun[];
  /** The second reading of the page's text (`pdf-reference-ours.ts`), hidden text left out. */
  reference: PdfReferenceCycle[];
}

/** What the second pass asks the caller about a page. `allRuns` and `allHasText` span the whole document. */
interface PageWants {
  wantOps: ReadPdfSourceOptions["wantOps"];
  wantGlyphs: ReadPdfSourceOptions["wantGlyphs"];
  allRuns: readonly (readonly PdfTextRun[])[];
  allHasText: readonly boolean[];
}

const PICTURE = Symbol("decoded picture");

/** The bytes a cache entry can hold, never less: the size is asked once, on entry, and a ceiling is held by excess.
 *  A reader that holds more than its pixels declares it (`heldBytes`). Otherwise by kind: one packed bit per pixel
 *  for CCITT, three bytes for RGB, four for RGBA. Never `.data`, which would trigger the lazy decode.
 *  Tried then dropped: charging a JPEG its compressed bytes alone. The cache keeps the closure for the life of the
 *  document, and a later path that decodes materialises the pixels above the ceiling. */
function cachedPictureBytes(image: DecodedImageObject): number {
  if (image.heldBytes !== undefined) return image.heldBytes;
  if (image.kind === IMAGE_KIND.GRAYSCALE_1BPP) return Math.ceil(image.width / 8) * image.height;
  return image.width * image.height * (image.kind === IMAGE_KIND.RGB_24BPP ? 3 : 4);
}

/** Where each picture of the page was painted and in what state: its resource scope, whether it is a STENCIL
 *  (`/ImageMask true`) and, if it is, the fill colour of the moment — a stencil has no colour of its own. The colour
 *  is tracked with a `q`/`Q` stack and the form boundary, because that is what restores it (§8.4.2, §8.10.1): reading
 *  the last `setFillRGBColor` of the stream would publish a red stamp in black.
 *  The map is held by NAME, so a stencil painted in two colours is first given one name per colour
 *  (`splitStencilsByColour`, review 06/11/2026: it came out twice, in the colour of the last painting). */
/** What an operator does to the fill colour and to the stack that restores it.
 *  A form boundary counts as a `q` (ISO 32000-1 §8.10.1: a `Do` on a form saves and restores the graphics state
 *  implicitly): otherwise a form that sets a colour without its own `q`/`Q` leaks it onto the page, and a stencil
 *  painted afterwards comes out in that colour. */
function trackFillColour(state: GraphicsStateStack<{ colour: string | undefined }>, op: PdfOp): void {
  if (op.op === "save") state.save();
  else if (op.op === "restore" || op.op === "paintFormXObjectEnd") state.restore();
  else if (op.op === "paintFormXObjectBegin") state.form((top) => ({ ...top }));
  else if (op.op === "setFillRGBColor" && Array.isArray(op.args))
    state.current.colour = typeof op.args[0] === "string" ? op.args[0] : state.current.colour;
  else if (op.op === "setFillColourUnknown") state.current.colour = undefined;
}

/** Separates a resource name from the colour a stencil of that name is painted in (`splitStencilsByColour`). */
const STENCIL_COLOUR_SEPARATOR = "\u0000";

/** The resource name under a stencil's per-colour name. */
const resourceNameOf = (name: string): string => name.split(STENCIL_COLOUR_SEPARATOR)[0]!;

/** A STENCIL PAINTED IN TWO COLOURS IS TWO PICTURES (review 06/11/2026). The decoded pictures are held by name, and the
 *  consumers ask for a picture by the name in the painting operator, so the operator itself carries the colour: every
 *  stencil painting of a name that is painted in more than one colour gets the name `name<NUL>colour`. A name painted in a
 *  single colour keeps its name, and the operators are returned as they came. */
function splitStencilsByColour(ops: PdfOp[]): PdfOp[] {
  const state = new GraphicsStateStack<{ colour: string | undefined }>({ colour: "#000000" });
  const colourAt = new Map<number, string | undefined>();
  const coloursOf = new Map<string, Set<string | undefined>>();
  ops.forEach((op, i) => {
    trackFillColour(state, op);
    if (op.op !== "paintImageMaskXObject" || !Array.isArray(op.args) || typeof op.args[0] !== "string") return;
    colourAt.set(i, state.current.colour);
    (coloursOf.get(op.args[0]) ?? coloursOf.set(op.args[0], new Set()).get(op.args[0])!).add(state.current.colour);
  });
  if (![...coloursOf.values()].some((colours) => colours.size > 1)) return ops;
  return ops.map((op, i) => {
    if (!colourAt.has(i)) return op;
    const args = op.args as unknown[];
    const name = args[0] as string;
    if (coloursOf.get(name)!.size < 2) return op;
    return { ...op, args: [`${name}${STENCIL_COLOUR_SEPARATOR}${colourAt.get(i) ?? "unknown"}`, ...args.slice(1)] };
  });
}

function paintedPicturesOf(ops: readonly PdfOp[]): {
  scopesByName: ReadonlyMap<string, ReadonlySet<PdfDict | undefined>>;
  paintedByName: ReadonlyMap<string, { resources: PdfDict | undefined; stencil: boolean; colour: string | undefined }>;
} {
  const scopesByName = new Map<string, Set<PdfDict | undefined>>();
  const paintedByName = new Map<
    string,
    { resources: PdfDict | undefined; stencil: boolean; colour: string | undefined }
  >();
  // §8.6.8: the fill colour of a fresh page is BLACK, not « unknown » — a stencil painted without any colour
  // operator is black, and refusing it would lose a legitimate picture. `setFillColourUnknown` is what makes it
  // unknown: a colour set in a space we do not convert (`pdf-ops-ours.ts`).
  const state = new GraphicsStateStack<{ colour: string | undefined }>({ colour: "#000000" });
  for (const op of ops) {
    trackFillColour(state, op);
    const stencil = op.op === "paintImageMaskXObject";
    if ((op.op !== "paintImageXObject" && !stencil) || !Array.isArray(op.args)) continue;
    const [name, resources] = op.args as [unknown, PdfDict | undefined];
    if (typeof name !== "string") continue;
    (scopesByName.get(name) ?? scopesByName.set(name, new Set()).get(name)!).add(resources);
    paintedByName.set(name, { resources, stencil, colour: state.current.colour });
  }
  return { scopesByName, paintedByName };
}

/** The pixels of a DCT, Flate, CCITT or STENCIL picture of the page, by its object name, once decoded here. A name
 *  painted with two different resource scopes (the same name in a page and in a form) is NOT decoded: the picture
 *  would be a guess. */
function ourImagesOf(
  ctx: ReadContext,
  ops: readonly PdfOp[],
): { decoded: ReadonlyMap<string, unknown>; refusals: ReadonlyMap<string, PictureRefusal> } {
  const { scopesByName, paintedByName } = paintedPicturesOf(ops);
  const decoded = new Map<string, unknown>();
  // Beside each picture we do NOT decode, the reason, read from what it declares (`pdf-image-refusal.ts`): a count
  // with nowhere to look is not a report (03/11/2026). Two causes are only knowable here, and this is why
  // they live here: a name painted in two scopes, and a name the resources do not declare at all.
  const refusals = new Map<string, PictureRefusal>();
  for (const [name, painted] of paintedByName) {
    if (scopesByName.get(name)!.size > 1) {
      refusals.set(name, "ambiguous");
      continue;
    }
    const scope = { resources: painted.resources };
    const rawName = painted.stencil ? resourceNameOf(name) : name;
    const decode = (): DecodedImageObject | undefined =>
      ccittImageObjectOf(ctx.ourDoc, scope, name, IMAGE_KIND.GRAYSCALE_1BPP) ??
      jpegImageObjectOf(ctx.ourDoc, scope, name, { rgb: IMAGE_KIND.RGB_24BPP, rgba: IMAGE_KIND.RGBA_32BPP }) ??
      flateImageObjectOf(ctx.ourDoc, scope, name, { rgb: IMAGE_KIND.RGB_24BPP, rgba: IMAGE_KIND.RGBA_32BPP });
    const stream = ctx.ourDoc.resolve(ctx.ourDoc.dictOf(painted.resources?.get("XObject"))?.get(rawName));
    // A picture painted on three hundred pages is decoded and charged ONCE, in the document's cache. Keyed by the stream: the decoders read the
    // stream alone (the resources of the scope only NAME it; none resolves a colour space through them), so every scope gets the same result.
    if (stream?.kind !== "stream") {
      refusals.set(name, "absent");
      continue;
    }
    // 🔴 A STENCIL IS NOT CACHED, and the reason is the invariant just above: its pixels depend on the FILL COLOUR,
    // which is not in the stream. Cached by its stream, the same stamp painted red then blue would come back red.
    const image = painted.stencil
      ? stencilImageObjectOf(ctx.ourDoc, scope, rawName, { rgba: IMAGE_KIND.RGBA_32BPP }, painted.colour)
      : documentCacheOf(ctx.ourDoc).getOrCompute<DecodedImageObject | undefined>(
          PICTURE,
          stream,
          // Never read `.data` here: on a JPEG it is a lazy accessor that decodes on first read, and the cache asks the
          // size on every insertion. The size follows the kind, not an average: four bytes per pixel would charge a
          // 1-bit CCITT page thirty-two times its size, past the cache ceiling, so it would never be kept.
          (decodedImage) => (decodedImage === undefined ? 0 : cachedPictureBytes(decodedImage)),
          decode,
        );
    if (image === undefined) refusals.set(name, pictureRefusalOf(ctx.ourDoc, stream.dict));
    else decoded.set(name, image);
  }
  return { decoded, refusals };
}

/** Scans the operators for what makes a page a hidden-text candidate: an invisible text mode (`candidate`), a WHITE fill
 *  colour (text drawn in the page's colour, `glyph-positions.ts` « paint », 05/11/2026), and an optional-content section
 *  named by `/OC` (`namesLayer`, which implies `candidate`). */
function scanHiddenCandidates(ops: readonly PdfOp[]): { candidate: boolean; namesLayer: boolean } {
  let candidate = false;
  let namesLayer = false;
  for (const op of ops) {
    if (op.op === "setTextRenderingMode") {
      const mode = Array.isArray(op.args) ? ((op.args[0] as number | undefined) ?? 0) : 0;
      if (INVISIBLE_TEXT_MODES.has(mode)) candidate = true;
    } else if (
      op.op === "setFillRGBColor" &&
      Array.isArray(op.args) &&
      typeof op.args[0] === "string" &&
      op.args[0].toLowerCase() === "#ffffff"
    ) {
      candidate = true;
    } else if (
      op.op === "beginMarkedContentProps" &&
      Array.isArray(op.args) &&
      op.args[0] === "OC" &&
      op.args[1] != null
    ) {
      namesLayer = candidate = true;
    }
  }
  return { candidate, namesLayer };
}

/** The glyph-space scale of a Type 3 font (`FontMatrix[0]`, read from our font object), `undefined` for any other font. */
const fontScaleReader =
  (ourFont: (name: string) => OurFontObject | undefined): FontScaleOf =>
  (name) => {
    const font = ourFont(name);
    if (font?.isType3Font !== true) return undefined;
    const scale = font.fontMatrix?.[0];
    return typeof scale === "number" && Number.isFinite(scale) && scale !== 0 ? scale : undefined;
  };

/** Is the font under this key the Symbol font? A font that cannot be read is not Symbol (ignorance, never a verdict). */
const symbolFontReader =
  (symbolVerdict: (name: string) => boolean): SymbolFontOf =>
  (name) =>
    symbolVerdict(name);

/** The layers' visibility for a page: every layer shows unless the page names an optional-content section. */
function visibilityOf(ctx: ReadContext, namesLayer: boolean): (group: unknown) => boolean {
  const config = namesLayer ? ctx.readLayerConfig() : undefined;
  return (group) => config?.isVisible(group) ?? true;
}

/** The weight of each run's font, read once per font. A font without an object has no known weight. */
function resolveRunWeights(ourFont: (name: string) => OurFontObject | undefined, runs: readonly PdfTextRun[]): void {
  const styleByFont = new Map<string, { weight: FontWeight; italic: boolean }>();
  for (const run of runs) {
    if (run.fontId === undefined) continue;
    const known = styleByFont.get(run.fontId);
    const font = known === undefined ? ourFont(run.fontId) : undefined;
    const style = known ?? { weight: font?.weight ?? "unknown", italic: font?.italic === true };
    styleByFont.set(run.fontId, style);
    run.weight = style.weight;
    // The font's italic, or the matrix's (`glyph-runs.ts#shearedItalic`): the PDF says it one way or the other.
    run.italic = style.italic || run.italic === true;
  }
}

/** The pdf object number of a page, the prefix of its marked-content ids (`p<num>R[<gen>]`). */
const pageObjIdOf = (entry: PdfPageEntry): string => `p${refKey(entry.ref)}`;

const normalizeUnicode = (text: string): string => text.normalize("NFKC");

/** The first pass over one page: its operators, its fonts, its glyphs and its runs, all read from our document. */
export function readPageText(ctx: ReadContext, pageIndex: number): PageText {
  const entry = ctx.ourDoc.pages()[pageIndex]!;
  const ops = ourOpsOfPage(ctx.ourDoc, entry, ctx.memo);
  if (ops.length > PDF_MAX_OPS_PER_PAGE)
    throw new ReaderError("FILE_UNSAFE", "the PDF has a page with too many drawing operations to be read");
  count(ctx.cost, "operatorsWalked", ops.length);

  const fonts = fontObjectsOfPage(ctx.ourDoc, entry);
  const ourFont = (name: string): OurFontObject | undefined => fonts.get(name);
  const symbolVerdict = (name: string): boolean => {
    const font = fonts.get(name);
    return font !== undefined && symbolVerdictOf(font);
  };
  // Two resource names of one font object are one font (`fontObjectsOfPage` shares the object between them).
  const sameFont = (a: string | undefined, b: string | undefined): boolean => {
    if (a === b) return true;
    const fa = a === undefined ? undefined : fonts.get(a);
    return fa !== undefined && fa === (b === undefined ? undefined : fonts.get(b));
  };
  const fontScaleOf = fontScaleReader(ourFont);
  const symbolFontOf = symbolFontReader(symbolVerdict);
  const pageObjId = pageObjIdOf(entry);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = entry.view;

  let hide: HidePolicy | undefined;
  let glyphs: GlyphFragment[] = [];
  let glyphsUnavailable: PdfTextUnreadReason | undefined;
  // A glyph of a font we could not read, which the filter of the published text would have KEPT (`unreadFontKept`).
  // Only computed when the glyphs were built: a page whose whole text is unread keeps that reason.
  let fontUnread = false;
  try {
    ({ glyphs, hide, fontUnread } = glyphsOfOps(ops, ctx, fontScaleOf, symbolFontOf));
  } catch (error) {
    // NOT narrowed (16/11/2026): the page is published without its text rather than failing the document, and the loss
    // is SAID — the error is classified into a closed word, then dropped (a native error can carry what the file chose).
    glyphs = [];
    glyphsUnavailable = textUnreadReasonOf(error);
  }
  const runs =
    glyphsUnavailable === undefined
      ? runsOfGlyphs(glyphs, { pageObjId, view: [x0, y0, x1, y1], normalize: normalizeUnicode, sameFont })
      : [];
  resolveRunWeights(ourFont, runs);
  const reference = glyphsUnavailable === undefined ? referenceOfGlyphs(glyphs, pageObjId) : [];
  // What the caller will never ask for is not kept: the runs and the reference are built, and the second pass reads `ops` and `glyphs` only for a
  // page its predicates select. Held for every page until the end, they were a few hundred megabytes on a long text document.
  return {
    index: pageIndex,
    ops: ctx.keepOps ? ops : [],
    fonts,
    ...(hide !== undefined ? { hide } : {}),
    glyphs: ctx.keepGlyphs ? glyphs : [],
    ...(glyphsUnavailable !== undefined ? { glyphsUnavailable } : {}),
    ...(fontUnread ? { fontUnread: true as const } : {}),
    runs,
    reference,
  };
}

/** The bounds of our object reader: a refusal for one of them is a `limit` that bit, any other refusal a damaged file.
 *  A `Record` so a reason added to `PdfObjectsRefusalReason` does not compile until it is classified here. */
const REFUSAL_IS_BOUND: Record<PdfObjectsRefusalReason, boolean> = {
  syntax: false,
  truncated: false,
  "nesting-too-deep": true,
  "token-too-long": true,
  "string-too-long": true,
  "stream-length": false,
  "stream-end": false,
  "length-unresolved": false,
  "startxref-missing": false,
  "xref-offset": false,
  "xref-syntax": false,
  "xref-chain": false,
  "xref-too-large": true,
  "filter-unsupported": false,
  predictor: false,
  "stream-decode": false,
  "object-stream": false,
  "xref-stream": false,
  "xref-stale": false,
  "ref-hops": true,
  "page-tree": false,
  "page-box": false,
  "content-syntax": false,
  "content-operands": false,
  "content-too-long": true,
  "inline-image": false,
  encrypted: false,
  "to-unicode": false,
  "value-too-large": true,
  "document-too-large": true,
  "glyphs-too-many": true,
  "forms-too-many": true,
  "font-tables-too-many": true,
  "page-missing": false,
};

/** Why a page's glyphs could not be built, CLASSIFIED from the error by its class, code or closed tag — never by its
 *  message, which is dropped. An abstention of the glyph builder is `unsupported`; a bound of ours that bit is `limit`
 *  (`FILE_UNSAFE`, or a bound of the object reader); any other refusal of ours is `damaged`; anything else `unexpected`. */
export function textUnreadReasonOf(error: unknown): PdfTextUnreadReason {
  if (error instanceof GlyphBuilderAbstention) return "unsupported";
  if (error instanceof PdfObjectsRefusal) return REFUSAL_IS_BOUND[error.reason] ? "limit" : "damaged";
  if (error instanceof ReaderError) {
    if (error.code === "FILE_UNSAFE") return "limit";
    if (error.code === "EXTRACT_FAILED") return "damaged";
  }
  return "unexpected";
}

/** The glyphs of a page's operators, and the hide policy when the page holds hidden-text candidates. The operators are walked ONCE: the policy is
 *  decided from the glyphs read, then the same glyphs are filtered by it (a second walk doubled the cost of every page of an OCR'd scan). */
function glyphsOfOps(
  ops: PdfOp[],
  ctx: ReadContext,
  fontScaleOf: FontScaleOf,
  symbolFontOf: SymbolFontOf,
): { glyphs: GlyphFragment[]; hide: HidePolicy | undefined; fontUnread: boolean } {
  // Counted before building: a hostile page must not allocate its glyph objects just to be refused.
  if (countShownGlyphs(ops) > MAX_FILTERED_GLYPHS)
    throw new ReaderError("FILE_UNSAFE", "the page has too many shown glyphs to be read");
  const { candidate, namesLayer } = scanHiddenCandidates(ops);
  const isLayerVisible = candidate ? visibilityOf(ctx, namesLayer) : undefined;
  const all = readGlyphs(ops, isLayerVisible, fontScaleOf, symbolFontOf);
  const hide: HidePolicy | undefined =
    isLayerVisible === undefined ? undefined : { isLayerVisible, dropModeHidden: dropsModeHidden(all) };
  return { glyphs: filteredGlyphs(all, hide), hide, fontUnread: unreadFontKept(all, hide) };
}

/** The pictures of a page the caller asked for: those we decode, and the names painted (an unpainted name is not a failure). */
function picturesOf(
  text: PageText,
  ctx: ReadContext,
  wantsOps: boolean,
): {
  ops: PdfOp[];
  decoded: ReadonlyMap<string, unknown>;
  painted: ReadonlySet<string>;
  refusals: ReadonlyMap<string, PictureRefusal>;
} {
  if (!wantsOps) return { ops: [], decoded: new Map(), painted: new Set(), refusals: new Map() };
  const ops = splitStencilsByColour(text.ops);
  // A stencil (`paintImageMaskXObject`) counts as painted: no decoder of ours reads one, and a picture that leaves
  //  the page must be able to SAY why (`imageRefusal` answers `mask` for it).
  const painted = new Set(
    ops
      .filter((op) => op.op === "paintImageXObject" || op.op === "paintImageMaskXObject")
      .map((op) => String((op.args as unknown[])[0])),
  );
  return { ...ourImagesOf(ctx, ops), painted, ops };
}

/** The declared reading order and the notes of the page's structure tree, and the reference cycles with their notes marked. */
function structureOf(
  text: PageText,
  ctx: ReadContext,
  entry: PdfPageEntry,
): { declaredOrder: string[]; noteIds: Set<string>; reference: PdfReferenceCycle[] } {
  const declared = declaredStructureOf(ctx.ourDoc, entry);
  const declaredOrder: string[] = [...(declared?.declaredOrder ?? [])];
  const noteIds = new Set<string>(declared?.noteIds ?? []);
  const reference = noteIds.size === 0 ? text.reference : text.reference.map((cycle) => markNote(cycle, noteIds));
  return { declaredOrder, noteIds, reference };
}

const markNote = (cycle: PdfReferenceCycle, noteIds: ReadonlySet<string>): PdfReferenceCycle =>
  cycle.markedContentId !== undefined && noteIds.has(cycle.markedContentId) ? { ...cycle, note: true as const } : cycle;

/** What the caller asked for this page: its glyphs (which imply its operators), or its operators. */
function wantsOf(text: PageText, pageIndex: number, wants: PageWants): { wantsGlyphs: boolean; wantsOps: boolean } {
  const wantsGlyphs = wants.wantGlyphs?.(pageIndex, text.runs, wants.allRuns, wants.allHasText) === true;
  const wantsOps = wantsGlyphs || wants.wantOps?.(pageIndex, text.runs, wants.allRuns, wants.allHasText) === true;
  return { wantsGlyphs, wantsOps };
}

/** The page box of the view, as the page's `width`, `height` and `bottom`. */
function boxOf(entry: PdfPageEntry): { width: number; height: number; bottom: number } {
  const [vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0] = entry.view;
  return { width: Math.abs(vx1 - vx0), height: Math.abs(vy1 - vy0), bottom: Math.min(vy0, vy1) };
}

/** Second pass over one page: what the caller's predicates ask for (operators, images, glyphs), the declared reading
 *  order and the notes of the structure tree, and the links. */
export function readPageSource(text: PageText, pageIndex: number, wants: PageWants, ctx: ReadContext): PdfSourcePage {
  const { runs, hide } = text;
  const { wantsGlyphs, wantsOps } = wantsOf(text, pageIndex, wants);
  const { ops, decoded, painted, refusals } = picturesOf(text, ctx, wantsOps);
  const entry = ctx.ourDoc.pages()[pageIndex]!;
  const { declaredOrder, noteIds, reference } = structureOf(text, ctx, entry);
  const links = runs.length === 0 ? [] : linkAnnotationsOfPage(ctx.ourDoc, entry);
  const glyphs = wantsGlyphs ? text.glyphs : [];
  if (wantsGlyphs) count(ctx.cost, "glyphFragments", glyphs.length);

  const store = { get: (name: string) => decoded.get(name) };
  return {
    ...boxOf(entry),
    runs,
    hasText: hasReadableText(linesFromItems(runs)),
    ops: wantsOps ? ops : [],
    ...(hide !== undefined ? { isLayerVisible: hide.isLayerVisible } : {}),
    readImage: (name: string) => readImageObject(store, name, IMAGE_KIND),
    imageFailure: (name: string) =>
      painted.has(name) && readImageObject(store, name, IMAGE_KIND) === undefined ? "unreadable" : undefined,
    imageRefusal: (name: string) => (painted.has(name) ? refusals.get(name) : undefined),
    imageRef: (name: string) => readImageRef(store, name),
    glyphs,
    ...(text.glyphsUnavailable !== undefined ? { glyphsUnavailable: text.glyphsUnavailable } : {}),
    ...(text.fontUnread === true ? { fontUnread: true as const } : {}),
    ...(declaredOrder.length > 0 ? { declaredOrder: hoistAgainstTree(declaredOrder, runs) } : {}),
    ...(noteIds.size > 0 ? { noteIds } : {}),
    reference,
    links,
  };
}

/** The document, read ONCE by our reader. A file our reader refuses is refused here: there is no second reader.
 *  An encrypted file that needs a password we do not have is named as such (the reader refuses it with the reason
 *  "encrypted", as pdf.js raised its PasswordException). Any other refusal keeps the message we compose for a damaged
 *  file, and carries OUR reason on `cause` for a tool to read (04/11/2026): the message is unchanged, the reason no
 *  longer thrown away. */
function openOrRefuse(bytes: Uint8Array): ReturnType<typeof openOurGlyphs> {
  try {
    return openOurGlyphs(bytes);
  } catch (error) {
    if (error instanceof PdfObjectsRefusal && error.reason === "encrypted") {
      throw new ReaderError("DOCUMENT_PASSWORD_PROTECTED", "this PDF is protected by a password");
    }
    // 04/11/2026: four documents of the corpus failed and nothing could say WHY — every refusal arrived here as this one message, so
    // `xref-syntax`, `startxref-missing` and `stream-decode` were indistinguishable, and a tool had no idea where to look. The reason is
    // OUR OWN word, from a closed vocabulary (`pdf-objects/refusal.ts`), so it may travel: it rides on `cause`, which never reaches the
    // message. The displayed text does not change — it stays the one we compose, and its test pins it.
    throw new ReaderError(
      "EXTRACT_FAILED",
      "the file is damaged or is not a valid PDF",
      undefined,
      error instanceof PdfObjectsRefusal ? { cause: error } : undefined,
    );
  }
}

export async function readPdfSource(bytes: Uint8Array, options: ReadPdfSourceOptions = {}): Promise<PdfSource> {
  const { onOpen, wantOps, wantGlyphs, cost, firstPages } = options;
  count(cost, "docOpens");
  const ours = openOrRefuse(bytes);
  const pageCount = ours.document.pages().length;
  // Before any page is read — see `onOpen`.
  onOpen?.(pageCount);

  const info = documentInfoOf(ours.document, bytes);
  const outline = outlineOfDocument(ours.document);
  let layerConfig: LayerConfig | undefined;
  let layersRead = false;
  const ctx: ReadContext = {
    file: bytes,
    cost,
    ourDoc: ours.document,
    memo: ours.memo,
    readLayerConfig: () => {
      if (!layersRead) {
        layerConfig = layerConfigOf(ours.document);
        layersRead = true;
      }
      return layerConfig;
    },
    keepOps: wantOps !== undefined || wantGlyphs !== undefined,
    keepGlyphs: wantGlyphs !== undefined,
  };

  const texts: PageText[] = [];
  for (let pageIndex = 0; pageIndex < Math.min(pageCount, firstPages ?? pageCount); pageIndex++)
    texts.push(readPageText(ctx, pageIndex));

  const allRuns = texts.map((t) => t.runs);
  const allHasText = allRuns.map((runs) => hasReadableText(linesFromItems(runs)));
  const wants: PageWants = { wantOps, wantGlyphs, allRuns, allHasText };
  const pages: PdfSourcePage[] = texts.map((text, pageIndex) => {
    const page = readPageSource(text, pageIndex, wants, ctx);
    // The page holds what it was given; the first pass's copy goes, so a page the caller dropped is freed before the next is read.
    text.ops = [];
    text.glyphs = [];
    return page;
  });
  return { pages, document: ours.document, info, ...(outline !== undefined ? { outline } : {}) };
}
