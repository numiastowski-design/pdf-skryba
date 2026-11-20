/**
 * A line is never dropped by the order of a band of several images (16/10/2026, safedocs 0000154 page 1 in tab mode: eight letterhead pictures in
 * one band, nine text lines gone). A line owned by a region whose median is HIGHER than another region's, and lying between the two medians, was
 * published neither before its image (its centre is below that frontier) nor after it (below its median), and the cursor of the band, set on the
 * LOWEST median, had already passed it: nothing downstream published it.
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
/** An image region as `pdf-image-anchors.ts#imageRegion` makes it: its `bottom` IS its `top` (an image consumes no band), the real extent is the `box`. */
const boxed = (id: string, xMin: number, xMax: number, top: number, bottom: number): PageRegion => ({
  top,
  bottom: top,
  xMin,
  blocks: [image(id)],
  consumesBand: false,
  orderAt: (top + bottom) / 2,
  box: { top, bottom, xMin, xMax },
});

describe("three images and a table band", () => {
  const table: PageRegion = {
    top: 400,
    bottom: 300,
    xMin: 0,
    blocks: [{ kind: "paragraph", inlines: [{ text: "TABLE" }] }],
    consumesBand: true,
  };

  it("every line goes out once, but the one the table swallows; the leftover step duplicates none", () => {
    const band = [boxed("L", 100, 300, 600, 490), boxed("M", 320, 340, 650, 500), boxed("R", 350, 500, 700, 580)];
    const items = [
      frag("high", 400, 40, 680),
      frag("between", 400, 40, 595),
      frag("mid", 322, 10, 520),
      frag("gap", 400, 40, 450),
      frag("swallowed", 50, 40, 350),
      frag("under", 50, 40, 100),
    ];
    const out = labels(interleaveRegions(items, [...band, table], para));
    for (const word of ["high", "between", "mid", "gap", "under"])
      expect(
        out.filter((l) => l === word),
        word,
      ).toHaveLength(1);
    expect(out).not.toContain("swallowed");
    expect(out.filter((l) => l === "TABLE")).toHaveLength(1);
    expect(out.filter((l) => l.startsWith("image:"))).toHaveLength(3);
  });
});

describe("a band of several images", () => {
  it("publishes a line that lies between the medians of two images, whichever image owns it", () => {
    // L: top 600, bottom 490, median 545. R: top 700, bottom 580, median 640. Their vertical extents cross (580 < 600): one band.
    const band = [boxed("L", 100, 300, 600, 490), boxed("R", 350, 500, 700, 580)];
    // The line sits on R (x 400), centre 600: below R's median (640), above L's (545). Failure value: it is missing from the output.
    const items = [frag("between", 400, 40, 595)];
    const out = labels(interleaveRegions(items, band, para));
    expect(out).toContain("between");
    expect(out.filter((l) => l === "between")).toHaveLength(1);
    expect(out).toContain("image:L");
    expect(out).toContain("image:R");
  });

  it("publishes each line once: a line before, after or between", () => {
    const band = [boxed("L", 100, 300, 600, 490), boxed("R", 350, 500, 700, 580)];
    const items = [
      frag("high", 400, 40, 680),
      frag("between", 400, 40, 595),
      frag("low", 400, 40, 500),
      frag("left", 150, 40, 560),
    ];
    const out = labels(interleaveRegions(items, band, para));
    for (const word of ["high", "between", "low", "left"])
      expect(
        out.filter((l) => l === word),
        word,
      ).toHaveLength(1);
  });
});
