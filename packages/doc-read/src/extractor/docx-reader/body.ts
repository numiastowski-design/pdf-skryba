/** A WordprocessingML story (the document body, a table cell, a text box, a
 *  note) turned into IR blocks: which elements are read, which are walked
 *  through as plain containers, and which are skipped. Also parses HYPERLINK fields, orders blocks by their
 *  connectors, pre-scans bookmarks and drops dead internal links.
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
import { type AnchorKey, chosenContent, equationText, type ImageLookup, isHiddenDrawing, isOffPage, type PageSize, readDrawing, unreadChoiceFallback, vmlTextBoxes } from "./objects";
import { framedSkippedText } from "../skipped-elements";
import { type DrawingObjects, drawingObjectsOf } from "./drawing-objects";
import { collapseBlanks } from "doc-ir/lib/blanks";
import { isSymbolFont, symbolFontText } from "doc-ir/lib/symbol-font";
import { type DrawingLedger } from "./google-drawings";
import type { Relationship } from "../ooxml/package";
import { type DrawingDiagram, type DrawingImageRegistrar, drawnShapeBlocks, readDrawingDiagram } from "./shapes";
import { type DiagramConnector, type DiagramElement, OOXML_DIAGRAM_TOLERANCES, orderDiagram } from "doc-ir/layout/diagram-graph";
import type { Box } from "doc-ir/layout/slide-elements";
import { onOff, type Styles } from "./styles";
import { intAttr } from "../../lib/ooxml-num";
import { attr, child, children, kids, tagOf, textOf, valOf, type XNode } from "../ooxml/xml";
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
  const head = /^\s*HYPERLINK\b/i.exec(instructions);
  if (!head) return undefined;
  const tokens = [...instructions.slice(head[0].length).matchAll(/"((?:[^"\\]|\\.)*)"|(\\[a-z])|(\S+)/gi)];
  const valueOf = (t: RegExpMatchArray | undefined): string | undefined => (t?.[1] ?? t?.[3])?.replace(/\\(.)/g, "$1");
  let url: string | undefined;
  let fragment: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t[2] !== undefined) {
      // \l, \o and \t take the next token as their argument; \m and \n take none.
      const sw = t[2].toLowerCase();
      if (sw === "\\l" || sw === "\\o" || sw === "\\t") {
        if (sw === "\\l") fragment = valueOf(tokens[i + 1]);
        i++;
      }
    } else if (url === undefined) url = valueOf(t);
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
    : pieces.map((p) => (p.kind === "inline" && p.inline.href === undefined ? { kind: "inline", inline: { ...p.inline, href } } : p));

/** The TOC field (its instruction's first word is TOC): the document's table
 *  of contents, published as ONE `toc` block like the w:sdt that usually
 *  wraps it; its cached entries and page numbers are not read (checkpoint A,
 *  Mikolaj 24/09/2026). */
const isTocField = (instructions: string): boolean => /^\s*TOC\b/i.test(instructions);

/** Word's « cold » fields never have a result by nature: Microsoft, WdFieldKind.wdFieldKindCold, « a field that doesn't have a
 *  result, for example, an Index Entry (XE), Table of Contents Entry (TC), or Private field ». TA (Table of Authorities entry, ECMA-376 §17.16.5) is the same kind of
 *  entry as XE. Not an omission to report. */
const COLD_FIELD = /^\s*(?:XE|TC|TA|PRIVATE)(?![A-Za-z0-9])/i;

/** Reads one `w:fldChar` or `w:instrText` into the stack of open fields: begin pushes, separate moves a field from its
 *  instructions to its result, end pops, an instruction's text is gathered while it is being written. The ONE state
 *  machine of the complex fields, shared by the run walk, `containsTocField` and `targetedBookmarks`.
 *  Returns what the node tells of a table of contents: "toc-block" (a TOC field whose block stands here), "toc-hidden"
 *  (one, inside the instructions of an enclosing field), or undefined. */
const trackField = (fields: OpenField[], node: XNode, onEmptyField?: () => void): "toc-block" | "toc-hidden" | undefined => {
  const top = fields[fields.length - 1];
  if (tagOf(node) === "w:instrText") {
    if (top?.state === "instructions") top.instructions += textOf(node);
    return undefined;
  }
  const type = attr(node, "w:fldCharType");
  if (type === "begin") fields.push({ state: "instructions", instructions: "" });
  else if (type === "separate" && top?.state === "instructions") {
    // A TOC's cached result is skipped up to its end; the block stands
    // where the field does, unless an enclosing field hides it anyway.
    if (!isTocField(top.instructions)) {
      top.state = "result";
      top.href = fieldLinkTarget(top.instructions);
    } else if (hidden(fields.slice(0, -1))) {
      top.state = "result";
      return "toc-hidden";
    } else {
      top.state = "toc";
      return "toc-block";
    }
  } else if (type === "end") {
    const closed = fields.pop();
    // A field closed with no « separate » has no computed result (a TOC is not one: it stands as its block).
    if (closed?.state === "instructions" && !isTocField(closed.instructions) && !COLD_FIELD.test(closed.instructions) && !hidden(fields)) onEmptyField?.();
    // A TOC never updated has no result at all: still a table of contents.
    if (closed?.state === "instructions" && isTocField(closed.instructions)) return hidden(fields) ? "toc-hidden" : "toc-block";
  }
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
   *  DATA for the dashboard, never text on the page (Mikolaj, 29/09/2026). */
  readonly reportShapesNotDrawn: (count: number) => void;
  /** Called once per drawing kept out because it is hidden (`wp:docPr hidden`), whatever it holds: counted, never its content
   *  (`hidden-dropped` notice, Mikolaj 08/10/2026). */
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
  /** The labels this reading writes, the caller's where it gave any (`lib/page-labels.ts#resolveLabels`). REQUIRED since the
   *  review of 30/10/2026: `docx-reader/index.ts` resolves them for every reading, so an optional field here only bought a
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
   *  ahead (`index.ts`): such a Fallback picture is junk (M16). */
  readonly isPixelImage?: ((relId: string) => boolean) | undefined;
  /** Filled with every block a text box gives: the box's blocks come out among the body's, but a layout table is never made of them
   *  (`docx-reader/layout-tables.ts`). Set for the body story only. */
  readonly textBoxBlocks?: Set<IRBlock> | undefined;
}

/**
 * Bookmarks (w:bookmarkStart) that some internal link (w:hyperlink w:anchor)
 * targets become Confluence anchors (checkpoint A, Mikolaj 24/09/2026); the
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
const sdtContent = (sdt: XNode): XNode | undefined => child(sdt, "w:sdtContent");

/** docPartGallery "Table of Contents" inside sdtPr/docPartObj: the
 *  control IS the document's table of contents. */
const isTableOfContents = (sdt: XNode): boolean => {
  const sdtPr = child(sdt, "w:sdtPr");
  const docPartObj = sdtPr ? child(sdtPr, "w:docPartObj") : undefined;
  const gallery = docPartObj ? child(docPartObj, "w:docPartGallery") : undefined;
  return gallery !== undefined && attr(gallery, "w:val") === "Table of Contents";
};

/** Whether a TOC field (complex, its instruction possibly split over
 *  several w:instrText, or simple) is anywhere inside `node`. */
const containsTocField = (node: XNode): boolean => {
  const fields: OpenField[] = [];
  let found = false;
  const walk = (n: XNode): void => {
    for (const c of kids(n)) {
      if (found) return;
      const tag = tagOf(c);
      if (tag === "w:fldSimple" && isTocField(attr(c, "w:instr") ?? "")) found = true;
      else if (tag === "w:fldChar" || tag === "w:instrText") found = trackField(fields, c) !== undefined;
      else walk(c);
    }
  };
  walk(node);
  return found;
};

/** Where a run sits: what its paragraph declares that its runs inherit. */
interface InlineScope {
  readonly paragraphStyle: string | undefined;
}

/** Elements that only group runs and say nothing themselves (ECMA-376 Part 1:
 *  customXml, smartTag, dir, bdo):
 *  their content is read as if they were not there. */
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

const drawingPieces = (drawing: XNode, ctx: ReadContext): Piece[] => {
  if (isHiddenDrawing(drawing)) {
    ctx.reportHiddenShape();
    return [];
  }
  if (isOffPage(drawing, ctx.page)) return [];
  const content = readDrawing(drawing, ctx.image);
  if (!content) return [];
  const out: Piece[] = [];
  const after: IRBlock[] = [];
  // D2's picture goes FIRST — before any of the drawing's own pictures or
  // text boxes below — the image, then the words (D3,
  // MIKSUDOC « Spécification fonctionnelle » §9.5). How many shapes it leaves out is
  // reported as DATA (dashboard), never as a block on the page.
  const shapePicture = drawnShapeBlocks(drawing, ctx.drawingImage, ctx.limits);
  if (shapePicture.shapesNotDrawn > 0) ctx.reportShapesNotDrawn(shapePicture.shapesNotDrawn);
  // Each picture of ours stands as a pending ref until Google's export has
  // been asked (voie A); a text box below is the DRAWING's words, never the
  // paragraph before the next drawing.
  const placed = shapePicture.blocks.map((block): IRBlock =>
    block.kind === "image" && shapePicture.canvas ? { ...block, ref: ctx.drawings.place(block.ref, shapePicture.canvas) } : block,
  );
  if (content.floating) after.push(...placed);
  else out.push(...placed.map((block): Piece => ({ kind: "block", block })));
  const diagram = readDrawingDiagram(drawing, ctx.limits);
  const units: PieceDiagram["units"] = [];
  for (const item of content.items) {
    if (item.kind === "textbox") {
      const before = ctx.drawings.lastText;
      const from = after.length;
      const boxBlocks = readBlocks(item.content, ctx);
      for (const b of boxBlocks) ctx.textBoxBlocks?.add(b);
      after.push(...boxBlocks);
      ctx.drawings.lastText = before;
      const seen = diagram?.texts.get(item.content);
      if (seen !== undefined && after.length > from) units.push({ from, to: after.length, ...seen });
    } else if (content.floating) after.push(item.block);
    else out.push({ kind: "block", block: item.block });
  }
  // A native chart stands where its drawing stands, as the chart block the
  // pptx and xlsx readers give; a SmartArt stands there too, as its picture
  // THEN its model's list (`DrawingObjects#smartArt`, 29/10/2026).
  for (const object of drawingObjectsOf(drawing)) {
    if (object.kind === "smartart") {
      for (const block of ctx.objects.smartArt(ctx.rels, object.relId, ctx.drawingImage)) {
        if (content.floating) after.push(block);
        else out.push({ kind: "block", block });
      }
      continue;
    }
    const block = ctx.objects.chart(ctx.rels, object.relId);
    if (!block) continue;
    if (content.floating) after.push(block);
    else out.push({ kind: "block", block });
  }
  // A drawing of lines only (a connector, nothing published) still tells
  // where its ends are: its piece goes on with no block.
  const lines = diagram !== undefined && diagram.connectors.length > 0;
  if (after.length > 0 || lines) {
    out.push({
      kind: "after",
      blocks: after,
      anchor: content.anchor,
      ...(diagram === undefined || (units.length === 0 && !lines) ? {} : { diagram: { units, connectors: diagram.connectors, obstacles: diagram.obstacles } }),
    });
  }
  return out;
};

/** The content of one run (`w:r`). */
const runPieces = (run: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const rPr = child(run, "w:rPr");
  const marks = ctx.styles.marks(scope.paragraphStyle, rPr);
  // Colour and highlight travel with the run since 10/11/2026 (`styles.ts#colours`): only what the FILE states.
  const colours = ctx.styles.colours(scope.paragraphStyle, rPr);
  const withMarks = (text: string): Piece => ({
    kind: "inline",
    inline: { text, ...(marks.length > 0 ? { marks: [...marks] } : {}), ...colours },
  });
  // Hidden text (w:vanish, G3, Mikolaj 24/09/2026) is not published: nothing
  // of the run is read but its field characters, which keep the open fields
  // in step (a table of contents block they give is kept).
  if (ctx.styles.hidden(scope.paragraphStyle, rPr)) {
    const fieldOnly = kids(run).filter((c) => tagOf(c) === "w:fldChar" || tagOf(c) === "w:instrText");
    return runContent(fieldOnly, { ...ctx, reportEmptyField: undefined }, withMarks, scope).filter((p) => p.kind === "block");
  }
  return runContent(kids(run), ctx, withMarks, scope);
};

/** Inside a field's instructions nothing is displayed: only its result is
 *  (w:fldChar; decided — no result, nothing). A field nested in the
 *  result of another shows its own result. */
const hidden = (fields: readonly OpenField[]): boolean => fields.some((f) => f.state !== "result");
const inInstructions = (ctx: ReadContext): boolean => hidden(ctx.fields);

/** mc:AlternateContent read once: the Choice this reader understands, then, only when that read gives NOTHING, its
 *  image-only Fallback (`unreadChoiceFallback`). The three walks (runs, paragraph content, story units) share it. */
const chooseAlternate = <T>(alternate: XNode, isPixel: ((relId: string) => boolean) | undefined, read: (branch: XNode) => T[]): T[] => {
  const chosen = chosenContent(alternate);
  if (!chosen) return [];
  const first = read(chosen);
  if (first.length > 0) return first;
  const fallback = unreadChoiceFallback(alternate, chosen, isPixel);
  return fallback ? read(fallback) : first;
};

const TOC_BLOCK: Piece = { kind: "block", block: { kind: "toc" } };

const runContent = (
  nodes: readonly XNode[],
  ctx: ReadContext,
  withMarks: (text: string) => Piece,
  scope: InlineScope,
): Piece[] => {
  const out: Piece[] = [];
  for (const c of nodes) {
    const tag = tagOf(c);
    if (tag === "w:fldChar" || tag === "w:instrText") {
      if (trackField(ctx.fields, c, ctx.reportEmptyField) === "toc-block") out.push(TOC_BLOCK);
      continue;
    }
    if (inInstructions(ctx)) continue;
    const start = out.length;
    switch (tag) {
      // The call of a note: its number in reading order, in superscript,
      // without a link (decided); the note itself is published at the end.
      // A6 of docs/CONCEPTION-CARTE-ET-REMARQUES.md (Mikolaj, 29/09/2026):
      // KEPT, with its brackets — through `noteCallLabel` like every other
      // page-label emitter, not written inline here any more.
      case "w:footnoteReference":
      case "w:endnoteReference": {
        const id = attr(c, "w:id");
        const part: NotePart = tag === "w:footnoteReference" ? "footnotes" : "endnotes";
        if (id !== undefined) out.push({ kind: "inline", inline: { text: ctx.labels.noteCallLabel(ctx.noteCall(part, id)), marks: ["sup"] } });
        break;
      }
      case "w:drawing":
        out.push(...drawingPieces(c, ctx));
        break;
      // w:ruby (CT_Ruby, ECMA-376 Part 1 §17.3.3.25, a child of w:r): a
      // phonetic guide. Its base text (w:rubyBase, §17.3.3.27) is the
      // document's own words, published like any run; its guide text (w:rt,
      // §17.3.3.24) follows in parentheses — also the document's own words,
      // only the parentheses are ours. Confluence's storage format is not
      // known to keep a native `<ruby><rt>` (docs/PLATFORM-STATUS.md §43's
      // catalogue does not test it): the parenthesised form is searchable and
      // carries no platform risk, chosen over the unverified native element
      // (Mikolaj, « on fix », 29/09/2026; fixture
      // `fixtures/docx/09-FABRIQUE-Ruby-Mot-Perdu.docx`). Both rt and
      // rubyBase share rubyBase's run-content group (a sequence of runs, like
      // a paragraph's), so `paragraphContent` reads each the same way it
      // reads a hyperlink's or an sdt's content.
      case "w:ruby": {
        const rubyBase = child(c, "w:rubyBase");
        if (rubyBase) out.push(...paragraphContent(rubyBase, ctx, scope));
        const rt = child(c, "w:rt");
        const guide = rt ? paragraphContent(rt, ctx, scope) : [];
        if (guide.some((p) => p.kind === "inline" && p.inline.text.trim().length > 0)) {
          out.push(withMarks(" ("), ...guide, withMarks(")"));
        }
        break;
      }
      // A VML text box: its paragraphs follow the paragraph, like a
      // DrawingML one. Reached outside mc:AlternateContent, or inside its
      // Fallback when no Choice is one the reader understands.
      case "w:pict": {
        const blocks = vmlTextBoxes(c).flatMap((box) => readBlocks(box, ctx));
        for (const b of blocks) ctx.textBoxBlocks?.add(b);
        if (blocks.length > 0) out.push({ kind: "after", blocks, anchor: undefined });
        break;
      }
      case "mc:AlternateContent":
        out.push(...chooseAlternate(c, ctx.isPixelImage, (branch) => runContent(kids(branch), ctx, withMarks, scope)));
        break;
      case "w:t": {
        const text = textOf(c);
        if (text.length > 0) out.push(withMarks(text));
        break;
      }
      // w:sym: a character given by its code (w:char, hexadecimal) in a
      // named font. In the Symbol font the private-use point becomes the
      // character it draws (lib/symbol-font.ts, Mikolaj 26/10/2026); in any
      // other font the declared code point is published as is — for
      // Wingdings it is a private-use point that Confluence does not draw;
      // that is visible, never silent.
      case "w:sym": {
        const code = Number.parseInt(attr(c, "w:char") ?? "", 16);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
          const point = String.fromCodePoint(code);
          out.push(withMarks(isSymbolFont(attr(c, "w:font")) ? symbolFontText(point) : point));
        }
        break;
      }
      // w:noBreakHyphen: a hyphen the line may not break at; the page shows
      // a plain hyphen (decided).
      case "w:noBreakHyphen":
        out.push(withMarks("-"));
        break;
      // A tab stop has no width on a page that has no tab stops: one space
      // keeps the words apart (decided).
      case "w:tab":
        out.push(withMarks(" "));
        break;
      // w:br: w:type absent or textWrapping is a line break; page and
      // column breaks are layout, ignored (decided — the file's order is the
      // reading order). w:cr is the same line break as textWrapping.
      case "w:br": {
        const type = attr(c, "w:type");
        if (type === undefined || type === "textWrapping") out.push(withMarks("\n"));
        break;
      }
      case "w:cr":
        out.push(withMarks("\n"));
        break;
    }
    // The words of a HYPERLINK field's result carry its target.
    const href = openFieldHref(ctx);
    if (href !== undefined && out.length > start) out.splice(start, out.length - start, ...withHref(out.slice(start), href));
  }
  return out;
};

/** The content of a paragraph or of a run container inside it. */
const paragraphContent = (container: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const siblings = kids(container);
  return siblings.flatMap((c, index): Piece[] => {
    const tag = tagOf(c);
    if (tag === "w:r") return runPieces(c, ctx, scope);
    if (tag === "w:hyperlink") return hyperlinkPieces(c, ctx, scope);
    if (tag === "w:bookmarkStart") {
      const name = attr(c, "w:name");
      return name !== undefined && ctx.anchors.targeted.has(name) ? [{ kind: "bookmark", name }] : [];
    }
    // An equation is a sibling of the runs, where it stands in the sentence. Its line in the ONE table of what we knowingly
    // do not render says it keeps a word boundary (`../skipped-elements.ts`): without it « vecteurs » + « u » came out
    // « vecteursu », a word no search can find.
    if (tag === "m:oMath" || tag === "m:oMathPara") {
      const text = equationText(c);
      // A boundary separates the equation from the TEXT around it, so the neighbour's own blank counts: « ainsi » + a space
      // already in the file must not become two. A sibling we cannot read the text of (a bookmark, an anchor) counts as no
      // neighbour, and the behaviour there is the one of before.
      const sideText = (at: number): string => {
        const sibling = siblings[at];
        return sibling === undefined ? "" : kids(sibling).map(textOf).join("");
      };
      const before = sideText(index - 1);
      const after = sideText(index + 1);
      const sides = { left: before !== "" && !/\s$/.test(before), right: after !== "" && !/^\s/.test(after) };
      if (inInstructions(ctx)) return [];
      const framed = framedSkippedText("equation", text, sides);
      return framed.length > 0 ? [{ kind: "inline", inline: { text: framed } }] : [];
    }
    if (tag === "mc:AlternateContent") {
      return chooseAlternate(c, ctx.isPixelImage, (branch) => paragraphContent(branch, ctx, scope));
    }
    if (tag === "w:sdt") {
      const content = sdtContent(c);
      return content ? paragraphContent(content, ctx, scope) : [];
    }
    // fldSimple: its content IS the field's displayed result — except for a
    // table of contents, which is the toc block and nothing of its result.
    if (tag === "w:fldSimple") {
      if (isTocField(attr(c, "w:instr") ?? "")) return inInstructions(ctx) ? [] : [TOC_BLOCK];
      const result = paragraphContent(c, ctx, scope);
      if (result.length === 0 && !inInstructions(ctx) && !COLD_FIELD.test(attr(c, "w:instr") ?? "")) ctx.reportEmptyField?.();
      return withHref(result, fieldLinkTarget(attr(c, "w:instr") ?? ""));
    }
    if (tag !== undefined && TRANSPARENT_INLINE.has(tag)) return paragraphContent(c, ctx, scope);
    return [];
  });
};

/** w:hyperlink: r:id names an external relationship whose target is
 *  the link. A w:anchor alone points at a bookmark of this document: the
 *  link goes to that bookmark's Confluence anchor (`#name`, see
 *  AnchorState); without one it stays text, never a dead link. `tooltip`,
 *  `history` and `tgtFrame` describe the link's behaviour, not its target. */
const hyperlinkPieces = (link: XNode, ctx: ReadContext, scope: InlineScope): Piece[] => {
  const inner = paragraphContent(link, ctx, scope);
  const id = attr(link, "r:id");
  const rel = id === undefined ? undefined : ctx.rels.get(id);
  // w:anchor alone: a bookmark of this document → a link to its anchor
  // (`#name`), kept only if that anchor gets written (dropDeadAnchorLinks).
  // An external target travels RAW since the arbitrage of 28/09/2026 — the
  // scheme guard is the renderer's (`lib/link-schemes.ts#PUBLISHED_SCHEME`), so a
  // hostile target now dies at the door instead of falling back to the
  // bookmark (edge change, chosen). Only OUR internal forms are refused
  // here: that is provenance, which the door cannot know.
  const bookmark = attr(link, "w:anchor");
  const external = externalLinkTarget(rel);
  const href = external ?? (bookmark !== undefined && ctx.anchors.targeted.has(bookmark) ? `#${bookmark}` : undefined);
  if (href === undefined) return inner;
  return inner.map((p) => (p.kind === "inline" ? { kind: "inline", inline: { ...p.inline, href } } : p));
};

/**
 * The blocks published after a paragraph, in reading order. Several floating
 * drawings are ordered top to bottom, then left to right, by their anchors —
 * only when every one is anchored by an offset from the same frames; any
 * other case keeps the file order (no order is invented).
 */
const orderedAfter = (after: readonly Extract<Piece, { kind: "after" }>[], limits: ReaderLimits | undefined): IRBlock[] => {
  const keys = after.map((a) => a.anchor);
  const first = keys[0];
  const comparable =
    after.length > 1 &&
    first !== undefined &&
    keys.every((k) => k !== undefined && k.vFrom === first.vFrom && k.hFrom === first.hFrom);
  const order = after.map((_, i) => i);
  if (comparable) {
    order.sort((a, b) => {
      const ka = keys[a];
      const kb = keys[b];
      if (!ka || !kb) return 0;
      return ka.v - kb.v || ka.h - kb.h || a - b;
    });
  }
  return inRelationOrder(order.map((i) => after[i]!).filter((a) => a !== undefined), limits);
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
const inRelationOrder = (pieces: readonly Extract<Piece, { kind: "after" }>[], limits: ReaderLimits | undefined): IRBlock[] => {
  interface Cell {
    blocks: IRBlock[];
    unit?: { cluster: string; box: Box; notLabel: boolean };
  }
  const cells: Cell[] = [];
  const clusters = new Map<string, { offsetOf: (box: Box) => Box; connectors: DiagramConnector[]; obstacles: Box[]; slots: number[] }>();
  pieces.forEach((piece, index) => {
    const anchor = piece.anchor;
    const key = anchor === undefined ? `alone:${index}` : `${anchor.vFrom}|${anchor.hFrom}`;
    const dx = anchor?.h ?? 0;
    const dy = anchor?.v ?? 0;
    const place = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, cx: b.cx, cy: b.cy });
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = { offsetOf: place, connectors: [], obstacles: [], slots: [] };
      clusters.set(key, cluster);
    }
    const diagram = piece.diagram;
    if (diagram !== undefined) {
      for (const c of diagram.connectors) {
        cluster.connectors.push({
          ends: { x1: c.ends.x1 + dx, y1: c.ends.y1 + dy, x2: c.ends.x2 + dx, y2: c.ends.y2 + dy },
          startArrow: c.startArrow,
          endArrow: c.endArrow,
          visible: c.visible,
        });
      }
      for (const o of diagram.obstacles) cluster.obstacles.push(place(o));
    }
    let at = 0;
    for (const u of diagram?.units ?? []) {
      for (; at < u.from; at++) cells.push({ blocks: [piece.blocks[at]!] });
      cluster.slots.push(cells.length);
      cells.push({ blocks: piece.blocks.slice(u.from, u.to), unit: { cluster: key, box: place(u.box), notLabel: u.notLabel } });
      at = u.to;
    }
    for (; at < piece.blocks.length; at++) cells.push({ blocks: [piece.blocks[at]!] });
  });
  for (const cluster of clusters.values()) {
    if (cluster.connectors.length === 0 || cluster.slots.length < 2) continue;
    // The pptx element cap, per CLUSTER (separate drawings of one cluster
    // bypass the per-drawing bound): past it today's order stands, nothing
    // is lost — the graph walk is never fed an unbounded diagram.
    if (cluster.slots.length + cluster.connectors.length + cluster.obstacles.length > (limits?.slideElements ?? NO_CAP)) continue;
    const units = cluster.slots.map((slot) => cells[slot]!);
    const elements: DiagramElement[] = units.map((u) => ({ box: u.unit!.box, node: true, notLabel: u.unit!.notLabel }));
    const order = orderDiagram({
      elements,
      obstacles: cluster.obstacles.map((box) => ({ box })),
      connectors: cluster.connectors,
      tolerances: OOXML_DIAGRAM_TOLERANCES,
    });
    if (order.paragraphs.length === 0) continue;
    const next = [...order.paragraphs.flat(), ...order.rest];
    cluster.slots.forEach((slot, k) => {
      cells[slot] = units[next[k]!]!;
    });
  }
  return cells.flatMap((c) => c.blocks);
};

/** A block made only of blanks says nothing and is not published. */
const hasVisibleText = (inlines: readonly Inline[]): boolean => inlines.some((i) => i.text.trim().length > 0);

/** Adjacent inlines that carry the same marks and link read as one: a
 *  producer splits runs for reasons (revision ids, spell-check state) that
 *  mean nothing on the page. */
const merged = (inlines: readonly Inline[]): Inline[] => {
  const out: Inline[] = [];
  const same = (a: Inline, b: Inline): boolean =>
    a.image === undefined &&
    a.anchor === undefined &&
    b.anchor === undefined &&
    b.image === undefined &&
    a.href === b.href &&
    (a.marks ?? []).join() === (b.marks ?? []).join();
  for (const inline of inlines) {
    const last = out[out.length - 1];
    if (last && same(last, inline)) out[out.length - 1] = { ...last, text: last.text + inline.text };
    else out.push(inline);
  }
  return out;
};

/** A list paragraph's place in its list. */
interface ListPlace {
  numId: string;
  ilvl: number;
  ordered: boolean;
  value: number;
}

/** One piece of a story before its list paragraphs are gathered into lists. */
interface Unit {
  blocks: IRBlock[];
  list?: ListPlace;
  /** A hidden paragraph: absent from the page, it neither ends nor joins a list. */
  invisible?: true;
}

/** w:numPr, on the paragraph or inherited from its style (the
 *  style hierarchy); each of numId and ilvl is taken where it is nearest.
 *  numId 0 REMOVES the numbering a style would give (w:numId). */
const numberingOf = (
  pPr: XNode | undefined,
  paragraphStyle: string | undefined,
  ctx: ReadContext,
): { numId: string; ilvl: number } | undefined => {
  const direct = pPr ? child(pPr, "w:numPr") : undefined;
  const fromStyle = ctx.styles.paragraphProperty(paragraphStyle, "w:numPr");
  const numId = valOf(direct, "w:numId") ?? valOf(fromStyle, "w:numId");
  if (numId === undefined || numId === "0") return undefined;
  const ilvl = Number.parseInt(valOf(direct, "w:ilvl") ?? valOf(fromStyle, "w:ilvl") ?? "0", 10);
  // ECMA-376 has nine levels, 0..8: a larger declared level is read as the
  // deepest one, never used as an index (review of 27/09/2026 night, finding 4).
  return { numId, ilvl: Number.isFinite(ilvl) && ilvl >= 0 ? Math.min(ilvl, MAX_ILVL) : 0 };
};

/**
 * w:jc, on the paragraph or else from its style chain: the alignment the page
 * keeps (checkpoint A, Mikolaj 24/09/2026). right and end → right, center →
 * center; left, start, both, distribute and the rest → nothing (left is the
 * page's default; justify is not kept by Confluence, PLATFORM-STATUS §43).
 * `end` is read as right: a right-to-left paragraph (w:bidi) would flip it,
 * and no document in scope (French, English) is one.
 */
const alignmentOf = (pPr: XNode | undefined, paragraphStyle: string | undefined, ctx: ReadContext): BlockAlign | undefined => {
  const fromStyle = ctx.styles.paragraphProperty(paragraphStyle, "w:jc");
  const jc = valOf(pPr, "w:jc") ?? (fromStyle ? attr(fromStyle, "w:val") : undefined);
  if (jc === "right" || jc === "end") return "right";
  if (jc === "center") return "center";
  return undefined;
};

const paragraphUnit = (p: XNode, ctx: ReadContext): Unit => {
  const pPr = child(p, "w:pPr");
  const paragraphStyle = valOf(pPr, "w:pStyle");
  // The anchors waiting before this paragraph are this paragraph's — taken
  // now, before a text box read inside it could make a block of its own.
  const anchors = ctx.anchors.pending.splice(0);
  const pieces = paragraphContent(p, ctx, { paragraphStyle });
  // A paragraph whose mark is hidden and that shows nothing does not exist on
  // the page: no block, and its numbering does not advance (Word shows no
  // number for it either). Its anchors wait for the next block.
  const markHidden = ctx.styles.hidden(paragraphStyle, pPr ? child(pPr, "w:rPr") : undefined);
  const showsSomething = pieces.some(
    (piece) => piece.kind === "block" || (piece.kind === "after" && piece.blocks.length > 0) || (piece.kind === "inline" && piece.inline.text.trim().length > 0),
  );
  if (markHidden && !showsSomething) {
    ctx.anchors.pending.push(...anchors, ...pieces.flatMap((piece) => (piece.kind === "bookmark" ? [piece.name] : [])));
    return { blocks: [], invisible: true };
  }
  const role = ctx.styles.role(paragraphStyle);
  const numbered = numberingOf(pPr, paragraphStyle, ctx);
  // The counter advances even for an empty paragraph: Word numbers it too.
  const item = numbered ? ctx.numbering.next(numbered.numId, numbered.ilvl) : undefined;

  // A numbered heading is a heading, preceded by the number it displays
  // (decided): never a list item. The number goes before its first words.
  let prefix: Inline | undefined =
    role.kind === "heading" && item?.label !== undefined ? { text: item.label + item.separator } : undefined;
  const align = alignmentOf(pPr, paragraphStyle, ctx);
  const wrap = (inlines: Inline[]): IRBlock => {
    const anchorInlines = anchors.splice(0).map((name): Inline => {
      ctx.anchors.placed.add(name);
      return { text: "", anchor: name };
    });
    const withPrefix = [...anchorInlines, ...(prefix ? [prefix] : []), ...inlines];
    prefix = undefined;
    const aligned = align !== undefined ? { align } : {};
    return role.kind === "heading"
      ? { kind: "heading", level: role.level, inlines: withPrefix, ...aligned }
      : { kind: "paragraph", inlines: withPrefix, ...aligned };
  };

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
  // The paragraph's OWN words (its text boxes come after, below): the one a
  // drawing after it is placed against (`docx-reader/google-drawings.ts`).
  const own = collapseBlanks(
    blocks.flatMap((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((i) => i.text) : [])).join(""),
  );
  if (own !== "") ctx.drawings.lastText = own;
  // No text block here: the anchors wait for the next one.
  ctx.anchors.pending.push(...anchors.splice(0));
  blocks.push(...orderedAfter(after, ctx.limits));

  if (role.kind !== "heading" && numbered && item) {
    return { blocks, list: { numId: numbered.numId, ilvl: numbered.ilvl, ordered: item.ordered, value: item.value } };
  }
  return { blocks };
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
          ? { list: { level: unit.list.ilvl, ordered: unit.list.ordered, key: unit.list.numId, ...(unit.list.value !== 1 ? { start: unit.list.value } : {}) } }
          : {}),
      })),
    // An empty item is not published; the lists at its level close so the next item reopens with its true number as `start`.
    { emptyItem: "restart" },
  );

type TableCell = Extract<IRBlock, { kind: "table" }>["rows"][number]["cells"][number];

/** Row- and cell-level containers that only group rows or cells. */
const wrapped = (wrapper: XNode, of: (node: XNode) => XNode[]): XNode[] => {
  if (tagOf(wrapper) === "w:customXml") return of(wrapper);
  const content = tagOf(wrapper) === "w:sdt" ? sdtContent(wrapper) : undefined;
  return content ? of(content) : [];
};
const rowsOf = (tbl: XNode): XNode[] => kids(tbl).flatMap((c) => (tagOf(c) === "w:tr" ? [c] : wrapped(c, rowsOf)));
const cellsOf = (tr: XNode): XNode[] => kids(tr).flatMap((c) => (tagOf(c) === "w:tc" ? [c] : wrapped(c, cellsOf)));

const intVal = (parent: XNode | undefined, tag: string): number | undefined => {
  return intAttr(valOf(parent, tag));
};

/**
 * w:tbl. A cell spans `w:gridSpan` grid columns (→ colspan). A
 * vertical merge (w:vMerge) starts at `restart` and goes on while the
 * cell at the SAME grid column of the next rows says `continue` (the value
 * absent means continue): those cells fold into the first one (→ rowspan).
 * Grid columns count `w:gridBefore`, the columns a row leaves empty first.
 * tblHeader marks a header row — by its VALUE: `<w:tblHeader
 * w:val="0"/>` is "not a header row" (decided, the docx reader (`extractor/docx-reader/`)
 * §1). Widths and borders are not read.
 */
/** Word's own ceiling on a table's columns: « Word tables support a maximum
 *  of 63 columns » (Microsoft Learn, « Export a paginated report to Microsoft
 *  Word », Word limitations; read 27/09/2026). A declared
 *  gridSpan is written into the page as colspan: 1 000 000 used to go there
 *  as is (review of 27/09/2026 night, finding 13). A rowspan needs no clamp:
 *  it grows by one per row actually read. */
const MAX_GRID_COLUMNS = 63;

const tableBlock = (tbl: XNode, outer: ReadContext): IRBlock[] => {
  // The empty fields met inside the table are held back: a table the page does not publish (`tableExceedsCaps`, the decision
  // `withholdOversizedTables` takes later on the same block) shows none of them, so they are reported only when it stands.
  let held = 0;
  const ctx: ReadContext = outer.reportEmptyField
    ? {
        ...outer,
        reportEmptyField: () => {
          held++;
        },
      }
    : outer;
  const rows: { cells: TableCell[] }[] = [];
  const merging = new Map<number, TableCell>();
  // The declared grid (§17.4.49 w:tblGrid/w:gridCol) bounds a cell's span, as a:gridSpan is bounded; no grid: only Word's ceiling.
  const gridColumns = children(child(tbl, "w:tblGrid") ?? {}, "w:gridCol").length;
  for (const tr of rowsOf(tbl)) {
    const trPr = child(tr, "w:trPr");
    const headerEl = trPr ? child(trPr, "w:tblHeader") : undefined;
    const header = headerEl !== undefined && onOff(headerEl);
    const cells: TableCell[] = [];
    const seen = new Set<number>();
    let column = intVal(trPr, "w:gridBefore") ?? 0;
    for (const tc of cellsOf(tr)) {
      const tcPr = child(tc, "w:tcPr");
      const room = gridColumns === 0 ? MAX_GRID_COLUMNS : Math.max(1, gridColumns - column);
      const span = Math.min(MAX_GRID_COLUMNS, room, Math.max(1, intVal(tcPr, "w:gridSpan") ?? 1));
      const vMergeEl = tcPr ? child(tcPr, "w:vMerge") : undefined;
      const vMerge = vMergeEl ? (attr(vMergeEl, "w:val") ?? "continue") : undefined;
      const above = merging.get(column);
      seen.add(column);
      if (vMerge === "continue" && above && (above.colspan ?? 1) === span) {
        above.rowspan = (above.rowspan ?? 1) + 1;
        // The continuation's content is dropped: Word does not show it (rule « Rien d'invisible »,
        // docs/PLATFORM-STATUS.md §67, observed by Mikolaj 09/10/2026), so it is not published either. It is not even read:
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
    for (const col of [...merging.keys()]) if (!seen.has(col)) merging.delete(col);
    rows.push({ cells });
  }
  if (rows.length === 0) return [];
  const table: Extract<IRBlock, { kind: "table" }> = { kind: "table", rows };
  const useful = withoutEmptyTableParts(table);
  const withheld = useful !== null && tableExceedsCaps(tableGridWidth(useful), useful.rows.length, outer.limits);
  if (!withheld) for (let i = 0; i < held; i++) outer.reportEmptyField?.();
  // WRITTEN BIAS: unlike Excel, Word does NOT visually overflow a row whose only text is in its first cell; the full-width cell is a chosen
  // embellishment, not a fidelity (Mikolaj, 27/10/2026: « idem pour tableau ds word, ds google doc et ds ppt »). Header cells are marked above.
  return [spanSingleFirstRows(table)];
};

/** Block-level containers that only group paragraphs (customXml). */
const TRANSPARENT_BLOCK = new Set(["w:customXml"]);

const storyUnits = (story: XNode, ctx: ReadContext): Unit[] =>
  kids(story).flatMap((c): Unit[] => {
    const tag = tagOf(c);
    if (tag === "w:p") return [paragraphUnit(c, ctx)];
    if (tag === "w:tbl") return [{ blocks: tableBlock(c, ctx) }];
    // A bookmark between blocks (Google's habit): its anchor waits for the
    // next text block.
    if (tag === "w:bookmarkStart") {
      const name = attr(c, "w:name");
      if (name !== undefined && ctx.anchors.targeted.has(name)) ctx.anchors.pending.push(name);
      return [];
    }
    if (tag === "mc:AlternateContent") {
      return chooseAlternate(c, ctx.isPixelImage, (branch) => storyUnits(branch, ctx));
    }
    if (tag === "w:sdt") {
      const content = sdtContent(c);
      // A table of contents control is an editing convenience; the table of
      // contents is the TOC FIELD inside it, which gives the toc block, so a
      // title typed in the control is read like any other text (Mikolaj,
      // 24/09/2026). A control with no TOC field at all (some producers)
      // stays ONE toc block, its content unread, as before.
      if (isTableOfContents(c) && !(content && containsTocField(content))) return [{ blocks: [{ kind: "toc" }] }];
      return content ? storyUnits(content, ctx) : [];
    }
    if (tag !== undefined && TRANSPARENT_BLOCK.has(tag)) return storyUnits(c, ctx);
    return [];
  });

/** Every block of a story, in document order. */
export const readBlocks = (story: XNode, ctx: ReadContext): IRBlock[] => assembleLists(storyUnits(story, ctx));

/** The names of the bookmarks internal links target (w:hyperlink w:anchor
 *  without an external relationship), in the parts of a story that are
 *  PUBLISHED: not inside a table of contents (a w:sdt control or a TOC field,
 *  both read as one toc block), nor anything else a field hides (its
 *  instructions), a deletion, a move's origin, or the alternative of an
 *  mc:AlternateContent the walk does not choose. Fields span
 *  runs and paragraphs, so they are followed in document order, as the
 *  walk itself follows them. */
export const targetedBookmarks = (story: XNode, rels: ReadonlyMap<string, Relationship>): Set<string> => {
  const found = new Set<string>();
  const fields: OpenField[] = [];
  const walk = (node: XNode): void => {
    for (const c of kids(node)) {
      const tag = tagOf(c);
      if (tag === "w:del" || tag === "w:moveFrom") continue;
      // Only the content the walk reads: the chosen Choice, or the Fallback.
      if (tag === "mc:AlternateContent") {
        const chosen = chosenContent(c);
        if (chosen) walk(chosen);
        continue;
      }
      // A TOC control is skipped whole only when it has no TOC field (it is
      // then one toc block); otherwise the field logic below hides its entries.
      if (tag === "w:sdt" && isTableOfContents(c)) {
        const content = sdtContent(c);
        if (!(content && containsTocField(content))) continue;
      }
      if (tag === "w:fldSimple" && isTocField(attr(c, "w:instr") ?? "")) continue;
      if (tag === "w:fldChar" || tag === "w:instrText") {
        trackField(fields, c);
        continue;
      }
      if (tag === "w:hyperlink" && !hidden(fields)) {
        const id = attr(c, "r:id");
        // "External" is judged as the real walk judges it (`hyperlinkPieces`).
        const external = externalLinkTarget(id === undefined ? undefined : rels.get(id)) !== undefined;
        const name = attr(c, "w:anchor");
        if (!external && name !== undefined) found.add(name);
      }
      walk(c);
    }
  };
  walk(story);
  return found;
};

/** Once every story is read: a link to an anchor that was never written (its
 *  bookmark missing, or in no text block) is published as text — never a
 *  dead link (decided) — and the text merges back with its neighbours. */
export const dropDeadAnchorLinks = (blocks: IRBlock[], placed: ReadonlySet<string>): IRBlock[] => {
  const isDead = (i: Inline): boolean => i.href !== undefined && i.href.startsWith("#") && !placed.has(i.href.slice(1));
  // Only a block that loses a link is touched (and merged again).
  const fixInlines = (inlines: Inline[]): Inline[] =>
    inlines.some(isDead)
      ? merged(
          inlines.map((i) => {
            if (!isDead(i)) return i;
            const rest: Inline = { ...i };
            delete rest.href;
            return rest;
          }),
        )
      : inlines;
  return mapInlines(blocks, fixInlines);
};
