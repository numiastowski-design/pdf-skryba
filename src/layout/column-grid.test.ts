import { describe, expect, it } from "vitest";

import { columnCuts, findGutters, type GutterItem } from "./gutter";
import { columnStarts, gridCuts } from "./column-grid";

const PROSE = "une ligne de prose repliée dans sa colonne";
const f = (x: number, width: number, text = PROSE): GutterItem => ({ text, x, width });

/** Three columns of 150 pt, starting at 45, 222 and 399. */
const troisColonnes = (): GutterItem[] => [45, 222, 399].flatMap((at) => Array.from({ length: 10 }, () => f(at, 150)));

describe("les départs de colonnes sont des bords gauches RÉPÉTÉS", () => {
  it("trois colonnes donnent trois départs, avec leur bord droit médian", () => {
    expect(columnStarts(troisColonnes()).map((c) => [Math.round(c.at), Math.round(c.right)])).toEqual([
      [45, 195],
      [222, 372],
      [399, 549],
    ]);
  });

  it("une seule colonne ne donne qu'un départ : il n'y a pas de grille", () => {
    expect(columnStarts(Array.from({ length: 30 }, () => f(65, 344)))).toHaveLength(1);
    expect(
      gridCuts(
        Array.from({ length: 30 }, () => f(65, 344)),
        "width",
      ),
    ).toEqual([]);
  });

  it("un bord gauche qui ne revient pas assez n'est pas un départ", () => {
    expect(
      columnStarts([...troisColonnes(), ...Array.from({ length: 3 }, () => f(300, 50))]).map((c) => Math.round(c.at)),
    ).toEqual([45, 222, 399]);
  });
});

/**
 * A gutter is a blank nobody crosses: one stray fragment of page furniture closes it, and a three-column page reads
 * as an ordinary one. Aligned left edges survive it.
 */
describe("un fragment égaré referme la gouttière, pas la grille", () => {
  // Two intruders, each closing one of the two blanks, neither wide enough for the transverse filter.
  const avecHabillage = (): GutterItem[] => [
    ...troisColonnes(),
    f(141, 90, "Federal Register"),
    f(348, 70, "E:FRFM27JAN1.SGM"),
  ];

  it("🔴 la gouttière disparaît, la grille tient", () => {
    // The control first: without the furniture the gutter sees the page too.
    expect(findGutters(troisColonnes()).length).toBeGreaterThan(0);
    expect(columnCuts(avecHabillage())).toEqual([]);
    expect(gridCuts(avecHabillage(), "width").map((c) => Math.round(c))).toEqual([209, 386]);
  });
});

describe("la preuve de la grille : des largeurs égales, ou des caractères en nombre voisin", () => {
  it("deux blocs de largeurs très inégales ne sont pas deux colonnes", () => {
    // Two starts, 17 pt and 263 pt wide: a ratio of 15.
    const inegal = [
      ...Array.from({ length: 12 }, () => f(46, 17, "•")),
      ...Array.from({ length: 13 }, () => f(79, 263)),
    ];
    expect(gridCuts(inegal, "width")).toEqual([]);
  });

  it("les caractères voient ce que la largeur ne voit pas : trois colonnes égales, une seule remplie", () => {
    const presqueVide = [
      ...Array.from({ length: 10 }, () => f(45, 150)),
      ...Array.from({ length: 10 }, () => f(222, 150, "ok")),
      ...Array.from({ length: 10 }, () => f(399, 150)),
    ];
    expect(gridCuts(presqueVide, "width")).toHaveLength(2);
    expect(gridCuts(presqueVide, "chars")).toEqual([]);
  });

  it("…et la largeur voit ce que les caractères ne voient pas : deux blocs inégaux au texte équilibré", () => {
    const inegal = [
      ...Array.from({ length: 12 }, () => f(46, 40, "douze caractères")),
      ...Array.from({ length: 12 }, () => f(120, 300, "douze caractères")),
    ];
    expect(gridCuts(inegal, "chars")).toHaveLength(1);
    expect(gridCuts(inegal, "width")).toEqual([]);
  });

  it("des colonnes qui se CHEVAUCHENT ne sont pas une grille : on s'abstient", () => {
    const chevauche = [
      ...Array.from({ length: 10 }, () => f(45, 300)),
      ...Array.from({ length: 10 }, () => f(222, 300)),
    ];
    expect(gridCuts(chevauche, "width")).toEqual([]);
  });
});

/**
 * A cut goes where the fewest fragments cross it: the banded reading gives up the whole column zone as soon as one
 * fragment crosses the cut inside it, so one point of difference decides a page.
 */
describe("la coupe évite ce qui la traverserait", () => {
  it("🔴 un fragment posé au milieu du blanc pousse la coupe à côté de lui, pas sur lui", () => {
    const page: GutterItem[] = [
      ...Array.from({ length: 10 }, () => f(45, 150)),
      ...Array.from({ length: 10 }, () => f(260, 150)),
      // A piece of text set in the blank 195→260: it crosses the middle (227), not the sides.
      f(205, 40, "note"),
    ];
    const [cut] = gridCuts(page, "width");
    expect(cut).toBeDefined();
    expect(page.some((it) => it.x < cut! && it.x + it.width > cut!)).toBe(false);
  });

  it("…et quand rien ne traverse, elle reste au milieu du blanc", () => {
    expect(
      gridCuts(
        [...Array.from({ length: 10 }, () => f(45, 150)), ...Array.from({ length: 10 }, () => f(260, 150))],
        "width",
      ),
    ).toEqual([227.5]);
  });

  it("🔴 des lignes justifiées qui dépassent le bord droit médian : la coupe se pose au milieu du blanc qui reste, pas sur leur bord (05/11/2026)", () => {
    // Median right edge of column 2 at 373, justified lines up to 390, column 3 at 399: a cut on the edge of the
    // long lines would fall inside the column on another page.
    const page: GutterItem[] = [...troisColonnes(), ...Array.from({ length: 3 }, () => f(222, 168))];
    const [, cut] = gridCuts(page, "width");
    expect(cut).toBeCloseTo(394.5, 1);
  });
});
