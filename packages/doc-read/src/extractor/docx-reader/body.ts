/** A WordprocessingML story (the document body, a table cell, a text box, a
 *  note) turned into IR blocks: which elements are read, which are walked
 *  through as plain containers, and which are skipped. Also parses HYPERLINK fields, orders blocks by their
 *  connectors, pre-scans bookmarks and drops dead internal links.
 *  Decides: revisions are read in their ACCEPTED state; hidden text, a field's instructions and a table of contents'
 *  cached entries are not published; a drawing that is hidden or wholly off the page gives nothing; an
 *  `mc:AlternateContent` gives its Choice, or its image-only Fallback when the Choice gives nothing; a link to a
 *  bookmark no text block carries is published as text.
 *  NOT here: opening the archive (`ooxml/package.ts`), nor the XML tree
 *  itself (`ooxml/xml.ts`).
 *  Called by: `docx-reader/index.ts`. */

import { type BlockAlign, type IRBlock, type Inline } from "doc-ir/lib/ir";
import { externalLinkTarget } from "doc-ir/lib/link-schemes";
import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import { mapInlines } from "doc-ir/lib/ir-walk";
import { tableGridWidth, withoutEmptyTableParts } from "doc-ir/lib/table-empty-parts";
import { tableExceedsCaps } from "doc-ir/lib/table-width-cap";
import { nestLists } from "../../lib/nest-lists";
import type { PageLabels } from "doc-ir/lib/page-labels";
import { MAX_ILVL, type Numbering } from "./numbering";
import {
  type AnchorKey,
  chosenContent,
  equationText,
  type ImageLookup,
  isHiddenDrawing,
  isOffPage,
  type PageSize,
  readDrawing,
  unreadChoiceFallback,
  vmlTextBoxes,
} from "./objects";
import { framedSkippedText } from "../skipped-elements";
import { type DrawingObjects, drawingObjectsOf } from "./drawing-objects";
import { collapseBlanks } from "doc-ir/lib/blanks";
import { isSymbolFont, symbolFontText } from "doc-ir/lib/symbol-font";
import { type DrawingLedger } from "./google-drawings";
import type { Relationship } from "../ooxml/package";
import { type DrawingDiagram, type DrawingImageRegistrar, drawnShapeBlocks, readDrawingDiagram } from "./shapes";
import {
  type DiagramConnector,
  type DiagramElement,
  OOXML_DIAGRAM_TOLERANCES,
  orderDiagram,
} from "doc-ir/layout/diagram-graph";
import type { Box } from "doc-ir/layout/slide-elements";
import { onOff, type Styles } from "./styles";
import { intAttr } from "../../lib/ooxml-num";
import {
  attributeOf,
  findChild,
  findChildren,
  childNodesOf,
  qualifiedNameOf,
  textContentOf,
  valOfChild,
  type XNode,
} from "../ooxml/xml";
import { spanSingleFirstRows } from "../span-single-first";

/** One complex field being read: its instruction text (w:instrText) until
 *  `separate`, then its displayed result until `end` — or, for a table of
 *  contents, a result that is not read at all (`toc`). */
interface OpenField {
  state: "instructions" | "result" | "toc";
  instructions: string;
  /** For a HYPERLINK field in its result: the target its visible words carry (`fieldLinkTarget`). */
  href?: string | undefined;
}

/** The target of a HYPERLINK field instruction (`HYPERLINK "url" \l "frag"`), or undefined for any other field. The URL
 *  goes through the same provenance filter as a w:hyperlink's external target (`externalLinkTarget`); the scheme guard
 *  stays the renderer's. `\l "frag"` appends `#frag`; `\l` ALONE is an internal anchor: no external link, text only. */
const fieldLinkTarget = (instructions: string): string | undefined => {
  const headMatch = /^\s*HYPERLINK\b/i.exec(instructions);
  if (!headMatch) return undefined;
  const tokens = [...instructions.slice(headMatch[0].length).matchAll(/"((?:[^"\\]|\\.)*)"|(\\[a-z])|(\S+)/gi)];
  const valueOf = (token: RegExpMatchArray | undefined): string | undefined =>
    (token?.[1] ?? token?.[3])?.replace(/\\(.)/g, "$1");
  let url: string | undefined;
  let fragment: string | undefined;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]!;
    if (token[2] !== undefined) {
      // \l, \o and \t take the next token as their argument; \m and \n take none.
      const fieldSwitch = token[2].toLowerCase();
      if (fieldSwitch === "\\l" || fieldSwitch === "\\o" || fieldSwitch === "\\t") {
        if (fieldSwitch === "\\l") fragment = valueOf(tokens[tokenIndex + 1]);
        tokenIndex++;
      }
    } else if (url === undefined) url = valueOf(token);
  }
  if (url === undefined || url.length === 0) return undefined;
  const target = externalLinkTarget({ external: true, target: url });
  return target !== undefined && fragment ? `${target}#${fragment}` : target;
};

/** The target the words being read carry because they sit in the result of a HYPERLINK field. */
const openFieldHref = (ctx: ReadContext): string | undefined => {
  const top = ctx.fields[ctx.fields.length - 1];
  return top?.state === "result" ? top.href : undefined;
};

/** Gives the unlinked inlines among `pieces` the href (a w:hyperlink inside the field keeps its own). */
const withHref = (pieces: readonly Piece[], href: string | undefined): Piece[] =>
  href === undefined
    ? [...pieces]
    : pieces.map((piece) =>
        piece.kind === "inline" && piece.inline.href === undefined
          ? { kind: "inline", inline: { ...piece.inline, href } }
          : piece,
      );

/** The TOC field (its instruction's first word is TOC): the document's table
 *  of contents, published as ONE `toc` block like the w:sdt that usually
 *  wraps it; its cached entries and page numbers are not read (24/09/2026). */
const isTocField = (instructions: string): boolean => /^\s*TOC\b/i.test(instructions);

/** The « cold » fields (index, contents and authorities entries, private data): entries that never have a result by
 *  nature, so a missing result is not an omission to report (held by `docx-reader.field-results-empty.test.ts`). */
const COLD_FIELD = /^\s*(?:XE|TC|TA|PRIVATE)(?![A-Z0-9])/i;

/** What a field node tells of a table of contents: "toc-block" (a TOC field whose block stands here), "toc-hidden"
 *  (one, inside the instructions of an enclosing field), or undefined. */
type TocMark = "toc-block" | "toc-hidden" | undefined;

/** Reads one `w:fldChar` or `w:instrText` into the stack of open fields: begin pushes, separate moves a field from its
 *  instructions to its result, end pops, an instruction's text is gathered while it is being written. The ONE state
 *  machine of the complex fields, shared by the run walk, `containsTocField` and `targetedBookmarks`. */
const trackField = (fields: OpenField[], node: XNode, onEmptyField?: () => void): TocMark => {
  const top = fields[fields.length - 1];
  if (qualifiedNameOf(node) === "w:instrText") {
    if (top?.state === "instructions") top.instructions += textContentOf(node);
    return undefined;
  }
  const fldCharType = attributeOf(node, "w:fldCharType");
  if (fldCharType === "begin") fields.push({ state: "instructions", instructions: "" });
  else if (fldCharType === "separate" && top?.state === "instructions") return separateField(fields, top);
  else if (fldCharType === "end") return endField(fields, onEmptyField);
  return undefined;
};

/** `separate`: the open field `top` moves from its instructions to its result. */
const separateField = (fields: readonly OpenField[], top: OpenField): TocMark => {
  // A TOC's cached result is skipped up to its end; the block stands
  // where the field does, unless an enclosing field hides it anyway.
  if (!isTocField(top.instructions)) {
    top.state = "result";
    top.href = fieldLinkTarget(top.instructions);
    return undefined;
  }
  if (hidden(fields.slice(0, -1))) {
    top.state = "result";
    return "toc-hidden";
  }
  top.state = "toc";
  return "toc-block";
};

/** `end`: the innermost open field closes. */
const endField = (fields: OpenField[], onEmptyField: (() => void) | undefined): TocMark => {
  const closed = fields.pop();
  // A field closed with no « separate » has no computed result (a TOC is not one: it stands as its block).
  if (
    closed?.state === "instructions" &&
    !isTocField(closed.instructions) &&
    !COLD_FIELD.test(closed.instructions) &&
    !hidden(fields)
  )
    onEmptyField?.();
  // A TOC never updated has no result at all: still a table of contents.
  if (closed?.state === "instructions" && isTocField(closed.instructions))
    return hidden(fields) ? "toc-hidden" : "toc-block";
  return undefined;
};

/** The part a note lives in, named as its relationship type names it. */
export type NotePart = "footnotes" | "endnotes";

/** What the walk needs besides the element it is on. Grows with each kind of
 *  declaration the reader learns to read. */
export interface ReadContext {
  /** The relationships of the part being walked: a story in footnotes.xml
   *  resolves its r:id through footnotes.xml.rels, not document.xml.rels. */
  readonly rels: ReadonlyMap<string, Relationship>;
  readonly styles: Styles;
  /** Resolves a picture's r:embed in the part being walked, registering
   *  its bytes for the result. */
  readonly image: ImageLookup;
  /** Registers a drawing's own shapes-picture (D2 of
   *  MIKSUDOC « Spécification fonctionnelle » §9.5, `docx-reader/shapes.ts`) — a
   *  synthesized SVG, unlike `image` above (an embedded relationship). */
  readonly drawingImage: DrawingImageRegistrar;
  /** How many of a drawing's declared shapes are not in its picture, called
   *  once per drawing that draws one (D2) — accumulated by
   *  `docx-reader/index.ts#readDocx` into `DocxReadResult#drawingShapesNotDrawn`,
   *  DATA for the dashboard, never text on the page (29/09/2026). */
  readonly reportShapesNotDrawn: (count: number) => void;
  /** Called once per drawing kept out because it is hidden (`wp:docPr hidden`), whatever it holds: counted, never its content
   *  (`hidden-dropped` notice, 08/10/2026). */
  readonly reportHiddenShape: () => void;
  /** The drawings met, and the last paragraph read before each: what Google's
   *  own image of a drawing is matched by (D2 voie A, `docx-reader/google-drawings.ts`). */
  readonly drawings: DrawingLedger;
  /** The charts and SmartArts of the drawings, read ahead of the walk
   *  (`docx-reader/drawing-objects.ts`). */
  readonly objects: DrawingObjects;
  /** Shared by every story: a numbering continues across tables and boxes. */
  readonly numbering: Numbering;
  /** Numbers note calls in the order they are read (w:footnoteReference,
   *  w:endnoteReference: the id names the note in its part, not the number
   *  shown). Footnotes and endnotes share ONE sequence: the page groups all
   *  notes in one list at its end, whose positions are these numbers. */
  readonly noteCall: (part: NotePart, id: string) => number;
  /** The labels this reading writes, the caller's where it gave any (`lib/page-labels.ts#resolveLabels`). REQUIRED since
   *  30/10/2026: `docx-reader/index.ts` resolves them for every reading, so an optional field here only bought a
   *  fallback no reading could reach, and a context built without them would silently write another reader's words. */
  readonly labels: PageLabels;
  /** Complex fields open in the story being walked (w:fldChar), one
   *  entry per nesting level. Mutable: a field spans runs and paragraphs. */
  readonly fields: OpenField[];
  /** Called once per published field that carries no computed result (complex field closed without « separate », or an
   *  empty w:fldSimple). Set for the body story only; hidden runs never call it. */
  readonly reportEmptyField?: (() => void) | undefined;
  /** Bookmarks as Confluence anchors, shared by every story of the document. */
  readonly anchors: AnchorState;
  /** The caps this reading applies (`lib/reader-limits.ts#ReaderLimits`); absent: NONE — `NO_CAP`, nothing withheld
   *  (the app passes `core/document-caps.ts#PRODUCT_READER_LIMITS`; corrected 10/11/2026). */
  readonly limits?: ReaderLimits | undefined;
  /** The document's largest page: a floating drawing wholly outside it is
   *  not displayed, so not published (`objects.ts#isOffPage`). Absent: no
   *  drawing is dropped. */
  readonly page?: PageSize | undefined;
  /** Whether a picture (`r:embed`) of this part is a 1×1 pixel, measured
   *  ahead (`index.ts`): such a Fallback picture is junk, never published. */
  readonly isPixelImage?: ((relId: string) => boolean) | undefined;
  /** Filled with every block a text box gives: the box's blocks come out among the body's, but a layout table is never made of them
   *  (`docx-reader/layout-tables.ts`). Set for the body story only. */
  readonly textBoxBlocks?: Set<IRBlock> | undefined;
}

/**
 * Bookmarks (w:bookmarkStart) that some internal link (w:hyperlink w:anchor)
 * targets become Confluence anchors (24/09/2026); the
 * others (_GoBack, the _Toc of an unread table of contents…) are not written.
 * A bookmark waits in `pending` until the next text block is made, and lands
 * at its start: a bookmark inside a paragraph goes to that paragraph, one
 * between paragraphs (Google's habit) to the next one, one before a table to
 * its first cell with text. `placed` lists the anchors actually written; a
 * link to any other is published as text (`dropDeadAnchorLinks`).
 */
interface AnchorState {
  readonly targeted: ReadonlySet<string>;
  readonly pending: string[];
  readonly placed: Set<string>;
}

/** A new walk context for another story of the same part: its own open
 *  fields, everything else shared. */
export const freshFields = (ctx: ReadContext): ReadContext => ({ ...ctx, fields: [] });

/** sdt: a content control's content (sdtContent); its properties
 *  (sdtPr) say what the control is, never what the page shows. */
const sdtContent = (sdt: XNode): XNode | undefined => findChild(sdt, "w:sdtContent");

/** docPartGallery "Table of Contents" inside sdtPr/docPartObj: the
 *  control IS the document's table of contents. */
const isTableOfContents = (sdt: XNode): boolean => {
  const sdtPr = findChild(sdt, "w:sdtPr");
  const docPartObj = sdtPr ? findChild(sdtPr, "w:docPartObj") : undefined;
  const gallery = docPartObj ? findChild(docPartObj, "w:docPartGallery") : undefined;
  return gallery !== undefined && attributeOf(gallery, "w:val") === "Table of Contents";
};

/** Whether a TOC field (complex, its instruction possibly split over
 *  several w:instrText, or simple) is anywhere inside `node`. */
const containsTocField = (node: XNode): boolean => {
  const fields: OpenField[] = [];
  let found = false;
  const walk = (parent: XNode): void => {
    for (const childNode of childNodesOf(parent)) {
      if (found) return;
      const tag = qualifiedNameOf(childNode);
      if (tag === "w:fldSimple" && isTocField(attributeOf(childNode, "w:instr") ?? "")) found = true;
      else if (tag === "w:fldChar" || tag === "w:instrText") found = trackField(fields, childNode) !== undefined;
      else walk(childNode);
    }
  };
  walk(node);
  return found;
};

/** Where a run sits: what its paragraph declares that its runs inherit. */
interface InlineScope {
  readonly paragraphStyle: string | undefined;
}

/** Elements that only group runs and say nothing themselves: their content is read as if they were not there. */
const TRANSPARENT_INLINE = new Set([
  "w:customXml",
  "w:smartTag",
  "w:dir",
  "w:bdo",
  // Revisions are published in their ACCEPTED state (decided): an insertion
  // (ins) or a move's destination (moveTo) is read, a deletion
  // (del) or a move's origin (moveFrom) is not — they are simply not listed.
  "w:ins",
  "w:moveTo",
]);

/**
 * What a paragraph's content turns into, in order: inline text; a block that
 * stands IN the line and so splits the paragraph (an inline picture); or
 * blocks published AFTER the paragraph (a floating picture, a text box's
 * paragraphs), with the anchor that orders them when there are several.
 */
type Piece =
  | { kind: "inline"; inline: Inline }
  | { kind: "block"; block: IRBlock }
  | { kind: "after"; blocks: IRBlock[]; anchor: AnchorKey | undefined; diagram?: PieceDiagram }
  | { kind: "bookmark"; name: string };

/** What a drawing's connectors know about its text boxes, kept beside the
 *  blocks published after the paragraph: each text box's range in `blocks`
 *  and its box in the drawing's own space, and the lines
 *  (`docx-reader/shapes.ts#readDrawingDiagram`). `orderedAfter` puts the
 *  boxes in the order of their relations. */
interface PieceDiagram {
  units: { from: number; to: number; box: Box; notLabel: boolean }[];
  connectors: DrawingDiagram["connectors"];
  obstacles: Box[];
}

/** What a `w:drawing` gives its paragraph: nothing when it is hidden or wholly off the page, else its blocks, in the
 *  line for an inline drawing, after the paragraph for a floating one and for every text box. */
const drawingPieces = (drawing: XNode, ctx: ReadContext): Piece[] => {
  if (isHiddenDrawing(drawing)) {
    ctx.reportHiddenShape();
    return [];
  }
  if (isOffPage(drawing, ctx.page)) return [];
  const content = readDrawing(drawing, ctx.image);
  if (!content) return [];
  const after: IRBlock[] = [];
  const inLine: IRBlock[] = [];
  // A floating drawing's pictures follow the paragraph; an inline one's stand in the line. Its text boxes always follow.
  const placed = content.floating ? after : inLine;
  placed.push(...shapePictureBlocks(drawing, ctx));
  const diagram = readDrawingDiagram(drawing, ctx.limits);
  const units: PieceDiagram["units"] = [];
  for (const item of content.items) {
    if (item.kind === "textbox") readTextBox(item.content, ctx, diagram, after, units);
    else placed.push(item.block);
  }
  placed.push(...drawingObjectBlocks(drawing, ctx));
  return [
    ...inLine.map((block): Piece => ({ kind: "block", block })),
    ...afterPieces(after, content.anchor, diagram, units),
  ];
};

/** The piece of the blocks a drawing puts after its paragraph, with what its connectors know of its text boxes. */
const afterPieces = (
  after: IRBlock[],
  anchor: AnchorKey | undefined,
  diagram: DrawingDiagram | undefined,
  units: PieceDiagram["units"],
): Piece[] => {
  // A drawing of lines only (a connector, nothing published) still tells
  // where its ends are: its piece goes on with no block.
  const hasLines = diagram !== undefined && diagram.connectors.length > 0;
  if (after.length > 0 || hasLines) {
    return [
      {
        kind: "after",
        blocks: after,
        anchor,
        ...(diagram === undefined || (units.length === 0 && !hasLines)
          ? {}
          : { diagram: { units, connectors: diagram.connectors, obstacles: diagram.obstacles } }),
      },
    ];
  }
  return [];
};

/** The picture D2 draws of a drawing's own shapes, its images standing as pending refs. */
const shapePictureBlocks = (drawing: XNode, ctx: ReadContext): IRBlock[] => {
  // D2's picture goes FIRST — before any of the drawing's own pictures or
  // text boxes below — the image, then the words (D3,
  // MIKSUDOC « Spécification fonctionnelle » §9.5). How many shapes it leaves out is
  // reported as DATA (dashboard), never as a block on the page.
  const shapePicture = drawnShapeBlocks(drawing, ctx.drawingImage, ctx.limits);
  if (shapePicture.shapesNotDrawn > 0) ctx.reportShapesNotDrawn(shapePicture.shapesNotDrawn);
  // Each picture of ours stands as a pending ref until Google's export has
  // been asked (voie A); a text box below is the DRAWING's words, never the
  // paragraph before the next drawing.
  return shapePicture.blocks.map((block): IRBlock =>
    block.kind === "image" && shapePicture.canvas
      ? { ...block, ref: ctx.drawings.place(block.ref, shapePicture.canvas) }
      : block,
  );
};

/** Reads a drawing's text box into `after`, and, when the drawing's connectors know its box, notes its range in `units`. */
const readTextBox = (
  content: XNode,
  ctx: ReadContext,
  diagram: DrawingDiagram | undefined,
  after: IRBlock[],
  units: PieceDiagram["units"],
): void => {
  const before = ctx.drawings.lastText;
  const from = after.length;
  const boxBlocks = readBlocks(content, ctx);
  for (const block of boxBlocks) ctx.textBoxBlocks?.add(block);
  after.push(...boxBlocks);
  ctx.drawings.lastText = before;
  const diagramText = diagram?.texts.get(content);
  if (diagramText !== undefined && after.length > from) units.push({ from, to: after.length, ...diagramText });
};

/** The charts and SmartArts a drawing holds, as their blocks, in file order. */
const drawingObjectBlocks = (drawing: XNode, ctx: ReadContext): IRBlock[] => {
  const blocks: IRBlock[] = [];
  // A native chart stands where its drawing stands, as the chart block the
  // pptx and xlsx readers give; a SmartArt stands there too, as its picture
  // THEN its model's list (`DrawingObjects#smartArt`, 29/10/2026).
  for (const object of drawingObjectsOf(drawing)) {
    if (object.kind === "smartart") {
      blocks.push(...ctx.objects.smartArt(ctx.rels, object.relId, ctx.drawingImage));
      continue;
    }
    const block = ctx.objects.chart(ctx.rels, object.relId);
    if (block) blocks.push(block);
  }
  return blocks;
};

/** The content of one run (`w:r`). */
const runPieces = (run: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const rPr = findChild(run, "w:rPr");
  const marks = ctx.styles.marks(scope.paragraphStyle, rPr);
  // Colour and highlight travel with the run since 10/11/2026 (`styles.ts#colours`): only what the FILE states.
  const colours = ctx.styles.colours(scope.paragraphStyle, rPr);
  const withMarks = (text: string): Piece => ({
    kind: "inline",
    inline: { text, ...(marks.length > 0 ? { marks: [...marks] } : {}), ...colours },
  });
  // Hidden text (w:vanish, 24/09/2026) is not published: nothing
  // of the run is read but its field characters, which keep the open fields
  // in step (a table of contents block they give is kept).
  if (ctx.styles.hidden(scope.paragraphStyle, rPr)) {
    const fieldOnly = childNodesOf(run).filter(
      (childNode) => qualifiedNameOf(childNode) === "w:fldChar" || qualifiedNameOf(childNode) === "w:instrText",
    );
    return runContent(fieldOnly, { ...ctx, reportEmptyField: undefined }, withMarks, scope).filter(
      (piece) => piece.kind === "block",
    );
  }
  return runContent(childNodesOf(run), ctx, withMarks, scope);
};

/** Inside a field's instructions nothing is displayed: only its result is
 *  (w:fldChar; decided — no result, nothing). A field nested in the
 *  result of another shows its own result. */
const hidden = (fields: readonly OpenField[]): boolean => fields.some((field) => field.state !== "result");
const inInstructions = (ctx: ReadContext): boolean => hidden(ctx.fields);

/** mc:AlternateContent read once: the Choice this reader understands, then, only when that read gives NOTHING, its
 *  image-only Fallback (`unreadChoiceFallback`). The three walks (runs, paragraph content, story units) share it. */
const chooseAlternate = <T>(
  alternate: XNode,
  isPixel: ((relId: string) => boolean) | undefined,
  read: (branch: XNode) => T[],
): T[] => {
  const chosen = chosenContent(alternate);
  if (!chosen) return [];
  const first = read(chosen);
  if (first.length > 0) return first;
  const fallback = unreadChoiceFallback(alternate, chosen, isPixel);
  return fallback ? read(fallback) : first;
};

const TOC_BLOCK: Piece = { kind: "block", block: { kind: "toc" } };

// The call of a note: its number in reading order, in superscript,
// without a link (decided); the note itself is published at the end.
// Kept with its brackets (29/09/2026), written through `noteCallLabel` like
// every other page label.
const noteCallPieces = (
  reference: XNode,
  tag: "w:footnoteReference" | "w:endnoteReference",
  ctx: ReadContext,
): Piece[] => {
  const id = attributeOf(reference, "w:id");
  const part: NotePart = tag === "w:footnoteReference" ? "footnotes" : "endnotes";
  return id !== undefined
    ? [{ kind: "inline", inline: { text: ctx.labels.noteCallLabel(ctx.noteCall(part, id)), marks: ["sup"] } }]
    : [];
};

// w:ruby: a phonetic guide. Its base text (w:rubyBase) is the document's own
// words, published like any run; its guide text (w:rt) follows in
// parentheses — also the document's own words, only the parentheses are
// ours. The parenthesised form is searchable and carries no platform risk,
// chosen over a native `<ruby><rt>` that no Confluence check has verified
// (29/09/2026; fixture `fixtures/docx/09-FABRIQUE-Ruby-Mot-Perdu.docx`).
// Both hold runs, like a paragraph, so `paragraphContent` reads each.
const rubyPieces = (ruby: XNode, ctx: ReadContext, scope: InlineScope, withMarks: (text: string) => Piece): Piece[] => {
  const pieces: Piece[] = [];
  const rubyBase = findChild(ruby, "w:rubyBase");
  if (rubyBase) pieces.push(...paragraphContent(rubyBase, ctx, scope));
  const rt = findChild(ruby, "w:rt");
  const guide = rt ? paragraphContent(rt, ctx, scope) : [];
  if (guide.some((piece) => piece.kind === "inline" && piece.inline.text.trim().length > 0)) {
    pieces.push(withMarks(" ("), ...guide, withMarks(")"));
  }
  return pieces;
};

// w:sym: a character given by its code (w:char, hexadecimal) in a
// named font. In the Symbol font the private-use point becomes the
// character it draws (lib/symbol-font.ts, 26/10/2026); in any
// other font the declared code point is published as is — for
// Wingdings it is a private-use point that Confluence does not draw;
// that is visible, never silent.
const symbolPieces = (sym: XNode, withMarks: (text: string) => Piece): Piece[] => {
  const charCode = Number.parseInt(attributeOf(sym, "w:char") ?? "", 16);
  if (!(Number.isFinite(charCode) && charCode > 0 && charCode <= 0x10ffff && (charCode < 0xd800 || charCode > 0xdfff)))
    return [];
  const character = String.fromCodePoint(charCode);
  return [withMarks(isSymbolFont(attributeOf(sym, "w:font")) ? symbolFontText(character) : character)];
};

/** How a run's text becomes inlines: its marks (`withMarks`) and the paragraph it sits in (`scope`). */
interface RunInlines {
  readonly withMarks: (text: string) => Piece;
  readonly scope: InlineScope;
}

/** The pieces a run's children give, the open fields followed: nothing shows inside a field's instructions, and the
 *  words of a HYPERLINK field's result carry its target. */
const runContent = (
  nodes: readonly XNode[],
  ctx: ReadContext,
  withMarks: (text: string) => Piece,
  scope: InlineScope,
): Piece[] => {
  const pieces: Piece[] = [];
  const run: RunInlines = { withMarks, scope };
  for (const childNode of nodes) {
    const tag = qualifiedNameOf(childNode);
    if (tag === "w:fldChar" || tag === "w:instrText") {
      if (trackField(ctx.fields, childNode, ctx.reportEmptyField) === "toc-block") pieces.push(TOC_BLOCK);
      continue;
    }
    if (inInstructions(ctx)) continue;
    const start = pieces.length;
    appendRunChild(pieces, childNode, tag, ctx, run);
    // The words of a HYPERLINK field's result carry its target.
    const href = openFieldHref(ctx);
    if (href !== undefined && pieces.length > start)
      pieces.splice(start, pieces.length - start, ...withHref(pieces.slice(start), href));
  }
  return pieces;
};

/** Appends to `pieces` what one child of a run gives once the open fields let it show: a note call, a drawing, a ruby, a
 *  VML text box, an alternate content's chosen branch, or text (`appendRunText`). */
const appendRunChild = (
  pieces: Piece[],
  childNode: XNode,
  tag: string | undefined,
  ctx: ReadContext,
  run: RunInlines,
): void => {
  const { withMarks, scope } = run;
  switch (tag) {
    case "w:footnoteReference":
    case "w:endnoteReference":
      pieces.push(...noteCallPieces(childNode, tag, ctx));
      break;
    case "w:drawing":
      pieces.push(...drawingPieces(childNode, ctx));
      break;
    case "w:ruby":
      pieces.push(...rubyPieces(childNode, ctx, scope, withMarks));
      break;
    // A VML text box: its paragraphs follow the paragraph, like a
    // DrawingML one. Reached outside mc:AlternateContent, or inside its
    // Fallback when no Choice is one the reader understands. Limit: a VML box is
    // never judged hidden or off the page — it is always published.
    case "w:pict": {
      const blocks = vmlTextBoxes(childNode).flatMap((box) => readBlocks(box, ctx));
      for (const block of blocks) ctx.textBoxBlocks?.add(block);
      if (blocks.length > 0) pieces.push({ kind: "after", blocks, anchor: undefined });
      break;
    }
    case "mc:AlternateContent":
      pieces.push(
        ...chooseAlternate(childNode, ctx.isPixelImage, (branch) =>
          runContent(childNodesOf(branch), ctx, withMarks, scope),
        ),
      );
      break;
    default:
      appendRunText(pieces, childNode, tag, withMarks);
  }
};

/** Appends to `pieces` the text one child of a run gives: its `w:t`, a symbol, a hyphen, a tab, a line break; any other
 *  child gives nothing. */
const appendRunText = (
  pieces: Piece[],
  childNode: XNode,
  tag: string | undefined,
  withMarks: (text: string) => Piece,
): void => {
  switch (tag) {
    case "w:t": {
      const text = textContentOf(childNode);
      if (text.length > 0) pieces.push(withMarks(text));
      break;
    }
    case "w:sym":
      pieces.push(...symbolPieces(childNode, withMarks));
      break;
    // w:noBreakHyphen: a hyphen the line may not break at; the page shows
    // a plain hyphen (decided).
    case "w:noBreakHyphen":
      pieces.push(withMarks("-"));
      break;
    // A tab stop has no width on a page that has no tab stops: one space
    // keeps the words apart (decided).
    case "w:tab":
      pieces.push(withMarks(" "));
      break;
    // w:br: w:type absent or textWrapping is a line break; page and
    // column breaks are layout, ignored (decided — the file's order is the
    // reading order). w:cr is the same line break as textWrapping.
    case "w:br": {
      const breakType = attributeOf(childNode, "w:type");
      if (breakType === undefined || breakType === "textWrapping") pieces.push(withMarks("\n"));
      break;
    }
    case "w:cr":
      pieces.push(withMarks("\n"));
      break;
    // A child with no qualified name gives nothing, like any other child not listed here.
    case undefined:
      break;
  }
};

/** The content of a paragraph or of a run container inside it. */
const paragraphContent = (container: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const siblings = childNodesOf(container);
  return siblings.flatMap((childNode, index): Piece[] => {
    const tag = qualifiedNameOf(childNode);
    if (tag === "w:r") return runPieces(childNode, ctx, scope);
    if (tag === "w:hyperlink") return hyperlinkPieces(childNode, ctx, scope);
    if (tag === "w:bookmarkStart") return bookmarkPieces(childNode, ctx);
    // An equation is a sibling of the runs, where it stands in the sentence. Its line in the ONE table of what we knowingly
    // do not render says it keeps a word boundary (`../skipped-elements.ts`): without it « vecteurs » + « u » came out
    // « vecteursu », a word no search can find.
    if (tag === "m:oMath" || tag === "m:oMathPara") return equationPieces(childNode, siblings, index, ctx);
    if (tag === "mc:AlternateContent") {
      return chooseAlternate(childNode, ctx.isPixelImage, (branch) => paragraphContent(branch, ctx, scope));
    }
    if (tag === "w:sdt") {
      const content = sdtContent(childNode);
      return content ? paragraphContent(content, ctx, scope) : [];
    }
    if (tag === "w:fldSimple") return fldSimplePieces(childNode, ctx, scope);
    if (tag !== undefined && TRANSPARENT_INLINE.has(tag)) return paragraphContent(childNode, ctx, scope);
    return [];
  });
};

/** A `w:bookmarkStart` some internal link targets, as the piece that places its anchor; any other gives nothing. */
const bookmarkPieces = (bookmarkStart: XNode, ctx: ReadContext): Piece[] => {
  const name = attributeOf(bookmarkStart, "w:name");
  return name !== undefined && ctx.anchors.targeted.has(name) ? [{ kind: "bookmark", name }] : [];
};

/** An equation (`m:oMath`, `m:oMathPara`) at `index` among `siblings`, as its framed text; nothing inside a field's instructions. */
const equationPieces = (equation: XNode, siblings: readonly XNode[], index: number, ctx: ReadContext): Piece[] => {
  if (inInstructions(ctx)) return [];
  const text = equationText(equation);
  // A boundary separates the equation from the TEXT around it, so the neighbour's own blank counts: « ainsi » + a space
  // already in the file must not become two. A sibling we cannot read the text of (a bookmark, an anchor) counts as no
  // neighbour, and the behaviour there is the one of before.
  const sideText = (siblingIndex: number): string => {
    const sibling = siblings[siblingIndex];
    return sibling === undefined ? "" : childNodesOf(sibling).map(textContentOf).join("");
  };
  const before = sideText(index - 1);
  const after = sideText(index + 1);
  const sides = { left: before !== "" && !/\s$/.test(before), right: after !== "" && !/^\s/.test(after) };
  const framed = framedSkippedText("equation", text, sides);
  return framed.length > 0 ? [{ kind: "inline", inline: { text: framed } }] : [];
};

// fldSimple: its content IS the field's displayed result — except for a
// table of contents, which is the toc block and nothing of its result.
const fldSimplePieces = (fldSimple: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const instruction = attributeOf(fldSimple, "w:instr") ?? "";
  if (isTocField(instruction)) return inInstructions(ctx) ? [] : [TOC_BLOCK];
  const result = paragraphContent(fldSimple, ctx, scope);
  if (result.length === 0 && !inInstructions(ctx) && !COLD_FIELD.test(instruction)) ctx.reportEmptyField?.();
  return withHref(result, fieldLinkTarget(instruction));
};

/** w:hyperlink: r:id names an external relationship whose target is
 *  the link. A w:anchor alone points at a bookmark of this document: the
 *  link goes to that bookmark's Confluence anchor (`#name`, see
 *  AnchorState); without one it stays text, never a dead link. `tooltip`,
 *  `history` and `tgtFrame` describe the link's behaviour, not its target. */
const hyperlinkPieces = (link: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const innerPieces = paragraphContent(link, ctx, scope);
  const relId = attributeOf(link, "r:id");
  const relationship = relId === undefined ? undefined : ctx.rels.get(relId);
  // w:anchor alone: a bookmark of this document → a link to its anchor
  // (`#name`), kept only if that anchor gets written (dropDeadAnchorLinks).
  // An external target travels RAW since the arbitrage of 28/09/2026 — the
  // scheme guard is the renderer's (`lib/link-schemes.ts#PUBLISHED_SCHEME`), so a
  // hostile target now dies at the door instead of falling back to the
  // bookmark (edge change, chosen). Only OUR internal forms are refused
  // here: that is provenance, which the door cannot know.
  const bookmark = attributeOf(link, "w:anchor");
  const external = externalLinkTarget(relationship);
  const href = external ?? (bookmark !== undefined && ctx.anchors.targeted.has(bookmark) ? `#${bookmark}` : undefined);
  if (href === undefined) return innerPieces;
  return innerPieces.map((piece) =>
    piece.kind === "inline" ? { kind: "inline", inline: { ...piece.inline, href } } : piece,
  );
};

/**
 * The blocks published after a paragraph, in reading order. Several floating
 * drawings are ordered top to bottom, then left to right, by their anchors —
 * only when every one is anchored by an offset from the same frames; any
 * other case keeps the file order (no order is invented).
 */
const orderedAfter = (
  after: readonly Extract<Piece, { kind: "after" }>[],
  limits: ReaderLimits | undefined,
): IRBlock[] => {
  const keys = after.map((piece) => piece.anchor);
  const first = keys[0];
  const comparable =
    after.length > 1 &&
    first !== undefined &&
    keys.every((key) => key !== undefined && key.vFrom === first.vFrom && key.hFrom === first.hFrom);
  const order = after.map((_, pieceIndex) => pieceIndex);
  if (comparable) {
    order.sort((firstIndex, secondIndex) => {
      const firstKey = keys[firstIndex]!;
      const secondKey = keys[secondIndex]!;
      return firstKey.v - secondKey.v || firstKey.h - secondKey.h || firstIndex - secondIndex;
    });
  }
  return inRelationOrder(
    order.map((pieceIndex) => after[pieceIndex]!),
    limits,
  );
};

/** The blocks of the pieces, in the order given, with the text boxes of each
 *  drawing cluster put in the order of their connectors
 *  (`layout/diagram-graph.ts`, milestone 1 of the diagram text). A cluster is the drawings that
 *  share their anchor frames (`relativeFrom` on both axes): their offsets
 *  then say where each stands against the others, and a connector may join
 *  two text boxes of two drawings (Word anchors every shape on its own).
 *  A drawing without an offset anchor is a cluster of its own. The boxes keep
 *  the places they had among the other blocks (the pictures stay put): only
 *  which box goes in which place changes, so nothing is lost or repeated. */
const inRelationOrder = (
  pieces: readonly Extract<Piece, { kind: "after" }>[],
  limits: ReaderLimits | undefined,
): IRBlock[] => {
  interface Cell {
    blocks: IRBlock[];
    unit?: { cluster: string; box: Box; notLabel: boolean };
  }
  const cells: Cell[] = [];
  const clusters = new Map<
    string,
    { offsetOf: (box: Box) => Box; connectors: DiagramConnector[]; obstacles: Box[]; slots: number[] }
  >();
  pieces.forEach((piece, index) => {
    const anchor = piece.anchor;
    const key = anchor === undefined ? `alone:${index}` : `${anchor.vFrom}|${anchor.hFrom}`;
    const dx = anchor?.h ?? 0;
    const dy = anchor?.v ?? 0;
    const place = (box: Box): Box => ({ x: box.x + dx, y: box.y + dy, cx: box.cx, cy: box.cy });
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = { offsetOf: place, connectors: [], obstacles: [], slots: [] };
      clusters.set(key, cluster);
    }
    const diagram = piece.diagram;
    if (diagram !== undefined) {
      for (const connector of diagram.connectors) {
        cluster.connectors.push({
          ends: {
            x1: connector.ends.x1 + dx,
            y1: connector.ends.y1 + dy,
            x2: connector.ends.x2 + dx,
            y2: connector.ends.y2 + dy,
          },
          startArrow: connector.startArrow,
          endArrow: connector.endArrow,
          visible: connector.visible,
        });
      }
      for (const obstacle of diagram.obstacles) cluster.obstacles.push(place(obstacle));
    }
    let blockIndex = 0;
    for (const unit of diagram?.units ?? []) {
      for (; blockIndex < unit.from; blockIndex++) cells.push({ blocks: [piece.blocks[blockIndex]!] });
      cluster.slots.push(cells.length);
      cells.push({
        blocks: piece.blocks.slice(unit.from, unit.to),
        unit: { cluster: key, box: place(unit.box), notLabel: unit.notLabel },
      });
      blockIndex = unit.to;
    }
    for (; blockIndex < piece.blocks.length; blockIndex++) cells.push({ blocks: [piece.blocks[blockIndex]!] });
  });
  for (const cluster of clusters.values()) {
    if (cluster.connectors.length === 0 || cluster.slots.length < 2) continue;
    // The pptx element cap, per CLUSTER (separate drawings of one cluster
    // bypass the per-drawing bound): past it today's order stands, nothing
    // is lost — the graph walk is never fed an unbounded diagram.
    if (cluster.slots.length + cluster.connectors.length + cluster.obstacles.length > (limits?.slideElements ?? NO_CAP))
      continue;
    const units = cluster.slots.map((slot) => cells[slot]!);
    const elements: DiagramElement[] = units.map((cell) => ({
      box: cell.unit!.box,
      node: true,
      notLabel: cell.unit!.notLabel,
    }));
    const order = orderDiagram({
      elements,
      obstacles: cluster.obstacles.map((box) => ({ box })),
      connectors: cluster.connectors,
      tolerances: OOXML_DIAGRAM_TOLERANCES,
    });
    if (order.paragraphs.length === 0) continue;
    const orderedUnits = [...order.paragraphs.flat(), ...order.rest];
    cluster.slots.forEach((slot, slotIndex) => {
      cells[slot] = units[orderedUnits[slotIndex]!]!;
    });
  }
  return cells.flatMap((cell) => cell.blocks);
};

/** A block made only of blanks says nothing and is not published. */
const hasVisibleText = (inlines: readonly Inline[]): boolean => inlines.some((inline) => inline.text.trim().length > 0);

/** Adjacent inlines that carry the same marks and link read as one: a
 *  producer splits runs for reasons (revision ids, spell-check state) that
 *  mean nothing on the page. */
const merged = (inlines: readonly Inline[]): Inline[] => {
  const mergedInlines: Inline[] = [];
  const same = (previous: Inline, next: Inline): boolean =>
    previous.image === undefined &&
    previous.anchor === undefined &&
    next.anchor === undefined &&
    next.image === undefined &&
    previous.href === next.href &&
    (previous.marks ?? []).join() === (next.marks ?? []).join();
  for (const inline of inlines) {
    const last = mergedInlines[mergedInlines.length - 1];
    if (last && same(last, inline))
      mergedInlines[mergedInlines.length - 1] = { ...last, text: last.text + inline.text };
    else mergedInlines.push(inline);
  }
  return mergedInlines;
};

/** A list paragraph's place in its list. */
interface ListPlace {
  readonly numId: string;
  readonly ilvl: number;
  readonly ordered: boolean;
  readonly value: number;
}

/** One piece of a story before its list paragraphs are gathered into lists. */
interface Unit {
  readonly blocks: IRBlock[];
  readonly list?: ListPlace;
  /** A hidden paragraph: absent from the page, it neither ends nor joins a list. */
  readonly invisible?: true;
}

/** w:numPr, on the paragraph or inherited from its style (the
 *  style hierarchy); each of numId and ilvl is taken where it is nearest.
 *  numId 0 REMOVES the numbering a style would give (w:numId). */
const numberingOf = (
  pPr: XNode | undefined,
  paragraphStyle: string | undefined,
  ctx: ReadContext,
): { numId: string; ilvl: number } | undefined => {
  const direct = pPr ? findChild(pPr, "w:numPr") : undefined;
  const fromStyle = ctx.styles.paragraphProperty(paragraphStyle, "w:numPr");
  const numId = valOfChild(direct, "w:numId") ?? valOfChild(fromStyle, "w:numId");
  if (numId === undefined || numId === "0") return undefined;
  const ilvl = Number.parseInt(valOfChild(direct, "w:ilvl") ?? valOfChild(fromStyle, "w:ilvl") ?? "0", 10);
  // A declared level deeper than `MAX_ILVL` is read as the deepest one, never
  // used as an index (27/09/2026).
  return { numId, ilvl: Number.isFinite(ilvl) && ilvl >= 0 ? Math.min(ilvl, MAX_ILVL) : 0 };
};

/**
 * w:jc, on the paragraph or else from its style chain: the alignment the page
 * keeps (24/09/2026). right and end → right, center → center; left, start,
 * both, distribute and the rest → nothing (left is the page's default;
 * justify is not kept by Confluence, docs/PLATFORM-STATUS.md §43).
 * Limit: `end` is read as right, so a right-to-left paragraph (w:bidi), where
 * it would flip, comes out on the wrong side.
 */
const alignmentOf = (
  pPr: XNode | undefined,
  paragraphStyle: string | undefined,
  ctx: ReadContext,
): BlockAlign | undefined => {
  const fromStyle = ctx.styles.paragraphProperty(paragraphStyle, "w:jc");
  const jc = valOfChild(pPr, "w:jc") ?? (fromStyle ? attributeOf(fromStyle, "w:val") : undefined);
  if (jc === "right" || jc === "end") return "right";
  if (jc === "center") return "center";
  return undefined;
};

/** Whether a piece shows something on the page: a block, blocks after the paragraph, or a non-blank inline. */
const showsSomething = (piece: Piece): boolean =>
  piece.kind === "block" ||
  (piece.kind === "after" && piece.blocks.length > 0) ||
  (piece.kind === "inline" && piece.inline.text.trim().length > 0);

/** The words of the paragraph and heading blocks, blanks collapsed. */
const ownTextOf = (blocks: readonly IRBlock[]): string =>
  collapseBlanks(
    blocks
      .flatMap((block) =>
        block.kind === "paragraph" || block.kind === "heading" ? block.inlines.map((inline) => inline.text) : [],
      )
      .join(""),
  );

/** One `w:p`: its text blocks (a heading or a paragraph, split by in-line pictures), then the blocks it puts after
 *  itself, and its place in a list. */
const paragraphUnit = (paragraph: XNode, ctx: ReadContext): Unit => {
  const pPr = findChild(paragraph, "w:pPr");
  const paragraphStyle = valOfChild(pPr, "w:pStyle");
  // The anchors waiting before this paragraph are this paragraph's — taken
  // now, before a text box read inside it could make a block of its own.
  const anchors = ctx.anchors.pending.splice(0);
  const pieces = paragraphContent(paragraph, ctx, { paragraphStyle });
  // A paragraph whose mark is hidden and that shows nothing does not exist on
  // the page: no block, and its numbering does not advance (Word shows no
  // number for it either). Its anchors wait for the next block.
  const markHidden = ctx.styles.hidden(paragraphStyle, pPr ? findChild(pPr, "w:rPr") : undefined);
  if (markHidden && !pieces.some(showsSomething)) {
    ctx.anchors.pending.push(...anchors, ...pieces.flatMap((piece) => (piece.kind === "bookmark" ? [piece.name] : [])));
    return { blocks: [], invisible: true };
  }
  const role = ctx.styles.role(paragraphStyle);
  const numbered = numberingOf(pPr, paragraphStyle, ctx);
  // The counter advances even for an empty paragraph: Word numbers it too.
  const item = numbered ? ctx.numbering.next(numbered.numId, numbered.ilvl) : undefined;

  // A numbered heading is a heading, preceded by the number it displays
  // (decided): never a list item. The number goes before its first words.
  const prefix: Inline | undefined =
    role.kind === "heading" && item?.label !== undefined ? { text: item.label + item.separator } : undefined;
  const wrap = textBlockWrapper(role, prefix, alignmentOf(pPr, paragraphStyle, ctx), anchors, ctx);
  const { blocks, after } = splitPieces(pieces, wrap, anchors);
  // The paragraph's OWN words (its text boxes come after, below): the one a
  // drawing after it is placed against (`docx-reader/google-drawings.ts`).
  const ownText = ownTextOf(blocks);
  if (ownText !== "") ctx.drawings.lastText = ownText;
  // No text block here: the anchors wait for the next one.
  ctx.anchors.pending.push(...anchors.splice(0));
  blocks.push(...orderedAfter(after, ctx.limits));

  if (role.kind !== "heading" && numbered && item) {
    return { blocks, list: { numId: numbered.numId, ilvl: numbered.ilvl, ordered: item.ordered, value: item.value } };
  }
  return { blocks };
};

/** Makes the text blocks of one paragraph: each opens with the anchors waiting in `anchors` (now placed), the first also
 *  with the heading's number `prefix`. */
const textBlockWrapper = (
  role: ReturnType<Styles["role"]>,
  prefix: Inline | undefined,
  align: BlockAlign | undefined,
  anchors: string[],
  ctx: ReadContext,
): ((inlines: Inline[]) => IRBlock) => {
  let pendingPrefix = prefix;
  return (inlines: Inline[]): IRBlock => {
    const anchorInlines = anchors.splice(0).map((name): Inline => {
      ctx.anchors.placed.add(name);
      return { text: "", anchor: name };
    });
    const withPrefix = [...anchorInlines, ...(pendingPrefix ? [pendingPrefix] : []), ...inlines];
    pendingPrefix = undefined;
    const aligned = align !== undefined ? { align } : {};
    return role.kind === "heading"
      ? { kind: "heading", level: role.level, inlines: withPrefix, ...aligned }
      : { kind: "paragraph", inlines: withPrefix, ...aligned };
  };
};

/** A paragraph's pieces split, in order, into its blocks (the inlines between two in-line blocks make one, through
 *  `wrap`) and the pieces published after it; a bookmark joins `anchors`, for the next text block. */
const splitPieces = (
  pieces: readonly Piece[],
  wrap: (inlines: Inline[]) => IRBlock,
  anchors: string[],
): { blocks: IRBlock[]; after: Extract<Piece, { kind: "after" }>[] } => {
  const blocks: IRBlock[] = [];
  const after: Extract<Piece, { kind: "after" }>[] = [];
  let current: Inline[] = [];
  const flush = (): void => {
    const inlines = merged(current);
    if (hasVisibleText(inlines)) blocks.push(wrap(inlines));
    current = [];
  };
  for (const piece of pieces) {
    if (piece.kind === "inline") current.push(piece.inline);
    else if (piece.kind === "block") {
      // A picture in the line splits the paragraph: the IR has no inline
      // picture for a document's own images.
      flush();
      blocks.push(piece.block);
    } else if (piece.kind === "bookmark") anchors.push(piece.name);
    else after.push(piece);
  }
  flush();
  return { blocks, after };
};

/**
 * Consecutive list paragraphs become nested lists: a deeper w:ilvl opens a
 * list inside the previous item, a shallower one returns to its level, and a
 * different numId (or a switch between ordered and unordered) at the same
 * level starts a new list. Anything that is not a list paragraph ends them.
 * `start` is the counter's value at the list's first item, omitted when 1.
 */
const assembleLists = (units: readonly Unit[]): IRBlock[] =>
  nestLists(
    units
      .filter((unit) => !unit.invisible)
      .map((unit) => ({
        blocks: unit.blocks,
        ...(unit.list
          ? {
              list: {
                level: unit.list.ilvl,
                ordered: unit.list.ordered,
                key: unit.list.numId,
                ...(unit.list.value !== 1 ? { start: unit.list.value } : {}),
              },
            }
          : {}),
      })),
    // An empty item is not published; the lists at its level close so the next item reopens with its true number as `start`.
    { emptyItem: "restart" },
  );

type TableCell = Extract<IRBlock, { kind: "table" }>["rows"][number]["cells"][number];

/** Row- and cell-level containers that only group rows or cells. */
const wrapped = (wrapper: XNode, childrenOf: (node: XNode) => XNode[]): XNode[] => {
  if (qualifiedNameOf(wrapper) === "w:customXml") return childrenOf(wrapper);
  const content = qualifiedNameOf(wrapper) === "w:sdt" ? sdtContent(wrapper) : undefined;
  return content ? childrenOf(content) : [];
};
const rowsOf = (tbl: XNode): XNode[] =>
  childNodesOf(tbl).flatMap((childNode) =>
    qualifiedNameOf(childNode) === "w:tr" ? [childNode] : wrapped(childNode, rowsOf),
  );
const cellsOf = (tr: XNode): XNode[] =>
  childNodesOf(tr).flatMap((childNode) =>
    qualifiedNameOf(childNode) === "w:tc" ? [childNode] : wrapped(childNode, cellsOf),
  );

const intValOfChild = (parent: XNode | undefined, tag: string): number | undefined => {
  return intAttr(valOfChild(parent, tag));
};

/** The widest span we write, taken as Word's own ceiling on a table's columns (27/09/2026). A declared gridSpan is
 *  written into the page as colspan: 1 000 000 used to go there as is (held by `docx-reader.test.ts`, « clamped to
 *  Word's 63 columns »). A rowspan needs no clamp: it grows by one per row actually read. */
const MAX_GRID_COLUMNS = 63;

/** The columns a cell spans: its `w:gridSpan`, bounded by the room left in the declared grid and by Word's ceiling. */
const cellSpan = (tcPr: XNode | undefined, column: number, gridColumns: number): number => {
  const room = gridColumns === 0 ? MAX_GRID_COLUMNS : Math.max(1, gridColumns - column);
  return Math.min(MAX_GRID_COLUMNS, room, Math.max(1, intValOfChild(tcPr, "w:gridSpan") ?? 1));
};

/** A cell's `w:vMerge`: `restart`, `continue` (also when the value is absent), or undefined without one. */
const vMergeOf = (tcPr: XNode | undefined): string | undefined => {
  const vMergeElement = tcPr ? findChild(tcPr, "w:vMerge") : undefined;
  return vMergeElement ? (attributeOf(vMergeElement, "w:val") ?? "continue") : undefined;
};

/** Whether a row's `w:trPr` marks it a header row: `w:tblHeader`, read by its value. */
const isHeaderRow = (trPr: XNode | undefined): boolean => {
  const tblHeader = trPr ? findChild(trPr, "w:tblHeader") : undefined;
  return tblHeader !== undefined && onOff(tblHeader);
};

/** The cells of one row. `merging` holds, by grid column, the cell a vertical merge started above: a continuation grows
 *  its rowspan instead of giving a cell. */
const tableRowCells = (
  tr: XNode,
  ctx: ReadContext,
  merging: Map<number, TableCell>,
  gridColumns: number,
): TableCell[] => {
  const trPr = findChild(tr, "w:trPr");
  const header = isHeaderRow(trPr);
  const cells: TableCell[] = [];
  const seenColumns = new Set<number>();
  let column = intValOfChild(trPr, "w:gridBefore") ?? 0;
  for (const tc of cellsOf(tr)) {
    const tcPr = findChild(tc, "w:tcPr");
    const span = cellSpan(tcPr, column, gridColumns);
    const vMerge = vMergeOf(tcPr);
    const above = merging.get(column);
    seenColumns.add(column);
    if (vMerge === "continue" && above && (above.colspan ?? 1) === span) {
      above.rowspan = (above.rowspan ?? 1) + 1;
      // The continuation's content is dropped: Word does not show it (rule « nothing invisible »,
      // docs/PLATFORM-STATUS.md §67, observed by 09/10/2026), so it is not published either. It is not even read:
      // a note call or a bookmark in it must leave no footnote and no link target behind (nor advance list numbering).
    } else {
      const cell: TableCell = {
        blocks: readBlocks(tc, ctx),
        ...(span > 1 ? { colspan: span } : {}),
        ...(header ? { header: true } : {}),
      };
      cells.push(cell);
      if (vMerge === "restart") merging.set(column, cell);
      else merging.delete(column);
    }
    column += span;
  }
  forgetUnseenMerges(merging, seenColumns);
  return cells;
};

/** Ends the vertical merges whose grid column the row just read did not reach. */
const forgetUnseenMerges = (merging: Map<number, TableCell>, seenColumns: ReadonlySet<number>): void => {
  for (const mergingColumn of [...merging.keys()]) if (!seenColumns.has(mergingColumn)) merging.delete(mergingColumn);
};

/**
 * w:tbl. A cell spans `w:gridSpan` grid columns (→ colspan). A vertical merge (w:vMerge) starts at `restart` and goes
 * on while the cell at the SAME grid column of the next rows says `continue` (the value absent means continue): those
 * cells fold into the first one (→ rowspan). Grid columns count `w:gridBefore`, the columns a row leaves empty first.
 * tblHeader marks a header row — by its VALUE: `<w:tblHeader w:val="0"/>` is "not a header row" (decided). Widths
 * and borders are not read.
 */
const tableBlock = (tbl: XNode, outerContext: ReadContext): IRBlock[] => {
  // The empty fields met inside the table are held back: a table the page does not publish (`tableExceedsCaps`, the decision
  // `withholdOversizedTables` takes later on the same block) shows none of them, so they are reported only when it stands.
  let heldEmptyFields = 0;
  const ctx: ReadContext = outerContext.reportEmptyField
    ? {
        ...outerContext,
        reportEmptyField: () => {
          heldEmptyFields++;
        },
      }
    : outerContext;
  const rows: { cells: TableCell[] }[] = [];
  const merging = new Map<number, TableCell>();
  // The declared grid (w:tblGrid/w:gridCol) bounds a cell's span, as a:gridSpan is bounded; no grid: only Word's ceiling.
  const gridColumns = findChildren(findChild(tbl, "w:tblGrid") ?? {}, "w:gridCol").length;
  for (const tr of rowsOf(tbl)) rows.push({ cells: tableRowCells(tr, ctx, merging, gridColumns) });
  if (rows.length === 0) return [];
  const table: Extract<IRBlock, { kind: "table" }> = { kind: "table", rows };
  const useful = withoutEmptyTableParts(table);
  const withheld = useful !== null && tableExceedsCaps(tableGridWidth(useful), useful.rows.length, outerContext.limits);
  if (!withheld) for (let heldIndex = 0; heldIndex < heldEmptyFields; heldIndex++) outerContext.reportEmptyField?.();
  // WRITTEN BIAS: unlike Excel, Word does NOT visually overflow a row whose only text is in its first cell; the full-width cell is a chosen
  // embellishment, not a fidelity (27/10/2026: the same for tables in Word, Google Docs and PowerPoint). Header cells are marked above.
  return [spanSingleFirstRows(table)];
};

/** Block-level containers that only group paragraphs (customXml). */
const TRANSPARENT_BLOCK = new Set(["w:customXml"]);

/** The units of a story's children: paragraphs, tables, and what wraps them. */
const storyUnits = (story: XNode, ctx: ReadContext): Unit[] =>
  childNodesOf(story).flatMap((childNode): Unit[] => {
    const tag = qualifiedNameOf(childNode);
    if (tag === "w:p") return [paragraphUnit(childNode, ctx)];
    if (tag === "w:tbl") return [{ blocks: tableBlock(childNode, ctx) }];
    // A bookmark between blocks (Google's habit): its anchor waits for the
    // next text block.
    if (tag === "w:bookmarkStart") {
      const name = attributeOf(childNode, "w:name");
      if (name !== undefined && ctx.anchors.targeted.has(name)) ctx.anchors.pending.push(name);
      return [];
    }
    if (tag === "mc:AlternateContent") {
      return chooseAlternate(childNode, ctx.isPixelImage, (branch) => storyUnits(branch, ctx));
    }
    if (tag === "w:sdt") return sdtUnits(childNode, ctx);
    if (tag !== undefined && TRANSPARENT_BLOCK.has(tag)) return storyUnits(childNode, ctx);
    return [];
  });

/** Whether a content control is a table of contents with no TOC field inside: then ONE toc block, its content unread. */
const isTocControlWithoutField = (sdt: XNode): boolean => {
  if (!isTableOfContents(sdt)) return false;
  const content = sdtContent(sdt);
  return !(content && containsTocField(content));
};

const sdtUnits = (sdt: XNode, ctx: ReadContext): Unit[] => {
  const content = sdtContent(sdt);
  // A table of contents control is an editing convenience; the table of
  // contents is the TOC FIELD inside it, which gives the toc block, so a
  // title typed in the control is read like any other text (24/09/2026).
  // A control with no TOC field at all (some producers)
  // stays ONE toc block, its content unread, as before.
  if (isTocControlWithoutField(sdt)) return [{ blocks: [{ kind: "toc" }] }];
  return content ? storyUnits(content, ctx) : [];
};

/** Every block of a story, in document order. */
export const readBlocks = (story: XNode, ctx: ReadContext): IRBlock[] => assembleLists(storyUnits(story, ctx));

/** The bookmark a `w:hyperlink` targets when it has no external target, else undefined. */
const internalLinkAnchor = (hyperlink: XNode, relationships: ReadonlyMap<string, Relationship>): string | undefined => {
  const relId = attributeOf(hyperlink, "r:id");
  // "External" is judged as the real walk judges it (`hyperlinkPieces`).
  const external = externalLinkTarget(relId === undefined ? undefined : relationships.get(relId)) !== undefined;
  const name = attributeOf(hyperlink, "w:anchor");
  return !external && name !== undefined ? name : undefined;
};

/** Adds to `found` the bookmark a `w:hyperlink` targets, when it is an internal link. */
const addInternalLinkAnchor = (
  found: Set<string>,
  hyperlink: XNode,
  relationships: ReadonlyMap<string, Relationship>,
): void => {
  const name = internalLinkAnchor(hyperlink, relationships);
  if (name !== undefined) found.add(name);
};

/** Whether an element and all it holds stay off the page, so no link in it counts: a deletion, a move's origin, a table
 *  of contents read as one toc block. Pure: it depends on the element alone. */
const isUnpublishedWhole = (node: XNode, tag: string | undefined): boolean => {
  if (tag === "w:del" || tag === "w:moveFrom") return true;
  // A TOC control is skipped whole only when it has no TOC field (it is
  // then one toc block); otherwise the field logic of `targetedBookmarks` hides its entries.
  if (tag === "w:sdt" && isTocControlWithoutField(node)) return true;
  return tag === "w:fldSimple" && isTocField(attributeOf(node, "w:instr") ?? "");
};

/** The names of the bookmarks internal links target (w:hyperlink w:anchor
 *  without an external relationship), in the parts of a story that are
 *  PUBLISHED: not inside a table of contents (a w:sdt control or a TOC field,
 *  both read as one toc block), nor anything else a field hides (its
 *  instructions), a deletion, a move's origin, or the alternative of an
 *  mc:AlternateContent the walk does not choose. Fields span
 *  runs and paragraphs, so they are followed in document order, as the
 *  walk itself follows them. */
export const targetedBookmarks = (story: XNode, relationships: ReadonlyMap<string, Relationship>): Set<string> => {
  const found = new Set<string>();
  const fields: OpenField[] = [];
  const walk = (node: XNode): void => {
    for (const childNode of childNodesOf(node)) {
      const tag = qualifiedNameOf(childNode);
      if (isUnpublishedWhole(childNode, tag)) continue;
      // Only the content the walk reads: the chosen Choice, or the Fallback.
      if (tag === "mc:AlternateContent") {
        const chosen = chosenContent(childNode);
        if (chosen) walk(chosen);
        continue;
      }
      if (tag === "w:fldChar" || tag === "w:instrText") {
        trackField(fields, childNode);
        continue;
      }
      if (tag === "w:hyperlink" && !hidden(fields)) addInternalLinkAnchor(found, childNode, relationships);
      walk(childNode);
    }
  };
  walk(story);
  return found;
};

/** Once every story is read: a link to an anchor that was never written (its
 *  bookmark missing, or in no text block) is published as text — never a
 *  dead link (decided) — and the text merges back with its neighbours. */
export const dropDeadAnchorLinks = (blocks: IRBlock[], placed: ReadonlySet<string>): IRBlock[] => {
  const isDead = (inline: Inline): boolean =>
    inline.href !== undefined && inline.href.startsWith("#") && !placed.has(inline.href.slice(1));
  // Only a block that loses a link is touched (and merged again).
  const fixInlines = (inlines: Inline[]): Inline[] =>
    inlines.some(isDead)
      ? merged(
          inlines.map((inline) => {
            if (!isDead(inline)) return inline;
            const rest: Inline = { ...inline };
            delete rest.href;
            return rest;
          }),
        )
      : inlines;
  return mapInlines(blocks, fixInlines);
};
