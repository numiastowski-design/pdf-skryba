/** The bullet a PLACEHOLDER's paragraph inherits when its `a:pPr` writes
 *  none (09/10/2026, as Word reads a bullet from a paragraph style):
 *  per level (`a:pPr lvl`, 0-based → `a:lvl{n+1}pPr`), the first of
 *  `buChar` / `buBlip` (bullet list), `buAutoNum` (numbered list) or `buNone`
 *  (no list) written along the chain PowerPoint reads — the shape's own
 *  `a:lstStyle`, the layout's placeholder, the master's placeholder, the
 *  master's `p:txStyles` (ECMA-376 §19.3.1.52, §21.1.2.4.2): the size's and
 *  the colour's chain (`pptx-reader/text-color.ts#placeholderStyles`), not a
 *  second walk. A title (`title`, `ctrTitle`) inherits none: its
 *  `p:titleStyle` stays a paragraph. A free shape (no `p:ph`) inherits none.
 *  NOT here: the paragraph's OWN bullet, which wins over this one (`pptx-reader/text.ts#bulletOf`), nor the placeholder
 *  matching (`pptx-reader/text-color.ts#placeholderStyles`).
 *  Called by: `pptx-reader/shapes.ts`. */

import { findChild, type XNode } from "../ooxml/xml";
import { placeholderOf } from "./placeholder";
import { bulletOf, type PptxListPlace } from "./text";
import { placeholderStyles, type TextStyleSources } from "./text-color";

export const inheritedBullet = (
  element: XNode,
  body: XNode,
  sources: TextStyleSources,
): ((level: number) => PptxListPlace | undefined) => {
  const ph = placeholderOf(element);
  if (ph === undefined || ph.type === "title" || ph.type === "ctrTitle") return () => undefined;
  const chain = [findChild(body, "a:lstStyle"), ...placeholderStyles(ph, sources)];
  return (level) => {
    for (const style of chain) {
      const found = bulletOf(findChild(style ?? {}, `a:lvl${level + 1}pPr`), level);
      if (found !== undefined) return found === "none" ? undefined : found;
    }
    return undefined;
  };
};
