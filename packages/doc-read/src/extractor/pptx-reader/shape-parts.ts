/** The reading of a DrawingML shape that PowerPoint (`p:sp`/`p:cxnSp`) and
 *  Word (`wps:wsp`) share: both write the same `a:xfrm`, `a:prstGeom` and
 *  `a:ln`. One definition here, imported by `pptx-reader/shapes.ts` and
 *  `docx-reader/shapes.ts`, so the two readers cannot drift apart (a copy in
 *  the Word reader once never set `groupTurned`).
 *  NOT here: what differs between the two — the fill (`fillOf`: PowerPoint
 *  also reads `p:style/a:fillRef`, Word does not, on purpose), the element
 *  names, the text, and how a connector's line is told visible.
 *  Called by: `pptx-reader/shapes.ts`, `docx-reader/shapes.ts`,
 *  `pptx-diagram-order.ts`. */

import { ARROW_GEOMETRIES } from "doc-ir/layout/slide-layout";
import { attributeOf, findChild, findChildren, type XNode } from "../ooxml/xml";
import { bentPath, type Frame, lineEnds, turnsOrMirrors, type Transform, visibleBox } from "./geometry";
import type { PptxConnectorShape, PptxShape } from "./shapes";

export const presetOf = (spPr: XNode | undefined): string | undefined => attributeOf(findChild(spPr ?? {}, "a:prstGeom") ?? {}, "prst");

/** A line end draws an arrow head: `type` present and not "none". */
export const arrowAt = (ln: XNode | undefined, end: "a:headEnd" | "a:tailEnd"): boolean => {
  const type = attributeOf(findChild(ln ?? {}, end) ?? {}, "type");
  return type !== undefined && type !== "none";
};

/** The guides of the preset's `a:avLst` written `val N`, by name. A guide
 *  written as another formula is left out (its preset default applies). */
export const guidesOf = (spPr: XNode | undefined): Record<string, number> => {
  const avLst = findChild(findChild(spPr ?? {}, "a:prstGeom") ?? {}, "a:avLst");
  const guides: Record<string, number> = {};
  for (const gd of findChildren(avLst ?? {}, "a:gd")) {
    const name = attributeOf(gd, "name");
    const m = /^val (-?\d+)$/.exec(attributeOf(gd, "fmla") ?? "");
    if (name !== undefined && m) guides[name] = Number(m[1]);
  }
  return guides;
};

/** What every shape carries: its place in the tree, its box on the page
 *  (groups applied) and its own turn and flips. */
export const shapeBase = (spTreeIndex: number, frame: Frame | undefined, transform: Transform) => ({
  spTreeIndex,
  ...(frame === undefined ? {} : { box: visibleBox(frame, transform) }),
  ...(frame === undefined || frame.rot === 0 ? {} : { rot: frame.rot }),
  ...(frame?.flipH === true ? { flipH: true as const } : {}),
  ...(frame?.flipV === true ? { flipV: true as const } : {}),
});

/** A text shape inside a group that turns or mirrors it: its own box is not
 *  a faithful frame for the words (set on text shapes only). */
export const groupTurnedOf = (transform: Transform): { groupTurned?: true } => (turnsOrMirrors(transform) ? { groupTurned: true as const } : {});

/** A connector's own fields: arrow heads, geometry, line ends and the bent
 *  path. Whether its line shows (`visibleLine`) is the caller's rule. */
export const connectorBody = (
  spPr: XNode | undefined,
  frame: Frame | undefined,
  transform: Transform,
  visibleLine: boolean,
): Pick<PptxConnectorShape, "startArrow" | "endArrow" | "geometry" | "visibleLine" | "ends" | "path"> => {
  const ln = findChild(spPr ?? {}, "a:ln");
  const geometry = presetOf(spPr);
  const path = frame === undefined || geometry === undefined ? undefined : bentPath(frame, transform, geometry, guidesOf(spPr));
  return {
    startArrow: arrowAt(ln, "a:headEnd"),
    endArrow: arrowAt(ln, "a:tailEnd"),
    ...(geometry === undefined ? {} : { geometry }),
    visibleLine,
    ...(frame === undefined ? {} : { ends: lineEnds(frame, transform) }),
    ...(path === undefined ? {} : { path }),
  };
};

/** A text box that is never the label of a connector: turned (its own turn
 *  or its group's), or a block arrow carrying its own text. */
export const isNotLabel = (turned: boolean, geometry: string | undefined): boolean =>
  turned || (geometry !== undefined && ARROW_GEOMETRIES.has(geometry));

/** `isNotLabel` of a shape the pptx reader read. */
export const shapeIsNotLabel = (s: PptxShape): boolean =>
  s.rot !== undefined || (s.kind === "text" && isNotLabel(s.groupTurned === true, s.geometry));
