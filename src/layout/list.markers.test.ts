/**
 * THE LIST READER'S MARKER GRAMMARS, AS A FROZEN MATRIX: one line per example, one value per rule, so that what each
 * pattern of `list.ts` does and does NOT see stays visible at a glance.
 *
 * WHERE IT COMES FROM. This was `marker-grammars.ts` + `marker-grammars.test.ts`: a registry of NINE rules — these
 * five, plus four of the heading paths — kept side by side so their divergences could not drift apart unseen. The
 * heading modules were deleted on 05/11/2026 (size alone makes a heading), and the registry stayed behind with four columns describing code that no longer exists and three regexes
 * (`ENUMERATION`, `NUMBERING`, `LABELLED`) nothing read. Production imported NONE of it: its own header said
 * « Called by: marker-grammars.test.ts ».
 * It was not dead, though — it was HALF dead, and that is why the file was not simply deleted on 09/11/2026. Its five
 * list columns pin live behaviour of `list.ts`, including decisions taken on real documents. Those rows are all here;
 * the registry's indirection is gone and the patterns are imported from `list.ts` itself.
 *
 * Run: npx vitest run --project=main src/layout/list.markers.test.ts
 */

import { describe, expect, it } from "vitest";

import { BULLET, DASH, LETTERED, NUMBERED, ROMAN } from "./list";

const GRAMMARS = {
  "list-bullet": BULLET,
  "list-dash": DASH,
  "list-numbered": NUMBERED,
  "list-lettered": LETTERED,
  "list-roman": ROMAN,
} as const;

type RuleName = keyof typeof GRAMMARS;
type Row = Record<RuleName, boolean>;

/** Column order of `row(...)`: bullet, dash, numbered, lettered, roman. */
const row = (bullet: boolean, dash: boolean, numbered: boolean, lettered: boolean, roman: boolean): Row => ({
  "list-bullet": bullet,
  "list-dash": dash,
  "list-numbered": numbered,
  "list-lettered": lettered,
  "list-roman": roman,
});

const T = true;
const F = false;

/** The frozen matrix. Every example the nine-rule version carried is kept: each one says something about these five. */
const MATRIX: [string, Row][] = [
  //                          bul dsh num let rom
  ["• Item", row(T, F, F, F, F)],
  ["● Titre court", row(T, F, F, F, F)],
  ["⁃ Item", row(T, F, F, F, F)],
  ["· Item", row(T, F, F, F, F)],
  ["- Item", row(F, T, F, F, F)],
  ["-Item", row(F, F, F, F, F)],
  ["– Item", row(F, T, F, F, F)],
  ["— Item", row(F, T, F, F, F)],
  ["1. Item", row(F, F, T, F, F)],
  ["1) Item", row(F, F, T, F, F)],
  ["12. Item", row(F, F, T, F, F)],
  ["123. Item", row(F, F, F, F, F)],
  ["3 Introduction", row(F, F, F, F, F)],
  ["3) Intro", row(F, F, T, F, F)],
  ["3.1 Intro", row(F, F, F, F, F)],
  ["3.1.2 Sous-partie", row(F, F, F, F, F)],
  ["3.1. Intro", row(F, F, F, F, F)],
  ["a) Item", row(F, F, F, T, F)],
  ["a. Item", row(F, F, F, T, F)],
  ["B) Item", row(F, F, F, T, F)],
  ["iv. Item", row(F, F, F, F, T)],
  ["IV. Titre", row(F, F, F, F, T)],
  ["L. Titre", row(F, F, F, T, F)],
  ["XIV) Titre", row(F, F, F, F, T)],
  ["Chapitre 3", row(F, F, F, F, F)],
  ["CHAPITRE IV", row(F, F, F, F, F)],
  ["Annexe A", row(F, F, F, F, F)],
  ["Part 2", row(F, F, F, F, F)],
  ["Section X", row(F, F, F, F, F)],
  ["Introduction", row(F, F, F, F, F)],
  ["  3.2 Intro", row(F, F, F, F, F)],
];

const RULES = Object.keys(GRAMMARS) as RuleName[];
const applies = (name: RuleName, s: string): boolean => GRAMMARS[name].test(s);
const seenBy = (s: string): RuleName[] => RULES.filter((name) => applies(name, s));

describe("the list reader's marker grammars: shape", () => {
  it("has the five named rules, and each one is a pattern", () => {
    expect(RULES).toEqual(["list-bullet", "list-dash", "list-numbered", "list-lettered", "list-roman"]);
    for (const name of RULES) expect(GRAMMARS[name]).toBeInstanceOf(RegExp);
  });

  it("every matrix row gives a value for every rule (a hole would read as `false` and pin nothing)", () => {
    for (const [example, expected] of MATRIX) {
      for (const name of RULES) expect(typeof expected[name], `${example} / ${name}`).toBe("boolean");
    }
  });
});

describe("the list reader's marker grammars: correspondence matrix", () => {
  it("every example is seen by exactly the rules the matrix names", () => {
    for (const [example, expected] of MATRIX) {
      const got = RULES.filter((name) => expected[name]);
      expect(seenBy(example), example).toEqual(got);
    }
  });
});

describe("the list reader's marker grammars: known behaviours, frozen", () => {
  it("'-Item' (a dash glued to its word) is seen by NO list rule (decision of 22/09/2026, in list.ts)", () => {
    expect(seenBy("-Item")).toEqual([]);
    expect(seenBy("- Item")).toEqual(["list-dash"]);
  });

  it("a number with no bracket and no dot is not a list: '3 Introduction' and '3.1 Intro' are seen by none", () => {
    // The heading paths DID see them (they are gone since 05/11/2026); the list reader never has.
    expect(seenBy("3 Introduction")).toEqual([]);
    expect(seenBy("3.1 Intro")).toEqual([]);
    expect(seenBy("3) Intro")).toEqual(["list-numbered"]);
  });

  it("'L. Titre' is a LETTER for the list reader, never a roman: its romans are IVXivx, one to four characters", () => {
    expect(seenBy("L. Titre")).toEqual(["list-lettered"]);
    expect(seenBy("IV. Titre")).toEqual(["list-roman"]);
    expect(seenBy("XIV) Titre")).toEqual(["list-roman"]);
  });

  it("a number of three digits is not a marker: '12. Item' is, '123. Item' is not", () => {
    expect(seenBy("12. Item")).toEqual(["list-numbered"]);
    expect(seenBy("123. Item")).toEqual([]);
  });

  it("'● Titre court' is a bullet like any other: the character set is shared, the length decides nothing here", () => {
    expect(seenBy("● Titre court")).toEqual(["list-bullet"]);
  });

  it("a leading blank is not trimmed by these patterns: '  3.2 Intro' is seen by none", () => {
    expect(seenBy("  3.2 Intro")).toEqual([]);
  });
});
