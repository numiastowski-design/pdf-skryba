/** Defects of the PDF walk found by the high review: unbounded marked-content scans, spread-argument
 *  overflow, unbounded save stack, ignored form XObject boundaries. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRAPHICS_STATE_MAX_DEPTH, walkPage } from "./pdf-table-detector";

const rect = (x: number, y: number, w = 80, h = 27) => ({
  op: "constructPath",
  args: {
    paintOp: 23,
    paint: "fill",
    subpaths: [
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
    ],
  },
});
const image = (name = "img") => ({ op: "paintImageXObject", args: [name] });
const translate = (e: number, f: number) => ({ op: "transform", args: { a: 1, b: 0, c: 0, d: 1, e, f } });
const bmc = (tag: string) => ({ op: "beginMarkedContent", args: [tag] });
const emc = { op: "endMarkedContent", args: null };
const origins = (ops: { op: string; args: unknown }[]) => walkPage(ops, 595, 842).filled.map((f) => [f.xMin, f.yMin]);

describe("D2 - walkPage flags artifact images with an O(1) check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an image inside a nested Artifact region is an artifact; outside and after the pops it is not", () => {
    const { imageBoxes } = walkPage(
      [image("before"), bmc("Artifact"), bmc("Span"), image("inside"), emc, image("still-inside"), emc, image("after")],
      595,
      842,
    );
    expect(imageBoxes.map((b) => [b.name, b.artifact])).toEqual([
      ["before", false],
      ["inside", true],
      ["still-inside", true],
      ["after", false],
    ]);
  });

  it("an Artifact opened by beginMarkedContentProps counts too", () => {
    const { imageBoxes } = walkPage(
      [{ op: "beginMarkedContentProps", args: ["Artifact", {}] }, image("a"), emc, image("b")],
      595,
      842,
    );
    expect(imageBoxes.map((b) => b.artifact)).toEqual([true, false]);
  });

  it("an unbalanced extra endMarkedContent does not break the count", () => {
    const { imageBoxes } = walkPage([emc, bmc("Artifact"), image("a"), emc, emc, image("b")], 595, 842);
    expect(imageBoxes.map((b) => b.artifact)).toEqual([true, false]);
  });

  // No wall clock: a scan of the marked-content stack is observed through the array methods that would do it.
  it("does not scan the marked-content stack at every image (100_000 nested BMC, 5_000 images)", () => {
    const bigScans: string[] = [];
    for (const method of ["includes", "indexOf", "lastIndexOf", "some", "find", "findIndex", "every"] as const) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- taken before the spy replaces it, then called through `apply`, which binds `this`.
      const original = Array.prototype[method] as (...a: unknown[]) => unknown;
      vi.spyOn(Array.prototype, method as "includes").mockImplementation(function (this: unknown[], ...a: unknown[]) {
        if (this.length >= 1000 && typeof this[0] === "boolean") bigScans.push(method);
        return original.apply(this, a);
      } as never);
    }
    const ops = [
      ...Array.from({ length: 100_000 }, () => bmc("Span")),
      ...Array.from({ length: 5_000 }, (_, i) => image(`i${i}`)),
    ];
    const { imageBoxes } = walkPage(ops, 595, 842);
    vi.restoreAllMocks();
    expect(imageBoxes).toHaveLength(5_000);
    expect(imageBoxes.every((b) => !b.artifact)).toBe(true);
    expect(bigScans).toEqual([]);
  });

  it("deep nesting with the Artifact at the bottom still flags every image", () => {
    const ops = [bmc("Artifact"), ...Array.from({ length: 100_000 }, () => bmc("Span")), image("deep")];
    expect(walkPage(ops, 595, 842).imageBoxes.map((b) => b.artifact)).toEqual([true]);
  });
});

describe("D4 - walkPage on a huge single path does not overflow the call stack", () => {
  const N = 130_000;
  const zigzag = Array.from({ length: N + 1 }, (_, i) => ({ x: i, y: (i % 2) * 10 }));

  it("a stroked polyline of 130_000 segments yields 130_000 segments", () => {
    const walk = walkPage(
      [{ op: "constructPath", args: { paintOp: 20, paint: "stroke", subpaths: [zigzag] } }],
      595,
      842,
    );
    expect(walk.segments).toHaveLength(N);
    expect(walk.segments[N - 1]).toMatchObject({ x1: N - 1, x2: N });
  });

  it("a filled path of 130_001 points yields its segments and one filled box with the right bbox", () => {
    const walk = walkPage(
      [{ op: "constructPath", args: { paintOp: 23, paint: "fill", subpaths: [zigzag] } }],
      595,
      842,
    );
    expect(walk.segments).toHaveLength(N);
    expect(walk.filled).toHaveLength(1);
    expect(walk.filled[0]).toMatchObject({ xMin: 0, xMax: N, yMin: 0, yMax: 10 });
  });
});

describe("D5 - the save stack is bounded, the surplus stays paired", () => {
  it("exports GRAPHICS_STATE_MAX_DEPTH = 256", () => {
    expect(GRAPHICS_STATE_MAX_DEPTH).toBe(256);
  });

  it("control: a normal q / cm / Q restores the matrix", () => {
    expect(
      origins([{ op: "save", args: null }, translate(100, 200), rect(0, 0), { op: "restore", args: null }, rect(0, 0)]),
    ).toEqual([
      [100, 200],
      [0, 0],
    ]);
  });

  it("100_000 q then 100_000 Q leaves the state equal to the initial one", () => {
    const ops = [
      ...Array.from({ length: 100_000 }, () => ({ op: "save", args: null })),
      translate(7, 9),
      ...Array.from({ length: 100_000 }, () => ({ op: "restore", args: null })),
      rect(0, 0),
    ];
    expect(origins(ops)).toEqual([[0, 0]]);
  });

  it("past the cap no more state is pushed: the first surplus Q pops nothing", () => {
    const depth = 256 + 44; // literal: the export is pinned by its own test
    const nested = Array.from({ length: depth }, () => [{ op: "save", args: null }, translate(1, 0)]).flat();
    const surplus = Array.from({ length: 44 }, () => ({ op: "restore", args: null }));
    // Unbounded stack: 44 Q undo 44 translations, x = depth - 44. Bounded + counted: they pair with the unpushed q, x = depth.
    expect(origins([...nested, ...surplus, rect(0, 0)])).toEqual([[depth, 0]]);
    // The remaining Q still restore the pushed states, all the way back to the initial one.
    const rest = Array.from({ length: depth - 44 }, () => ({ op: "restore", args: null }));
    expect(origins([...nested, ...surplus, ...rest, rect(0, 0)])).toEqual([[0, 0]]);
  });
});

describe("D3 - paintFormXObjectBegin / End isolate the graphics state of the form", () => {
  const begin = (matrix: ArrayLike<number> | null) => ({ op: "paintFormXObjectBegin", args: [matrix, null] });
  const end = { op: "paintFormXObjectEnd", args: null };

  it("a cm set inside the form without q/Q does not leak onto the rest of the page", () => {
    const without = origins([rect(10, 20)]);
    const withForm = origins([begin(null), translate(50, 700), rect(0, 0), end, rect(10, 20)]);
    expect(withForm).toEqual([[50, 700], ...without]);
  });

  it("the form /Matrix shifts the content inside it by (10, 20) only", () => {
    expect(origins([begin([1, 0, 0, 1, 10, 20]), rect(0, 0), end, rect(0, 0)])).toEqual([
      [10, 20],
      [0, 0],
    ]);
  });

  it("an unnormalised /Matrix (Float32Array) is composed too", () => {
    expect(origins([begin(new Float32Array([1, 0, 0, 1, 10, 20])), rect(0, 0), end, rect(0, 0)])).toEqual([
      [10, 20],
      [0, 0],
    ]);
  });

  it("the form /Matrix composes with the current matrix and is undone at End", () => {
    expect(origins([translate(100, 100), begin([1, 0, 0, 1, 10, 20]), rect(0, 0), end, rect(0, 0)])).toEqual([
      [110, 120],
      [100, 100],
    ]);
  });

  it("a stray End at the base level does not throw nor pop the initial state", () => {
    expect(origins([end, translate(5, 5), rect(0, 0)])).toEqual([[5, 5]]);
  });

  it("a fill colour set inside the form does not survive it", () => {
    const { filled } = walkPage([begin(null), { op: "setFillRGBColor", args: ["#ff0000"] }, end, rect(0, 0)], 595, 842);
    expect(filled.map((f) => f.color)).toEqual(["#000000"]);
  });
});

describe("walkPage - text of a switched-off layer is not visible text (Rien d'invisible)", () => {
  const fullPage = [{ op: "transform", args: { a: 595, b: 0, c: 0, d: 842, e: 0, f: 0 } }, image("scan")];
  const mode = (m: number) => ({ op: "setTextRenderingMode", args: [m] });
  const show = { op: "showText", args: [[{ unicode: "a", width: 500 }]] };
  const layer = (group: string) => ({ op: "beginMarkedContentProps", args: ["OC", group] });
  const scanWithLayerText = [...fullPage, mode(3), show, mode(0), layer("off"), show, emc, layer("on"), emc];
  const isLayerVisible = (group: unknown) => group !== "off";

  it("a scan with an OCR layer plus normal text inside an OFF layer is an OCR page", () => {
    // Failure value: false (the OFF layer's text counted as visible, the OCR layer would be published).
    expect(walkPage(scanWithLayerText, 595, 842, isLayerVisible).ocrLayer).toBe(true);
  });

  it("the same text in a layer that is ON is visible: not an OCR page", () => {
    expect(walkPage(scanWithLayerText, 595, 842, () => true).ocrLayer).toBe(false);
  });
});

describe("walkPage - marked-content operators without operands", () => {
  it("a BDC/BMC whose args are null neither throws nor hides anything", () => {
    const nullBdc = { op: "beginMarkedContentProps", args: null };
    const nullBmc = { op: "beginMarkedContent", args: null };
    const run = () => walkPage([nullBdc, nullBmc, image("a"), emc, emc, image("b")], 595, 842, () => false);
    expect(run).not.toThrow();
    expect(run().imageBoxes.map((b) => [b.name, b.artifact])).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });
});
