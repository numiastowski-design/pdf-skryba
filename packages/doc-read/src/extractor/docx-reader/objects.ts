/** What a `w:drawing` holds that the page keeps — its pictures (bytes by
 *  relationship, alt text, drawn width) and its text boxes, in reading order
 *  — and the text of an equation. Also decides where a drawing sits (page, off-page, hidden) and which
 *  `mc:AlternateContent` branch is read.
 *  NOT here: where those land around their paragraph, nor reading a text
 *  box's paragraphs (`docx-reader/body.ts`); a drawing's declared SHAPES
 *  (rectangles, ellipses, connectors) are read separately, into the picture
 *  D2 draws for them (`docx-reader/shapes.ts`, MIKSUDOC « Spécification fonctionnelle » §9.5
 *  §5) — no picture of them exists in the docx itself, only the shapes.
 *  Called by: `docx-reader/body.ts`. */

import { collapseBlanks } from "doc-ir/lib/blanks";
import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import { fallbackPictureIds, imageOnlyFallback, renderedBranch, WORD_TEXT_TAGS, WORD_UNDERSTOOD } from "../markup-compat";
import { EMU_PER_PT, isWhollyOutside } from "../pptx-reader/geometry";
import { finiteNumber as num } from "../../lib/ooxml-num";
import { isHiddenFlag, isOnOff } from "../../lib/ooxml-bool";
import { attr, child, drawingFrame, graphicData, kids, someDescendant, tagOf, textOf, type XNode } from "../ooxml/xml";

/** Where a floating drawing is anchored (wp:anchor): offsets in EMU
 *  from a reference frame named by `relativeFrom`. Two anchors compare only
 *  when their frames are the same. */
export interface AnchorKey {
  vFrom: string;
  v: number;
  hFrom: string;
  h: number;
}

type DrawingItem = { kind: "image"; block: IRBlock } | { kind: "textbox"; content: XNode };

export interface DrawingContent {
  /** `wp:anchor`: the drawing floats and follows its paragraph (decided);
   *  `wp:inline`: it stands in the line. */
  floating: boolean;
  anchor: AnchorKey | undefined;
  /** In reading order: top to bottom, then left to right inside a group. */
  items: DrawingItem[];
}

/** Resolves a picture's `r:embed` to the bytes it names. */
export type ImageLookup = (relId: string) => Pick<ImageRef, "sha256" | "mimeType" | "pixelWidth"> | undefined;

/** A shape's offset inside its group (a:xfrm → a:off), from the
 *  properties element that holds its transform. */
const offsetOf = (shape: XNode): { x: number; y: number } | undefined => {
  const props = kids(shape).find((c) => {
    const tag = tagOf(c);
    return tag === "wps:spPr" || tag === "pic:spPr" || tag === "wpg:grpSpPr";
  });
  const xfrm = props ? child(props, "a:xfrm") : undefined;
  const off = xfrm ? child(xfrm, "a:off") : undefined;
  const x = off ? num(attr(off, "x")) : undefined;
  const y = off ? num(attr(off, "y")) : undefined;
  return x !== undefined && y !== undefined ? { x, y } : undefined;
};

const pictureBlock = (pic: XNode, widthPt: number | undefined, image: ImageLookup): IRBlock | undefined => {
  const blipFill = child(pic, "pic:blipFill");
  const blip = blipFill ? child(blipFill, "a:blip") : undefined;
  // r:embed names a part of the package; r:link an external file, never read: its lookup gives nothing and is counted as missing.
  const relId = blip ? (attr(blip, "r:embed") ?? attr(blip, "r:link")) : undefined;
  const found = relId === undefined ? undefined : image(relId);
  if (!found) return undefined;
  // Rule « Rien d'invisible » (Mikolaj, 09/10/2026): `pic:cNvPr@descr` is not shown by Word on the page, so it is never read
  // as alt text.
  return {
    kind: "image",
    ref: { ...found, ...(widthPt !== undefined && widthPt > 0 ? { widthPt } : {}) },
  };
};

/**
 * The items of one graphic object, in reading order. A group's members are
 * ordered by their offset in the group's coordinate space — top to bottom,
 * then left to right (decided) — each nested group as one member at its own
 * offset. When a member declares no offset, the file order stands: no order
 * is invented.
 */
const collect = (
  node: XNode,
  topLevel: { widthPt: number | undefined } | undefined,
  image: ImageLookup,
): DrawingItem[] => {
  switch (tagOf(node)) {
    case "pic:pic": {
      // Inside a group the drawing's extent is the GROUP's: no width is
      // given rather than a wrong one.
      const block = pictureBlock(node, topLevel?.widthPt, image);
      return block ? [{ kind: "image", block }] : [];
    }
    case "wps:wsp": {
      const txbx = child(node, "wps:txbx");
      const content = txbx ? child(txbx, "w:txbxContent") : undefined;
      return content ? [{ kind: "textbox", content }] : [];
    }
    case "wpg:wgp":
    case "wpg:grpSp": {
      const members = kids(node).filter((c) => {
        const tag = tagOf(c);
        return tag === "wps:wsp" || tag === "pic:pic" || tag === "wpg:grpSp";
      });
      const offsets = members.map(offsetOf);
      const order = members.map((_, i) => i);
      if (offsets.every((o) => o !== undefined)) {
        order.sort((a, b) => {
          const oa = offsets[a];
          const ob = offsets[b];
          if (!oa || !ob) return 0;
          return oa.y - ob.y || oa.x - ob.x || a - b;
        });
      }
      return order.flatMap((i) => {
        const member = members[i];
        return member ? collect(member, undefined, image) : [];
      });
    }
    default:
      return [];
  }
};

const anchorKeyOf = (anchor: XNode): AnchorKey | undefined => {
  if (isOnOff(attr(anchor, "simplePos"), false)) {
    // wp:simplePos: the position is given in page coordinates.
    const pos = child(anchor, "wp:simplePos");
    const x = pos ? num(attr(pos, "x")) : undefined;
    const y = pos ? num(attr(pos, "y")) : undefined;
    return x !== undefined && y !== undefined ? { vFrom: "simplePos", v: y, hFrom: "simplePos", h: x } : undefined;
  }
  const axis = (tag: string): { from: string; offset: number } | undefined => {
    const el = child(anchor, tag);
    const from = el ? attr(el, "relativeFrom") : undefined;
    const offsetEl = el ? child(el, "wp:posOffset") : undefined;
    const offset = offsetEl ? num(textOf(offsetEl).trim()) : undefined;
    // A position given by alignment (wp:align) has no number to compare.
    return from !== undefined && offset !== undefined ? { from, offset } : undefined;
  };
  const v = axis("wp:positionV");
  const h = axis("wp:positionH");
  return v && h ? { vFrom: v.from, v: v.offset, hFrom: h.from, h: h.offset } : undefined;
};

/** wp:inline / wp:anchor, holding one `a:graphic`. */
export const readDrawing = (drawing: XNode, image: ImageLookup): DrawingContent | undefined => {
  const frame = drawingFrame(drawing);
  if (!frame) return undefined;
  const floating = tagOf(frame) === "wp:anchor";
  const extent = child(frame, "wp:extent");
  const cx = extent ? num(attr(extent, "cx")) : undefined;
  const data = graphicData(frame);
  const topLevel = {
    widthPt: cx !== undefined ? cx / EMU_PER_PT : undefined,
  };
  const items = data ? kids(data).flatMap((c) => collect(c, topLevel, image)) : [];
  return { floating, anchor: floating ? anchorKeyOf(frame) : undefined, items };
};

/**
 * The text boxes of a VML picture (`w:pict`), the form older Word files use
 * for a text box outside any `mc:AlternateContent`: every
 * `v:textbox` → `w:txbxContent` in file order. VML declares no DrawingML
 * offsets to order them by, so the file order stands. A VML shape without a
 * text box (a horizontal line, a rectangle) gives nothing.
 */
export const vmlTextBoxes = (pict: XNode): XNode[] => {
  const found: XNode[] = [];
  const walk = (node: XNode): void => {
    for (const c of kids(node)) {
      if (tagOf(c) === "v:textbox") {
        const content = child(c, "w:txbxContent");
        if (content) found.push(content);
      } else walk(c);
    }
  };
  walk(pict);
  return found;
};

/** The m:val of an OMML property (m:chr, m:begChr…) inside `props`:
 *  undefined when the element is absent, "" when it declares no character. */
const mathChar = (props: XNode | undefined, tag: string): string | undefined => {
  const el = props ? child(props, tag) : undefined;
  return el ? (attr(el, "m:val") ?? "") : undefined;
};

const spaced = (parts: readonly string[]): string => parts.filter((p) => p.length > 0).join(" ");

const mathText = (node: XNode): string => {
  const tag = tagOf(node) ?? "";
  // Properties (m:fPr, m:naryPr, m:ctrlPr, m:rPr, w:rPr…) hold no text.
  if (tag.endsWith("Pr")) return "";
  const sub = (name: string): string => {
    const el = child(node, name);
    return el ? mathText(el) : "";
  };
  switch (tag) {
    case "m:t":
      return textOf(node);
    // A run's text is one piece: "taux=" stays "taux=".
    // THROUGH A TRACKED INSERTION, AND NEVER THROUGH A DELETION (measured 29/10/2026 on a real NIST template): Word may
    // wrap a maths run's text in `w:ins`, and this case looked for `m:t` as a DIRECT child — one wrapper and the whole
    // equation came out empty. « Declare H_submitter (this value… » published « Declare (this value… », a sentence without
    // its subject, and « false reject rate, α, the APT's… » published two commas in a row. The 36 other equations of that
    // same document were fine, which is what made it invisible. Deleted text (`w:del`) is NOT in the document and is not
    // read: a reader that took it would publish what the author removed.
    case "m:r":
      return mathRunText(node);
    // A fraction reads numerator / denominator.
    case "m:f":
      return spaced([sub("m:num"), "/", sub("m:den")]);
    // An n-ary operator shows the character m:chr declares — ∫ when absent,
    // the OMML default — then its limits and its operand.
    case "m:nary":
      return spaced([mathChar(child(node, "m:naryPr"), "m:chr") ?? "∫", sub("m:sub"), sub("m:sup"), sub("m:e")]);
    // Delimiters: m:begChr, m:sepChr, m:endChr, by default ( | ).
    case "m:d": {
      const props = child(node, "m:dPr");
      const elements = kids(node)
        .filter((c) => tagOf(c) === "m:e")
        .map(mathText);
      return (
        (mathChar(props, "m:begChr") ?? "(") + elements.join(mathChar(props, "m:sepChr") ?? "|") + (mathChar(props, "m:endChr") ?? ")")
      );
    }
    // Any other structure (sub/superscript, radical, function…): its parts
    // in file order, separated by a space.
    default:
      return spaced(kids(node).map(mathText));
  }
};

/** The text of one maths run: its `m:t` pieces, reached through any number of transparent wrappers — a tracked INSERTION
 *  is one — and never through a deletion. */
const mathRunText = (node: XNode): string =>
  kids(node)
    .map((c) => {
      const tag = tagOf(c);
      if (tag === "m:t") return textOf(c);
      if (tag === "w:del" || tag === "w:moveFrom") return "";
      return tag === undefined ? "" : mathRunText(c);
    })
    .join("");

/** An OMML equation's text: the text of its runs (m:t), each mathematical
 *  structure separated from the next by a space, with the characters the
 *  structures DECLARE (an n-ary operator's m:chr such as ∑, a delimiter's
 *  brackets) and "/" between a fraction's two halves. No mathematical layout
 *  (decided): "taux=remise/total" reads « taux= remise / total ». */
export const equationText = (math: XNode): string => collapseBlanks(mathText(math));

/**
 * The content an `mc:AlternateContent` offers the Word reader: the ONE branch
 * Word renders (`markup-compat.ts#renderedBranch`, ECMA-376 Part 3,
 * AlternateContent) — the first `mc:Choice` whose `Requires` names only
 * namespaces Word understands, else the `mc:Fallback`. A Choice Word
 * understands but this reader cannot read gives way to its Fallback only if
 * image-only (`unreadChoiceFallback`; M16, 02/10/2026; the list was ten prefixes, shorter than
 * Word's, and sent such a Choice to the Fallback). Google's text box keeps
 * its exception by the rule itself: its Choice requires `wps`, read, so its
 * Fallback — a transparent 1×1 pixel — is not (docs/PLATFORM-STATUS.md §53).
 */
export const chosenContent = (alternate: XNode): XNode | undefined => renderedBranch(alternate, WORD_UNDERSTOOD);

/** The Fallback to read when the Choice `chosenContent` gave this reader
 *  yielded NOTHING: only an image-only one (M16, Mikolaj 02/10/2026 — the
 *  same object Word draws, e.g. an extended chart's picture). A Fallback
 *  carrying text is never read; the caller asks only after an empty Choice,
 *  so the two branches never come out together. */
export const unreadChoiceFallback = (alternate: XNode, chosen: XNode, isPixel?: (relId: string) => boolean): XNode | undefined =>
  imageOnlyFallback(alternate, chosen, WORD_TEXT_TAGS, isPixel);

/** The ids of the pictures any `mc:Fallback` under this node names: the ones
 *  `docx-reader/index.ts` measures ahead (a 1×1 pixel is junk, not content). */
export const fallbackPictureRelIds = (node: XNode): string[] =>
  kids(node).flatMap((c) => (tagOf(c) === "mc:Fallback" ? fallbackPictureIds(c) : fallbackPictureRelIds(c)));

/** A page's size, in EMU. */
export interface PageSize {
  readonly widthEmu: number;
  readonly heightEmu: number;
}

/** EMU per twentieth of a point: 12 700 / 20. */
const EMU_PER_TWIP = 635;

/** The LARGEST page of the document: the widest and the tallest `w:pgSz` of
 *  its sections (ECMA-376 Part 1 §17.6.13, twips) — a box outside the largest
 *  page is outside every page. `undefined` when a section declares no
 *  readable size (Word then falls back on a default this reader does not
 *  guess) or there is none. */
export const largestPage = (body: XNode): PageSize | undefined => {
  let width = 0;
  let height = 0;
  let sections = 0;
  let unreadable = false;
  const walk = (node: XNode): void => {
    for (const c of kids(node)) {
      const tag = tagOf(c);
      if (tag === undefined || tag === "#text") continue;
      if (tag === "w:sectPr") {
        sections++;
        const size = child(c, "w:pgSz");
        const w = size ? num(attr(size, "w:w")) : undefined;
        const h = size ? num(attr(size, "w:h")) : undefined;
        if (w === undefined || h === undefined || w <= 0 || h <= 0) unreadable = true;
        else {
          width = Math.max(width, w);
          height = Math.max(height, h);
        }
        continue;
      }
      walk(c);
    }
  };
  walk(body);
  return sections === 0 || unreadable ? undefined : { widthEmu: width * EMU_PER_TWIP, heightEmu: height * EMU_PER_TWIP };
};

const isRotated = (node: XNode): boolean =>
  someDescendant(node, (n) => {
    if (tagOf(n) !== "a:xfrm") return false;
    const rot = attr(n, "rot");
    return rot !== undefined && rot !== "0";
  });

/** Whether a drawing is hidden: `wp:docPr hidden` true ("1" or "true", any case; CT_NonVisualDrawingProps, ECMA-376 Part 1
 *  §20.4.2.5). Decision of 08/10/2026 (Mikolaj): hidden content is not published, neither its picture nor its words. "0",
 *  "false" and an absent attribute are visible. */
export const isHiddenDrawing = (drawing: XNode): boolean => {
  const frame = drawingFrame(drawing);
  const value = frame ? child(frame, "wp:docPr") : undefined;
  return isHiddenFlag(value ? attr(value, "hidden") : undefined);
};

/** Whether a floating drawing lies ENTIRELY outside the page, so that Word
 *  does not display it (M14, 02/10/2026). Decided only on what is declared:
 *  an anchor `wp:positionH`/`wp:positionV` `relativeFrom="page"` with a
 *  `wp:posOffset` (or `wp:simplePos`, page coordinates), plus its
 *  `wp:extent` (ECMA-376 Part 1 §20.4.2.3, §20.4.2.10). One axis wholly
 *  outside is enough. Anything else — another frame (margin, column,
 *  paragraph…), an alignment instead of an offset, a rotated shape, an
 *  unknown page, an inline drawing — is kept: only what is PROVABLY off the
 *  page is dropped (a box PARTLY on the page is displayed). */
export const isOffPage = (drawing: XNode, page: PageSize | undefined): boolean => {
  const frame = child(drawing, "wp:anchor");
  if (!frame || !page || isRotated(frame)) return false;
  const extent = child(frame, "wp:extent");
  const cx = extent ? num(attr(extent, "cx")) : undefined;
  const cy = extent ? num(attr(extent, "cy")) : undefined;
  if (cx === undefined || cy === undefined) return false;
  const outside = (start: number | undefined, size: number, limit: number): boolean => start !== undefined && isWhollyOutside(start, size, limit);
  if (isOnOff(attr(frame, "simplePos"), false)) {
    const pos = child(frame, "wp:simplePos");
    return outside(pos ? num(attr(pos, "x")) : undefined, cx, page.widthEmu) || outside(pos ? num(attr(pos, "y")) : undefined, cy, page.heightEmu);
  }
  const offsetOnPage = (tag: string): number | undefined => {
    const el = child(frame, tag);
    if (!el || attr(el, "relativeFrom") !== "page") return undefined;
    const offset = child(el, "wp:posOffset");
    return offset ? num(textOf(offset).trim()) : undefined;
  };
  return outside(offsetOnPage("wp:positionH"), cx, page.widthEmu) || outside(offsetOnPage("wp:positionV"), cy, page.heightEmu);
};
