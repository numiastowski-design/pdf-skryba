/**
 * Invisible repaints (chantier tableaux PDF, tranche « repeintures invisibles », 27/10/2026).
 * Word repaints an already painted background, SAME colour, in one band per text line. A filled rectangle ENTIRELY CONTAINED in a
 * STRICTLY larger filled rectangle of the same colour changes no pixel: its edges are not row boundaries.
 * A repaint SPANS its container's width: the container is at most 2 x maxInsetPt wider (measured insets per side 2.88 to 5.4 pt;
 * a same-colour NESTED CELL SHADING is far narrower — 122 or 333 pt in a 523 pt frame, 06-homes p8 — and its edges are the only
 * row structure of the form, so it stays visible).
 * Containment tolerance under test: 0.3 pt (starting value; measured on 32 Word PDFs: real overshoot 0.12 pt, real inset of a band 2.88 pt).
 */
import { describe, expect, it } from "vitest";

import { hiddenRepaintFills, type PaintedBox } from "./hidden-repaints";

const TOLERANCE_PT = 0.3;
const MAX_INSET_PT = 8;
const MIN_WIDTH_RATIO = 0.5;
const box = (color: string, xMin: number, xMax: number, yMin: number, yMax: number): PaintedBox => ({
  color,
  xMin,
  xMax,
  yMin,
  yMax,
});
const GREY = "#d9d9d9";

describe("hiddenRepaintFills", () => {
  it("hides a band contained in a bigger fill of the same colour, and shows the container", () => {
    // FAILS WITH (today): the module does not exist (Failed to resolve import "./hidden-repaints").
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    const hidden = hiddenRepaintFills([container, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO);
    expect(hidden.has(band)).toBe(true);
    expect(hidden.has(container)).toBe(false);
    expect(hidden.size).toBe(1);
  });

  it("keeps visible a repaint with a DIFFERENT-colour fill painted between it and its container and overlapping it: the repaint changes pixels back, the eye sees its edge (paint order = list order)", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const whiteOver = box("#ffffff", 50, 500, 110, 150);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    expect(hiddenRepaintFills([container, whiteOver, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("still hides the repaint when the intervening different-colour fill does NOT overlap it", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const whiteElsewhere = box("#ffffff", 50, 500, 160, 190);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    expect(
      hiddenRepaintFills([container, whiteElsewhere, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band),
    ).toBe(true);
  });

  it("hides a band painted BEFORE its container too: the container covers it, nothing of it shows (both orders are invisible, measured 27/10)", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    expect(hiddenRepaintFills([band, container], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band)).toBe(true);
  });

  it("still hides a band when the different-colour fill comes AFTER both paints: it covers the band, which therefore still shows nothing — only a fill BETWEEN the two restores visibility", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    const whiteOnTop = box("#ffffff", 50, 500, 110, 150);
    expect(
      hiddenRepaintFills([container, band, whiteOnTop], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band),
    ).toBe(true);
  });

  it("the page cap bites at limit + 1 and not at the limit itself (off-by-one pinned)", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    const noiseTo = (total: number) =>
      Array.from({ length: total - 2 }, (_, i) => box(`#0000${((i % 90) + 10).toString()}`, 600 + i, 602 + i, 0, 2));
    expect(
      hiddenRepaintFills([container, band, ...noiseTo(4096)], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band),
    ).toBe(true);
    expect(
      hiddenRepaintFills([container, band, ...noiseTo(4097)], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size,
    ).toBe(0);
  });

  it("hides NOTHING on a page whose TOTAL fills pass the page cap, even when a small same-colour group holds a genuine repaint", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 52.88, 497.12, 120, 140);
    const noise = Array.from({ length: 4200 }, (_, i) => box(`#0000${((i % 90) + 10).toString()}`, i, i + 2, 0, 2));
    expect(hiddenRepaintFills([container, band, ...noise], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("hides NOTHING in a same-colour group larger than the cost cap (a vector-heavy page is not Word repaint territory; measured bands: at most ~134 fills per colour per page)", () => {
    // 600 bands inside one container, all genuine repaints by geometry: past the cap the group is skipped whole.
    const container = box(GREY, 0, 500, 0, 12000);
    const bands = Array.from({ length: 600 }, (_, i) => box(GREY, 2.9, 497.1, i * 20, i * 20 + 14));
    expect(hiddenRepaintFills([container, ...bands], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("keeps visible a tiny same-colour mark in a SWATCH cell (071 p7: a 3.4 pt paragraph mark in a 13.7 pt swatch, ratio 0.25 — real repaints sit at 0.83 or more)", () => {
    const swatch = box("#f7fcf5", 101.1, 114.8, 391.3, 405.5);
    const mark = box("#f7fcf5", 101.1, 104.5, 393.5, 403.8);
    expect(hiddenRepaintFills([swatch, mark], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("keeps visible a same-colour NESTED CELL SHADING far narrower than its container (06-homes p8: 122 pt label cell in a 523 pt frame)", () => {
    const frame = box("#dae8f8", 50, 573.4, 100, 632);
    const labelCell = box("#dae8f8", 55, 177.2, 500, 524.7);
    const hidden = hiddenRepaintFills([frame, labelCell], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO);
    expect(hidden.has(labelCell)).toBe(false);
    expect(hidden.size).toBe(0);
  });

  it("hides a repaint inset up to maxInsetPt per side (01-osfi p1: a 79 pt band in an 89.3 pt container, 5.15 pt per side)", () => {
    const container = box("#156082", 100, 189.3, 100, 113.4);
    const band = box("#156082", 105.15, 184.15, 100, 113.4);
    expect(hiddenRepaintFills([container, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band)).toBe(true);
  });

  it("hides a band that overshoots its container by 0.12 pt (the measured real overshoot): the tolerance contains it", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 49.88, 500.12, 120, 140);
    expect(hiddenRepaintFills([container, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(band)).toBe(true);
    // Full width like every measured repaint (insets <= 5.4 pt): this case exercises the y-overshoot tolerance alone.
    const bandOverTop = box(GREY, 52.88, 497.12, 99.88, 120);
    expect(
      hiddenRepaintFills([container, bandOverTop], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).has(bandOverTop),
    ).toBe(true);
  });

  it("keeps visible a band that overshoots by more than the tolerance (0.5 pt)", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const band = box(GREY, 49.5, 500.5, 120, 140);
    expect(hiddenRepaintFills([container, band], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("keeps visible a contained fill of a DIFFERENT colour (a real, visible cell background)", () => {
    const container = box(GREY, 50, 500, 100, 200);
    const inner = box("#ff0000", 60, 200, 120, 140);
    expect(hiddenRepaintFills([container, inner], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("keeps visible a same-colour fill of the SAME size as the other (not STRICTLY larger)", () => {
    const a = box(GREY, 50, 500, 100, 200);
    const sameSize = box(GREY, 50, 500, 100, 200);
    expect(hiddenRepaintFills([a, sameSize], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("never hides the container itself, and one container hides all its bands", () => {
    const container = box(GREY, 50, 500, 100, 400);
    const bands = [120, 140, 160, 180].map((y) => box(GREY, 50.1, 499.9, y, y + 15));
    const hidden = hiddenRepaintFills([container, ...bands], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO);
    expect(hidden.has(container)).toBe(false);
    expect(bands.every((b) => hidden.has(b))).toBe(true);
    expect(hidden.size).toBe(4);
  });

  it("two IDENTICAL overlapping fills: ABSTAIN, both stay visible (neither is strictly larger; hiding either would be a guess)", () => {
    const first = box(GREY, 50, 500, 100, 200);
    const second = box(GREY, 50, 500, 100, 200);
    const hidden = hiddenRepaintFills([first, second], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO);
    expect(hidden.has(first)).toBe(false);
    expect(hidden.has(second)).toBe(false);
  });

  it("keeps visible two fills of the same colour that merely overlap or touch (neither contains the other)", () => {
    const left = box(GREY, 50, 300, 100, 200);
    const right = box(GREY, 250, 500, 100, 200);
    const below = box(GREY, 50, 300, 200, 300);
    expect(hiddenRepaintFills([left, right, below], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });

  it("returns an empty set for an empty list and for a single fill", () => {
    expect(hiddenRepaintFills([], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
    expect(hiddenRepaintFills([box(GREY, 0, 10, 0, 10)], TOLERANCE_PT, MAX_INSET_PT, MIN_WIDTH_RATIO).size).toBe(0);
  });
});
