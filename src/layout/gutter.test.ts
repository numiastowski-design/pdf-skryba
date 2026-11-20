import { describe, expect, it } from "vitest";

import {
  columnCut,
  columnCuts,
  documentColumnCut,
  documentColumnCuts,
  findGutters,
  MIN_COLUMN_PT,
  type GutterItem,
} from "./gutter";

/** The default text is prose on purpose: a gutter cut demands at least four words per fragment in both of its bands,
 *  so a one-word fixture would describe no page the reader cuts. */
const PROSE = "une ligne de prose repliée";

const f = (x: number, width = 40, text = PROSE): GutterItem => ({ text, x, width });

/** Two columns: five fragments on the left, five on the right. */
const deuxColonnes = (): GutterItem[] => [
  ...Array.from({ length: 5 }, () => f(60, 60)),
  ...Array.from({ length: 5 }, () => f(200, 60)),
];

describe("une gouttière, c'est un blanc que personne ne traverse", () => {
  it("deux colonnes franches donnent une coupe", () => {
    const cut = columnCut(deuxColonnes());
    expect(cut).toBeGreaterThan(120);
    expect(cut).toBeLessThan(200);
  });

  it("UN SEUL fragment ÉTROIT qui traverse referme la gouttière", () => {
    // The definition of a column, not a threshold: nothing crosses.
    expect(columnCut([...deuxColonnes(), f(130, 40)])).toBeUndefined();
  });

  it("…mais un fragment LARGE qui traverse est masqué comme transverse, pas compté", () => {
    // This lets a title across the columns leave a real column layout open. Written price: a full-width sentence in
    // the middle of the columns is hidden too, and the page stays cut.
    expect(columnCut([...deuxColonnes(), f(100, 120)])).toBeDefined();
  });

  it("mais un élément TRANSVERSE est masqué avant, sinon tout titre referme tout", () => {
    expect(columnCut([...deuxColonnes(), f(60, 300, "Un titre à cheval sur les deux colonnes")])).toBeDefined();
  });

  it("une page sans blanc franc n'en donne aucune", () => {
    expect(columnCut(Array.from({ length: 10 }, (_, i) => f(60 + i * 20, 22)))).toBeUndefined();
  });

  it("trop peu de fragments d'un côté : on s'abstient", () => {
    expect(columnCut([...Array.from({ length: 8 }, () => f(60, 60)), f(200, 60)])).toBeUndefined();
  });
});

describe("plusieurs gouttières décrivent une GRILLE, pas des colonnes", () => {
  it("trois colonnes de chiffres ne rendent aucune coupe de lecture", () => {
    const grille = [
      ...Array.from({ length: 5 }, () => f(60, 40)),
      ...Array.from({ length: 5 }, () => f(150, 40)),
      ...Array.from({ length: 5 }, () => f(240, 40)),
    ];
    expect(findGutters(grille).length).toBeGreaterThan(1);
    expect(columnCut(grille)).toBeUndefined();
  });
});

describe("une colonne a une largeur — le faux positif du retrait pendant (16/09/2026)", () => {
  /** Six bullets at 52.8 before a text at 70.8: a hanging indent in a one-column document. */
  const retraitPendant = (): GutterItem[] => [
    ...Array.from({ length: 6 }, () => f(52.8, 5.7, "•")),
    ...Array.from({ length: 28 }, () => f(70.8, 450, "le texte de l'item, pleine largeur")),
  ];

  it("🔴 le blanc qui suit une puce n'est PAS une gouttière — il n'a pas de colonne derrière", () => {
    // The reason is pinned: two rules would refuse this page (the column width and the prose guard), and the test
    // would not say which.
    expect(findGutters(retraitPendant())[0]!.columnPt).toBeLessThan(MIN_COLUMN_PT);
    expect(columnCut(retraitPendant())).toBeUndefined();
  });

  it("le témoin positif reste coupé — ses colonnes font 142 et 144 pt", () => {
    expect(columnCut(deuxColonnes())).toBeDefined();
  });

  it("⚠️ la largeur se vérifie APRÈS le décompte, sinon une grille devient deux colonnes", () => {
    // An invoice has two gutters, one of them narrow. Refusing the narrow one while measuring would leave one, hence
    // "two columns".
    const facture = [
      ...Array.from({ length: 6 }, () => f(60, 100, "Numero de facture")),
      ...Array.from({ length: 6 }, () => f(200, 100, "F-2026-0147")),
      ...Array.from({ length: 6 }, () => f(360, 20, "€")),
    ];
    expect(findGutters(facture).length).toBeGreaterThan(1);
    expect(columnCut(facture)).toBeUndefined();
  });
});

describe("une colonne d'ÉTIQUETTES n'est pas une colonne de texte (22/09/2026)", () => {
  /** Ten bill numbers on the left and their subject on the right: one clear gutter and a left column wide enough. */
  const colonneEtiquettes = (): GutterItem[] => [
    ...Array.from({ length: 10 }, () => f(50, 46, "HB 173")),
    ...Array.from({ length: 30 }, () =>
      f(150, 300, "Amends Insurance in special provisions relating to classes of insurers"),
    ),
  ];

  it("🔴 les dix numéros de loi ne partent plus en bloc, séparés de leur objet", () => {
    // Read in two bands, the page would give the ten numbers in a row, then the ten descriptions.
    expect(findGutters(colonneEtiquettes())).toHaveLength(1);
    expect(findGutters(colonneEtiquettes())[0]!.columnPt).toBeGreaterThanOrEqual(MIN_COLUMN_PT);
    expect(columnCut(colonneEtiquettes())).toBeUndefined();
  });

  it("…et la même géométrie avec de la prose des deux côtés reste coupée", () => {
    // Only the text changes.
    const prose = colonneEtiquettes().map((it) =>
      it.text === "HB 173" ? { ...it, text: "un libellé qui est une phrase" } : it,
    );
    expect(columnCut(prose)).toBeDefined();
  });
});

describe("la coupe se décide à l'échelle du DOCUMENT — c'est un invariant, pas une optimisation", () => {
  it("une page qui s'abstient hérite de la coupe des autres", () => {
    // Deciding page by page rendered two pages of identical geometry differently.
    const pageAvecGrille = [
      ...Array.from({ length: 5 }, () => f(60, 40)),
      ...Array.from({ length: 5 }, () => f(150, 40)),
      ...Array.from({ length: 5 }, () => f(240, 40)),
    ];
    expect(columnCut(pageAvecGrille)).toBeUndefined();
    expect(documentColumnCut([deuxColonnes(), pageAvecGrille])).toBeDefined();
  });

  it("aucune page ne donne de coupe : le document n'en a pas", () => {
    expect(documentColumnCut([[f(60)], [f(60)]])).toBeUndefined();
  });

  it("l'abscisse retenue est celle qui revient sur le plus de pages", () => {
    const autre = [...Array.from({ length: 5 }, () => f(60, 40)), ...Array.from({ length: 5 }, () => f(400, 40))];
    const cut = documentColumnCut([deuxColonnes(), deuxColonnes(), autre]);
    expect(cut).toBeLessThan(200);
  });
});

/**
 * N cuts, not one: `columnCut` abstains as soon as a page has more than one gutter, so a page of four columns would
 * be read across all of them.
 * The guard against a column of labels read as two bands stays: each gutter is judged on its two adjacent bands,
 * never on the two halves of the page, or two columns of prose would validate a third by contagion.
 */
describe("columnCuts : une page peut porter plusieurs colonnes", () => {
  /** Four columns of prose: edges at 60, 205, 350 and 495. */
  const quatreColonnes = (): GutterItem[] => [
    ...Array.from({ length: 5 }, () => f(60, 60)),
    ...Array.from({ length: 5 }, () => f(205, 60)),
    ...Array.from({ length: 5 }, () => f(350, 60)),
    ...Array.from({ length: 5 }, () => f(495, 60)),
  ];

  it("rend LES TROIS coupes d'une page à quatre colonnes, là où `columnCut` s'abstient", () => {
    // Counter-proof first: the single-cut decision gives nothing.
    expect(columnCut(quatreColonnes())).toBeUndefined();
    const cuts = columnCuts(quatreColonnes());
    expect(cuts).toHaveLength(3);
    // The middles of the gutters 120-205, 265-350 and 410-495: between column edges, not between left edges.
    expect(cuts.map((c) => Math.round(c))).toEqual([163, 308, 453]);
  });

  it("rend la coupe unique d'une page à deux colonnes, comme avant", () => {
    expect(columnCuts(deuxColonnes()).map((c) => Math.round(c))).toEqual([Math.round(columnCut(deuxColonnes())!)]);
  });

  it("ne rend rien là où l'ancienne décision ne rendait rien : une page d'une seule colonne", () => {
    expect(columnCuts(Array.from({ length: 10 }, () => f(60, 400)))).toEqual([]);
  });

  it("🔴 une colonne d'ÉTIQUETTES ne devient pas une coupe, même entourée de prose", () => {
    // Three bands: prose, one-word labels, prose. Both gutters touch the label band, so neither passes: the prose
    // guard applies pair by pair.
    const avecEtiquettes = [
      ...Array.from({ length: 5 }, () => f(60, 60)),
      ...Array.from({ length: 5 }, () => f(205, 60, "Nom")),
      ...Array.from({ length: 5 }, () => f(350, 60)),
    ];
    expect(columnCuts(avecEtiquettes)).toEqual([]);
  });

  it("un fragment qui RECOUVRE une gouttière la referme, et garde les autres", () => {
    // A fragment closes a gutter when it leaves no white in it: 118-208 covers 120-205 whole (`f(130, 60)` would sit
    // inside it and split it in two). Its 90 pt stay under the transverse filter, so it is counted.
    const cuts = columnCuts([...quatreColonnes(), f(118, 90)]);
    expect(cuts.map((c) => Math.round(c))).toEqual([308, 453]);
  });
});

/**
 * Two gutters around a sliver describe the same white. A margin ornament set in the gutter (a page number, a bullet)
 * splits it into two whites, each with a neighbouring band as wide as the sliver; both would be refused on
 * `MIN_COLUMN_PT` and the page would stay uncut.
 */
describe("un ÉCLAT dans une gouttière ne la dédouble pas", () => {
  /** Two columns of prose and, in their gutter, four one-word fragments 6 pt wide. */
  const avecEclat = (): GutterItem[] => [
    ...Array.from({ length: 15 }, () => f(60, 200)),
    ...Array.from({ length: 4 }, () => f(300, 6, "3")),
    ...Array.from({ length: 5 }, () => f(360, 200)),
  ];

  it("🔴 les deux blancs se fondent en UNE coupe, et la page redevient deux colonnes", () => {
    // Counter-proof first: the page does have two gutters. The single-cut decision sets the sliver aside too.
    expect(findGutters(avecEclat())).toHaveLength(2);
    expect(columnCut(avecEclat())).toBe(333);
    expect(columnCuts(avecEclat())).toHaveLength(1);
  });

  it("…et la coupe retenue est le blanc le plus FRANC des deux, pas le premier venu", () => {
    // Whites of 40 pt (260→300) and 54 pt (306→360): the second one is the separation, and it puts the sliver on the
    // left side.
    expect(columnCuts(avecEclat()).map((c) => Math.round(c))).toEqual([333]);
  });

  it("un éclat LARGE n'est pas un éclat : deux vraies colonnes étroites restent deux coupes", () => {
    // The guard must not swallow a middle column: this one is 80 pt wide and carries prose.
    const troisColonnes = [
      ...Array.from({ length: 5 }, () => f(60, 100)),
      ...Array.from({ length: 5 }, () => f(200, 80)),
      ...Array.from({ length: 5 }, () => f(330, 100)),
    ];
    expect(columnCuts(troisColonnes)).toHaveLength(2);
  });
});

/**
 * The cuts of the document. A cut is decided for the document, never for the page; a document may carry several.
 * One page is enough to found an abscissa, and it then holds for every page: a page the prose guard refuses still
 * gets the cuts another page founded.
 */
describe("documentColumnCuts : toutes les coupes que le document fonde", () => {
  const quatreColonnes = (): GutterItem[] => [
    ...Array.from({ length: 5 }, () => f(60, 60)),
    ...Array.from({ length: 5 }, () => f(205, 60)),
    ...Array.from({ length: 5 }, () => f(350, 60)),
    ...Array.from({ length: 5 }, () => f(495, 60)),
  ];

  it("une seule page à quatre colonnes fonde les trois coupes de tout le document", () => {
    const uneColonne = Array.from({ length: 10 }, () => f(60, 400));
    expect(columnCuts(uneColonne)).toEqual([]);
    expect(documentColumnCuts([uneColonne, quatreColonnes(), uneColonne]).map((c) => Math.round(c))).toEqual([
      163, 308, 453,
    ]);
  });

  it("aucune page ne donne de coupe : le document n'en a aucune", () => {
    expect(documentColumnCuts([[f(60)], [f(60)]])).toEqual([]);
  });

  it("les abscisses voisines à 10 pt près ne comptent que pour une", () => {
    const decale = (dx: number): GutterItem[] => [
      ...Array.from({ length: 5 }, () => f(60, 60)),
      ...Array.from({ length: 5 }, () => f(200 + dx, 60)),
    ];
    expect(documentColumnCuts([decale(0), decale(6), decale(3)])).toHaveLength(1);
  });

  it("la coupe DOMINANTE reste l'une d'elles, et le reste des deux décisions concorde", () => {
    const pages = [quatreColonnes(), deuxColonnes(), deuxColonnes()];
    const cuts = documentColumnCuts(pages);
    expect(cuts).toContain(documentColumnCut(pages)!);
    expect([...cuts].sort((a, b) => a - b)).toEqual(cuts);
  });
});

/**
 * Two document cuts closer than `MIN_COLUMN_PT` describe the same boundary. Founded by different pages and applied
 * together to every page, they would cut a band narrower than a word. No new threshold: `MIN_COLUMN_PT` is already
 * the minimal column width. The best founded one, carried by the most pages, is kept.
 */
describe("les coupes du document ne se marchent pas dessus", () => {
  const colonnesA = (): GutterItem[] => [
    ...Array.from({ length: 5 }, () => f(60, 60)),
    ...Array.from({ length: 5 }, () => f(200, 60)),
  ];
  /** The same page shifted by 25 pt: its cut falls 25 pt from the previous one, not enough for a column. */
  const colonnesB = (): GutterItem[] => [
    ...Array.from({ length: 5 }, () => f(85, 60)),
    ...Array.from({ length: 5 }, () => f(225, 60)),
  ];

  it("🔴 la coupe la moins fondée disparaît quand elle serre la mieux fondée", () => {
    // Two pages found 160, one founds 185: 25 pt apart, so only the best founded survives.
    expect(columnCuts(colonnesA()).map((c) => Math.round(c))).toEqual([160]);
    expect(columnCuts(colonnesB()).map((c) => Math.round(c))).toEqual([185]);
    expect(documentColumnCuts([colonnesA(), colonnesA(), colonnesB()]).map((c) => Math.round(c))).toEqual([160]);
  });

  it("…et deux coupes franchement distantes restent toutes les deux", () => {
    const loin = [...Array.from({ length: 5 }, () => f(60, 60)), ...Array.from({ length: 5 }, () => f(400, 60))];
    expect(documentColumnCuts([colonnesA(), loin])).toHaveLength(2);
  });
});

/**
 * 🔴 THE AUCTION CATALOGUE `sd-1026348` (10/11/2026: « il faut juste un espace après les numéros de
 * paragraphe »). Two columns of lots; each lot opens with its number, set apart from its text by a blank. Measured on
 * the reader's items, page 2: gutters at 53 (the left numbers, a band 11 pt wide), 266 and 337 (the right numbers
 * between them) — three gutters, so no cut, and every line of a lot is followed by the line beside it.
 */
describe("a column of lot numbers is not a column", () => {
  const numbered = (): GutterItem[] => [
    ...Array.from({ length: 8 }, () => f(30, 6, "1")),
    ...Array.from({ length: 16 }, () => f(65, 150, `${PROSE} ${PROSE}`)),
    ...Array.from({ length: 8 }, () => f(300, 6, "5")),
    ...Array.from({ length: 16 }, () => f(320, 150, `${PROSE} ${PROSE}`)),
  ];

  it("🔴 the page keeps its ONE cut, between the left text and the right numbers", () => {
    // Counter-proof first: the page measures three gutters.
    expect(findGutters(numbered())).toHaveLength(3);
    const cut = columnCut(numbered());
    expect(cut).toBeGreaterThan(215);
    expect(cut).toBeLessThan(300);
  });
});

/**
 * 🔴 THE CUT STANDS IN THE WHITE OF EVERY LINE OF ITS COLUMN (10/11/2026, same catalogue). `findGutters` hides the widest
 * fragments to find the white (`TRANSVERSE_RATIO`); on the catalogue they are the long lines of the left column (65 to
 * 279 pt), and the gutter came out at 266, across them. A line that ends before the right column starts is not a
 * transverse: the cut moves into the white it leaves.
 */
describe("a hidden line that ends before the right column does not hold the cut", () => {
  const page = (): GutterItem[] => [
    ...Array.from({ length: 15 }, () => f(65, 40)),
    ...Array.from({ length: 5 }, () => f(65, 214)),
    ...Array.from({ length: 20 }, () => f(314, 40)),
  ];

  it("🔴 the gutter sits between 279 (the long lines' end) and 314 (the right column)", () => {
    const [gutter] = findGutters(page());
    expect(gutter?.x).toBeGreaterThan(279);
    expect(gutter?.x).toBeLessThan(314);
  });

  it("a line that crosses into the right column stays a transverse: the white is found as before", () => {
    const withTitle = [...page(), f(65, 400)];
    expect(findGutters(withTitle)).toHaveLength(1);
  });
});
