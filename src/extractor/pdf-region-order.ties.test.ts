/**
 * Characterisation (12/10/2026) of « the text fragment nearest to a blank », in both places `pdf-region-order.ts` asks it:
 * the centre a blank is ordered by, and the piece of a gutter-split line a blank follows. On a tie (equal distance on
 * both sides) the blank follows the LEFTMOST fragment.
 */
import { describe, expect, it } from "vitest";
import type { IRBlock } from "doc-ir";
import type { PageRegion } from "./pdf-model";
import { interleaveRegions } from "./pdf-region-order";

const image = (id: string): IRBlock => ({ kind: "image", ref: { sha256: id, mimeType: "image/png" } });
const frag = (text: string, x: number, width: number, y: number, height = 10) =>
  ({ text, x, y, width, height }) as never;
const para = (items: { text: string }[]): IRBlock[] =>
  items.map((i) => ({ kind: "paragraph", inlines: [{ text: i.text }] }));
const labels = (blocks: IRBlock[]): string[] =>
  blocks.map((b) =>
    b.kind === "paragraph" ? b.inlines[0]!.text : b.kind === "image" ? `image:${b.ref.sha256}` : b.kind,
  );

describe("a blank equidistant from two text fragments follows the leftmost", () => {
  it("in the piece of a line cut at a gutter", () => {
    const boxed = (id: string, xMin: number, xMax: number, top: number, bottom: number): PageRegion => ({
      top,
      bottom: top,
      xMin,
      blocks: [image(id)],
      consumesBand: false,
      orderAt: (top + bottom) / 2,
      box: { top, bottom, xMin, xMax },
    });
    const band = [boxed("L", 100, 300, 400, 200), boxed("R", 350, 500, 420, 180)];
    // "left" ends at 240, "right" starts at 400; the blank spans 319-321: 79 away on each side.
    const items = [frag("left", 200, 40, 380), frag(" ", 319, 2, 380, 0), frag("right", 400, 40, 380)];
    expect(labels(interleaveRegions(items, band, para))).toEqual(["left", " ", "image:L", "right", "image:R"]);
  });

  it("in the centre a blank is ordered by", () => {
    // The baselines are within 1 pt but the heights differ: the left word's centre (300) lies above the image's median
    // (280), the right word's (260.4) below it. The blank, at 250 with no height, takes the left centre.
    const region: PageRegion = {
      top: 400,
      bottom: 100,
      xMin: 0,
      blocks: [image("I")],
      consumesBand: false,
      orderAt: 280,
    };
    const items = [frag("left", 100, 40, 250, 100), frag(" ", 169, 2, 250, 0), frag("right", 200, 40, 250.4, 20)];
    expect(labels(interleaveRegions(items, [region], para))).toEqual(["left", " ", "image:I", "right"]);
  });
});
