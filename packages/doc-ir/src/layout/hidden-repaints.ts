/** Invisible repaints: a filled rectangle ENTIRELY CONTAINED (within a tolerance on each edge) in a STRICTLY larger filled rectangle
 *  of the SAME colour changes no pixel, so its edges are not row boundaries. Word repaints a cell background in one band per
 *  text line; the band edges would otherwise vote and cut a wrapped word. Strictly larger means a greater area: two identical
 *  fills abstain (neither is hidden), and a different colour is a real, visible background.
 *  A repaint also SPANS its container's width: the container is at most 2 x `maxInsetPt` wider (left plus right insets, so a band
 *  touching one side still counts). A same-colour nested cell shading far narrower than its frame stays visible: its edges are
 *  the only row structure of the form (06-homes p8).
 *  PAINTING ORDER: the list order is the painting order. The inner fill is hidden only when no fill of ANOTHER colour, painted
 *  BETWEEN the two, overlaps it (that fill would sit on top of the container and under the band: the band would be visible).
 *  The 27/10/2026 diagnosis verified 0 intervening different-colour fill on every hidden fill of the corpus; this guard carries
 *  that very criterion. A fill of another colour painted after both covers the band and changes nothing.
 *  WRITTEN LIMIT (review of 27/10/2026): the between-guard is symmetric in paint order, so a band painted FIRST, overlapped
 *  by another colour, then covered whole by its same-colour container, is kept visible although nothing of it shows — the
 *  conservative side (a kept edge is the pre-rule behaviour); no such order exists in the measured corpus (containers paint first).
 *  WRITTEN LIMIT: containment is tested on axis-aligned boxes, and the caller matches horizontals by exact y1 === y2 as `recordPath`
 *  emits them; rotated or skewed fills are unmeasured (none in the 32-PDF corpus). There the rule silently does nothing, which is
 *  the behaviour from before the rule.
 *  A repaint also covers most of its container: inner width / container width must reach `minWidthRatio`, or the tick mark of a
 *  small round swatch (071 p7: 3.4 pt in 13.7, ratio 0.25) would pass the absolute inset test.
 *  NOT here: the three call bounds (`REPAINT_CONTAINMENT_LIMIT_PT`, `REPAINT_MAX_INSET_PT`, `REPAINT_WIDTH_RATIO_LIMIT`) live with their
 *  caller in `extractor/pdf-table-detector.ts`, with their populations; the two COST caps (`HIDDEN_REPAINT_GROUP_LIMIT`,
 *  `HIDDEN_REPAINT_PAGE_LIMIT`) live HERE, their fiches in `core/bounds.ts`. Nor the removal of the edges (the caller drops the segments of the fills this returns).
 *  Called by: `extractor/pdf-table-detector.ts`. */

/** A painted rectangle with its colour ("#rrggbb"). The detector's filled rectangle extends it. */
export interface PaintedBox {
  color: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

const areaOf = (box: PaintedBox): number => (box.xMax - box.xMin) * (box.yMax - box.yMin);

/** Cost cap per same-colour group (starting value to calibrate): the quadratic scan is skipped for a group past this size.
 *  Populations, 27/10/2026: real Word repaint bands measured at most ~134 fills of one colour on one page (06-homes p8);
 *  the risk population is a vector-heavy page (map, chart) with thousands of same-colour fills, none a repaint. */
export const HIDDEN_REPAINT_GROUP_LIMIT = 512;

/** Page-level companion of the group cap (review of 27/10/2026): `coveredBetween` scans the WHOLE paint list between two
 *  indices, so a page with few same-colour fills among tens of thousands of mixed fills would still blow up. Past this
 *  total, the page is skipped whole — the behaviour from before the rule. Word pages measured: a few hundred fills. */
export const HIDDEN_REPAINT_PAGE_LIMIT = 4096;

const overlaps = (a: PaintedBox, b: PaintedBox): boolean =>
  Math.min(a.xMax, b.xMax) > Math.max(a.xMin, b.xMin) && Math.min(a.yMax, b.yMax) > Math.max(a.yMin, b.yMin);

/** Smallest index of `sorted` (ascending) strictly greater than `value`, or `sorted.length`. */
const firstAbove = (sorted: readonly number[], value: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

/** The fills of `fills` that hide under another: contained in a strictly larger fill of the same colour within `tolerancePt`
 *  on every edge and at most `2 * maxInsetPt` narrower and at least `minWidthRatio` as wide, with no fill of another colour painted between the two that overlaps it.
 *  The container itself is never in the result. Pure. Works on INDICES (the paint order is the index in `fills`; no identity map, so a
 *  Indices are the paint order (the former identity Map could be corrupted by a repeated reference; the RESULT is still a
 *  set of boxes, so a caller passing one object at two paint positions gets one shared verdict — walkPage never does).
 *  against the strictly larger ones before it.
 *  COST (review n. 2, 27/10/2026): the order guard is built per INNER candidate, once and lazily: the ascending list of the paint
 *  indices of the other-colour fills that overlap it, then a binary search per candidate container ("is one strictly between the two
 *  indices"). O(group x page + pairs x log) instead of O(pairs x page): the review measured about 10^9 operations still possible under
 *  the caps (nested containers plus intervening fills that defeat the early exit), past the 25 s of a Forge invocation. */
export function hiddenRepaintFills(
  fills: readonly PaintedBox[],
  tolerancePt: number,
  maxInsetPt: number,
  minWidthRatio: number,
): Set<PaintedBox> {
  if (fills.length > HIDDEN_REPAINT_PAGE_LIMIT) return new Set<PaintedBox>();
  const hidden = new Set<PaintedBox>();
  const byColor = new Map<string, number[]>();
  fills.forEach((fill, index) => {
    const group = byColor.get(fill.color);
    if (group === undefined) byColor.set(fill.color, [index]);
    else group.push(index);
  });
  /** Ascending paint indices of the fills of another colour that overlap `fills[innerAt]`. */
  const coverersOf = (innerAt: number): number[] => {
    const inner = fills[innerAt]!;
    const out: number[] = [];
    fills.forEach((other, k) => {
      if (other.color !== inner.color && overlaps(other, inner)) out.push(k);
    });
    return out;
  };
  for (const group of byColor.values()) {
    // Cost bound (review of 27/10/2026): a vector-heavy page (a map, a chart export) can paint tens of thousands of same-colour fills
    // that are not Word repaint bands. Past the cap the group is skipped whole, the behaviour from before the rule. Measured bands
    // per colour per page on the corpus: at most ~134.
    if (group.length > HIDDEN_REPAINT_GROUP_LIMIT) continue;
    const sorted = [...group].sort((a, b) => areaOf(fills[b]!) - areaOf(fills[a]!));
    sorted.forEach((innerAt, position) => {
      const inner = fills[innerAt]!;
      const innerArea = areaOf(inner);
      let coverers: number[] | undefined;
      for (let j = 0; j < position; j += 1) {
        const outerAt = sorted[j]!;
        const outer = fills[outerAt]!;
        if (areaOf(outer) <= innerArea) break;
        const contains =
          outer.xMax - outer.xMin - (inner.xMax - inner.xMin) <= 2 * maxInsetPt &&
          (inner.xMax - inner.xMin) / (outer.xMax - outer.xMin) >= minWidthRatio &&
          inner.xMin >= outer.xMin - tolerancePt &&
          inner.xMax <= outer.xMax + tolerancePt &&
          inner.yMin >= outer.yMin - tolerancePt &&
          inner.yMax <= outer.yMax + tolerancePt;
        if (!contains) continue;
        coverers ??= coverersOf(innerAt);
        const low = Math.min(innerAt, outerAt);
        const high = Math.max(innerAt, outerAt);
        const next = firstAbove(coverers, low);
        if (next < coverers.length && coverers[next]! < high) continue;
        hidden.add(inner);
        break;
      }
    });
  }
  return hidden;
}
