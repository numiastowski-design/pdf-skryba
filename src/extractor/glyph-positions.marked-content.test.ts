/** The marked-content stack read by every glyph: O(1) per glyph, however deep the stack (hostile PDF: a million BDC without EMC). */
import { describe, expect, it } from "vitest";

import { MarkedContentStack, buildGlyphFragments, type NamedOp } from "./glyph-positions";

describe("MarkedContentStack", () => {
  it("an empty stack has no mcid and is not in an artifact", () => {
    const s = new MarkedContentStack();
    expect(s.innermostMcid).toBeUndefined();
    expect(s.inArtifact).toBe(false);
  });

  it("the innermost DEFINED mcid wins: a BMC without mcid inside a tagged section keeps the outer one", () => {
    const s = new MarkedContentStack();
    s.push(3, false);
    s.push(undefined, false);
    expect(s.innermostMcid).toBe(3);
    s.push(7, false);
    expect(s.innermostMcid).toBe(7);
    s.pop();
    expect(s.innermostMcid).toBe(3);
    s.pop();
    s.pop();
    expect(s.innermostMcid).toBeUndefined();
  });

  it("an artifact inside a non-artifact makes the glyph an artifact until its own pop", () => {
    const s = new MarkedContentStack();
    s.push(1, false);
    s.push(undefined, true);
    s.push(undefined, false);
    expect(s.inArtifact).toBe(true);
    s.pop();
    expect(s.inArtifact).toBe(true);
    s.pop();
    expect(s.inArtifact).toBe(false);
    expect(s.innermostMcid).toBe(1);
  });

  it("a surplus pop is harmless", () => {
    const s = new MarkedContentStack();
    s.pop();
    s.push(2, true);
    s.pop();
    s.pop();
    expect(s.inArtifact).toBe(false);
    expect(s.innermostMcid).toBeUndefined();
  });

  it("stays right after 200 000 nested sections without end", () => {
    const s = new MarkedContentStack();
    for (let i = 0; i < 200_000; i++) s.push(i === 0 ? 9 : undefined, i === 1);
    expect(s.innermostMcid).toBe(9);
    expect(s.inArtifact).toBe(true);
  });
});

describe("readGlyphs with nested marked content", () => {
  const glyph = {
    originalCharCode: 65,
    fontChar: "A",
    unicode: "A",
    accent: null,
    width: 500,
    isSpace: false,
    isInFont: true,
  };
  // Each call at its own x, so that the overpaint merge keeps the three glyphs.
  let x = 0;
  const show = (): NamedOp[] => [
    { op: "beginText", args: null },
    { op: "setTextMatrix", args: { a: 1, b: 0, c: 0, d: 1, e: (x += 50), f: 0 } },
    { op: "setFont", args: ["f1", 10] },
    { op: "showText", args: [[glyph]] },
    { op: "endText", args: null },
  ];
  it("tags each glyph with the innermost mcid and the artifact flag of its place in the stack", () => {
    const ops: NamedOp[] = [
      { op: "beginMarkedContentProps", args: ["P", 4] },
      { op: "beginMarkedContent", args: [{ name: "Artifact" }] },
      ...show(),
      { op: "endMarkedContent", args: null },
      ...show(),
      { op: "endMarkedContent", args: null },
      ...show(),
    ];
    expect(buildGlyphFragments(ops).map((g) => [g.mcid, g.artifact])).toEqual([
      [4, true],
      [4, false],
      [undefined, false],
    ]);
  });
});
