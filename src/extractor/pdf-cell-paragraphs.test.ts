/**
 * THE TWO NUMBER GUARDS OF A CELL JOIN, on lines written by hand (lot « 42 »,
 * 23/09/2026, `pdf-cell-paragraphs.ts`).
 *
 * They are here rather than on a fixture because each one names a defect, and
 * a defect deserves a test that says exactly what it is:
 *  - a piece that is ONLY a number never joins — « 7,00 » and « 6,00 », the two
 *    grades of one subject on the real school report, came out as « 7,00 6,00 »;
 *  - a join must never FABRICATE a number — « 7, » then « 6 » would give
 *    `7,6`, a value nowhere in the document.
 *
 * Every line below is built to pass the geometry, so that only the guard under
 * test can refuse the join: same size, adjacent ordinates, a first line ending
 * far from the margin only where that is the point.
 */
import { describe, expect, it } from "vitest";

import type { CellLine } from "../layout/cell-text";
import { cellParagraphs, isNumberAlone, joinCellLines, wouldFabricateNumber } from "./pdf-cell-paragraphs";

/** The cell's drawn right edge, which is the margin a break is judged against. */
const CELL_RIGHT = 100;

/** A cell line whose geometry says « the next word did not fit »: it ends AT
 *  the cell's drawn edge, so nothing but the guards can refuse the join. */
const line = (text: string, middle: number, firstWordWidth = 20): CellLine => ({
  text,
  depth: 0,
  middle,
  endMiddle: middle,
  left: 0,
  right: CELL_RIGHT,
  widest: CELL_RIGHT,
  fontSize: 10,
  startFontSize: 10,
  firstWordWidth,
});

const joined = (...lines: CellLine[]): string[] => joinCellLines(lines, CELL_RIGHT).map((l) => l.text);

describe("a piece that is only a number never joins", () => {
  it("« 7,00 » and « 6,00 » stay two paragraphs", () => {
    // Sabotage: drop `isNumberAlone` from `continuesCellParagraph` and the two
    // grades come out as one value.
    expect(joined(line("7,00", 100), line("6,00", 90))).toEqual(["7,00", "6,00"]);
  });

  it("a number does not join the prose around it either", () => {
    expect(joined(line("le total est de", 100), line("19,14", 90))).toEqual(["le total est de", "19,14"]);
    expect(joined(line("19,14", 100), line("est le total", 90))).toEqual(["19,14", "est le total"]);
  });

  it("the grammar is closed: what it calls a number, and what it does not", () => {
    // Fixture integrity for the predicate itself. Without this pair the test
    // above would also pass on a grammar that calls EVERYTHING a number.
    for (const number of ["7", "7,00", "7.00", "-7,00", "1 000", "1.000,50", "60%", "2,50 €", "2023"]) {
      expect(isNumberAlone(number)).toBe(true);
    }
    for (const text of ["35h", "Lot 3.6.5", "7 hôtels", "N+1", "le total", ""]) {
      expect(isNumberAlone(text)).toBe(false);
    }
  });
});

describe("a join never fabricates a number", () => {
  it("« 7, » followed by « 6 » stays two paragraphs — `7,6` is nowhere in the document", () => {
    // The gravest defect this product can produce: the page looks normal and
    // the figure is false. Sabotage: drop `wouldFabricateNumber` and this joins.
    expect(joined(line("sur 7,", 100), line("6 de moyenne", 90))).toEqual(["sur 7,", "6 de moyenne"]);
  });

  it("a dot does the same, and so does no separator at all", () => {
    expect(wouldFabricateNumber("note 7.", "6 sur dix")).toBe(true);
    expect(wouldFabricateNumber("note 7", "6 sur dix")).toBe(true);
    expect(wouldFabricateNumber("note 7,", "6 sur dix")).toBe(true);
  });

  it("but a sentence that merely ends on a figure still joins an ordinary word", () => {
    // The guard must not refuse everything behind a digit, or it would be a
    // rule about digits rather than about fabricated numbers.
    expect(wouldFabricateNumber("en 1990,", "est né")).toBe(false);
    expect(joined(line("fondé en 1990,", 100), line("il ouvre", 90))).toEqual(["fondé en 1990, il ouvre"]);
  });
});

/**
 * WHAT THE LINES THE JOIN LEFT ALONE BECOME (lot « 44 », 23/09/2026).
 *
 * The lines below are set in a body of 10 pt, so `PARAGRAPH_BREAK_GAP_RATIO`
 * (2.2) puts the paragraph blank at 22 pt of vertical gap: 10 pt apart is an
 * ordinary line spacing, 30 pt apart is a real blank. Both sides are asserted,
 * so a rule that never breaks and a rule that always breaks each fail one test.
 */
describe("an ordinary line spacing is a line break, a real blank is a new paragraph", () => {
  /** What these tests are about: the GROUPING and the ordinate a neighbouring
   *  image is placed against. The paragraph also carries its `top`/`bottom`
   *  extent since lot « 45 »; that extent is asserted where it is used, at
   *  `pdf-table-render.test.ts#imageFrontier`, not here. */
  const grouped = (lines: readonly CellLine[]): { text: string; middle: number }[] =>
    cellParagraphs(lines).map(({ text, middle }) => ({ text, middle }));

  it("two lines an ordinary spacing apart are ONE paragraph, on two lines", () => {
    // Failure value: two paragraphs — what the product published until this lot,
    // and what Confluence separated with a paragraph blank.
    expect(grouped([line("FRANCAIS", 100), line("Mme FINELLE", 90)])).toEqual([
      { text: "FRANCAIS\nMme FINELLE", middle: 100 },
    ]);
  });

  it("a real paragraph blank still opens a second paragraph", () => {
    // Sabotage: drop the gap test from `cellParagraphs` and a whole cell comes
    // out as one block, blanks and all.
    expect(grouped([line("dernier mot.", 100), line("Titre suivant", 70)])).toEqual([
      { text: "dernier mot.", middle: 100 },
      { text: "Titre suivant", middle: 70 },
    ]);
  });

  it("a paragraph is ordered on the middle of its FIRST line", () => {
    // That ordinate is what an image in the same cell is placed against
    // (`pdf-table-render.ts#placeCellImages`). Failure value: 80, the last line.
    expect(grouped([line("un", 100), line("deux", 90), line("trois", 80)])).toEqual([
      { text: "un\ndeux\ntrois", middle: 100 },
    ]);
  });

  it("a blank line carries no paragraph of its own", () => {
    expect(grouped([line("un", 100), line("   ", 90), line("deux", 80)])).toEqual([{ text: "un\ndeux", middle: 100 }]);
  });

  it("an unmeasurable gap gives a line break: the rule only asserts what it proves", () => {
    // No text size, so the ratio means nothing and no paragraph break is
    // proved. The weaker claim is the line break. Failure value: two paragraphs.
    const sizeless: CellLine = { ...line("sans corps", 90), fontSize: 0, startFontSize: 0 };
    expect(grouped([line("avant", 100), sizeless])).toEqual([{ text: "avant\nsans corps", middle: 100 }]);
  });
});

/**
 * A word cut by a hyphen at a line end, and what the rule refuses.
 *
 * Two logical lines of one cell paragraph are joined by a `\n`, a line break on the page; when the upper line ends on
 * a hyphen that cut a word, the break splits the word for search.
 *
 * The rule is not J2 (`layout/cell-text.ts#wrapSeparator`), which rejoins on a hyphen or an underscore but is only
 * reached for a line that really wrapped at the cell edge. At the junction of two logical lines none of that holds,
 * and the wide rule glued a form's underscores to the next label, a dash to a title, and a dash to an amount: an
 * invented number. Hence the narrower rule: a letter touches the hyphen and the lower line starts with a letter.
 */
describe("un trait d'union de fin de ligne recolle le mot, et rien d'autre", () => {
  const texts = (lines: readonly CellLine[]): string[] => cellParagraphs(lines).map((p) => p.text);

  it("recolle le mot coupé, sans espace et sans `<br/>`", () => {
    // Failure value before the fix: « sous-\nutilisés », published « sous-<br/>utilisés ».
    expect(texts([line("sous-", 100), line("utilisés", 90)])).toEqual(["sous-utilisés"]);
    expect(texts([line("Net-", 100), line("Zero", 90)])).toEqual(["Net-Zero"]);
    expect(texts([line("CLARENCE-", 100), line("ROCKLAND", 90)])).toEqual(["CLARENCE-ROCKLAND"]);
  });

  it("REFUSE de souder un nombre derrière un tiret isolé — « Total -12,00 » n'existe nulle part", () => {
    // The gravest defect this product can produce, and the first version of this rule produced it.
    expect(texts([line("Total -", 100), line("12,00", 90)])).toEqual(["Total -\n12,00"]);
  });

  it("REFUSE un trait d'union précédé d'une espace : ce n'est pas un mot coupé", () => {
    expect(texts([line("Chapitre 1 -", 100), line("Introduction", 90)])).toEqual(["Chapitre 1 -\nIntroduction"]);
  });

  it("REFUSE le souligné d'un formulaire, que J2 accepte pour un enroulement", () => {
    expect(texts([line("Signature ______", 100), line("Date", 90)])).toEqual(["Signature ______\nDate"]);
  });

  it("REFUSE quand la ligne du bas ne commence pas par une lettre", () => {
    // A real cut word on paper, but no discriminant separates it from a fabricated number: the rule abstains.
    expect(texts([line("AG-", 100), line("002.", 90)])).toEqual(["AG-\n002."]);
  });
});
