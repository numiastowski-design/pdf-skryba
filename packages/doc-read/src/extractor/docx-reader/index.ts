/** A .docx read by our own reader, as ECMA-376 declares it: the IR document
 *  and the raw bytes of every image it references, keyed by sha256 —
 *  including a drawing's own shapes picture, synthesized here
 *  (`docx-reader/shapes.ts`), and how many shapes it leaves out
 *  (`DocxReadResult#drawingShapesNotDrawn`, display-only).
 *  DECIDES here, step by step (`readDocx`): the formatting parts and their fallback (`readFormattingParts`), the drawings' own allowance
 *  (`newDrawingImageStore`), which notes are loaded (`loadNoteStories`), the 1×1 Fallback pixels (`findPixelFallbacks`), Google's picture or
 *  our SVG per drawing (`swapGoogleDrawings`), the notices (`buildNotices`).
 *  NOT here: the package layer (`ooxml/package.ts`), the walk of a story
 *  (`docx-reader/body.ts`), nor persisting images
 *  (`orchestrator/doc-processor.ts`).
 *  Called by: `extractor/docx.ts`, `extractor/google-doc.ts`. */

import { sha256Hex } from "doc-ir/lib/digest";

import { listedMimeType } from "../../lib/mime-types";
import type { ReaderError } from "doc-ir/lib/reader-error";
import { type PageLabelOverride, resolveLabels } from "doc-ir/lib/page-labels";
import { type ReaderLimits, unpublishedPartNotices } from "doc-ir/lib/reader-limits";
import { withholdOversizedTables } from "doc-ir/lib/table-width-cap";
import type { DocumentNotice } from "doc-ir/lib/reader-types";
import type { ImageRef, IRBlock, IRDoc } from "doc-ir/lib/ir";
import { columnsBackToTables, layoutTablesToColumns } from "./layout-tables";
import { dropDeadAnchorLinks, freshFields, type NotePart, type ReadContext, readBlocks, targetedBookmarks } from "./body";
import { ImageCollector } from "../image-collector";
import { imagePixelWidth } from "doc-ir/extractor/image-pixel-width";
import { type DrawingObjects, preloadObjects } from "./drawing-objects";
import { type DrawingLedger, type GoogleDrawingSource, googlePictures, newDrawingLedger, PENDING_DRAWING_REF } from "./google-drawings";
import { mapImageRefs } from "./image-refs";
import { readNumbering } from "./numbering";
import { isOnePixel } from "../image-reduction";
import { fallbackPictureRelIds, type ImageLookup, largestPage } from "./objects";
import { damaged, type DocxPackage, IMAGE_MAX_TOTAL_BYTES, openPackage, OverAllowanceError, orDamaged, PartDamagedError, readOrFlag, type Relationship, relationOfKind } from "../ooxml/package";
import type { DrawingImageRegistrar } from "./shapes";
import { readStyles } from "./styles";
import { attr, child, children, kids, someDescendant, tagOf, textOf, type XNode } from "../ooxml/xml";

/** A picture's bytes as the reader hands them on, keyed by sha256. Same shape as the shared declaration
 *  `extractor/raw-image.ts#RawImage`, kept local to this reader. */
interface RawImage {
  sha256: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface DocxReadResult {
  doc: IRDoc;
  images: RawImage[];
  /** Total shapes NOT drawn, across every drawing of the document (D2 of
   *  MIKSUDOC « Spécification fonctionnelle » §9.5, `docx-reader/shapes.ts`), absent
   *  when every drawing draws every shape it declares (or the document has
   *  none). Display-only, for the dashboard (`orchestrator/doc-processor.ts`
   *  → `SyncedDocument#drawingShapesNotDrawn`) — never on the published
   *  page (Mikolaj, 29/09/2026). */
  drawingShapesNotDrawn?: number;
  /** Charts the reader keeps out whole (a bound, a damaged part): one `chart-withheld` entry with their count,
   *  one `image-missing` entry for pictures whose part is damaged or past the image byte budget, and `hidden-dropped` entries (hidden drawings, tracked
   *  deletions holding text); absent when none. Display-only, like the pptx path's notices. */
  notices?: DocumentNotice[];
}

export type { GoogleDrawingSource } from "./google-drawings";

/** Marks a picture ref whose bytes are not read yet; never survives
 *  `readDocx`. */
export const PENDING_REF = "\u0000pending:";
const PENDING = PENDING_REF;

/** No `pending:` ref may survive `resolve` — the guard the recensement of
 *  28/09/2026 asked for: `resolve`'s `fix` patches an INVENTORY of block
 *  kinds, and an image carried anywhere else (an `Inline.image`, a future
 *  block) would cross with the sentinel as its sha256 — an attachment
 *  named from `pending:`, in silence. Generic on purpose: the WHOLE tree,
 *  never an inventory. A plain Error — OUR defect, UNKNOWN upstream,
 *  retried and visible, never blamed on the file. */
export const assertNoPendingRef = (doc: IRDoc): void => {
  // A structural recursion, not a serialization: it visits every array
  // element and object property — the nested block carriers (blocks, cells,
  // items, rows), the inlines' `image.sha256`, the image blocks' `ref.sha256`
  // and the chart/equation blocks' `image.sha256` included — and stops at the
  // first sentinel, without ever building the JSON text of the whole page.
  const taints = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(taints);
    if (typeof value !== "object" || value === null) return false;
    return Object.entries(value as Record<string, unknown>).some(
      ([key, inner]) =>
        (key === "sha256" && typeof inner === "string" && inner.startsWith(PENDING_REF)) || taints(inner),
    );
  };
  if (taints(doc)) throw new Error("docx-reader: a pending image ref survived resolve");
};

/** The image relationship `relId` names, when it is internal and its part exists. */
const internalImage = (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>, relId: string): Relationship | undefined => {
  const rel = rels.get(relId);
  return rel && rel.kind === "image" && !rel.external && pkg.hasPart(rel.target) ? rel : undefined;
};

/**
 * The pictures of one document, read LAZILY (review of 27/09/2026 night,
 * finding 9). The walk is synchronous, so its lookup cannot inflate: it only
 * checks that the part exists and notes it, returning a pending ref; once
 * every story is read, `resolve` inflates the parts the walk actually used —
 * an `mc:Fallback` picture, or one no drawing names, is never inflated — under
 * `IMAGE_MAX_TOTAL_BYTES`, and patches the refs. A part named by several
 * relationships (or parts) is read once; identical bytes are one entry,
 * keyed by sha256, in order of first use.
 */
const pictures = (pkg: DocxPackage, onDamaged: () => ReaderError, limits: ReaderLimits | undefined) => {
  const targets: string[] = [];
  const indexOf = new Map<string, number>();
  // Pictures the walk asked for whose part cannot be read at all (absent from the archive, linked externally, relationship
  // that does not resolve): said like a damaged one, in the same `image-missing` count.
  let unreachable = 0;
  const lookup = (rels: ReadonlyMap<string, Relationship>): ImageLookup => (relId) => {
    const rel = internalImage(pkg, rels, relId);
    if (!rel) {
      unreachable++;
      return undefined;
    }
    let at = indexOf.get(rel.target);
    if (at === undefined) {
      at = targets.push(rel.target) - 1;
      indexOf.set(rel.target, at);
    }
    // The declared type crosses only from our list (finding 1).
    return { sha256: `${PENDING}${at}`, mimeType: listedMimeType(pkg.contentType(rel.target)) };
  };

  const resolve = async (blocks: IRBlock[], totalBudget: number = limits?.payloadBytes ?? IMAGE_MAX_TOTAL_BYTES): Promise<{ blocks: IRBlock[]; images: RawImage[]; dropped: number }> => {
    // `undefined` = that picture's part is damaged: its image blocks leave the page, the rest is published.
    const refs: (Pick<ImageRef, "sha256" | "mimeType" | "pixelWidth"> | undefined)[] = [];
    // Reduces an oversized picture before its sha256 (the published bytes name the attachment).
    const collector = new ImageCollector();
    let budget = totalBudget;
    for (const target of targets) {
      // A picture past what is left of the budget is left out alone, like a damaged one (Mikolaj, 14/10/2026). Its DECLARED
      // size is checked first, so a skipped picture is never inflated and spends nothing of the package counter (twenty
      // 30 MB EMF pictures must not refuse the document). A header that lies low still stops at `budget`.
      const declared = pkg.declaredSize(target);
      const read =
        declared !== undefined && declared > budget
          ? undefined
          : await orDamaged(async () => {
              try {
                const got = await pkg.readBytes(target, budget);
                if (!got) throw onDamaged(); // hasPart said it was there
                return got;
              } catch (e) {
                if (e instanceof OverAllowanceError) throw new PartDamagedError(e);
                throw e;
              }
            });
      if (read === undefined) {
        refs.push(undefined);
        continue;
      }
      const bytes = read;
      budget -= bytes.byteLength;
      const collected = collector.collect(bytes, listedMimeType(pkg.contentType(target)));
      // The file's own width (the reduced file's when reduced): the page never draws the image wider (G2).
      const pixelWidth = collected.pixelWidth ?? imagePixelWidth(bytes);
      refs.push({ sha256: collected.sha256, mimeType: collected.mimeType, ...(pixelWidth !== undefined ? { pixelWidth } : {}) });
    }
    let dropped = 0;
    const patch = (ref: ImageRef): ImageRef | undefined => {
      if (!ref.sha256.startsWith(PENDING)) return ref;
      const at = Number(ref.sha256.slice(PENDING.length));
      if (at >= refs.length) throw onDamaged();
      const found = refs[at];
      if (found === undefined) dropped++;
      return found === undefined ? undefined : { ...ref, ...found };
    };
    const patched = targets.length > 0 ? mapImageRefs(blocks, patch) : blocks;
    return { blocks: patched, images: collector.images, dropped: dropped + unreachable };
  };

  return { lookup, resolve };
};

interface Story {
  root: XNode;
  rels: ReadonlyMap<string, Relationship>;
}

/** The styles and the numbering of the document. A damaged part is not a reason to refuse: default formatting, said in one notice (08/10/2026). */
const readFormattingParts = async (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>): Promise<Pick<ReadContext, "styles" | "numbering"> & { stylesDefaulted: boolean }> => {
  const partOfKind = async (kind: string) => {
    const rel = relationOfKind(rels, kind);
    return rel ? pkg.readXml(rel.target) : undefined;
  };
  let stylesDefaulted = false;
  const formattingPart = async (kind: string): Promise<XNode | undefined> => {
    const { value, damaged: partDamaged } = await readOrFlag(() => partOfKind(kind));
    if (partDamaged) stylesDefaulted = true;
    return value;
  };
  const styles = readStyles(await formattingPart("styles"));
  const numbering = readNumbering(await formattingPart("numbering"), (styleId) => {
    const numPr = styles.paragraphProperty(styleId, "w:numPr");
    const numIdEl = numPr ? child(numPr, "w:numId") : undefined;
    return numIdEl ? attr(numIdEl, "w:val") : undefined;
  });
  return { styles, numbering, stylesDefaulted };
};

/** A drawing's own shapes-picture (D2, `docx-reader/shapes.ts`): its bytes are already in hand at read time (a synthesized SVG,
 *  not a package part), so no lazy `pending:` ref is needed here — only the SAME dedup-by-sha256 the embedded pictures get,
 *  kept separate since the two are never the same bytes. Synthesized SVG bytes have their OWN allowance, the same size as the
 *  pictures' (lead decision 30/09/2026): real pictures keep the full IMAGE_MAX_TOTAL_BYTES, so a drawing can never get a
 *  document refused. Over its allowance a drawing follows the not-drawn path. `bytes` is the allowance spent; Google's pictures
 *  (`swapGoogleDrawings`) spend it too. */
interface DrawingImageStore {
  readonly images: Map<string, RawImage>;
  /** The bytes the drawings may spend together: `ReaderLimits.payloadBytes`, else `IMAGE_MAX_TOTAL_BYTES`. */
  readonly allowance: number;
  bytes: number;
  readonly register: DrawingImageRegistrar;
}

const newDrawingImageStore = (limits: ReaderLimits | undefined): DrawingImageStore => {
  const store: DrawingImageStore = {
    images: new Map(),
    allowance: limits?.payloadBytes ?? IMAGE_MAX_TOTAL_BYTES,
    bytes: 0,
    register: (bytes, mimeType) => {
      const sha256 = sha256Hex(bytes);
      if (!store.images.has(sha256)) {
        if (store.bytes + bytes.byteLength > store.allowance) return undefined;
        store.bytes += bytes.byteLength;
        store.images.set(sha256, { sha256, bytes, mimeType });
      }
      return { sha256, mimeType };
    },
  };
  return store;
};

/** What the walk counts for the dashboard and the notices, never as text on the page (Mikolaj, 29/09/2026 and 08/10/2026): the
 *  shapes left out of the drawings' pictures (summed across every drawing), the hidden drawings kept out whole, the empty fields. */
interface Tally {
  shapesNotDrawn: number;
  hiddenShapes: number;
  emptyFields: number;
}

/** Note calls in the order they are read, footnotes and endnotes together: the number shown is the position here, from 1 (the id
 *  only names the note inside its part). The Map finds a repeated call without scanning every earlier one (review of
 *  27/09/2026 night, finding 14). */
const newNoteCalls = () => {
  const called: { part: NotePart; id: string }[] = [];
  const numberOf = new Map<string, number>();
  const noteCall = (part: NotePart, id: string): number => {
    const key = `${part}\u0000${id}`;
    const known = numberOf.get(key);
    if (known !== undefined) return known;
    called.push({ part, id });
    numberOf.set(key, called.length);
    return called.length;
  };
  return { called, noteCall };
};

/** The stories whose charts and SmartArts are read ahead of the walk (`docx-reader/drawing-objects.ts`): the body, then the notes it
 *  calls. Each notes part is parsed ONCE, here, and handed to `noteBlocks` (every inflate counts against PACKAGE_MAX_BYTES: a part
 *  read twice counts twice). A body that calls no note reads none: a note is only ever called from the body, then from another note. */
const loadNoteStories = async (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>, body: XNode): Promise<{ storyRoots: Story[]; noteStories: Map<NotePart, Story> }> => {
  const storyRoots: Story[] = [{ root: body, rels }];
  const noteStories = new Map<NotePart, Story>();
  if (callsNotes(body)) {
    for (const kind of ["footnotes", "endnotes"] as const) {
      const rel = relationOfKind(rels, kind);
      const root = rel ? await pkg.readXml(rel.target) : undefined;
      if (rel && root) {
        const story = { root, rels: await pkg.relationships(rel.target) };
        noteStories.set(kind, story);
        storyRoots.push(story);
      }
    }
  }
  return { storyRoots, noteStories };
};

/** Largest inflated size a 1×1 picture can have (a PNG or GIF of one pixel is a few hundred bytes; starting value, generous). */
const ONE_PIXEL_MAX_BYTES = 64 * 1024;

/** The 1×1 pixels among the pictures the Fallbacks of the body name: junk, never published in place of an unread Choice (M16).
 *  Only the main part. */
const findPixelFallbacks = async (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>, body: XNode): Promise<Set<string>> => {
  const pixelIds = new Set<string>();
  for (const id of new Set(fallbackPictureRelIds(body))) {
    const rel = internalImage(pkg, rels, id);
    if (!rel) continue;
    // A 1×1 pixel is tiny: a picture declared larger is not one, and is never inflated for the probe (it would spend the
    // package budget the real pictures need). A damaged Fallback picture is simply not a known pixel.
    if ((pkg.declaredSize(rel.target) ?? 0) > ONE_PIXEL_MAX_BYTES) continue;
    const bytes = await orDamaged(async () => {
      try {
        return await pkg.readBytes(rel.target, ONE_PIXEL_MAX_BYTES);
      } catch (e) {
        if (e instanceof OverAllowanceError) return undefined;
        throw e;
      }
    });
    if (bytes && isOnePixel(bytes)) pixelIds.add(id);
  }
  return pixelIds;
};

/** The picture each drawing of the document ends up with: Google's image for the drawings it matches (voie A), our SVG for the
 *  others. The export is asked only when a drawing was drawn, and never decides the document: any refusal leaves our SVG. */
const swapGoogleDrawings = async (drawings: DrawingLedger, google: GoogleDrawingSource | undefined, store: DrawingImageStore): Promise<ImageRef[]> => {
  const kept = drawings.slots.map((slot): ImageRef => slot.picture);
  if (google === undefined) return kept;
  const found = await googlePictures(drawings.slots, google);
  const svgUses = new Map<string, number>();
  for (const s of drawings.slots) svgUses.set(s.picture.sha256, (svgUses.get(s.picture.sha256) ?? 0) + 1);
  found.forEach((picture, slot) => {
    const slotOf = drawings.slots[slot];
    if (picture === undefined || slotOf === undefined) return;
    // Google's picture counts in the drawings' own allowance, like our SVG,
    // which it replaces: the SVG's bytes are refunded when no other slot
    // still shows it.
    const svgSha = slotOf.picture.sha256;
    const svg = store.images.get(svgSha);
    const refund = svg !== undefined && (svgUses.get(svgSha) ?? 0) <= 1 ? svg.bytes.byteLength : 0;
    if (!store.images.has(picture.ref.sha256)) {
      if (store.bytes - refund + picture.bytes.byteLength > store.allowance) return;
      store.bytes += picture.bytes.byteLength;
      store.images.set(picture.ref.sha256, { sha256: picture.ref.sha256, bytes: picture.bytes, mimeType: picture.ref.mimeType });
    }
    svgUses.set(svgSha, (svgUses.get(svgSha) ?? 1) - 1);
    if (refund > 0) {
      store.images.delete(svgSha);
      store.bytes -= refund;
    }
    kept[slot] = picture.ref;
  });
  // An SVG no slot keeps is not attached.
  const stillDrawn = new Set(kept.map((ref) => ref.sha256));
  for (const slot of drawings.slots) if (!stillDrawn.has(slot.picture.sha256)) store.images.delete(slot.picture.sha256);
  return kept;
};

/** A part left out is said, one folded notice per kind: a chart kept out (bound or damaged part), a picture whose part is damaged. */
const buildNotices = (found: {
  stylesDefaulted: boolean;
  emptyFields: number;
  objects: DrawingObjects;
  imagesMissing: number;
  hiddenShapes: number;
  tablesWithheld: number;
  storyRoots: readonly Story[];
}): DocumentNotice[] => {
  const notices: DocumentNotice[] = [
    ...(found.stylesDefaulted ? [{ kind: "styles-defaulted" as const }] : []),
    ...(found.emptyFields > 0 ? [{ kind: "field-results-empty" as const, count: found.emptyFields }] : []),
  ];
  notices.push(...unpublishedPartNotices({
    chartsWithheld: found.objects.chartsWithheld(),
    imagesMissing: found.imagesMissing,
    hiddenShapes: found.hiddenShapes,
    tablesWithheld: found.tablesWithheld,
    trackedDeletions: found.storyRoots.reduce((sum, story) => sum + countTrackedDeletions(story.root), 0),
  }));
  return notices;
};

/** `onDamaged` names the format in the error the user sees — the Word file's
 *  or the Google Docs export's (review of 27/09/2026 night, finding 6): the
 *  one message a damaged package gives, while a defect of this reader stays
 *  its own error. */
export const readDocx = async (
  bytes: Uint8Array,
  onDamaged: () => ReaderError = damaged,
  google?: GoogleDrawingSource,
  limits?: ReaderLimits,
  /** The caller's own labels, when it gave any: only the note call is written by this reader. */
  labelOverride?: PageLabelOverride,
): Promise<DocxReadResult> => {
  // The only label this reader writes is the note call, which both our tables spell the same way (`page-labels.ts`): the page
  // language changes nothing here, the caller's override changes everything.
  const labels = resolveLabels("en", labelOverride);
  const pkg = await openPackage(bytes, onDamaged);
  const document = await pkg.readXml(pkg.mainPart);
  const body = document ? child(document, "w:body") : undefined;
  if (!body) throw onDamaged();

  const rels = await pkg.relationships(pkg.mainPart);
  const { styles, numbering, stylesDefaulted } = await readFormattingParts(pkg, rels);
  const images = pictures(pkg, onDamaged, limits);
  const drawingStore = newDrawingImageStore(limits);
  const tally: Tally = { shapesNotDrawn: 0, hiddenShapes: 0, emptyFields: 0 };
  const reportShapesNotDrawn = (count: number): void => {
    tally.shapesNotDrawn += count;
  };
  const reportHiddenShape = (): void => {
    tally.hiddenShapes++;
  };
  // The drawings we drew, each a pending ref until Google's export has been
  // asked (D2 voie A, `docx-reader/google-drawings.ts`).
  const drawings = newDrawingLedger();
  const { called, noteCall } = newNoteCalls();
  // Bookmarks become anchors only where a link of the body targets them.
  const anchors = { targeted: targetedBookmarks(body, rels), pending: [], placed: new Set<string>() };
  const { storyRoots, noteStories } = await loadNoteStories(pkg, rels, body);
  const objects = await preloadObjects(pkg, storyRoots, limits);
  const pixelIds = await findPixelFallbacks(pkg, rels, body);
  const textBoxBlocks = new Set<IRBlock>();
  const bodyBlocks = readBlocks(body, {
    textBoxBlocks,
    reportEmptyField: () => {
      tally.emptyFields++;
    },
    page: largestPage(body),
    isPixelImage: (id) => pixelIds.has(id),
    rels,
    styles,
    numbering,
    image: images.lookup(rels),
    drawingImage: drawingStore.register,
    reportShapesNotDrawn,
    reportHiddenShape,
    drawings,
    objects,
    noteCall,
    fields: [],
    anchors,
    limits,
    labels,
  });
  // A one-row table of side-by-side prose becomes columns: on the body's own blocks only (never a note, a cell, a text box).
  const blocks = layoutTablesToColumns(bodyBlocks, textBoxBlocks);
  blocks.push(
    ...noteBlocks(
      noteStories,
      called,
      { styles, numbering, noteCall, page: largestPage(body), anchors, drawingImage: drawingStore.register, reportShapesNotDrawn, reportHiddenShape, drawings, objects, limits, labels },
      images.lookup,
    ),
  );
  // The words of every SmartArt, in one collapsed block (milestone 0 of the
  // diagram text: they were lost before), after the notes were read.
  blocks.push(...objects.gathered());
  const kept = await swapGoogleDrawings(drawings, google, drawingStore);
  const drawn = mapImageRefs(dropDeadAnchorLinks(blocks, anchors.placed), (ref) =>
    ref.sha256.startsWith(PENDING_DRAWING_REF) ? (kept[Number(ref.sha256.slice(PENDING_DRAWING_REF.length))] ?? ref) : ref,
  );
  const resolved = await images.resolve(drawn);
  // A table wider than MAX_TABLE_COLS or longer than MAX_TABLE_ROWS is not published, and said (one notice for the document).
  const { blocks: published, withheld: tablesWithheld } = withholdOversizedTables(columnsBackToTables(resolved.blocks), undefined, limits);
  const doc: IRDoc = { blocks: published };
  assertNoPendingRef(doc);
  const notices = buildNotices({ stylesDefaulted, emptyFields: tally.emptyFields, objects, imagesMissing: resolved.dropped, hiddenShapes: tally.hiddenShapes, tablesWithheld, storyRoots });
  return {
    doc,
    images: [...resolved.images, ...drawingStore.images.values()],
    ...(tally.shapesNotDrawn > 0 ? { drawingShapesNotDrawn: tally.shapesNotDrawn } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
};

/** The `w:del` elements of a story that hold text (`w:delText` or `w:t`, anywhere inside): the deletions the reader drops.
 *  A paragraph-mark deletion (`w:rPr/w:del`) holds none and is not counted. */
const countTrackedDeletions = (node: XNode): number => {
  if (tagOf(node) === "w:del") return holdsText(node) ? 1 : 0;
  return kids(node).reduce((sum, k) => sum + countTrackedDeletions(k), 0);
};

const holdsText = (node: XNode): boolean =>
  someDescendant(node, (n) => {
    const tag = tagOf(n);
    return (tag === "w:delText" || tag === "w:t") && textOf(n).trim().length > 0;
  });

/** Whether the body holds a note call anywhere (a superset of the calls the walk reads). */
const callsNotes = (node: XNode): boolean =>
  someDescendant(node, (n) => {
    const tag = tagOf(n);
    return tag === "w:footnoteReference" || tag === "w:endnoteReference";
  });

const NOTE_ELEMENT: Record<NotePart, string> = { footnotes: "w:footnote", endnotes: "w:endnote" };

/**
 * The notes the body calls, in call order, as IR `footnote` blocks (grouped at
 * the end of the page by the renderer, in one numbered list). A note is a
 * story of its own part (footnotes.xml or endnotes.xml), walked with THAT
 * part's relationships. The note's own mark (`w:footnoteRef`,
 * `w:endnoteRef`) is not read — the renderer numbers the list. A note called
 * but absent from its part gives an EMPTY block, so that the list positions
 * still match the numbers in the text.
 */
const noteBlocks = (
  stories: ReadonlyMap<NotePart, { root: XNode; rels: ReadonlyMap<string, Relationship> }>,
  called: readonly { part: NotePart; id: string }[],
  shared: Pick<ReadContext, "styles" | "numbering" | "page" | "noteCall" | "anchors" | "drawingImage" | "reportShapesNotDrawn" | "reportHiddenShape" | "drawings" | "objects" | "limits" | "labels">,
  imageLookup: (rels: ReadonlyMap<string, Relationship>) => ImageLookup,
): IRBlock[] => {
  if (called.length === 0) return [];
  const parts = new Map<NotePart, { notes: Map<string | undefined, XNode>; base: ReadContext } | undefined>();
  for (const [kind, { root, rels }] of stories) {
    parts.set(kind, {
      notes: new Map(children(root, NOTE_ELEMENT[kind]).map((n) => [attr(n, "w:id"), n] as const)),
      base: { ...shared, rels, image: imageLookup(rels), fields: [] },
    });
  }
  const out: IRBlock[] = [];
  // `called` may grow while notes are read (a call inside a note).
  for (let i = 0; i < called.length; i++) {
    const call = called[i];
    const part = call ? parts.get(call.part) : undefined;
    const note = call && part ? part.notes.get(call.id) : undefined;
    const blocks = note && part ? readBlocks(note, freshFields(part.base)) : [];
    out.push({ kind: "footnote", id: String(i + 1), blocks: withoutLeadingSpace(blocks) });
  }
  return out;
};

/** A note's text starts after its mark (`w:footnoteRef`), usually with the
 *  space that separated the mark from the words. The mark is not published
 *  (the list numbers the note), so that space would open the note: it goes.
 *  The anchors a note opens with stay where they are and the space is taken
 *  from the first inline after them: an anchor is empty text, and dropping it
 *  as « space » left a link to it pointing nowhere — the anchor was already
 *  counted as written (review of 27/09/2026 night, finding 11). */
const withoutLeadingSpace = (blocks: IRBlock[]): IRBlock[] => {
  const [first, ...rest] = blocks;
  if (first?.kind !== "paragraph") return blocks;
  const at = first.inlines.findIndex((i) => i.anchor === undefined);
  const head = first.inlines[at];
  if (!head || head.image) return blocks;
  const text = head.text.replace(/^\s+/, "");
  const inlines = [...first.inlines.slice(0, at), ...(text.length > 0 ? [{ ...head, text }] : []), ...first.inlines.slice(at + 1)];
  return [{ ...first, inlines }, ...rest];
};
