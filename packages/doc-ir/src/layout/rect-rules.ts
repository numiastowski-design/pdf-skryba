/**
 * The containment rule "A contains B" for rectangles, with its variants (edge treatment, degenerate-input handling,
 * box or centre measure), and the table of which module uses which variant. The raw* constructors map each module's
 * box shape onto Rect without ever reordering coordinates.
 *
 * NOT here: distances, unions, the PDF "line against interval" questions, the choice of coordinate frame (the caller's).
 *
 * Called by: layout/diagram-graph.ts ("diagram-frame"), extractor/slide-svg.ts ("text-in-shape"), layout/slide-elements.ts
 * ("centre-in-box"), layout/intersection-cells.ts ("cell-encloses"), extractor/pdf-page-tables.ts ("grid-claim"),
 * rect-rules.test.ts, rect.equivalence.test.ts.
 */

import type { Rect } from "./rect";

/** "raw" compares the coordinates as given; "normalize" reorders each axis first. */
export type Degenerate = "raw" | "normalize";

/** How the borders of a box-contained inner are judged against the outer. */
type ContainEdges = "inclusive" | "smaller-on-one-axis" | "not-identical";

export type RectRule =
  | { readonly measure: "box"; readonly edges: ContainEdges; readonly degenerate: Degenerate }
  | { readonly measure: "centre"; readonly edges: "inclusive"; readonly degenerate: Degenerate };

export interface PointRule {
  readonly measure: "point";
  readonly edges: "inclusive";
  readonly degenerate: Degenerate;
}

export const RECT_RULES = {
  "diagram-frame": { measure: "box", edges: "smaller-on-one-axis", degenerate: "raw" },
  "text-in-shape": { measure: "box", edges: "inclusive", degenerate: "raw" },
  "cell-encloses": { measure: "box", edges: "not-identical", degenerate: "raw" },
  "centre-in-box": { measure: "centre", edges: "inclusive", degenerate: "raw" },
  "grid-claim": { measure: "point", edges: "inclusive", degenerate: "raw" },
} as const satisfies Record<string, RectRule | PointRule>;

/** Low corner (x, y) plus extents cx, cy; a negative extent stays inverted. */
export function rawFromBox(b: { x: number; y: number; cx: number; cy: number }): Rect {
  return { x0: b.x, y0: b.y, x1: b.x + b.cx, y1: b.y + b.cy };
}

export function rawFromXywh(b: { x: number; y: number; w: number; h: number }): Rect {
  return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
}

export function rawFromEdges(b: { left: number; right: number; bottom: number; top: number }): Rect {
  return { x0: b.left, y0: b.bottom, x1: b.right, y1: b.top };
}

export function rawFromMinMax(b: { xMin: number; xMax: number; yMin: number; yMax: number }): Rect {
  return { x0: b.xMin, y0: b.yMin, x1: b.xMax, y1: b.yMax };
}

export function rawFromCell(c: { xLeft: number; xRight: number; yBottom: number; yTop: number }): Rect {
  return { x0: c.xLeft, y0: c.yBottom, x1: c.xRight, y1: c.yTop };
}

/** Whether `rule` holds for `inner` against `outer`. Allocation-free. */
export function holdsRect(rule: RectRule, outer: Rect, inner: Rect): boolean {
  const norm = rule.degenerate === "normalize";
  const ox0 = norm ? Math.min(outer.x0, outer.x1) : outer.x0;
  const ox1 = norm ? Math.max(outer.x0, outer.x1) : outer.x1;
  const oy0 = norm ? Math.min(outer.y0, outer.y1) : outer.y0;
  const oy1 = norm ? Math.max(outer.y0, outer.y1) : outer.y1;
  const ix0 = norm ? Math.min(inner.x0, inner.x1) : inner.x0;
  const ix1 = norm ? Math.max(inner.x0, inner.x1) : inner.x1;
  const iy0 = norm ? Math.min(inner.y0, inner.y1) : inner.y0;
  const iy1 = norm ? Math.max(inner.y0, inner.y1) : inner.y1;

  if (rule.measure === "centre") {
    // Scale x2 so a half-integer centre needs no division.
    const cx2 = ix0 + ix1;
    const cy2 = iy0 + iy1;
    return cx2 >= 2 * ox0 && cx2 <= 2 * ox1 && cy2 >= 2 * oy0 && cy2 <= 2 * oy1;
  }

  const contained = ix0 >= ox0 && ix1 <= ox1 && iy0 >= oy0 && iy1 <= oy1;
  if (!contained) return false;
  switch (rule.edges) {
    case "inclusive":
      return true;
    case "smaller-on-one-axis":
      return ix1 - ix0 < ox1 - ox0 || iy1 - iy0 < oy1 - oy0;
    case "not-identical":
      return ix0 !== ox0 || ix1 !== ox1 || iy0 !== oy0 || iy1 !== oy1;
  }
}

/** Whether the point lies in `rect`, borders included. Allocation-free. */
export function holdsPoint(rule: PointRule, rect: Rect, x: number, y: number): boolean {
  const norm = rule.degenerate === "normalize";
  const x0 = norm ? Math.min(rect.x0, rect.x1) : rect.x0;
  const x1 = norm ? Math.max(rect.x0, rect.x1) : rect.x1;
  const y0 = norm ? Math.min(rect.y0, rect.y1) : rect.y0;
  const y1 = norm ? Math.max(rect.y0, rect.y1) : rect.y1;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
