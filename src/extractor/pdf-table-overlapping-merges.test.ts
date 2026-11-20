/**
 * A fragment is published once, even when two merges overlap. The invariant is textual, not geometric (no invented
 * word): two overlapping merges each collect the slots they cover, so the text of a shared slot would come out
 * twice.
 */
import { describe, expect, it } from "vitest";

import { cellsOfRow } from "./pdf-table-render";

/** A 2×2 grid whose slots hold one word each. */
const byCase = [
  [["a"], ["b"]],
  [["c"], ["partagé"]],
];

describe("deux fusions qui se recouvrent", () => {
  it("ne publient la case partagée qu'une fois", () => {
    // A right-hand cell that runs down (col 1, rowspan 2) and a bottom cell that spans (row 1, colspan 2): slot
    // (1,1) belongs to both.
    const merge = {
      cells: [
        { row: 0, col: 0, colspan: 1, rowspan: 1 },
        { row: 0, col: 1, colspan: 1, rowspan: 2 },
        { row: 1, col: 0, colspan: 2, rowspan: 1 },
      ],
      ownerAt: [
        [0, 1],
        [2, 1],
      ],
    };
    const publié = [0, 1].flatMap((row) => cellsOfRow(byCase, row, merge).flatMap((c) => c.fragments));
    expect(publié.filter((mot) => mot === "partagé")).toEqual(["partagé"]);
  });

  it("laisse une grille sans recouvrement exactement comme elle est", () => {
    const merge = {
      cells: [
        { row: 0, col: 0, colspan: 2, rowspan: 1 },
        { row: 1, col: 0, colspan: 1, rowspan: 1 },
        { row: 1, col: 1, colspan: 1, rowspan: 1 },
      ],
      ownerAt: [
        [0, 0],
        [1, 2],
      ],
    };
    const publié = [0, 1].flatMap((row) => cellsOfRow(byCase, row, merge).flatMap((c) => c.fragments));
    expect(publié.sort()).toEqual(["a", "b", "c", "partagé"]);
  });

  it("publie tout, sans fusion du tout", () => {
    const publié = [0, 1].flatMap((row) => cellsOfRow(byCase, row, undefined).flatMap((c) => c.fragments));
    expect(publié.sort()).toEqual(["a", "b", "c", "partagé"]);
  });
});
