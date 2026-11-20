/**
 * A LINE THAT OPENS WITH ITS NUMBER BELONGS TO ITS COLUMN (10/11/2026, auction catalogue `sd-1026348`: « il faut
 * juste un espace après les numéros de paragraphe »).
 *
 * Each lot opens with its number set before the column's text edge, a blank between them: « 6 » at 314, « 2 bottles
 * Believed Cockburn 1935 » at 349, the right column's lines all starting at 349. Alone on its baseline, the line was
 * taken for a line crossing the column's edge and published under the two columns — three lot titles out of their lots
 * on page 1. A fragment that crosses the edge is a transverse; a number that ENDS before the edge is part of the line.
 */
import { describe, expect, it } from "vitest";

import type { PositionedItem } from "./pdf-model";
import { readingBands } from "./pdf-bands";

const item = (text: string, x: number, y: number, width = 150): PositionedItem => ({ text, x, y, width, fontSize: 10 });

/** Two columns of prose, text edges at 65 and 349, every line on both sides; at y = 595 a right-column line alone on its
 *  baseline, opening with its number. */
const page = (lone: PositionedItem[]): PositionedItem[] => [
  ...[700, 690, 680, 670, 660, 650, 640, 630, 620, 610, 600].flatMap((y) => [
    item(`left ${String(y)}`, 65, y),
    item(`right ${String(y)}`, 349, y),
  ]),
  ...lone,
  ...[590, 580, 570, 560].flatMap((y) => [item(`left ${String(y)}`, 65, y), item(`right ${String(y)}`, 349, y)]),
];

const columns = (items: readonly PositionedItem[]): string[][] =>
  readingBands(items, [300])
    .filter((s) => s.column)
    .map((s) => s.lines.flat().map((it) => it.text));

describe("a line that opens with its number belongs to its column", () => {
  it("🔴 « 6 » and its title stay in the right column, between the lines around them", () => {
    const [, right] = columns(page([item("6", 314, 595, 6), item("2 bottles Believed Cockburn 1935", 349, 595)]));
    const at = right!.indexOf("right 600");
    expect(right!.slice(at, at + 4)).toEqual(["right 600", "6", "2 bottles Believed Cockburn 1935", "right 590"]);
  });

  it("a fragment that CROSSES the column's edge still leaves it (the centred notice of 11/09/2026)", () => {
    const [, right] = columns(page([item("aucun duplicata", 300, 595, 100)]));
    expect(right).not.toContain("aucun duplicata");
  });
});
