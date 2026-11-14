/** The order of a diagram slide's text elements from the slide's connectors:
 *  feeds `layout/diagram-graph.ts#orderDiagram` with what the pptx reader
 *  read (`PptxShape` boxes and ids, `PptxConnectorShape` glue, line ends and
 *  arrow heads, all in EMU on the slide, groups and flips already applied).
 *  A text shape is a node; a table, a picture, a frame or a SmartArt is
 *  never one (it stays where today's order puts it). Every shape of the
 *  slide that has a box can be TOUCHED by a line end, text or not.
 *  NOT here: the graph rules (`layout/diagram-graph.ts`), the IR.
 *  Called by: `extractor/pptx.ts`. */

import {
  type DiagramConnector,
  type DiagramElement,
  type DiagramObstacle,
  type DiagramOrder,
  OOXML_DIAGRAM_TOLERANCES,
  orderDiagram,
} from "doc-ir/layout/diagram-graph";
import type { PptxShape } from "./pptx-reader";
import { shapeIsNotLabel } from "./pptx-reader/shape-parts";

/** `items`: the slide's diagram elements in today's flow order (what the
 *  layout kept); `slideShapes`: every shape the reader found on the slide. */
export const slideDiagramOrder = (slideShapes: readonly PptxShape[], items: readonly PptxShape[]): DiagramOrder => {
  const elements: DiagramElement[] = items.map((s) => ({
    ...(s.id === undefined ? {} : { id: s.id }),
    ...(s.box === undefined ? {} : { box: s.box }),
    node: s.kind === "text" && s.box !== undefined,
    notLabel: shapeIsNotLabel(s),
  }));
  const placed = new Set<PptxShape>(items);
  const obstacles: DiagramObstacle[] = slideShapes
    .filter((s) => s.kind !== "connector" && !placed.has(s))
    .map((s) => ({ ...(s.id === undefined ? {} : { id: s.id }), ...(s.box === undefined ? {} : { box: s.box }) }));
  const connectors: DiagramConnector[] = slideShapes.flatMap((s): DiagramConnector[] =>
    s.kind === "connector"
      ? [
          {
            ...(s.from === undefined ? {} : { from: s.from }),
            ...(s.to === undefined ? {} : { to: s.to }),
            ...(s.ends === undefined ? {} : { ends: s.ends }),
            startArrow: s.startArrow,
            endArrow: s.endArrow,
            visible: s.visibleLine,
          },
        ]
      : [],
  );
  return orderDiagram({ elements, obstacles, connectors, tolerances: OOXML_DIAGRAM_TOLERANCES });
};
