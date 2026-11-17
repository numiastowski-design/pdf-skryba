/** What a `w:drawing` holds that the page keeps — its pictures (bytes by
 *  relationship, drawn width) and its text boxes, in reading order — and the
 *  text of an equation.
 *  Decides: whether a drawing is hidden or wholly off the page (then not published), which `mc:AlternateContent`
 *  branch is read, and the document's largest page.
 *  NOT here: where those land around their paragraph, nor reading a text
 *  box's paragraphs (`docx-reader/body.ts`); a drawing's declared SHAPES
 *  (rectangles, ellipses, connectors) are read separately, into the picture
 *  D2 draws for them (`docx-reader/shapes.ts`, MIKSUDOC « Spécification fonctionnelle » §9.5).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import { collapseBlanks } from "doc-ir/lib/blanks";
import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import {
  fallbackPictureIds,
  imageOnlyFallback,
  renderedBranch,
  WORD_TEXT_TAGS,
  WORD_UNDERSTOOD,
} from "../markup-compat";
import { EMU_PER_PT, isWhollyOutside } from "../pptx-reader/geometry";
import { finiteNumber } from "../../lib/ooxml-num";
import { isHiddenFlag, isOnOff } from "../../lib/ooxml-bool";
import {
  attributeOf,
  findChild,
  findDrawingFrame,
  findGraphicData,
  childNodesOf,
  hasMatchingNode,
  qualifiedNameOf,
  textContentOf,
  type XNode,
} from "../ooxml/xml";

/** Where a floating drawing is anchored (wp:anchor): offsets in EMU
 *  from a reference frame named by `relativeFrom`. Two anchors compare only
 *  when their frames are the same. */
export interface AnchorKey {
  vFrom: string;
  v: number;
  hFrom: string;
  h: number;
}

type DrawingItem =
  { readonly kind: "image"; readonly block: IRBlock } | { readonly kind: "textbox"; readonly content: XNode };

export interface DrawingContent {
  /** `wp:anchor`: the drawing floats and follows its paragraph (decided);
   *  `wp:inline`: it stands in the line. */
  readonly floating: boolean;
  readonly anchor: AnchorKey | undefined;
  /** In reading order: top to bottom, then left to right inside a group. */
  readonly items: readonly DrawingItem[];
}

/** Resolves a picture's `r:embed` to the bytes it names. */
export type ImageLookup = (relId: string) => Pick<ImageRef, "sha256" | "mimeType" | "pixelWidth"> | undefined;

/** A shape's offset inside its group (a:xfrm → a:off), from the
 *  properties element that holds its transform. */
const offsetOf = (shape: XNode): { x: number; y: number } | undefined => {
  const shapeProperties = childNodesOf(shape).find((childNode) => {
    const tag = qualifiedNameOf(childNode);
    return tag === "wps:spPr" || tag === "pic:spPr" || tag === "wpg:grpSpPr";
  });
  const xfrm = shapeProperties ? findChild(shapeProperties, "a:xfrm") : undefined;
  const off = xfrm ? findChild(xfrm, "a:off") : undefined;
  const x = off ? finiteNumber(attributeOf(off, "x")) : undefined;
  const y = off ? finiteNumber(attributeOf(off, "y")) : undefined;
  return x !== undefined && y !== undefined ? { x, y } : undefined;
};

const pictureBlock = (pic: XNode, widthPt: number | undefined, imageLookup: ImageLookup): IRBlock | undefined => {
  const blipFill = findChild(pic, "pic:blipFill");
  const blip = blipFill ? findChild(blipFill, "a:blip") : undefined;
  // r:embed names a part of the package; r:link an external file, never read: its lookup gives nothing and is counted as missing.
  const relId = blip ? (attributeOf(blip, "r:embed") ?? attributeOf(blip, "r:link")) : undefined;
  const found = relId === undefined ? undefined : imageLookup(relId);
  if (!found) return undefined;
  // Rule « nothing invisible » (09/10/2026): `pic:cNvPr@descr` is not shown on the page, so it is never read as alt
  // text.
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
  imageLookup: ImageLookup,
): DrawingItem[] => {
  switch (qualifiedNameOf(node)) {
    case "pic:pic": {
      // Inside a group the drawing's extent is the GROUP's: no width is
      // given rather than a wrong one.
      const block = pictureBlock(node, topLevel?.widthPt, imageLookup);
      return block ? [{ kind: "image", block }] : [];
    }
    case "wps:wsp": {
      const txbx = findChild(node, "wps:txbx");
      const content = txbx ? findChild(txbx, "w:txbxContent") : undefined;
      return content ? [{ kind: "textbox", content }] : [];
    }
    case "wpg:wgp":
    case "wpg:grpSp": {
      const members = childNodesOf(node).filter((childNode) => {
        const tag = qualifiedNameOf(childNode);
        return tag === "wps:wsp" || tag === "pic:pic" || tag === "wpg:grpSp";
      });
      const offsets = members.map(offsetOf);
      const order = members.map((_, memberIndex) => memberIndex);
      if (offsets.every((offset) => offset !== undefined)) {
        order.sort((firstIndex, secondIndex) => {
          const firstOffset = offsets[firstIndex]!;
          const secondOffset = offsets[secondIndex]!;
          return firstOffset.y - secondOffset.y || firstOffset.x - secondOffset.x || firstIndex - secondIndex;
        });
      }
      return order.flatMap((memberIndex) => {
        const member = members[memberIndex];
        return member ? collect(member, undefined, imageLookup) : [];
      });
    }
    default:
      return [];
  }
};

const anchorKeyOf = (anchor: XNode): AnchorKey | undefined => {
  if (isOnOff(attributeOf(anchor, "simplePos"), false)) {
    // wp:simplePos: the position is given in page coordinates.
    const simplePos = findChild(anchor, "wp:simplePos");
    const x = simplePos ? finiteNumber(attributeOf(simplePos, "x")) : undefined;
    const y = simplePos ? finiteNumber(attributeOf(simplePos, "y")) : undefined;
    return x !== undefined && y !== undefined ? { vFrom: "simplePos", v: y, hFrom: "simplePos", h: x } : undefined;
  }
  const axis = (tag: string): { from: string; offset: number } | undefined => {
    const positionElement = findChild(anchor, tag);
    const from = positionElement ? attributeOf(positionElement, "relativeFrom") : undefined;
    const posOffset = positionElement ? findChild(positionElement, "wp:posOffset") : undefined;
    const offset = posOffset ? finiteNumber(textContentOf(posOffset).trim()) : undefined;
    // A position given by alignment (wp:align) has no number to compare.
    return from !== undefined && offset !== undefined ? { from, offset } : undefined;
  };
  const vertical = axis("wp:positionV");
  const horizontal = axis("wp:positionH");
  return vertical && horizontal
    ? { vFrom: vertical.from, v: vertical.offset, hFrom: horizontal.from, h: horizontal.offset }
    : undefined;
};

/** wp:inline / wp:anchor, holding one `a:graphic`. */
export const readDrawing = (drawing: XNode, imageLookup: ImageLookup): DrawingContent | undefined => {
  const frame = findDrawingFrame(drawing);
  if (!frame) return undefined;
  const floating = qualifiedNameOf(frame) === "wp:anchor";
  const extent = findChild(frame, "wp:extent");
  const cx = extent ? finiteNumber(attributeOf(extent, "cx")) : undefined;
  const graphicData = findGraphicData(frame);
  const topLevel = {
    widthPt: cx !== undefined ? cx / EMU_PER_PT : undefined,
  };
  const items = graphicData
    ? childNodesOf(graphicData).flatMap((childNode) => collect(childNode, topLevel, imageLookup))
    : [];
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
    for (const childNode of childNodesOf(node)) {
      if (qualifiedNameOf(childNode) === "v:textbox") {
        const content = findChild(childNode, "w:txbxContent");
        if (content) found.push(content);
      } else walk(childNode);
    }
  };
  walk(pict);
  return found;
};

/** The m:val of an OMML property (m:chr, m:begChr…) inside `properties`:
 *  undefined when the element is absent, "" when it declares no character. */
const mathChar = (properties: XNode | undefined, tag: string): string | undefined => {
  const property = properties ? findChild(properties, tag) : undefined;
  return property ? (attributeOf(property, "m:val") ?? "") : undefined;
};

const spaced = (parts: readonly string[]): string => parts.filter((part) => part.length > 0).join(" ");

const mathText = (node: XNode): string => {
  const tag = qualifiedNameOf(node) ?? "";
  // Properties (m:fPr, m:naryPr, m:ctrlPr, m:rPr, w:rPr…) hold no text.
  if (tag.endsWith("Pr")) return "";
  const childText = (name: string): string => {
    const childElement = findChild(node, name);
    return childElement ? mathText(childElement) : "";
  };
  switch (tag) {
    case "m:t":
      return textContentOf(node);
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
      return spaced([childText("m:num"), "/", childText("m:den")]);
    // An n-ary operator shows the character m:chr declares — ∫ when absent,
    // the OMML default — then its limits and its operand.
    case "m:nary":
      return spaced([
        mathChar(findChild(node, "m:naryPr"), "m:chr") ?? "∫",
        childText("m:sub"),
        childText("m:sup"),
        childText("m:e"),
      ]);
    // Delimiters: m:begChr, m:sepChr, m:endChr, by default ( | ).
    case "m:d": {
      const dPr = findChild(node, "m:dPr");
      const elements = childNodesOf(node)
        .filter((childNode) => qualifiedNameOf(childNode) === "m:e")
        .map(mathText);
      return (
        (mathChar(dPr, "m:begChr") ?? "(") +
        elements.join(mathChar(dPr, "m:sepChr") ?? "|") +
        (mathChar(dPr, "m:endChr") ?? ")")
      );
    }
    // Any other structure (sub/superscript, radical, function…): its parts
    // in file order, separated by a space.
    default:
      return spaced(childNodesOf(node).map(mathText));
  }
};

/** The text of one maths run: its `m:t` pieces, reached through any number of transparent wrappers — a tracked INSERTION
 *  is one — and never through a deletion. */
const mathRunText = (node: XNode): string =>
  childNodesOf(node)
    .map((childNode) => {
      const tag = qualifiedNameOf(childNode);
      if (tag === "m:t") return textContentOf(childNode);
      if (tag === "w:del" || tag === "w:moveFrom") return "";
      return tag === undefined ? "" : mathRunText(childNode);
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
 * Word renders (`markup-compat.ts#renderedBranch`) — the first `mc:Choice`
 * whose `Requires` names only namespaces Word understands, else the
 * `mc:Fallback`. A Choice Word understands but this reader cannot read gives
 * way to its Fallback only if image-only (`unreadChoiceFallback`, 02/10/2026:
 * a shorter list of understood prefixes used to send such a Choice to the
 * Fallback). Google's text box is covered by the rule itself: its Choice is
 * read, so its Fallback, a 1×1 pixel, is not.
 */
export const chosenContent = (alternate: XNode): XNode | undefined => renderedBranch(alternate, WORD_UNDERSTOOD);

/** The Fallback to read when the Choice `chosenContent` gave this reader
 *  yielded NOTHING: only an image-only one (02/10/2026 — the picture of the
 *  object Word draws, e.g. an extended chart). A Fallback
 *  carrying text is never read; the caller asks only after an empty Choice,
 *  so the two branches never come out together. */
export const unreadChoiceFallback = (
  alternate: XNode,
  chosen: XNode,
  isPixel?: (relId: string) => boolean,
): XNode | undefined => imageOnlyFallback(alternate, chosen, WORD_TEXT_TAGS, isPixel);

/** The ids of the pictures any `mc:Fallback` under this node names: the ones
 *  `docx-reader/index.ts` measures ahead (a 1×1 pixel is junk, not content). */
export const fallbackPictureRelIds = (node: XNode): string[] =>
  childNodesOf(node).flatMap((childNode) =>
    qualifiedNameOf(childNode) === "mc:Fallback" ? fallbackPictureIds(childNode) : fallbackPictureRelIds(childNode),
  );

/** A page's size, in EMU. */
export interface PageSize {
  readonly widthEmu: number;
  readonly heightEmu: number;
}

/** EMU per twentieth of a point: 12 700 / 20. */
const EMU_PER_TWIP = 635;

/** The LARGEST page of the document: the widest and the tallest `w:pgSz` of
 *  its sections, in twips — a box outside the largest page is outside every
 *  page. `undefined` when a section declares no readable size (no default
 *  page is guessed) or there is none. */
export const largestPage = (body: XNode): PageSize | undefined => {
  let width = 0;
  let height = 0;
  let sectionCount = 0;
  let unreadable = false;
  const walk = (node: XNode): void => {
    for (const childNode of childNodesOf(node)) {
      const tag = qualifiedNameOf(childNode);
      if (tag === undefined || tag === "#text") continue;
      if (tag === "w:sectPr") {
        sectionCount++;
        const pgSz = findChild(childNode, "w:pgSz");
        const declaredWidth = pgSz ? finiteNumber(attributeOf(pgSz, "w:w")) : undefined;
        const declaredHeight = pgSz ? finiteNumber(attributeOf(pgSz, "w:h")) : undefined;
        if (declaredWidth === undefined || declaredHeight === undefined || declaredWidth <= 0 || declaredHeight <= 0)
          unreadable = true;
        else {
          width = Math.max(width, declaredWidth);
          height = Math.max(height, declaredHeight);
        }
        continue;
      }
      walk(childNode);
    }
  };
  walk(body);
  return sectionCount === 0 || unreadable
    ? undefined
    : { widthEmu: width * EMU_PER_TWIP, heightEmu: height * EMU_PER_TWIP };
};

const isRotated = (node: XNode): boolean =>
  hasMatchingNode(node, (descendant) => {
    if (qualifiedNameOf(descendant) !== "a:xfrm") return false;
    const rot = attributeOf(descendant, "rot");
    return rot !== undefined && rot !== "0";
  });

/** Whether a drawing is hidden: `wp:docPr hidden` true ("1" or "true", any case). Decision of 08/10/2026: hidden
 *  content is not published, neither its picture nor its words. "0", "false" and an absent attribute are visible. */
export const isHiddenDrawing = (drawing: XNode): boolean => {
  const frame = findDrawingFrame(drawing);
  const docPr = frame ? findChild(frame, "wp:docPr") : undefined;
  return isHiddenFlag(docPr ? attributeOf(docPr, "hidden") : undefined);
};

/** Whether a floating drawing lies ENTIRELY outside the page, so that Word
 *  does not display it (02/10/2026). Decided only on what is declared: an
 *  anchor `wp:positionH`/`wp:positionV` `relativeFrom="page"` with a
 *  `wp:posOffset` (or `wp:simplePos`, page coordinates), plus its
 *  `wp:extent`. One axis wholly outside is enough; a box PARTLY on the page is
 *  displayed. Limit: anything else — another frame (margin, column,
 *  paragraph…), an alignment instead of an offset, a rotated shape, an unknown
 *  page, an inline drawing — is kept unjudged: only what is
 *  PROVABLY off the page is dropped. */
export const isOffPage = (drawing: XNode, page: PageSize | undefined): boolean => {
  const frame = findChild(drawing, "wp:anchor");
  if (!frame || !page || isRotated(frame)) return false;
  const extent = findChild(frame, "wp:extent");
  const cx = extent ? finiteNumber(attributeOf(extent, "cx")) : undefined;
  const cy = extent ? finiteNumber(attributeOf(extent, "cy")) : undefined;
  if (cx === undefined || cy === undefined) return false;
  const outside = (start: number | undefined, size: number, limit: number): boolean =>
    start !== undefined && isWhollyOutside(start, size, limit);
  if (isOnOff(attributeOf(frame, "simplePos"), false)) {
    const simplePos = findChild(frame, "wp:simplePos");
    return (
      outside(simplePos ? finiteNumber(attributeOf(simplePos, "x")) : undefined, cx, page.widthEmu) ||
      outside(simplePos ? finiteNumber(attributeOf(simplePos, "y")) : undefined, cy, page.heightEmu)
    );
  }
  const offsetOnPage = (tag: string): number | undefined => {
    const positionElement = findChild(frame, tag);
    if (!positionElement || attributeOf(positionElement, "relativeFrom") !== "page") return undefined;
    const posOffset = findChild(positionElement, "wp:posOffset");
    return posOffset ? finiteNumber(textContentOf(posOffset).trim()) : undefined;
  };
  return (
    outside(offsetOnPage("wp:positionH"), cx, page.widthEmu) ||
    outside(offsetOnPage("wp:positionV"), cy, page.heightEmu)
  );
};
