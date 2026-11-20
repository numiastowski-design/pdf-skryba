/**
 * Characterisation (12/10/2026) of the verdict « this glyph is left out » of `buildGlyphFragments(ops, hide)`: a glyph in a
 * hidden optional-content layer always goes; a mode 3 glyph only when `dropModeHidden`; a visible one never.
 */
import { describe, expect, it } from "vitest";
import { buildGlyphFragments, type NamedOp } from "./glyph-positions";

const at = (x: number): NamedOp => ({ op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: x, f: 700 } });
const show = (unicode: string): NamedOp => ({ op: "showText", args: [[{ unicode, width: 500 }]] });

const ops: NamedOp[] = [
  { op: "beginText", args: [] },
  { op: "setFont", args: ["F1", 10] },
  at(100),
  show("A"),
  { op: "setTextRenderingMode", args: [3] },
  at(200),
  show("B"),
  { op: "setTextRenderingMode", args: [0] },
  { op: "beginMarkedContentProps", args: ["OC", "layer-1"] },
  at(300),
  show("C"),
  { op: "endMarkedContent", args: [] },
  { op: "endText", args: [] },
];

const texts = (hide?: { isLayerVisible: (group: unknown) => boolean; dropModeHidden: boolean }): string[] =>
  buildGlyphFragments(ops, hide).map((g) => g.text);

describe("buildGlyphFragments with a hide policy", () => {
  it("without a policy, every glyph is kept", () => {
    expect(texts()).toEqual(["A", "B", "C"]);
  });

  it("drops the hidden layer, and mode 3 only when asked", () => {
    expect(texts({ isLayerVisible: () => false, dropModeHidden: true })).toEqual(["A"]);
    expect(texts({ isLayerVisible: () => false, dropModeHidden: false })).toEqual(["A", "B"]);
  });

  it("keeps the layer's glyph when the layer is shown", () => {
    expect(texts({ isLayerVisible: () => true, dropModeHidden: true })).toEqual(["A", "C"]);
    expect(texts({ isLayerVisible: () => true, dropModeHidden: false })).toEqual(["A", "B", "C"]);
  });
});
