/** The placeholder (`p:ph`) a `p:sp` declares: its type and index, read
 *  one way for both consumers — a slide's shapes and the layout's and
 *  master's placeholders alike. Its own module since the recensement of
 *  28/09/2026: living in `shapes.ts` closed the shapes↔text-color import
 *  cycle.
 *  NOT here: what a placeholder MEANS — a title (`pptx-reader/index.ts`),
 *  an inherited colour (`pptx-reader/text-color.ts`).
 *  Called by: `pptx-reader/shapes.ts`, `pptx-reader/text-color.ts`. */

import { attributeOf, findChild, type XNode } from "../ooxml/xml";

export interface PptxPlaceholder {
  type?: string;
  idx?: string;
}

export const placeholderOf = (sp: XNode): PptxPlaceholder | undefined => {
  const ph = findChild(findChild(findChild(sp, "p:nvSpPr") ?? {}, "p:nvPr") ?? {}, "p:ph");
  if (!ph) return undefined;
  const type = attributeOf(ph, "type");
  const idx = attributeOf(ph, "idx");
  return { ...(type === undefined ? {} : { type }), ...(idx === undefined ? {} : { idx }) };
};
