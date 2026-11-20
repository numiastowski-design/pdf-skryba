/**
 * `readGlyphs` with a layer verdict (lot 10B characterisation): which glyph a viewer does not show carries `hidden`
 * (`"layer"` inside a switched-off optional-content section, `"mode"` in text rendering mode 3) or `unpainted` (mode 7),
 * how those sections nest against `q`/`Q`, how form XObjects move the glyphs, and which operators the walk refuses or
 * ignores. Operator lists are written by hand, one glyph per `Tj`, at the origin of its line so a position names the glyph.
 */
import { describe, expect, it } from "vitest";

import { ReaderError } from "doc-ir";
import { MAX_SHELTER_BOXES_PER_PAGE, readGlyphs, type NamedOp } from "./glyph-positions";

const glyph = (unicode: string, width = 500): Record<string, unknown> => ({ unicode, width, isSpace: false });
const matrix = (e: number, f: number) => ({ a: 1, b: 0, c: 0, d: 1, e, f });

/** `BT /F 10 Tf <ops> ET`, one glyph "x" shown at x = 100 after the given operators. */
const show = (text: string, at = 0): NamedOp[] => [
  { op: "setTextMatrix", args: matrix(100 + at, 700) },
  { op: "showText", args: [[glyph(text)]] },
];
const header: NamedOp[] = [
  { op: "beginText", args: null },
  { op: "setFont", args: ["f1", 10] },
];
const visible = (group: unknown): boolean => group !== "off";
const OC_OFF: NamedOp = { op: "beginMarkedContentProps", args: ["OC", "off"] };
const OC_ON: NamedOp = { op: "beginMarkedContentProps", args: ["OC", "on"] };
const EMC: NamedOp = { op: "endMarkedContent", args: null };
const marks = (ops: NamedOp[], layer: ((g: unknown) => boolean) | undefined = visible) =>
  readGlyphs([...header, ...ops], layer).map(
    (g) => `${g.text}:${g.hidden ?? (g.unpainted === true ? "unpainted" : "-")}`,
  );

describe("readGlyphs - what a viewer does not show", () => {
  it("without a verdict nothing is flagged, whatever the document says", () => {
    const ops: NamedOp[] = [OC_OFF, { op: "setTextRenderingMode", args: [3] }, ...show("a"), EMC];
    const [g] = readGlyphs([...header, ...ops]);
    expect(g!.text).toBe("a");
    expect("hidden" in g!).toBe(false);
    expect("unpainted" in g!).toBe(false);
  });

  // Mode 7 is judged on what is painted through it (arXiv:2606.15020): a clip nothing is painted through hides its text.
  it("mode 3 is hidden by mode, mode 7 with nothing painted through is hidden by clip, the other modes carry no mark", () => {
    const at = (mode: number) => marks([{ op: "setTextRenderingMode", args: [mode] }, ...show("a")]);
    expect(at(3)).toEqual(["a:mode"]);
    expect(at(7)).toEqual(["a:clip"]);
    for (const mode of [0, 1, 2, 4, 5, 6]) expect(at(mode)).toEqual(["a:-"]);
  });

  it("mode 7 WITH a fill painted through it keeps its letters: a gradient title is never lost", () => {
    const painted = [
      { op: "setTextRenderingMode", args: [7] },
      ...show("a"),
      { op: "constructPath", args: { paint: "fill", minMax: [0, 0, 100, 100] } },
    ];
    // Failure value: « a:clip », a title clipped then painted, lost.
    expect(marks(painted)).toEqual(["a:unpainted"]);
  });

  it("the marks are separate keys: a mode 7 glyph carries BOTH its mark and its verdict, a plain one neither", () => {
    const [stencil, plain] = readGlyphs(
      [
        ...header,
        { op: "setTextRenderingMode", args: [7] },
        ...show("a"),
        { op: "setTextRenderingMode", args: [0] },
        ...show("b", 50),
      ],
      visible,
    );
    // `unpainted` says what the operator painted, `hidden: "clip"` what the page showed: the second decides, the first
    // still feeds the scanned-page verdict.
    expect(Object.keys(stencil!)).toContain("unpainted");
    expect(stencil!.hidden).toBe("clip");
    expect("hidden" in plain!).toBe(false);
    expect("unpainted" in plain!).toBe(false);
  });

  it("the mode may arrive as a bare number or as an argument list; a missing argument means 0", () => {
    expect(marks([{ op: "setTextRenderingMode", args: 3 }, ...show("a")])).toEqual(["a:mode"]);
    expect(marks([{ op: "setTextRenderingMode", args: [3] }, ...show("a")])).toEqual(["a:mode"]);
    expect(
      marks([{ op: "setTextRenderingMode", args: [3] }, { op: "setTextRenderingMode", args: [] }, ...show("a")]),
    ).toEqual(["a:-"]);
    expect(
      marks([{ op: "setTextRenderingMode", args: [3] }, { op: "setTextRenderingMode", args: null }, ...show("a")]),
    ).toEqual(["a:-"]);
  });

  it("a glyph inside a switched-off layer is hidden by layer, even in mode 3; a layer that is on hides nothing", () => {
    expect(marks([OC_OFF, ...show("a"), EMC, ...show("b", 50)])).toEqual(["a:layer", "b:-"]);
    expect(marks([OC_OFF, { op: "setTextRenderingMode", args: [3] }, ...show("a"), EMC])).toEqual(["a:layer"]);
    expect(marks([OC_ON, ...show("a"), EMC])).toEqual(["a:-"]);
  });

  it("the layer stack is independent of q/Q: a Q inside the section does not show the layer again", () => {
    const ops: NamedOp[] = [
      { op: "save", args: null },
      OC_OFF,
      { op: "restore", args: null },
      ...show("a"),
      EMC,
      ...show("b", 50),
    ];
    expect(marks(ops)).toEqual(["a:layer", "b:-"]);
    const nested: NamedOp[] = [OC_OFF, OC_ON, ...show("a"), EMC, ...show("b", 50), EMC, ...show("c", 100)];
    expect(marks(nested)).toEqual(["a:layer", "b:layer", "c:-"]);
  });

  it("only an `OC` section with a group can hide: a plain section, another tag, a null group and a surplus EMC do not", () => {
    expect(marks([{ op: "beginMarkedContent", args: ["Span"] }, ...show("a"), EMC])).toEqual(["a:-"]);
    expect(marks([{ op: "beginMarkedContentProps", args: ["Span", "off"] }, ...show("a"), EMC])).toEqual(["a:-"]);
    expect(marks([{ op: "beginMarkedContentProps", args: ["OC", null] }, ...show("a"), EMC])).toEqual(["a:-"]);
    expect(marks([{ op: "beginMarkedContentProps", args: null }, ...show("a"), EMC])).toEqual(["a:-"]);
    expect(marks([EMC, ...show("a")])).toEqual(["a:-"]);
  });
});

describe("readGlyphs - form XObjects and the other operators", () => {
  it("a form's /Matrix moves its glyphs and is given back at its end; a form without a usable matrix does not move them", () => {
    const withForm = (formArgs: unknown): number[] =>
      readGlyphs([
        ...header,
        { op: "paintFormXObjectBegin", args: formArgs },
        ...show("a"),
        { op: "paintFormXObjectEnd", args: null },
        ...show("b"),
      ]).map((g) => g.x);
    expect(withForm([[1, 0, 0, 1, 20, 0]])).toEqual([120, 100]);
    expect(withForm([null])).toEqual([100, 100]);
    expect(withForm(null)).toEqual([100, 100]);
  });

  it("a form is a graphics state of its own: cm, Tf and Tc inside it are gone after its end", () => {
    const ops: NamedOp[] = [
      ...header,
      { op: "paintFormXObjectBegin", args: [[1, 0, 0, 1, 0, 0]] },
      { op: "transform", args: matrix(5, 0) },
      { op: "setCharSpacing", args: [3] },
      { op: "setFont", args: ["f2", 20] },
      ...show("a"),
      { op: "paintFormXObjectEnd", args: null },
      ...show("b"),
    ];
    const [a, b] = readGlyphs(ops);
    expect([a!.x, a!.width, a!.height]).toEqual([105, 13, 20]);
    expect([b!.x, b!.width, b!.height]).toEqual([100, 5, 10]);
  });

  it("cm composes with the CTM, and T*, TD, Ts and Tz read the state they set", () => {
    const ops: NamedOp[] = [
      ...header,
      { op: "transform", args: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } },
      { op: "setLeadingMoveText", args: [10, -14] },
      { op: "setTextRise", args: [4] },
      { op: "setHScale", args: [50] },
      { op: "showText", args: [[glyph("a", 1000)]] },
      { op: "nextLine", args: null },
      { op: "showText", args: [[glyph("b", 1000)]] },
    ];
    const [a, b] = readGlyphs(ops);
    // TD 10 -14 puts the origin at (10, -14), the rise 4 lifts it, the CTM doubles: (20, 2*(-14+4)).
    expect([a!.x, a!.y]).toEqual([20, -20]);
    // 1000/1000 * 10 * 0.5 = 5 wide, doubled by the CTM; T* goes down by the leading (14) set by TD.
    expect(a!.width).toBe(10);
    expect([b!.x, b!.y]).toEqual([20, -48]);
  });

  it("a show operator whose argument is not a list shows nothing and does not fail; a non-number kerning item moves nothing", () => {
    expect(
      readGlyphs([
        ...header,
        { op: "showText", args: null },
        { op: "showSpacedText", args: ["x"] },
        { op: "showText", args: [null] },
      ]),
    ).toEqual([]);
  });

  it("refuses the operators it cannot place, by name, and lets the ones it does not need pass", () => {
    for (const op of ["nextLineShowText", "nextLineSetSpacingShowText", "setCharSpacing2", "setTextFont"]) {
      const error = (() => {
        try {
          readGlyphs([{ op, args: null }]);
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(error, op).toBeInstanceOf(ReaderError);
      expect((error as ReaderError).message).toContain(op);
    }
    for (const op of ["endText", "fill", "setFillRGBColor", "paintImageXObject"])
      expect(() => readGlyphs([{ op, args: null }]), op).not.toThrow();
  });

  it("a matrix operator whose argument was not decoded fails, naming the operator", () => {
    for (const op of ["transform", "setTextMatrix"]) {
      expect(() => readGlyphs([{ op, args: [1, 0, 0, 1, 0, 0] }]), op).toThrow(new RegExp(`^${op}:`));
    }
  });

  it("the run id is the index of the showing operator", () => {
    const ids = readGlyphs([...header, ...show("a"), { op: "fill", args: null }, ...show("b", 50)]).map((g) => g.runId);
    expect(ids).toEqual([3, 6]);
  });

  it("a kerning number moves the text matrix by itself: the character spacing is not added for it", () => {
    const ops: NamedOp[] = [
      ...header,
      { op: "setCharSpacing", args: [2] },
      { op: "setTextMatrix", args: matrix(100, 700) },
      { op: "showText", args: [[glyph("a", 500), -1000, glyph("b", 500)]] },
    ];
    const [a, b] = readGlyphs(ops);
    // a advances 500/1000*10 + 2 = 7; the kerning -1000 adds 10; nothing else.
    expect([a!.x, b!.x]).toEqual([100, 117]);
  });

  it("a glyph with no text is not a fragment, but it still advances the text matrix; a missing width advances by the spacing only", () => {
    const ops: NamedOp[] = [
      ...header,
      { op: "setTextMatrix", args: matrix(100, 700) },
      {
        op: "showText",
        args: [[glyph("a", 500), { unicode: "", width: 500 }, { width: 400 }, { unicode: "c" }, glyph("b", 500)]],
      },
    ];
    const fragments = readGlyphs(ops);
    expect(fragments.map((g) => [g.text, g.x])).toEqual([
      ["a", 100],
      ["c", 114],
      ["b", 114],
    ]);
  });
});

describe("readGlyphs — a glyph painted in the colour of the page is hidden by its paint (05/11/2026)", () => {
  // Federal Register `sd-4133285`: the typesetter's line « VerDate Sep<11>2014 … » and the margin stamp « asabaliauskas on
  // DSK5VPTVN1PROD with NOTICES » are drawn after `1 g` — white on the white page, 6.5 pt: present in the text, invisible
  // on paper, and published as a false footer. White text over a dark fill painted BEFORE it is what a viewer shows.
  const fill = (hex: string): NamedOp => ({ op: "setFillRGBColor", args: [hex] });
  const box = (x0: number, y0: number, x1: number, y1: number): NamedOp => ({
    op: "constructPath",
    args: {
      paintOp: 0,
      paint: "fill",
      subpaths: [
        [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      ],
    },
  });

  it("🔴 white text on the bare page is hidden by its paint", () => {
    expect(marks([fill("#ffffff"), ...show("a")])).toEqual(["a:paint"]);
  });

  it("🔴 white text over a dark box painted before it is shown", () => {
    expect(marks([fill("#003366"), box(50, 650, 400, 750), fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
  });

  it("a white box shelters nothing, and a dark box elsewhere on the page neither", () => {
    expect(marks([fill("#ffffff"), box(50, 650, 400, 750), ...show("a")])).toEqual(["a:paint"]);
    expect(marks([fill("#003366"), box(50, 50, 400, 150), fill("#ffffff"), ...show("a")])).toEqual(["a:paint"]);
  });

  it("black text, and text whose white a `Q` restores to black, carry no mark", () => {
    expect(marks([fill("#000000"), ...show("a")])).toEqual(["a:-"]);
    expect(marks([{ op: "save", args: null }, fill("#ffffff"), { op: "restore", args: null }, ...show("a")])).toEqual([
      "a:-",
    ]);
  });

  it("without a verdict nothing is flagged, as for the other marks", () => {
    const [g] = readGlyphs([...header, fill("#ffffff"), ...show("a")]);
    expect("hidden" in g!).toBe(false);
  });

  it("🔴 a white digit on a coloured DISC is shown: the box of a path of curves is its `minMax`, not its decoded points", () => {
    // The disc of `pdf.test.ts#makePdfWithDiscInCell`: moveTo then four curves, which the subpath decoder stops at.
    const disc: NamedOp = {
      op: "constructPath",
      args: { paintOp: 0, paint: "fill", subpaths: [[{ x: 115, y: 700 }]], minMax: [85, 685, 115, 715] },
    };
    expect(marks([fill("#008000"), disc, fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
  });

  it("🔴 a white title over a painted IMAGE is shown (safedocs 0000669, a cover on a full-page photo)", () => {
    // The image is drawn in the unit square under the CTM: `q 400 0 0 300 50 600 cm /Im1 Do Q` covers (50..450, 600..900).
    const photo: NamedOp[] = [
      { op: "save", args: null },
      { op: "transform", args: { a: 400, b: 0, c: 0, d: 300, e: 50, f: 600 } },
      { op: "paintImageXObject", args: ["Im1", undefined] },
      { op: "restore", args: null },
    ];
    expect(marks([...photo, fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
    expect(marks([fill("#ffffff"), ...show("a"), ...photo])).toEqual(["a:paint"]);
  });

  it("🔴 white text over a box filled in a colour we do not convert is shown (review 06/11/2026, point 1)", () => {
    const unknown: NamedOp = { op: "setFillColourUnknown", args: null };
    expect(marks([unknown, box(50, 650, 400, 750), fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
  });

  it("🔴 white text after a shading (`sh`, box unknown) is shown: the bias is « we publish »", () => {
    expect(marks([{ op: "paintShading", args: ["Sh1"] }, fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
    expect(marks([fill("#ffffff"), ...show("a"), { op: "paintShading", args: ["Sh1"] }])).toEqual(["a:paint"]);
  });

  it("🔴 past the cap of shelter boxes, white text is NOT dropped: the bias is « we publish » (review 06/11/2026, point 13)", () => {
    const far = (i: number): NamedOp => box(1000 + i, 5000, 1001 + i, 5001);
    const boxes = Array.from({ length: MAX_SHELTER_BOXES_PER_PAGE + 5 }, (_, i) => far(i));
    expect(marks([fill("#003366"), ...boxes, fill("#ffffff"), ...show("a")])).toEqual(["a:-"]);
    const few = Array.from({ length: 5 }, (_, i) => far(i));
    expect(marks([fill("#003366"), ...few, fill("#ffffff"), ...show("a")])).toEqual(["a:paint"]);
  });

  it("🔴 white OUTLINE text (render mode 1 or 5) is shown, the stroke being visible (review 06/11/2026, point 2)", () => {
    const mode = (m: number): NamedOp => ({ op: "setTextRenderingMode", args: [m] });
    expect(marks([fill("#ffffff"), mode(1), ...show("a")])).toEqual(["a:-"]);
    expect(marks([fill("#ffffff"), mode(5), ...show("a")])).toEqual(["a:-"]);
    expect(marks([fill("#ffffff"), mode(0), ...show("a")])).toEqual(["a:paint"]);
  });
});
