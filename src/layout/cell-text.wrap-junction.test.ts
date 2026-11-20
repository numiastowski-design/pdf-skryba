/**
 * Wrap junction of `recomposeCellText` (chantier tableaux PDF, tranche « repeintures invisibles », sous-règle JONCTION, 27/10/2026).
 * Measured on 32 Word/PDF pairs (2 464 junctions):
 *  - J1 « cut token »: the upper VISUAL line holds ONE token (no blank), ends with a letter or digit, and the lower line starts with a
 *    lowercase LETTER (a digit start keeps its space — no measured case wants the glue, and « 13,834 » + « 56 » would invent a
 *    number): the junction has NO space (11/12 true cases fixed, 0/2298 false positive).
 *  - J2 « hyphen »: the upper line ends with ASCII « - » or « _ »: no space, the hyphen stays (25/25, 0 false positive).
 *    The em dash « — » stays OUT of the rule (written limit).
 * Every case asserts ONE output line: a case that does not join at all would test nothing.
 */
import { describe, expect, it } from "vitest";

import { recomposeCellText, type CellBounds } from "./cell-text";
import type { Fragment } from "./geometry";

const WIDE: CellBounds = { left: 200, right: 560 }; // 360 pt

const g = (text: string, x: number, y: number, width: number): Fragment => ({ text, x, y, width, height: 8 });

/** A visual line whose width is `fill` of the cell, one glyph per character, starting at the left margin. */
const filled = (text: string, y: number, fill: number): Fragment[] => {
  const width = ((WIDE.right - WIDE.left) * fill) / text.length;
  return [...text].map((ch, i) => g(ch, WIDE.left + 1 + i * width, y, width));
};

/** Upper line fills 96 % (it OPENS a wrap), lower line fills ~8 % (the asymmetry that arms `pendingWrap`). */
const wrapped = (upper: string, lower: string): string[] =>
  recomposeCellText([...filled(upper, 700, 0.96), ...filled(lower, 690, 0.08)], WIDE).map((l) => l.text);

describe("recomposeCellText — wrap junction, rule J1 (cut token)", () => {
  it("J1 (11 true cases of 12): one long token cut by the cell, lower line starts lowercase: joined WITHOUT space", () => {
    // FAILS WITH (today): expected [ '…/{toStopAreaId}/schedu les' ] to deeply equal [ '…/{toStopAreaId}/schedules' ] (a space is written).
    const upper = "/lines/{lineId}/stopAreas/{stopAreaId}/to/{toStopAreaId}/schedu";
    expect(wrapped(upper, "les")).toEqual([`${upper}les`]);
  });

  it("guard: a lower line starting with a DIGIT keeps its space — no measured case wants the glue, and gluing could invent a number (review of 27/10/2026, « 13,834 » + « 56 »)", () => {
    const upper = "/v3/networks/{networkId}/lines/{lineId}/stopPoints/{stopPointId}/to/{toStopPointId}/sched";
    expect(wrapped(upper, "2ules")).toEqual([`${upper} 2ules`]);
  });

  it("guard: J2 keeps a space the document wrote after the hyphen (a trailing blank glyph on the upper line)", () => {
    expect(wrapped("une plage de valeurs 10 - ", "20")).toEqual(["une plage de valeurs 10 - 20"]);
  });

  it("guard (« INFORMATION » / « FLOW », doc 13): one token, lower line starts UPPERCASE: space kept", () => {
    expect(wrapped("INFORMATIONINFORMATIONINFORMATION", "FLOW")).toEqual(["INFORMATIONINFORMATIONINFORMATION FLOW"]);
  });

  it("guard (« GET » then a path): one token, lower line starts with « / »: space kept", () => {
    expect(wrapped("GETGETGETGETGETGETGETGETGETGETGETGETGET", "/v3/networks")).toEqual([
      "GETGETGETGETGETGETGETGETGETGETGETGETGET /v3/networks",
    ]);
  });

  it("guard: upper line with SEVERAL tokens, lower line starts lowercase: space kept (the junction happens, J1 does not apply)", () => {
    expect(wrapped("un texte de plusieurs mots qui remplit la cellule en entier ici", "suite")).toEqual([
      "un texte de plusieurs mots qui remplit la cellule en entier ici suite",
    ]);
  });
});

describe("recomposeCellText — wrap junction, rule J2 (ASCII hyphen or underscore)", () => {
  it("J2 (25/25): upper line ends with « - »: « mots- » + « cles. » joined WITHOUT space, the hyphen stays", () => {
    // FAILS WITH (today): expected [ 'des mots- cles.' ] shape to equal [ '…mots-cles.' ] (a space is written after the hyphen).
    const upper = "un texte qui remplit la cellule avec des mots-";
    expect(wrapped(upper, "cles.")).toEqual([`${upper}cles.`]);
  });

  it("J2: upper line ends with « _ »: joined WITHOUT space, the underscore stays", () => {
    const upper = "un texte qui remplit la cellule avec le_nom_";
    expect(wrapped(upper, "complet")).toEqual([`${upper}complet`]);
  });

  it("limit (written): upper line ends with an EM DASH « — » (outside the rule): space kept", () => {
    const upper = "un texte qui remplit la cellule avec des mots —";
    expect(wrapped(upper, "cles.")).toEqual([`${upper} cles.`]);
  });
});
