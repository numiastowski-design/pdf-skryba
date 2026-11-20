/** A line smaller than its page's body is a paragraph in small text, never body text (footnotes of 6.5 pt under a
 *  body of 10). The verdict comes from the page; here it is a given function. */
import { describe, expect, it } from "vitest";

import { CUT_MARK } from "../layout/cut-word";
import { paragraphsFromSegment, type SegmentReading } from "./pdf-paragraphs";

const item = (text: string, y: number, fontSize: number) => ({ text, x: 0, y, width: 100, fontSize });
const reading = (isSmallSize: (size: number) => boolean): SegmentReading => ({
  isBold: () => false,
  wordWidthAt: () => 3,
  markerBefore: undefined,
  headingLevelOf: undefined,
  isSmallSize,
  centredContainer: undefined,
});

describe("paragraphsFromSegment — LA TAILLE SEULE fait un titre (05/11/2026 : « on se base sur la taille des textes »)", () => {
  const boldReading = (headingLevelOf: (size: number) => 1 | undefined): SegmentReading => ({
    ...reading(() => false),
    isBold: () => true,
    headingLevelOf,
  });
  const bodyLine = (text: string, y: number) => [{ text, x: 0, y, width: 400, fontSize: 10 }];

  it("🔴 une ligne courte en GRAS, à la taille du corps, reste un paragraphe", () => {
    const blocks = paragraphsFromSegment(
      [
        bodyLine("Une première ligne du corps, assez longue pour un bloc.", 300)[0]!,
        { text: "Objectifs", x: 0, y: 270, width: 60, fontSize: 10 },
        bodyLine("La suite du corps, encore une ligne assez longue ici.", 240)[0]!,
      ].map((l) => [l]),
      boldReading(() => undefined),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("🔴 « 1.2 Méthodes » en gras, à la taille du corps, reste un paragraphe", () => {
    const blocks = paragraphsFromSegment(
      [
        bodyLine("Corps avant, une ligne entière de prose ordinaire.", 300),
        [{ text: "1.2 Méthodes", x: 0, y: 270, width: 80, fontSize: 10 }],
        bodyLine("Corps après, une autre ligne entière de prose.", 240),
      ],
      boldReading(() => undefined),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("et une taille classée fait le titre, image ou pas", () => {
    expect(
      paragraphsFromSegment([[item("Alouette", 700, 168)]], { ...reading(() => false), headingLevelOf: () => 1 }),
    ).toEqual([{ kind: "heading", level: 1, inlines: [{ text: "Alouette" }] }]);
  });
});

describe("paragraphsFromSegment — small text", () => {
  it('🔴 un paragraphe dont la ligne est petite pour sa page porte `size: "small"`', () => {
    const blocks = paragraphsFromSegment(
      [[item("4 See Securities Exchange Act Release No. 73991.", 100, 6.5)]],
      reading((size) => size < 8),
    );
    expect(blocks).toEqual([
      { kind: "paragraph", inlines: [{ text: "4 See Securities Exchange Act Release No. 73991." }], size: "small" },
    ]);
  });

  it("un paragraphe du corps n'en porte pas, et sans verdict de page rien ne change", () => {
    expect(
      paragraphsFromSegment(
        [[item("Une ligne du corps.", 100, 10)]],
        reading((size) => size < 8),
      ),
    ).toEqual([{ kind: "paragraph", inlines: [{ text: "Une ligne du corps." }] }]);
    expect(
      paragraphsFromSegment([[item("4 See id.", 100, 6.5)]], { ...reading(() => true), isSmallSize: undefined }),
    ).toEqual([{ kind: "paragraph", inlines: [{ text: "4 See id." }] }]);
  });
});

describe("paragraphsFromSegment — a word cut across two lines carries the cut mark (05/11/2026)", () => {
  // The mark is resolved for the whole document after extraction (`layout/cut-word.ts#resolveCutHyphens`).
  it("🔴 « jour- » + « nal » joins with the mark in place of the hyphen", () => {
    const blocks = paragraphsFromSegment(
      [
        [{ text: "éditorialiste au jour-", x: 0, y: 100, width: 100, fontSize: 8 }],
        [{ text: "nal Le Temps", x: 0, y: 90, width: 60, fontSize: 8 }],
      ],
      reading(() => false),
    );
    expect(blocks).toEqual([
      { kind: "paragraph", inlines: [{ text: `éditorialiste au jour${CUT_MARK}nal Le Temps` }] },
    ]);
  });
});

describe("paragraphsFromSegment — un morceau en italique porte la marque `em` (05/11/2026)", () => {
  it("🔴 « Adieu à Terminus », titre d'ouvrage en italique dans la légende, sort en em", () => {
    const blocks = paragraphsFromSegment(
      [
        [
          { text: "dont", x: 0, y: 100, width: 20, fontSize: 8 },
          { text: "Adieu à Terminus", x: 25, y: 100, width: 70, fontSize: 8, italic: true },
        ],
      ],
      reading(() => false),
    );
    // The word-break space leads the italic piece, as it leads a bold one.
    expect(blocks).toEqual([
      { kind: "paragraph", inlines: [{ text: "dont" }, { text: " Adieu à Terminus", marks: ["em"] }] },
    ]);
  });
});
