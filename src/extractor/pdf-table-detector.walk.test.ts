/**
 * `walkPage` on hand-written operators (lot 10B characterisation): what a painted path gives (segments with their
 * thickness, the fill itself), how the graphics state, forms and marked content move the matrix, and what the walk counts
 * to decide an OCR layer. The hardening and detector tests cover the stacks and the real documents.
 */
import { describe, expect, it } from "vitest";

import { walkPage } from "./pdf-table-detector";

type Op = { op: string; args: unknown };
const path = (paint: string | undefined, subpaths: { x: number; y: number }[][]): Op => ({
  op: "constructPath",
  args: { paintOp: 0, paint, subpaths },
});
const box = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const matrix = (a: number, b: number, c: number, d: number, e: number, f: number): Op => ({
  op: "transform",
  args: { a, b, c, d, e, f },
});
const walk = (ops: Op[], isLayerVisible?: (g: unknown) => boolean) => walkPage(ops, 600, 800, isLayerVisible);
const thicknesses = (ops: Op[]): number[] => [
  ...new Set(walk(ops).segments.map((s) => Math.round((s.thickness ?? 0) * 1000) / 1000)),
];
const shown = (mode?: number): Op[] => [
  ...(mode === undefined ? [] : [{ op: "setTextRenderingMode", args: [mode] }]),
  { op: "showText", args: [[]] },
];
const fullPageImage: Op = { op: "paintImageXObject", args: ["scan"] };

describe("walkPage: the paths", () => {
  it("a stroked path gives its edges at the line width, scaled by the matrix; a filled one at its thinnest side", () => {
    expect(thicknesses([path("stroke", [box(10, 10, 100, 50)])])).toEqual([1]);
    expect(
      thicknesses([
        { op: "setLineWidth", args: [2] },
        matrix(3, 0, 0, 3, 0, 0),
        path("stroke", [box(10, 10, 100, 50)]),
      ]),
    ).toEqual([6]);
    expect(thicknesses([path("fill", [box(10, 10, 100, 4)])])).toEqual([4]);
    expect(thicknesses([path("eoFill", [box(10, 10, 6, 50)])])).toEqual([6]);
  });

  it("every paint that strokes uses the line width, every one that only fills the thinnest side", () => {
    for (const paint of [
      "stroke",
      "closeStroke",
      "fillStroke",
      "eoFillStroke",
      "closeFillStroke",
      "closeEOFillStroke",
    ]) {
      expect(thicknesses([{ op: "setLineWidth", args: [2] }, path(paint, [box(10, 10, 100, 50)])]), paint).toEqual([2]);
    }
    for (const paint of ["fill", "eoFill"]) {
      expect(thicknesses([{ op: "setLineWidth", args: [2] }, path(paint, [box(10, 10, 100, 50)])]), paint).toEqual([
        50,
      ]);
    }
  });

  it("a path with no known paint (a clip) gives nothing; a painted path with no point gives no segment and no fill", () => {
    expect(walk([path(undefined, [box(10, 10, 100, 50)])])).toMatchObject({ segments: [], filled: [] });
    expect(walk([path("clip", [box(10, 10, 100, 50)])])).toMatchObject({ segments: [], filled: [] });
    expect(walk([path("fill", [])])).toMatchObject({ segments: [], filled: [] });
  });

  it("the fill is kept with its colour and its box in page space; a stroke alone keeps no fill", () => {
    const { filled } = walk([
      { op: "setFillRGBColor", args: ["#00ff00"] },
      matrix(2, 0, 0, 2, 5, 7),
      path("fill", [box(10, 10, 100, 50)]),
    ]);
    expect(filled).toEqual([{ color: "#00ff00", xMin: 25, xMax: 225, yMin: 27, yMax: 127 }]);
    expect(walk([path("stroke", [box(10, 10, 100, 50)])]).filled).toEqual([]);
    expect(walk([path("fillStroke", [box(10, 10, 100, 50)])]).filled).toHaveLength(1);
  });

  it("a fill with no area carries no ink: its edges stay, the fill does not", () => {
    for (const flat of [box(10, 10, 0, 50), box(10, 10, 50, 0)]) {
      const w = walk([path("fill", [flat])]);
      expect(w.filled).toEqual([]);
      expect(w.segments.length).toBeGreaterThan(0);
    }
  });

  it("an operator without its operand leaves the state as it was: line width, fill colour and rendering mode", () => {
    const stroked = thicknesses([
      { op: "setLineWidth", args: [3] },
      { op: "setLineWidth", args: [] },
      path("stroke", [box(0, 0, 10, 10)]),
    ]);
    expect(stroked).toEqual([3]);
    const { filled } = walk([
      { op: "setFillRGBColor", args: ["#123456"] },
      { op: "setFillRGBColor", args: [] },
      path("fill", [box(0, 0, 10, 10)]),
    ]);
    expect(filled[0]!.color).toBe("#123456");
  });

  it("q/Q restores the line width and the matrix; a form has its own matrix and gives it back at its end", () => {
    const at = (ops: Op[]) => walk([...ops, path("fill", [box(0, 0, 10, 10)])]).filled[0]!.xMin;
    expect(at([{ op: "save", args: null }, matrix(1, 0, 0, 1, 40, 0), { op: "restore", args: null }])).toBe(0);
    expect(
      at([
        { op: "paintFormXObjectBegin", args: [[1, 0, 0, 1, 30, 0]] },
        { op: "paintFormXObjectEnd", args: null },
      ]),
    ).toBe(0);
    const inForm = walk([
      { op: "paintFormXObjectBegin", args: [[1, 0, 0, 1, 30, 0]] },
      matrix(1, 0, 0, 1, 5, 0),
      path("fill", [box(0, 0, 10, 10)]),
    ]);
    expect(inForm.filled[0]!.xMin).toBe(35);
    expect(at([{ op: "paintFormXObjectBegin", args: [null] }])).toBe(0);
  });
});

describe("walkPage: the ExtGState and zero values", () => {
  const filledAfter = (gs: unknown): number =>
    walk([{ op: "setGState", args: gs }, path("fill", [box(0, 0, 10, 10)])]).filled.length;

  it("only `ca` set to exactly 0 removes the fill; any other value, key, shape or order does not", () => {
    expect(filledAfter([[["ca", 0]]])).toBe(0);
    expect(filledAfter([[["ca", 0.5]]])).toBe(1);
    expect(filledAfter([[["CA", 0]]])).toBe(1);
    expect(filledAfter([[["ca", "0"]]])).toBe(1);
    expect(filledAfter([[["ca"]]])).toBe(1);
    expect(filledAfter([["ca", 0]])).toBe(1);
    expect(filledAfter([null])).toBe(1);
    expect(filledAfter(null)).toBe(1);
    expect(
      filledAfter([
        [
          ["LW", 3],
          ["ca", 0],
        ],
      ]),
    ).toBe(0);
    // The last `ca` of the dictionary wins.
    expect(
      filledAfter([
        [
          ["ca", 0],
          ["ca", 1],
        ],
      ]),
    ).toBe(1);
    expect(
      filledAfter([
        [
          ["ca", 1],
          ["ca", 0],
        ],
      ]),
    ).toBe(0);
  });

  it("a line width of 0 is a width (hairline), not an absent operand; an empty colour is a colour", () => {
    expect(
      thicknesses([
        { op: "setLineWidth", args: [2] },
        { op: "setLineWidth", args: [0] },
        path("stroke", [box(0, 0, 10, 10)]),
      ]),
    ).toEqual([0]);
    expect(walk([{ op: "setFillRGBColor", args: [""] }, path("fill", [box(0, 0, 10, 10)])]).filled[0]!.color).toBe("");
  });
});

describe("walkPage: the images", () => {
  it("an image box is the unit square through the matrix, with its name and its drawn width; a rotated one draws its own edge", () => {
    expect(walk([matrix(100, 0, 0, 40, 20, 30), { op: "paintImageXObject", args: ["a"] }]).imageBoxes).toEqual([
      { name: "a", xMin: 20, xMax: 120, yMin: 30, yMax: 70, drawnWidth: 100, artifact: false },
    ]);
    const [rotated] = walk([matrix(0, 40, -100, 0, 150, 30), { op: "paintImageXObject", args: ["r"] }]).imageBoxes;
    expect([rotated!.xMin, rotated!.xMax, rotated!.yMin, rotated!.yMax, rotated!.drawnWidth]).toEqual([
      50,
      150,
      30,
      30 + 40,
      40,
    ]);
  });

  it("an image whose first operand is not a name has no box (inline images are counted for the scan verdict only)", () => {
    expect(
      walk([
        matrix(100, 0, 0, 40, 0, 0),
        { op: "paintInlineImageXObject", args: [{ width: 1 }] },
        { op: "paintImageXObject", args: [7] },
      ]).imageBoxes,
    ).toEqual([]);
  });

  it("an image painted in a form uses the form's matrix", () => {
    const [b] = walk([
      { op: "paintFormXObjectBegin", args: [[2, 0, 0, 2, 10, 10]] },
      matrix(5, 0, 0, 5, 0, 0),
      { op: "paintImageXObject", args: ["f"] },
    ]).imageBoxes;
    expect([b!.xMin, b!.xMax, b!.yMin, b!.yMax]).toEqual([10, 20, 10, 20]);
  });
});

describe("walkPage: the OCR layer verdict", () => {
  const cover = (fraction: number): Op =>
    matrix(Math.sqrt(fraction * 600 * 800), 0, 0, Math.sqrt(fraction * 600 * 800), 0, 0);
  const verdict = (text: Op[], fraction: number, isLayerVisible?: (g: unknown) => boolean): boolean =>
    walk([cover(fraction), fullPageImage, { op: "restore", args: null }, ...text], isLayerVisible).ocrLayer;

  it("invisible text, no visible text and an image over 80 % of the page: an OCR layer", () => {
    expect(verdict(shown(3), 0.9)).toBe(true);
    expect(verdict(shown(7), 0.9)).toBe(true);
  });

  it("each of the three conditions is needed", () => {
    expect(verdict(shown(3), 0.5)).toBe(false);
    expect(verdict([], 0.9)).toBe(false);
    expect(verdict([...shown(3), ...shown(0)], 0.9)).toBe(false);
    expect(verdict(shown(0), 0.9)).toBe(false);
    expect(verdict(shown(1), 0.9)).toBe(false);
  });

  it("80 % is enough, and the largest image counts, not the sum", () => {
    expect(verdict(shown(3), 0.8)).toBe(true);
    expect(verdict(shown(3), 0.79)).toBe(false);
    const halves = walk([
      matrix(Math.sqrt(0.5 * 480000), 0, 0, Math.sqrt(0.5 * 480000), 0, 0),
      fullPageImage,
      fullPageImage,
      ...shown(3),
    ]);
    expect(halves.ocrLayer).toBe(false);
  });

  it("a rendering mode set without its operand reads as 0 (visible)", () => {
    expect(
      walk([
        cover(0.9),
        fullPageImage,
        { op: "setTextRenderingMode", args: [3] },
        { op: "setTextRenderingMode", args: [] },
        { op: "showText", args: [[]] },
      ]).ocrLayer,
    ).toBe(false);
  });

  it("the mode is part of the graphics state: set inside q, it is gone after Q", () => {
    const ops: Op[] = [
      cover(0.9),
      fullPageImage,
      { op: "save", args: null },
      { op: "setTextRenderingMode", args: [3] },
      { op: "restore", args: null },
      { op: "showText", args: [[]] },
    ];
    expect(walk(ops).ocrLayer).toBe(false);
  });

  it("a page with no area never reads an image as covering it", () => {
    expect(walkPage([matrix(100, 0, 0, 100, 0, 0), fullPageImage, ...shown(3)], 0, 800).ocrLayer).toBe(false);
  });

  it("text in a switched-off layer counts for neither side; a layer that is on counts", () => {
    const layer = (group: string): Op[] => [
      { op: "beginMarkedContentProps", args: ["OC", group] },
      ...shown(0),
      { op: "endMarkedContent", args: null },
    ];
    const off = (g: unknown) => g !== "off";
    expect(verdict([...shown(3), ...layer("off")], 0.9, off)).toBe(true);
    expect(verdict([...shown(3), ...layer("on")], 0.9, off)).toBe(false);
  });

  it("an image inside an artifact section is flagged, one after its end is not", () => {
    const ops: Op[] = [
      { op: "beginMarkedContent", args: ["Artifact"] },
      { op: "paintImageXObject", args: ["in"] },
      { op: "endMarkedContent", args: null },
      { op: "beginMarkedContentProps", args: ["Span", {}] },
      { op: "paintImageXObject", args: ["span"] },
      { op: "endMarkedContent", args: null },
      { op: "paintImageXObject", args: ["out"] },
    ];
    expect(walk(ops).imageBoxes.map((b) => [b.name, b.artifact])).toEqual([
      ["in", true],
      ["span", false],
      ["out", false],
    ]);
  });
});
