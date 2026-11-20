/** `reseatSuperscripts` — the trailing bound is the CELLS' only (Fable's review, 23/10/2026): in the page flow, a small raised item just
 *  past a line's right edge may be the value of the next column of a tight grid not rebuilt; it is left where it is. */
import { describe, expect, it } from "vitest";

import { reseatSuperscripts, TRAILING_CALL_GAP_EM } from "./superscript";

type Item = { x: number; y: number; width: number; text: string; size: number };
const item = (text: string, x: number, y: number, size: number, width = 6): Item => ({ text, x, y, width, size });
// Groups top to bottom: the raised call's own group above, its host line below.
const groups = (): Item[][] => [[item("2", 30, 104, 7)], [item("Total", 0, 100, 12, 30)]];

describe("reseatSuperscripts — a call that starts at its host line's right edge", () => {
  it("🔴 by default (the page flow) it is left where it is", () => {
    // FAILS WITH: [["Total", "2"]] (the trailing bound reached the page flow).
    expect(reseatSuperscripts(groups(), (it) => it.size).map((g) => g.map((it) => it.text))).toEqual([
      ["2"],
      ["Total"],
    ]);
  });

  it("🔴 a cell asks for the trailing bound and gets the call back on its line", () => {
    const out = reseatSuperscripts(groups(), (it) => it.size, TRAILING_CALL_GAP_EM);
    expect(out.flat().length).toBe(2);
    expect(out.filter((g) => g.length > 0).map((g) => g.map((it) => it.text).sort())).toEqual([["2", "Total"]]);
  });
});

/**
 * The host is the line below that the call sits over, not the next line of the list. On a page of several columns
 * the lines interleave in y order, so the line after the call is often another column's, which does not contain it.
 */
describe("reseatSuperscripts — the host is the line the call sits over, among the lines within reach below", () => {
  /** A call of column 2 at y 104 over its host at y 100 [200→300]; between them, in the list, a column-3 line at
   *  y 102 [400→500] that does not contain it. */
  const interleaved = (): Item[][] => [
    [item("6", 250, 104, 7)],
    [item("Joint Industry Plan", 400, 102, 12, 100)],
    [item("registration. However", 200, 100, 12, 100)],
  ];

  it("🔴 the call joins the line it sits over, past a foreign column's line", () => {
    // FAILS WITH: [["6"], ["Joint Industry Plan"], ["registration. However"]] — the next line in the list is the only host tried.
    const out = reseatSuperscripts(interleaved(), (it) => it.size).map((g) => g.map((it) => it.text));
    expect(out).toEqual([["Joint Industry Plan"], ["registration. However", "6"]]);
  });

  it("a line out of the rise window is not a host: the call stays alone", () => {
    const farBelow = (): Item[][] => [
      [item("6", 250, 120, 7)],
      [item("Joint Industry Plan", 400, 102, 12, 100)],
      [item("registration. However", 200, 100, 12, 100)],
    ];
    const out = reseatSuperscripts(farBelow(), (it) => it.size).map((g) => g.map((it) => it.text));
    expect(out).toEqual([["6"], ["Joint Industry Plan"], ["registration. However"]]);
  });

  it("the nearest line that contains the call wins, never one further down that also would", () => {
    const twoHosts = (): Item[][] => [
      [item("6", 250, 104, 7)],
      [item("near host", 200, 101, 12, 100)],
      [item("far host", 200, 99.5, 12, 100)],
    ];
    const out = reseatSuperscripts(twoHosts(), (it) => it.size).map((g) => g.map((it) => it.text));
    expect(out).toEqual([["near host", "6"], ["far host"]]);
  });
});

/**
 * A number that opens its note joins it: a small raised digit set just before the start of the note's line, not
 * inside it.
 */
describe("reseatSuperscripts — a note number that ends just before its line opens it", () => {
  // Host at y 100, [60→200], 7 pt. The number « 1 » is 3 pt wide and ends 1 pt before the host's left edge: 0.14 em.
  const opening = (): Item[][] => [[item("1", 56, 102.5, 4.5, 3)], [item("The Commission notes", 60, 100, 7, 140)]];

  it("🔴 in the page flow it joins the line it precedes", () => {
    // FAILS WITH: [["1"], ["The Commission notes"]] — an item had to START inside the host to be its call.
    // Compared SORTED, like the cell test above: the function moves the item onto the line, and sorting the line by x
    // is `groupIntoReseatedLines`'s job (a first expectation on the raw order failed for that reason alone).
    const out = reseatSuperscripts(opening(), (it) => it.size).map((g) => g.map((it) => it.text).sort());
    expect(out).toEqual([["1", "The Commission notes"]]);
  });

  it("a small raised item well before the line — the previous column's end — stays where it is", () => {
    // 10 pt of white before the host: 1.4 em, more than a gutter. Failure value: joined to a line it never opened.
    const farLeft = (): Item[][] => [[item("1", 47, 102.5, 4.5, 3)], [item("The Commission notes", 60, 100, 7, 140)]];
    const out = reseatSuperscripts(farLeft(), (it) => it.size).map((g) => g.map((it) => it.text));
    expect(out).toEqual([["1"], ["The Commission notes"]]);
  });
});

describe("reseatSuperscripts — a drop cap is not a host for the lines above its baseline (05/11/2026)", () => {
  // Front page of the newspaper `sd-2479793`: « C' » in 36 pt opens « C'est devenu un rituel ». The two lines above its
  // baseline (9 pt, 19 and 10 pt higher) passed for its superscripts — and with them the items of column 3 at the same
  // height, since a visual line crosses the whole page. The host size under a candidate is that of the text BENEATH it.
  const page = (): Item[][] => [
    [item("est devenu un ri-", 245, 475, 9, 67), item("manifestant son attachement", 555, 475, 9, 105)],
    [item("tuel. Une semaine", 245, 466, 9, 67), item("et en célébrant joyeusement sa", 555, 466, 9, 105)],
    [
      item("C'", 207, 456, 36.4, 39),
      item("du mois de mars", 245, 456, 9, 67),
      item("vitalité. Une manière de mon-", 555, 456, 9, 105),
    ],
  ];

  it("🔴 the lines above the drop cap keep their place, in both columns", () => {
    expect(reseatSuperscripts(page(), (it) => it.size).map((g) => g.map((it) => it.text))).toEqual([
      ["est devenu un ri-", "manifestant son attachement"],
      ["tuel. Une semaine", "et en célébrant joyeusement sa"],
      ["C'", "du mois de mars", "vitalité. Une manière de mon-"],
    ]);
  });

  it("a call raised over a word of the drop cap's line still joins it", () => {
    const withCall = [[item("6", 300, 460, 6)], ...page()];
    const out = reseatSuperscripts(withCall, (it) => it.size)
      .filter((g) => g.length > 0)
      .map((g) => g.map((it) => it.text).sort());
    expect(out).toEqual([
      ["est devenu un ri-", "manifestant son attachement"],
      ["et en célébrant joyeusement sa", "tuel. Une semaine"],
      ["6", "C'", "du mois de mars", "vitalité. Une manière de mon-"],
    ]);
  });
});
