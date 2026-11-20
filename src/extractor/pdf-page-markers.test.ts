/**
 * Characterisation (12/10/2026) of `pageMarkers#markerBefore`: a character-sized picture is placed in front of the FIRST
 * text item to its right whose vertical middle (`y + fontSize / 2`) lies inside the picture's span; nothing else.
 */
import { describe, expect, it } from "vitest";
import { createImageStore } from "./pdf-image-store";
import { pageMarkers } from "./pdf-page-markers";

const item = (text: string, x: number, y: number, fontSize = 10) => ({ text, x, y, width: 20, fontSize }) as never;
const badge = { png: Uint8Array.from([1, 2, 3]), xMin: 10, xMax: 20, yMin: 100, yMax: 110 } as never;

const markerOf = (target: ReturnType<typeof item>, items: ReturnType<typeof item>[], inline: unknown[] = [badge]) => {
  const store = createImageStore();
  const { markerBefore } = pageMarkers(store, { items, inlineImages: inline as never });
  return markerBefore(target)?.sha256;
};

describe("pageMarkers", () => {
  const first = item("Absent", 25, 100);
  const second = item("Present", 60, 100);

  it("places the picture before the first item to its right on its line", () => {
    expect(markerOf(first, [first, second])).toBeDefined();
    expect(markerOf(second, [first, second])).toBeUndefined();
  });

  it("judges the line by the middle of the item, not its baseline: middle 105 is inside 100-110, middle 99 is not", () => {
    const inside = item("A", 25, 100, 10);
    const below = item("B", 25, 94, 10);
    const aboveEdge = item("C", 25, 105.5, 10);
    expect(markerOf(inside, [inside])).toBeDefined();
    expect(markerOf(below, [below])).toBeUndefined();
    expect(markerOf(aboveEdge, [aboveEdge])).toBeUndefined();
  });

  it("keeps both edges of the span (middle exactly 100 and exactly 110)", () => {
    const low = item("L", 25, 95, 10);
    const high = item("H", 25, 105, 10);
    expect(markerOf(low, [low])).toBeDefined();
    expect(markerOf(high, [high])).toBeDefined();
  });

  it("does not place it before an item left of the picture, a blank item, or when there is no picture", () => {
    expect(markerOf(item("L", 5, 100), [item("L", 5, 100)])).toBeUndefined();
    expect(markerOf(item(" ", 25, 100), [item(" ", 25, 100)])).toBeUndefined();
    expect(markerOf(first, [first], [])).toBeUndefined();
  });

  it("skips an item when a nearer text item lies between the picture and it, on the same line", () => {
    const near = item("Near", 22, 100);
    const far = item("Far", 60, 100);
    expect(markerOf(far, [near, far])).toBeUndefined();
    const offLine = item("Off", 22, 200);
    expect(markerOf(far, [offLine, far])).toBeDefined();
  });
});
