/** The size a PLACEHOLDER's run inherits when its `a:rPr` writes no `sz`,
 *  for the slide drawing only (Mikolaj, 29/09/2026 — lifts the limit of
 *  MIKSUDOC « Spécification fonctionnelle » §9.3.7): per paragraph level (`a:pPr lvl`, 0-based →
 *  `a:lvl{n+1}pPr/a:defRPr sz`), the first size written along the chain
 *  PowerPoint reads — the shape's own `a:lstStyle`, then the layout's
 *  placeholder (by `idx`, else by `type`), the master's placeholder of that
 *  type, and the master's `p:txStyles` — the colour's chain, step 2
 *  (`pptx-reader/text-color.ts#placeholderStyles`), not a second copy. The
 *  SIZE only: a placeholder's position is never inherited here (a shape
 *  without its own frame stays "no-box" in the drawing).
 *  A free shape (no `p:ph`) gets nothing here: the drawing reads
 *  `p:defaultTextStyle` for it, as before.
 *  NOT here: the run's own size (`pptx-reader/text.ts#sizeOf`), shrinking by
 *  `a:normAutofit fontScale` (applied by the drawing to every size,
 *  `extractor/slide-svg.ts`).
 *  Called by: `pptx-reader/shapes.ts`. */

import { child, type XNode } from "../ooxml/xml";
import { placeholderOf } from "./placeholder";
import { sizeOf } from "./text";
import { placeholderStyles, type TextStyleSources } from "./text-color";

/** For one text shape (`p:sp` and its `p:txBody`) and the paragraph levels
 *  it uses: the size, in points, a run writing none inherits at each level
 *  where the chain writes one; `undefined` for a free shape, or when no
 *  level finds a size. */
export const inheritedTextSizes = (
  element: XNode,
  body: XNode,
  levels: readonly number[],
  sources: TextStyleSources,
): Readonly<Record<number, number>> | undefined => {
  const ph = placeholderOf(element);
  if (ph === undefined) return undefined;
  const chain = [child(body, "a:lstStyle"), ...placeholderStyles(ph, sources)];
  const sizes: Record<number, number> = {};
  for (const level of new Set(levels)) {
    for (const style of chain) {
      const size = sizeOf(child(child(style ?? {}, `a:lvl${level + 1}pPr`) ?? {}, "a:defRPr"));
      if (size !== undefined) {
        sizes[level] = size;
        break;
      }
    }
  }
  return Object.keys(sizes).length > 0 ? sizes : undefined;
};
