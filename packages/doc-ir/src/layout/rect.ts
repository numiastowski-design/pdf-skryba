/**
 * The rectangle shape {x0, y0, x1, y1} (x0 <= x1, y0 <= y1), one constructor from a low corner plus a size, and two
 * point-to-box distances (edges belong to the rectangle).
 *
 * NOT here: containment predicates (layout/rect-rules.ts), unions, the choice of coordinate frame (y up or y down is
 * the caller's), any tolerance or epsilon (comparisons are exact; NaN propagates untreated).
 *
 * Called by: layout/diagram-graph.ts (fromBox, distanceToPoint, outlineDistance); the Rect type by rect-rules.ts.
 */

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Low corner (x, y) plus width cx and height cy; normalised so that the lower value comes first on each axis. */
export function fromBox(b: { x: number; y: number; cx: number; cy: number }): Rect {
  const xb = b.x + b.cx;
  const yb = b.y + b.cy;
  return {
    x0: Math.min(b.x, xb),
    y0: Math.min(b.y, yb),
    x1: Math.max(b.x, xb),
    y1: Math.max(b.y, yb),
  };
}

/** Euclidean distance from the point to the filled rectangle: 0 inside or on the border. */
export function distanceToPoint(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

/** Distance to the outline: like distanceToPoint outside, distance to the nearest edge inside. */
export function outlineDistance(r: Rect, x: number, y: number): number {
  const inside = x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  if (!inside) return distanceToPoint(r, x, y);
  return Math.min(x - r.x0, r.x1 - x, y - r.y0, r.y1 - y);
}
