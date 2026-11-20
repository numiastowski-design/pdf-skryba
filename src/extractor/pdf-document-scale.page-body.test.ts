/**
 * The styles of a page are decided per page, on the one thing the PDF says explicitly: the size of each fragment.
 *
 * The page's body is the size that carries the most letters. Above it the sizes rank from largest to smallest as
 * `h1`… `h6`, two sizes within `DEFAULT_HEADING_SIZE_RATIO` of each other sharing a rank. Below the body by at
 * least that ratio, it is small text. A page with too few letters to have a body keeps the document's scale.
 */
import { describe, expect, it } from "vitest";

import { scaleOfPage } from "./pdf-document-scale";
import type { PdfTextRun } from "./pdf-source";

const run = (text: string, fontSize: number): PdfTextRun =>
  ({
    text,
    x: 0,
    y: 0,
    width: 10,
    height: fontSize,
    fontSize,
    matrix: [1, 0, 0, 1, 0, 0],
    fontId: undefined,
    weight: "unknown",
    rotated: false,
    hasEOL: false,
    dir: "ltr",
    artifact: false,
  }) as never;

describe("scaleOfPage — les styles d'une page, par page, sur ses tailles", () => {
  const une = [
    ...Array.from({ length: 100 }, () => run("une ligne de corps en neuf points", 9)),
    ...Array.from({ length: 60 }, () => run("une ligne de la barre en huit et demi", 8.5)),
    run("Alouette", 168),
    run("La langue", 54),
    run("française en fête", 54),
    run("Association suisse des journalistes", 24),
    run("Francophonie", 22),
    run("Numéro 1 Mars 2009", 12.8),
    run("Du Jura au Tessin", 12),
    run("4 See id.", 6.5),
  ];
  // The document's scale: 9 → h6, 12.75 → h3, 12 → h6, 14 → h2; nothing for 168, 54, 24, 22.
  const journal = {
    headingLevelOf: (size: number) =>
      (({ 9: 6, 12.75: 3, 12: 6, 14: 2 }) as Record<number, 1 | 2 | 3 | 4 | 5 | 6 | undefined>)[size],
    isBodySize: (size: number) => size === 7.5,
    pageBodySizes: new Set([7.5]),
  };
  const page = scaleOfPage(une, journal);

  it("🔴 le corps de la page n'est pas un titre, et une taille proche du corps non plus", () => {
    expect(page.headingLevelOf(9)).toBeUndefined();
    expect(page.headingLevelOf(8.5)).toBeUndefined();
    expect(page.isBodySize(9)).toBe(true);
    expect(page.isBodySize(8.5)).toBe(true);
  });

  it("🔴 une taille que le document ne classe pas est un titre dès 2 fois le corps, rangée parmi les titres de la page", () => {
    expect([168, 54, 24, 22].map((s) => page.headingLevelOf(s))).toEqual([1, 2, 3, 3]);
  });

  it("🔴 une taille que le document classe garde son niveau, ou descend au rang que la page lui donne : jamais au-dessus", () => {
    // 12.8 pt: h3 in the document, 4th rank on this page (after 168, 54, 24-22) → h4. 12 pt: h6 in the document, 5th rank → h6.
    expect(page.headingLevelOf(12.8)).toBe(4);
    expect(page.headingLevelOf(12)).toBe(6);
  });

  // MEASURED (06/11/2026, p4 of the Alouette bulletin, fixture 58 p2, `corpus-local/diag-alouette-tailles.ts`): letters by size
  // on the page — 7.5 pt: 2 972 (the programme), 9 pt: 1 739 (the Argument, « Informations pratiques »), 12 pt: 288, 24: 24,
  // 31: 65. The page's body is 7.5; 9 pt is the body of page 3 (6 960 letters) — yet the DOCUMENT classes 9 pt `h6`
  // (`diag-alouette-echelle.ts`: the four-column lines straddle the gutter and leave the distribution, 7.5 wins). 9 / 7.5 =
  // 1.2 exactly, so the 9 pt prose passed the title gate and the whole Argument came out in `<h6>`, sentence by sentence.
  it("🔴 une taille qui est le CORPS d'une page du document n'est un titre sur aucune page : l'Argument en 9 pt reste de la prose sur la page dont le corps est le programme en 7,5", () => {
    const p4 = scaleOfPage(
      [
        ...Array.from({ length: 100 }, () => run("une ligne du programme en sept points et demi", 7.5)),
        ...Array.from({ length: 60 }, () => run("une ligne de l'argument en neuf points", 9)),
        run("Argument", 12),
        run("Programme", 24),
        run("Le français dans l’enseignement", 31),
      ],
      {
        headingLevelOf: (size) => (size === 9 ? 6 : undefined),
        isBodySize: (size) => size === 7.5,
        pageBodySizes: new Set([7.5, 9]),
      },
    );
    // Failure value (today): 9 → h6, the sixth rank after 31, 24 and 12. Not small either: 9 pt is above the page's body.
    expect(p4.headingLevelOf(9)).toBeUndefined();
    expect(p4.isSmallSize(9)).toBe(false);
    expect([31, 24, 12].map((s) => p4.headingLevelOf(s))).toEqual([1, 2, 3]);
  });

  it("🔴 une taille que le document ne classe pas est un titre dès 1,2 fois le corps de la page (05/11/2026 : « quitte à inventer des titres »)", () => {
    const page13 = scaleOfPage(
      [
        ...Array.from({ length: 100 }, () => run("corps de dix points, une ligne de prose", 10)),
        run("un libellé un peu plus grand", 13),
      ],
      { headingLevelOf: () => undefined, isBodySize: (size) => size === 10, pageBodySizes: new Set([10]) },
    );
    expect(page13.headingLevelOf(13)).toBe(1);
  });

  it("🔴 une page qui ne porte que des sections h3 du document les garde en h3 (02-jvmalin : les niveaux exacts)", () => {
    const inner = scaleOfPage(
      [
        ...Array.from({ length: 100 }, () => run("corps de dix points, une ligne de prose", 10)),
        run("3.2 Une section", 13),
        run("3.3 Une autre", 13),
      ],
      {
        headingLevelOf: (size) => (size === 13 ? 3 : size === 18 ? 1 : undefined),
        isBodySize: (size) => size === 10,
        pageBodySizes: new Set([10]),
      },
    );
    expect(inner.headingLevelOf(13)).toBe(3);
  });

  it("deux tailles d'une même classe du document tiennent un seul rang (le tableau KPI : quatre titres h1)", () => {
    const kpi = scaleOfPage(
      [
        ...Array.from({ length: 100 }, () => run("corps de dix points, une ligne de prose", 10)),
        run("Titre", 20),
        run("Second", 15),
        run("Tiers", 15),
      ],
      {
        headingLevelOf: (size) => (size === 20 || size === 15 ? 1 : undefined),
        isBodySize: (size) => size === 10,
        pageBodySizes: new Set([10]),
      },
    );
    expect([20, 15].map((s) => kpi.headingLevelOf(s))).toEqual([1, 1]);
  });

  it("🔴 sous le corps d'au moins le rapport des titres, c'est du petit texte", () => {
    expect(page.isSmallSize(6.5)).toBe(true);
    expect(page.isSmallSize(8.5)).toBe(false);
    expect(page.isSmallSize(9)).toBe(false);
  });

  it("🔴 une taille de moins de trois lettres — la lettrine « C' » en 36 pt — ne prend pas de rang", () => {
    const withCap = scaleOfPage([...une, run("C’", 36.4)], journal);
    expect(withCap.headingLevelOf(36.4)).toBeUndefined();
    expect([168, 54, 24, 12.8].map((s) => withCap.headingLevelOf(s))).toEqual([1, 2, 3, 4]);
  });

  it("au-delà de six rangs, tout est h6", () => {
    const deep = scaleOfPage(
      [
        ...Array.from({ length: 100 }, () => run("corps de dix points, beaucoup de lettres ici", 10)),
        ...[80, 60, 45, 34, 26, 20].map((s) => run("titre", s)),
      ],
      { headingLevelOf: () => undefined, isBodySize: () => false, pageBodySizes: new Set() },
    );
    expect([80, 60, 45, 34, 26, 20].map((s) => deep.headingLevelOf(s))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deep.headingLevelOf(80 * 2)).toBeUndefined();
  });

  it("une page sans assez de lettres garde l'échelle du document, et n'a pas de petit texte", () => {
    const cover = scaleOfPage([run("Rapport annuel", 36)], journal);
    expect(cover.headingLevelOf(9)).toBe(6);
    expect(cover.headingLevelOf(14)).toBe(2);
    expect(cover.isSmallSize(6)).toBe(false);
  });
});
