/**
 * A doubled rule that text crosses folds onto its edge, whatever its gap. A thick rule records its two edges, the
 * grid reads two boundaries for one rule, and the text passing over the sliver column leaves a piece in it.
 *
 * The gap ceiling cannot settle it: a merge puts the boundary in the middle of the pair, and past the ceiling the
 * middle belongs to no painted line, so each row reads a colspan over it. What decides is not the width: text
 * passes over a sliver, while a narrow column that is a real one holds text.
 *
 * The fold goes onto an edge, not the middle: the edge is a painted line, so the merged-cell reading recognises it.
 */
import { describe, expect, it } from "vitest";

import { mergeDoubledBoundaries } from "./straddled-boundaries";

const DELTA = 4;
/** The predicate the rule asks receives a pair of boundaries, not a fragment: does text pass over that pair? This
 *  factory says yes for the named pair and no for every other. */
const crossing = (low: number, high: number) => (pairLow: number, pairHigh: number) =>
  pairLow >= low && pairHigh <= high;
const nothingCrosses = () => false;

describe("un filet doublé traversé par le texte", () => {
  it("se replie sur son bord gauche, même à 5,4 pt — au-delà du plafond", () => {
    expect(mergeDoubledBoundaries([0, 100, 105.4, 200], [50, 150], DELTA, crossing(100, 105.4))).toEqual([0, 100, 200]);
  });

  it("ne se replie pas quand rien ne le traverse, au-delà du plafond", () => {
    expect(mergeDoubledBoundaries([0, 100, 105.4, 200], [50, 150], DELTA, nothingCrosses)).toEqual([
      0, 100, 105.4, 200,
    ]);
  });

  it("ne se replie jamais quand un centre de fragment est DEDANS, même traversé", () => {
    // A narrow column that holds text of its own stays a column.
    expect(mergeDoubledBoundaries([0, 100, 106.5, 200], [50, 103, 150], DELTA, crossing(100, 106.5))).toEqual([
      0, 100, 106.5, 200,
    ]);
  });

  it("laisse la fusion ordinaire telle quelle, au milieu, quand l'écart tient dans le plafond", () => {
    expect(mergeDoubledBoundaries([0, 100, 103.8, 200], [50, 150], DELTA)).toEqual([0, 101.9, 200]);
    expect(mergeDoubledBoundaries([0, 100, 103.8, 200], [50, 150], DELTA, nothingCrosses)).toEqual([0, 101.9, 200]);
  });

  it("garde la vraie colonne à texte de 4,73 pt, traversée ou non", () => {
    expect(mergeDoubledBoundaries([0, 100, 104.73, 200], [50, 102, 150], DELTA, crossing(100, 104.73))).toEqual([
      0, 100, 104.73, 200,
    ]);
  });

  it("rend la liste dans l'ordre reçu, descendante comprise", () => {
    expect(mergeDoubledBoundaries([200, 105.4, 100, 0], [50, 150], DELTA, crossing(100, 105.4))).toEqual([200, 100, 0]);
  });
});
