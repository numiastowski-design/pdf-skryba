/**
 * `paragraphsFromLines` on hand-written lines (lot 10B characterisation): which gathered paragraph becomes a heading
 * — by SIZE alone — and how the lines are gathered (size change, vertical gap,
 * junction space). Lists are in `pdf-lists.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IRBlock } from "doc-ir";
import type { HeadingLevel } from "../layout/heading-sizes";

vi.mock("../layout/list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout/list")>();
  return { ...actual, listRuns: vi.fn(actual.listRuns) };
});

import { listRuns, type ListCandidate } from "../layout/list";
import type { Line, TextRun } from "./pdf-model";
import { paragraphsFromLines } from "./pdf-paragraphs";

const BODY = 12;
const line = (y: number, text: string, extra: Partial<Line> & { bold?: boolean; runs?: TextRun[] } = {}): Line => {
  const { bold = false, runs, ...rest } = extra;
  return {
    y,
    fontSize: BODY,
    text,
    runs: runs ?? [{ text, bold }],
    left: 72,
    right: 72 + text.length * 6,
    firstWordWidth: 0,
    maxInnerGap: 0,
    ...rest,
  };
};

/**
 * A COLUMN RUNNING ALONGSIDE A PICTURE IS MEASURED AGAINST ITS OWN LINES (12/11/2026: a line significantly shorter
 * than its neighbours beside the picture ends a paragraph, the slack being four characters). The photo narrows the column, so every
 * line there stops short of the segment's margin and `isDeliberateBreak` cut each of them into its own paragraph —
 * the staircase seen on the published page of the newspaper `sd-2479793`.
 */
describe("les lignes qui longent une image se mesurent entre elles (12/11/2026)", () => {
  // Every line here takes its width from its own text (`line`: 6 pt a character from 72), so a character of slack is
  // 6 pt and the rule's four characters are 24 pt. The four first lines run beside the picture, the fifth below it.
  const L1 = "Concerts, spectacles, conferences, ateliers et animations"; // 57 characters, 1 short of the group
  const L2 = "diverses dans leur expression francophone, tel se presente"; // 58, the group's own right edge
  const L3 = "le menu de la 14e Semaine de la langue."; // 39, nineteen characters short: a paragraph ends
  const L4 = "Un feu d'artifice de manifestations mises sur pied autour"; // 57
  const L5 = "Particularite de la Semaine suisse: celebration de deux ecrivains celebres"; // 74, below the picture
  const beside = [
    line(500, L1, { firstWordWidth: 20 }),
    line(488, L2, { firstWordWidth: 20 }),
    line(476, L3, { firstWordWidth: 20 }),
    line(464, L4, { firstWordWidth: 20 }),
  ];
  const below = line(440, L5, { firstWordWidth: 20 });
  const asidePicture = (l: Line): number | undefined => (beside.includes(l) ? 330 : undefined);

  it("🔴 les lignes collées à l'image font UN paragraphe, et la ligne courte le termine", () => {
    const blocks = paragraphsFromLines([...beside, below], undefined, undefined, undefined, asidePicture);
    expect(kinds(blocks)).toEqual([`paragraph:${L1} ${L2} ${L3}`, `paragraph:${L4} ${L5}`]);
  });

  // The upper line is judged on the obstacle it had: whether it stops short is answered by its own geometry, not
  // by the lower line, which has the page's full width.
  it("🔴 une ligne courte le long de l'image ferme son paragraphe, même si la suivante est sous l'image", () => {
    const short = line(464, L3, { firstWordWidth: 20 }); // 39 characters, nineteen fewer than the group
    const lines = [line(500, L1, { firstWordWidth: 20 }), line(488, L2, { firstWordWidth: 20 }), short, below];
    const aside = (l: Line): number | undefined => (l === below ? undefined : 330);
    expect(kinds(paragraphsFromLines(lines, undefined, undefined, undefined, aside))).toEqual([
      `paragraph:${L1} ${L2} ${L3}`,
      `paragraph:${L5}`,
    ]);
  });

  it("🔴 sans la règle, la même colonne sort en escalier : une ligne, un paragraphe", () => {
    expect(kinds(paragraphsFromLines([...beside, below]))).toEqual([
      `paragraph:${L1}`,
      `paragraph:${L2}`,
      `paragraph:${L3}`,
      `paragraph:${L4}`,
      `paragraph:${L5}`,
    ]);
  });

  // The rule above glued two numbered steps: step 2 butts against the picture, so step 3 passed for its
  // continuation. A marker at the same left edge opens a sibling item, which `startsNewItem` does not see (it asks
  // for an outdent).
  it("🔴 un item numéroté sous l'image ne se colle pas à la ligne qui bute contre l'image", () => {
    const butts = line(500, "2) selectionner le groupe IT service desk du portail", { firstWordWidth: 20 });
    const sibling = line(488, "3) selectionner la raison du signalement et remplir", { firstWordWidth: 20 });
    const aside = (l: Line): number | undefined => (l === butts ? 330 : undefined);
    expect(kinds(paragraphsFromLines([butts, sibling], undefined, undefined, undefined, aside))).toEqual([
      "paragraph:2) selectionner le groupe IT service desk du portail",
      "paragraph:3) selectionner la raison du signalement et remplir",
    ]);
  });

  it("une ligne courte de MOINS de 4 caractères reste dans son paragraphe", () => {
    const nearly = line(488, "diverses dans leur expression francophone, tel se pres", { firstWordWidth: 20 }); // 54, soit 4 de moins que 58
    const lines = [line(500, L2, { firstWordWidth: 20 }), nearly];
    const aside = (l: Line): number | undefined => (lines.includes(l) ? 330 : undefined);
    expect(kinds(paragraphsFromLines(lines, undefined, undefined, undefined, aside))).toEqual([
      `paragraph:${L2} diverses dans leur expression francophone, tel se pres`,
    ]);
  });
});

const textOf = (block: IRBlock): string => ("inlines" in block ? block.inlines.map((i) => i.text).join("") : "");
const kinds = (blocks: readonly IRBlock[]): string[] =>
  blocks.map((b) => (b.kind === "heading" ? `h${b.level}:${textOf(b)}` : `${b.kind}:${textOf(b)}`));

/** Body lines 12 pt apart with a short bold line standing alone between two bodies: 36 pt above (3 line gaps), 36 below. */
const withTitle = (title: Partial<Line> & { bold?: boolean } = {}): Line[] => [
  line(700, "The first body line is here and goes on and on."),
  line(688, "The second body line is here and goes on and on."),
  line(676, "The third body line is here and goes on and on."),
  line(640, "Mission and values", { bold: true, ...title }),
  line(604, "After the title comes more body text, as usual."),
  line(592, "The last body line is here and goes on and on."),
];

beforeEach(() => {
  vi.mocked(listRuns).mockClear();
});

/** The candidates the list decision was handed, one per block. */
const candidates = (): readonly ListCandidate[] => vi.mocked(listRuns).mock.calls.at(-1)![0];

describe("paragraphsFromLines: headings", () => {
  it("lines of one size and a regular gap are one paragraph, joined by a space", () => {
    const lines = withTitle().filter((l) => l.text !== "Mission and values");
    // 676 -> 604 is a gap of 72 pt: six lines of body, two paragraphs.
    expect(kinds(paragraphsFromLines(lines))).toEqual([
      "paragraph:The first body line is here and goes on and on. The second body line is here and goes on and on. The third body line is here and goes on and on.",
      "paragraph:After the title comes more body text, as usual. The last body line is here and goes on and on.",
    ]);
  });

  it("a size that the caller names a heading makes its paragraph a heading of that level", () => {
    const lines = withTitle({ bold: false, fontSize: 20 });
    expect(kinds(paragraphsFromLines(lines, (size) => (size === 20 ? 1 : undefined)))).toContain(
      "h1:Mission and values",
    );
    expect(kinds(paragraphsFromLines(lines, (size) => (size === 20 ? 4 : undefined)))).toContain(
      "h4:Mission and values",
    );
  });

  it("🔴 une ligne courte en GRAS à la taille du corps reste un paragraphe : le chemin par critères est retiré (05/11/2026)", () => {
    // The size alone decides.
    expect(kinds(paragraphsFromLines(withTitle()))).toContain("paragraph:Mission and values");
    const two = [
      line(700, "Note 4. Prêts", { bold: true }),
      line(673, "The body line under the title is here and goes on and on."),
    ];
    expect(kinds(paragraphsFromLines(two)).some((k) => k.startsWith("h"))).toBe(false);
  });

  it("🔴 « 4.1 Scope of the work » en gras à la taille du corps reste un paragraphe : la règle N est retirée (05/11/2026)", () => {
    const inProse = [
      line(700, "The first body line is here and goes on and on and on."),
      line(688, "The second body line is here and goes on and on and on."),
      line(652, "4.1 Scope of the work", { bold: true }),
      line(616, "The third body line is here and goes on and on and on."),
    ];
    expect(kinds(paragraphsFromLines(inProse)).some((k) => k.startsWith("h"))).toBe(false);
  });

  it("a multi-line paragraph of one size is never a heading without a size level", () => {
    const wrapped = [
      line(700, "The first body line is here and goes on and on."),
      line(640, "Mission and values", { bold: true }),
      line(628, "and more of it", { bold: true }),
      line(592, "The last body line is here and goes on and on."),
    ];
    expect(kinds(paragraphsFromLines(wrapped)).some((k) => k.startsWith("h"))).toBe(false);
  });

  it("a sized title of two lines is one heading, whatever lies under it on the page", () => {
    const two = [
      line(700, "Body before it, long enough to be body text."),
      line(640, "Mission and values", { bold: true, fontSize: 20 }),
      line(620, "second title line", { bold: true, fontSize: 20 }),
      line(592, "Body after it, long enough to be body text too."),
    ];
    const level = (s: number): HeadingLevel | undefined => (s === 20 ? 1 : undefined);
    expect(kinds(paragraphsFromLines(two, level))).toContain("h1:Mission and values second title line");
  });
});

describe("paragraphsFromLines: gathering the lines", () => {
  it("a size change opens a paragraph; a gap beyond 2.2 times the size too, a gap of exactly 2.2 does not", () => {
    const size = (y: number, fontSize: number, text: string) => line(y, text, { fontSize });
    expect(kinds(paragraphsFromLines([size(700, 12, "alpha"), size(688, 13, "beta")]))).toEqual([
      "paragraph:alpha",
      "paragraph:beta",
    ]);
    expect(kinds(paragraphsFromLines([size(700, 10, "alpha"), size(678, 10, "beta")]))).toEqual([
      "paragraph:alpha beta",
    ]);
    expect(kinds(paragraphsFromLines([size(700, 10, "alpha"), size(677.9, 10, "beta")]))).toEqual([
      "paragraph:alpha",
      "paragraph:beta",
    ]);
  });

  it("the junction space goes on the piece before (a bold piece keeps it, the next piece never starts with it); a link continues only with the same link", () => {
    const first = line(700, "plain bold", {
      runs: [
        { text: "plain ", bold: false },
        { text: "bold", bold: true },
      ],
    });
    const second = line(688, "next", { runs: [{ text: "next", bold: false }] });
    const [paragraph] = paragraphsFromLines([first, second]);
    expect(paragraph!.kind === "paragraph" && paragraph.inlines.map((i) => [i.text, i.marks ?? []])).toEqual([
      ["plain ", []],
      ["bold ", ["strong"]],
      ["next", []],
    ]);
    const linked = line(700, "see site", {
      runs: [
        { text: "see ", bold: false },
        { text: "site", bold: false, href: "https://a.example/" },
      ],
    });
    const same = line(688, "site again", { runs: [{ text: "site again", bold: false, href: "https://a.example/" }] });
    const other = line(688, "other", { runs: [{ text: "other", bold: false }] });
    const hrefs = (lines: Line[]) => {
      const [p] = paragraphsFromLines(lines);
      return p!.kind === "paragraph" ? p.inlines.map((i) => [i.text, i.href]) : [];
    };
    expect(hrefs([linked, same])).toEqual([
      ["see ", undefined],
      ["site site again", "https://a.example/"],
    ]);
    expect(hrefs([linked, other])).toEqual([
      ["see ", undefined],
      ["site", "https://a.example/"],
      [" other", undefined],
    ]);
  });

  it("no lines, no blocks", () => {
    expect(paragraphsFromLines([])).toEqual([]);
  });

  it("the body indent is the most frequent left margin: items indented against it make a list, and the vote is by count", () => {
    const at = (y: number, left: number, text: string): Line => line(y, text, { left, right: left + 200 });
    const lines = [
      at(700, 72, "Body one."),
      at(660, 72, "Body two."),
      at(620, 72, "Body three."),
      at(580, 90, "1. first"),
      at(540, 90, "2. second"),
      at(500, 72, "Body four."),
    ];
    const blocks = paragraphsFromLines(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph", "list", "paragraph"]);
    // Majority at 90 instead: the items are the body, the body lines are the ones indented against it, and nothing is a list.
    const flipped = [
      at(700, 90, "1. first"),
      at(660, 90, "2. second"),
      at(620, 90, "3. third"),
      at(580, 72, "Body one."),
      at(540, 72, "Body two."),
    ];
    expect(paragraphsFromLines(flipped).map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
  });
});

describe("paragraphsFromLines: what the list decision is told about each block", () => {
  const at = (y: number, left: number, text: string, extra: Partial<Line> = {}): Line =>
    line(y, text, { left, right: left + 200, ...extra });

  it("a block that is not a marker has none, is indented against the body or not, and starts where its first line starts", () => {
    paragraphsFromLines([
      at(700, 72, "Body one."),
      at(660, 72, "Body two."),
      at(620, 72, "Body three."),
      at(580, 100, "Indented body"),
    ]);
    expect(candidates()).toEqual([
      { indented: false, marker: undefined, left: 72, geometry: { firstLeft: 72, firstY: 700, lastY: 700 } },
      { indented: false, marker: undefined, left: 72, geometry: { firstLeft: 72, firstY: 660, lastY: 660 } },
      { indented: false, marker: undefined, left: 72, geometry: { firstLeft: 72, firstY: 620, lastY: 620 } },
      { indented: true, marker: undefined, left: 100, geometry: { firstLeft: 100, firstY: 580, lastY: 580 } },
    ]);
  });

  it("a block of several lines starts at its leftmost line", () => {
    paragraphsFromLines([
      at(700, 80, "A first line that reaches the right margin", { right: 372 }),
      at(688, 72, "second line that reaches it too", { right: 372 }),
    ]);
    expect(candidates()).toEqual([
      { indented: false, marker: undefined, left: 72, geometry: { firstLeft: 80, firstY: 700, lastY: 688, pitch: 12 } },
    ]);
  });

  it("a numbered block says where its text starts: after the marker on its line, and on its second line; both must agree", () => {
    const lead = (text: string, nextLeft: number) => ({ lead: { text, nextLeft } });
    const textLefts = (lines: Line[]): (number | undefined)[] => {
      paragraphsFromLines(lines);
      return candidates().map((c) => c.textLeft);
    };
    // Marker and text read on the first line only.
    expect(textLefts([at(700, 90, "1. first", lead("1.", 110))])).toEqual([110]);
    // The marker the line reads is not the one its text starts with: that reading is not used.
    expect(textLefts([at(700, 90, "1. first", lead("1", 110))])).toEqual([undefined]);
    expect(textLefts([at(700, 90, "1. first")])).toEqual([undefined]);
    // Two readings that agree (within the tolerance) give the first; two that differ give nothing.
    expect(textLefts([at(700, 90, "1. first", lead("1.", 110)), at(688, 110, "continued", { right: 372 })])).toEqual([
      110,
    ]);
    expect(textLefts([at(700, 90, "1. first", lead("1.", 110)), at(688, 130, "continued", { right: 372 })])).toEqual([
      undefined,
    ]);
    // The second line alone stands.
    expect(textLefts([at(700, 90, "1. first"), at(688, 110, "continued", { right: 372 })])).toEqual([110]);
  });

  it("only a numbered block reads where its text starts: a bullet or a plain block never does", () => {
    const lead = { lead: { text: "•", nextLeft: 110 } };
    paragraphsFromLines([
      at(700, 90, "• bullet", lead),
      at(660, 90, "plain", { lead: { text: "plain", nextLeft: 120 } }),
    ]);
    expect(candidates().map((c) => [c.marker?.kind, "textLeft" in c])).toEqual([
      ["bullet", false],
      [undefined, false],
    ]);
  });
});

describe("paragraphsFromLines: which pairs of lines are one paragraph", () => {
  const full = (y: number, text: string, extra: Partial<Line> = {}): Line => line(y, text, { right: 372, ...extra });
  const count = (lines: Line[], centredContainerWidth?: Parameters<typeof paragraphsFromLines>[2]): number =>
    paragraphsFromLines(lines, undefined, centredContainerWidth).length;

  it("a line that starts a numbered item after an indented one opens a paragraph; a plain one at the same place does not", () => {
    expect(
      count([full(700, "The text of the paragraph before.", { left: 90 }), full(688, "1. the item", { left: 72 })]),
    ).toBe(2);
    expect(
      count([full(700, "The text of the paragraph before.", { left: 90 }), full(688, "the plain line", { left: 72 })]),
    ).toBe(1);
  });

  it("a break the layout did not force is deliberate; but not after a marker whose next line hangs from it", () => {
    // « foo » ends far from the margin and the next word would have fitted: the author broke the line.
    const deliberate = (first: string) =>
      count([
        line(700, first, { left: 72, right: 150 }),
        full(688, "bar baz", { left: 100, firstWordWidth: 20 }),
        full(676, "wide line", { left: 72 }),
      ]);
    expect(deliberate("plain foo")).toBe(2);
    // A marker followed by a line indented past it: the item and its continuation, never split here.
    expect(deliberate("1. foo")).toBe(1);
  });

  it("two lines centred on each other are two paragraphs, unless the container says the second is a wrap of the first", () => {
    const first = line(700, "A centred title", { left: 100, right: 200 });
    const second = line(688, "wrapped", { left: 120, right: 180, firstWordEstimate: 20 });
    expect(count([first, second])).toBe(2);
    const seen: unknown[][] = [];
    const container = (...args: unknown[]) => {
      seen.push(args);
      return 120;
    };
    // (120 - 100) / 20 = 1 word of room: it fits, so it was wrapped.
    expect(count([first, second], container as never)).toBe(1);
    expect(seen).toEqual([[first, second, [first, second]]]);
    expect(count([first, second], () => 400)).toBe(2);
    expect(count([first, second], () => undefined)).toBe(2);
  });

  it("a bitmap marker keeps its picture, takes no junction space and no neighbour", () => {
    const marker = { sha256: "m1", mimeType: "image/png" as const };
    const marked = line(700, " Absent", {
      runs: [
        { text: "", bold: false, marker },
        { text: " Absent", bold: false },
      ],
    });
    const next = line(688, "next line");
    const [paragraph] = paragraphsFromLines([marked, next]);
    expect(paragraph!.kind === "paragraph" && paragraph.inlines).toEqual([
      { text: "", image: marker },
      { text: " Absent next line" },
    ]);
    const endsWithMarker = line(700, "badge", {
      runs: [
        { text: "badge", bold: false },
        { text: "", bold: false, marker },
      ],
    });
    const [joined] = paragraphsFromLines([endsWithMarker, next]);
    expect(joined!.kind === "paragraph" && joined.inlines).toEqual([
      { text: "badge" },
      { text: "", image: marker },
      { text: " next line" },
    ]);
  });
});

describe("paragraphsFromLines: a contents line ends its paragraph", () => {
  const full = (y: number, text: string): Line => line(y, text, { right: 372 });
  const count = (lines: Line[]): number => paragraphsFromLines(lines).length;

  it("a line ending in leader dots and a page number is the last of its paragraph", () => {
    expect(
      count([
        full(700, "1 Introduction ........ 5"),
        full(688, "2 Method ........ 7"),
        full(676, "3 Results ........ 9"),
      ]),
    ).toBe(3);
    expect(count([full(700, "Annexe A . . . . . . iv"), full(688, "Annexe B . . . . . . v")])).toBe(2);
    expect(count([full(700, "Preface …… 3"), full(688, "Summary …… 4")])).toBe(2);
  });

  it("dots with no page number after them, a number with no dots and three dots do not end a paragraph", () => {
    expect(count([full(700, "The text goes on and on and then ........"), full(688, "continues here.")])).toBe(1);
    expect(count([full(700, "In 2024 the total reached 5"), full(688, "and went on from there.")])).toBe(1);
    expect(count([full(700, "He waited... 5"), full(688, "and went on from there.")])).toBe(1);
  });
});

describe("a line that opens with a note number opens a paragraph (05/11/2026)", () => {
  // Federal Register `sd-4133285` p1, foot of column 2: « 6 See id. and Section 19(a) of the Exchange Act. » fills
  // its line to the margin, so « 7 Id. » below it read as a wrap and the two notes came out as one paragraph.
  // The number is the line's first `sup` run (`pdf-lines.ts#isRaisedCall`), and that alone decides.
  const note = (y: number, number: string, text: string, right: number): Line =>
    line(y, `${number} ${text}`, {
      runs: [
        { text: number, bold: false, sup: true },
        { text: ` ${text}`, bold: false },
      ],
      right,
    });

  it("🔴 two one-line notes, the first filling its line, are two paragraphs", () => {
    const blocks = paragraphsFromLines([
      note(700, "6", "See id. and Section 19(a) of the Exchange Act.", 380),
      note(688, "7", "Id.", 240),
      note(676, "8", "See supra note 4.", 290),
    ]);
    expect(blocks.map(textOf)).toEqual([
      "6 See id. and Section 19(a) of the Exchange Act.",
      "7 Id.",
      "8 See supra note 4.",
    ]);
  });

  it("a call INSIDE a line decides nothing: the wrap below it still joins", () => {
    const first = line(700, "the Commission noted4 that the", {
      runs: [
        { text: "the Commission noted", bold: false },
        { text: "4", bold: false, sup: true },
        { text: " that the", bold: false },
      ],
      right: 380,
    });
    expect(paragraphsFromLines([first, line(688, "proceedings would continue", { right: 240 })])).toHaveLength(1);
  });
});
