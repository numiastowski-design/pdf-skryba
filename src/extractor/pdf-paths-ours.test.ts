/** The painted paths read from our content stream (`pdf-paths-ours.ts`). Expected values were measured on pdf.js (removed since), on the same
 *  operators: a rectangle is four sides closed, a zero side is a diagonal, `s` closes before it paints, a curve stops
 *  its sub-path, and every coordinate is a Float32 value. */
import { describe, expect, it } from "vitest";

import { PathBuilder, PATH_OPS } from "./pdf-paths-ours";
import { readContentOps } from "./pdf-objects/content";
import type { PdfPathArg } from "./pdf-ops";

/** The painted paths of a stream, in order: one `PdfPathArg` per painting operator, a painting with no segment included.
 *  The product feeds `PathBuilder` from `pdf-ops-ours.ts`; this is the same loop, on a bare stream. */
function pathsOf(stream: string): PdfPathArg[] {
  const builder = new PathBuilder();
  const out: PdfPathArg[] = [];
  for (const { op, operands } of readContentOps(Buffer.from(stream, "latin1"))) {
    if (!PATH_OPS.has(op)) continue;
    const painted = builder.feed(op, operands);
    if (painted !== undefined) out.push(painted);
  }
  return out;
}

describe("PathBuilder: a path of very many points (review 06/11/2026, point 3)", () => {
  it("🔴 200 000 points throw nothing and give their box", () => {
    const builder = new PathBuilder();
    const num = (n: number) => ({ kind: "number" as const, value: n });
    builder.feed("m", [num(0), num(0)]);
    for (let i = 1; i <= 200_000; i++) builder.feed("l", [num(i), num(i % 100)]);
    const painted = builder.feed("S", []);
    expect(painted?.minMax).toEqual([0, 0, 200_000, 99]);
  });
});

describe("PathBuilder: the painted paths of a page, read from our stream", () => {
  it("a painted rectangle is four closed sides, painted at once", () => {
    expect(pathsOf("10 20 30 40 re f")).toEqual([
      {
        paintOp: 0,
        paint: "fill",
        minMax: [10, 20, 40, 60],
        subpaths: [
          [
            { x: 10, y: 20 },
            { x: 40, y: 20 },
            { x: 40, y: 60 },
            { x: 10, y: 60 },
            { x: 10, y: 20 },
          ],
        ],
      },
    ]);
  });

  it("a zero side gives a lone diagonal, as pdf.js did", () => {
    const [path] = pathsOf("0 0 10 0 re S");
    expect(path!.subpaths).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
  });

  it("`s` closes the path before painting it; `n` paints without drawing anything", () => {
    expect(pathsOf("0 0 m 5 0 l 5 5 l s")[0]!.paint).toBe("closeStroke");
    expect(pathsOf("0 0 m 5 0 l 5 5 l s")[0]!.subpaths[0]).toHaveLength(4);
    expect(pathsOf("0 0 1 1 re n")[0]).toMatchObject({ paint: "endPath" });
  });

  it("a curve stops its sub-path: what follows is not read", () => {
    const [path] = pathsOf("0 0 m 5 0 l 5 5 l 1 1 2 2 3 3 c 9 9 l f");
    expect(path!.subpaths).toEqual([
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
      ],
    ]);
  });

  it("a path without a segment is a painting like the others", () => {
    expect(pathsOf("f")).toEqual([{ paintOp: 0, paint: "fill", subpaths: [] }]);
  });

  it("coordinates are single-precision floats, as in pdf.js's buffer", () => {
    const [path] = pathsOf("0.1 0 m 0.1 1 l S");
    expect(path!.subpaths[0]![0]!.x).toBe(Math.fround(0.1));
  });

  it("drawing operators without a path produce no painting", () => {
    expect(pathsOf("1 0 0 1 0 0 cm 0 g")).toEqual([]);
  });
});

describe("a painted path carries its box, curves included (05/11/2026)", () => {
  it("🔴 a circle of four curves has a box, though its subpaths stop at the first curve", () => {
    const [disc] = pathsOf("115 700 m 115 716 85 716 85 700 c 85 684 115 684 115 700 c f");
    expect(disc?.subpaths).toEqual([[{ x: 115, y: 700 }]]);
    expect(disc?.minMax).toEqual([85, 684, 115, 716]);
  });

  it("a path with no point has no box", () => {
    expect(pathsOf("f")[0]?.minMax).toBeUndefined();
  });
});
